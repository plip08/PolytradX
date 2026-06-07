/**
 * BACKEND ENTRY POINT
 *
 * Boot sequence:
 *  1. Load env → validate required vars
 *  2. Init ProviderManager (HTTP + WS RPC)
 *  3. Init WalletManager → CTF approval check
 *  4. Init ClobClient → WalletManager
 *  5. Init TransactionManager
 *  6. Init CtfClient
 *  7. Init RiskManager
 *  8. Start WebSocket broadcast server
 *  9. Register log forwarder
 * 10. Start StrategyRunner
 * 11. Start REST API
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { JsonRpcProvider } from 'ethers';
import { ProviderManager, WalletManager } from './core/base.js';
import { BotWebSocketServer } from './core/wsServer.js';
import { TransactionManager } from './core/transactionManager.js';
import { ClobClient } from './services/clobClient.js';
import { CtfClient } from './services/ctfClient.js';
import { RiskManager } from './services/riskManager.js';
import { StrategyRunner } from './services/strategyRunner.js';
import { logger, registerWsLogForwarder, emitLog } from './utils/logger.js';
import type { ConfigMap, StrategyId, WsMessage, LogEntry } from './types/index.js';
import { AI_MODELS, type AiProvider, IaAgentStrategy } from './strategies/iaAgent.js';

// ─── Required env validation ──────────────────────────────────────────────────

const REQUIRED_ENV = ['PRIVATE_KEY', 'POLYGON_RPC_HTTP', 'POLYGON_RPC_WS'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

// ─── Default config for all strategies ───────────────────────────────────────

// Capital plan for 150€ total:
//   AtomicArb       $60  — risk-free if fast enough, small but guaranteed
//   ResolutionSnipe $55  — highest certainty, snipe stale asks on resolved markets
//   NegativeRisk    $45  — mathematical certainty on multi-outcome events
//   LogicArb        $20  — conservative, only real logical pairs
//   MarketMaker     OFF  — needs $5k+ to be competitive
//   LatencyArb      OFF  — needs paid sports feed
//   AI_AGENT        OFF  — useful for filtering, no direct capital

const dryRun = process.env['DRY_RUN'] === 'true';

const DEFAULT_CONFIG: ConfigMap = {
  ATOMIC_ARB: {
    id: 'ATOMIC_ARB',
    enabled: true,
    maxSlippagePct: 0.005,   // tight — arb only works if price is right
    minProfitUsd: 0.15,      // ~$0.15 min to cover gas on Polygon
    capitalAllocationUsd: 60,
    gasStrategy: 'FAST',
    dryRun,
    customParams: {},
  },
  MARKET_MAKER: {
    id: 'MARKET_MAKER',
    enabled: false,           // needs $5k+ capital to compete
    maxSlippagePct: 0.005,
    minProfitUsd: 0.1,
    capitalAllocationUsd: 0,
    gasStrategy: 'STANDARD',
    dryRun,
    customParams: {},
  },
  LATENCY_ARB: {
    id: 'LATENCY_ARB',
    enabled: false,           // needs paid sports feed (Betfair/Pinnacle)
    maxSlippagePct: 0.03,
    minProfitUsd: 0.5,
    capitalAllocationUsd: 0,
    gasStrategy: 'FRONTRUN',
    dryRun,
    customParams: {},
  },
  LOGIC_ARB: {
    id: 'LOGIC_ARB',
    enabled: true,
    maxSlippagePct: 0.02,
    minProfitUsd: 0.20,
    capitalAllocationUsd: 20,
    gasStrategy: 'FAST',
    dryRun,
    customParams: {},
  },
  NEGATIVE_RISK: {
    id: 'NEGATIVE_RISK',
    enabled: true,
    maxSlippagePct: 0.02,
    minProfitUsd: 0.20,
    capitalAllocationUsd: 45,
    gasStrategy: 'FAST',
    dryRun,
    customParams: {},
  },
  RESOLUTION_SNIPE: {
    id: 'RESOLUTION_SNIPE',
    enabled: true,
    maxSlippagePct: 0.005,
    minProfitUsd: 0.10,      // low threshold — even $0.10 guaranteed profit is worth it
    capitalAllocationUsd: 55,
    gasStrategy: 'FRONTRUN', // speed is everything here
    dryRun,
    customParams: {},
  },
  AI_AGENT: {
    id: 'AI_AGENT',
    enabled: false,           // too expensive in API calls for small capital
    maxSlippagePct: 0.02,
    minProfitUsd: 1.0,
    capitalAllocationUsd: 0,
    gasStrategy: 'FAST',
    dryRun,
    customParams: {},
  },
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('='.repeat(60));
  logger.info('  POLYMARKET QUANT BOT v2.0 — STARTING');
  logger.info('='.repeat(60));

  // 1. WS Broadcast Server
  const wsPort = parseInt(process.env['WS_PORT'] ?? '8080');
  const wss = BotWebSocketServer.getInstance(wsPort);

  // 2. Log forwarder → WS broadcast
  registerWsLogForwarder((entry: LogEntry) => {
    wss.broadcast('LOG_ENTRY', entry);
  });

  // 3. RPC Provider
  const rpcConfig = {
    httpUrl: process.env['POLYGON_RPC_HTTP']!,
    wsUrl: process.env['POLYGON_RPC_WS']!,
    fallbackHttpUrls: [
      process.env['POLYGON_RPC_FALLBACK_1'] ?? 'https://polygon-rpc.com',
      process.env['POLYGON_RPC_FALLBACK_2'] ?? 'https://rpc-mainnet.maticvigil.com',
    ],
    chainId: parseInt(process.env['POLYGON_CHAIN_ID'] ?? '137'),
    timeoutMs: 5000,
  };

  const providerManager = ProviderManager.getInstance(rpcConfig);
  const provider = await providerManager.getProvider();
  await providerManager.connectWebSocket();

  // 4. Wallet
  const walletManager = new WalletManager(process.env['PRIVATE_KEY']!, provider);
  const wallet = walletManager.getWallet();
  logger.info(`[Boot] Wallet: ${walletManager.getAddress()}`);

  // 5. CLOB Client
  const clob = ClobClient.getInstance();
  clob.setWallet(walletManager);

  // 6. Transaction Manager
  const txManager = new TransactionManager(wallet);

  // 7. CTF Client → ensure approvals
  const ctf = CtfClient.getInstance(wallet, txManager);
  await ctf.ensureCtfApproval('STANDARD').catch((err) => {
    logger.warn('[Boot] CTF approval check failed (may be already approved)', { err });
  });

  // 8. Risk Manager
  const risk = RiskManager.getInstance();

  // 9. Strategy Runner
  const runner = StrategyRunner.getInstance(clob, ctf, risk, wallet, txManager, DEFAULT_CONFIG);
  runner.startAll();

  // 10. REST API (control plane)
  const app = express();
  app.use(cors());
  app.use(express.json());

  const apiSecret = process.env['API_SECRET'] ?? 'changeme';

  // Auth middleware
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const token = req.headers['x-api-key'];
    if (token !== apiSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
  });

  app.post('/kill-switch', (_req, res) => {
    runner.activateKillSwitch();
    res.json({ success: true, message: 'Kill switch activated' });
  });

  app.delete('/kill-switch', (_req, res) => {
    runner.deactivateKillSwitch();
    res.json({ success: true, message: 'Kill switch deactivated' });
  });

  app.post('/strategy/:id/start', (req, res) => {
    try {
      runner.startStrategy(req.params['id'] as StrategyId);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/strategy/:id/stop', (req, res) => {
    runner.stopStrategy(req.params['id'] as StrategyId);
    res.json({ success: true });
  });

  app.patch('/strategy/:id/config', (req, res) => {
    try {
      runner.updateConfig(req.params['id'] as StrategyId, req.body as Partial<typeof DEFAULT_CONFIG[StrategyId]>);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/config', (_req, res) => {
    res.json(runner.getConfigMap());
  });

  // ─── AI provider / model selection ──────────────────────────────────────────

  // List all available models per provider
  app.get('/ai/models', (_req, res) => {
    res.json(AI_MODELS);
  });

  // Hot-swap AI provider + model
  app.post('/ai/provider', (req, res) => {
    const { provider, model } = req.body as { provider: AiProvider; model?: string };
    const validProviders: AiProvider[] = ['ANTHROPIC', 'OPENAI', 'GROK', 'GOOGLE'];

    if (!validProviders.includes(provider)) {
      res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
      return;
    }

    if (model && !AI_MODELS[provider].find((m) => m.id === model)) {
      res.status(400).json({ error: `Model "${model}" not found for provider ${provider}` });
      return;
    }

    const aiStrategy = runner.getStrategy('AI_AGENT') as IaAgentStrategy | undefined;
    if (!aiStrategy) {
      res.status(404).json({ error: 'AI_AGENT strategy not initialized' });
      return;
    }

    aiStrategy.setProvider(provider, model);
    res.json({ success: true, provider, model: model ?? aiStrategy.resolveModel(provider) });
  });

  // ─── Settings (API keys + bot config) ────────────────────────────────────────

  const ALLOWED_SETTINGS = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROK_API_KEY', 'GOOGLE_API_KEY',
    'DRY_RUN', 'MAX_GLOBAL_CAPITAL_USD', 'AI_CONFIDENCE_THRESHOLD', 'AI_PROVIDER',
  ] as const;
  type SettingKey = typeof ALLOWED_SETTINGS[number];

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ENV_PATH  = path.resolve(__dirname, '../../.env');

  const PLACEHOLDER_PREFIXES = ['sk-YOUR', 'xai-YOUR', 'YOUR_', 'CHANGE_ME'];

  function maskKey(val: string | undefined): { masked: string; configured: boolean } {
    if (!val || PLACEHOLDER_PREFIXES.some((p) => val.startsWith(p))) {
      return { masked: '', configured: false };
    }
    const visible = val.length > 10 ? val.slice(0, 6) + '••••••••' + val.slice(-4) : '••••••••';
    return { masked: visible, configured: true };
  }

  function updateEnvFile(updates: Partial<Record<SettingKey, string>>): void {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [key, value] of Object.entries(updates) as [SettingKey, string][]) {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(content)) {
        content = content.replace(re, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      process.env[key] = value;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  }

  app.get('/settings', (_req, res) => {
    const apiKeys = {
      ANTHROPIC_API_KEY: maskKey(process.env['ANTHROPIC_API_KEY']),
      OPENAI_API_KEY:    maskKey(process.env['OPENAI_API_KEY']),
      GROK_API_KEY:      maskKey(process.env['GROK_API_KEY']),
      GOOGLE_API_KEY:    maskKey(process.env['GOOGLE_API_KEY']),
    };
    const botConfig = {
      DRY_RUN:                  process.env['DRY_RUN'] ?? 'true',
      MAX_GLOBAL_CAPITAL_USD:   process.env['MAX_GLOBAL_CAPITAL_USD'] ?? '10000',
      AI_CONFIDENCE_THRESHOLD:  process.env['AI_CONFIDENCE_THRESHOLD'] ?? '0.90',
      AI_PROVIDER:              process.env['AI_PROVIDER'] ?? 'ANTHROPIC',
    };
    res.json({ apiKeys, botConfig });
  });

  app.post('/settings', (req, res) => {
    const body = req.body as Partial<Record<SettingKey, string>>;
    const updates: Partial<Record<SettingKey, string>> = {};

    for (const key of ALLOWED_SETTINGS) {
      if (body[key] !== undefined && body[key] !== '') {
        updates[key] = body[key] as string;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No valid settings provided' });
      return;
    }

    try {
      updateEnvFile(updates);

      // Reload AI clients if any key changed
      const aiKeyChanged = (['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROK_API_KEY', 'GOOGLE_API_KEY'] as const)
        .some((k) => k in updates);
      if (aiKeyChanged) {
        const aiStrategy = runner.getStrategy('AI_AGENT') as IaAgentStrategy | undefined;
        aiStrategy?.reloadApiKeys();
      }

      // Update risk capital limit if it changed
      if ('MAX_GLOBAL_CAPITAL_USD' in updates) {
        risk.updateCapitalLimit();
      }

      res.json({ success: true, updated: Object.keys(updates) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  const apiPort = parseInt(process.env['API_PORT'] ?? '3001');
  app.listen(apiPort, () => {
    logger.info(`[Boot] REST API listening on http://0.0.0.0:${apiPort}`);
  });

  // 11. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`[Boot] ${signal} received — shutting down gracefully`);
    runner.stopAll();
    providerManager.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('[Boot] Uncaught exception', { err });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[Boot] Unhandled rejection', { reason });
  });

  emitLog('SUCCESS', `Bot online — DRY_RUN=${process.env['DRY_RUN']} | WS:${wsPort} | API:${apiPort}`);
}

main().catch((err) => {
  logger.error('[Boot] Fatal error', { err });
  process.exit(1);
});
