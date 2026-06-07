/**
 * STRATEGY RUNNER / ORCHESTRATOR
 *
 * Central controller that:
 *  - Initializes and holds all 8 strategy instances
 *  - Handles global kill switch
 *  - Exposes start/stop/configure per strategy
 *  - Publishes global BotState snapshots every second
 *  - Routes config hot-reload messages from the API
 */

import { Wallet } from 'ethers';
import { ClobClient } from './clobClient.js';
import { CtfClient } from './ctfClient.js';
import { RiskManager } from './riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { TransactionManager } from '../core/transactionManager.js';
import { AtomicArbStrategy } from '../strategies/atomicArb.js';
import { MarketMakerStrategy } from '../strategies/marketMaker.js';
import { LatencyArbStrategy } from '../strategies/latencyArb.js';
import { LogicArbStrategy } from '../strategies/logicArb.js';
import { NegativeRiskStrategy } from '../strategies/negativeRisk.js';
import { ResolutionSnipingStrategy } from '../strategies/resolutionSniping.js';
import { IaAgentStrategy } from '../strategies/iaAgent.js';
import { MarketDiscovery, DEFAULT_DISCOVERY_CONFIG } from './marketDiscovery.js';
import { emitLog } from '../utils/logger.js';
import type {
  StrategyId,
  StrategyStatus,
  BotState,
  ConfigMap,
  StrategyConfig,
} from '../types/index.js';

type AnyStrategy = {
  readonly strategyId: StrategyId;
  status: StrategyStatus;
  start(): void;
  stop(): void;
  getMetrics(): Record<string, number | string>;
};

export class StrategyRunner {
  private static instance: StrategyRunner | null = null;

  private readonly strategies = new Map<StrategyId, AnyStrategy>();
  private configMap: ConfigMap;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startTime = Date.now();

  // Cached balances — refreshed every 30s to avoid RPC spam
  private cachedUsdcBalance = 0;
  private cachedPolBalance = 0;
  private balanceRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // Trade history for win rate
  private totalTrades = 0;
  private winningTrades = 0;

  private constructor(
    private readonly clob: ClobClient,
    private readonly ctf: CtfClient,
    private readonly risk: RiskManager,
    private readonly wallet: Wallet,
    private readonly txManager: TransactionManager,
    initialConfig: ConfigMap,
  ) {
    this.configMap = initialConfig;
    this.initStrategies();
  }

  static getInstance(
    clob?: ClobClient,
    ctf?: CtfClient,
    risk?: RiskManager,
    wallet?: Wallet,
    txManager?: TransactionManager,
    config?: ConfigMap,
  ): StrategyRunner {
    if (!StrategyRunner.instance) {
      if (!clob || !ctf || !risk || !wallet || !txManager || !config) {
        throw new Error('StrategyRunner not initialized');
      }
      StrategyRunner.instance = new StrategyRunner(clob, ctf, risk, wallet, txManager, config);
    }
    return StrategyRunner.instance;
  }

  private initStrategies(): void {
    const provider = this.wallet.provider;
    if (!provider) throw new Error('Wallet has no provider');

    // Strategy 1 — Atomic Arb (markets fed dynamically by MarketDiscovery)
    this.strategies.set(
      'ATOMIC_ARB',
      new AtomicArbStrategy(
        {
          targetMargin: 0.005,   // 0.5% min net profit per pair
          maxPositionUsdc: 1000,
          collateralToken: process.env['USDC_ADDRESS'] ?? '',
        },
        this.configMap['ATOMIC_ARB'],
        this.clob,
        this.ctf,
        this.risk,
      ),
    );

    // Strategy 2 — Market Maker
    this.strategies.set(
      'MARKET_MAKER',
      new MarketMakerStrategy(
        {
          marketId: process.env['MM_MARKET_ID'] ?? '',
          tokenId: process.env['MM_TOKEN_ID'] ?? '',
          targetSpreadBps: 50,
          orderSizeUsdc: 100,
          maxInventoryTokens: 5000,
          rebalanceThresholdPct: 0.003,
          imbalanceAdjustmentFactor: 0.5,
        },
        this.configMap['MARKET_MAKER'],
        this.clob,
        this.risk,
      ),
    );

    // Strategy 3 — Latency Arb
    this.strategies.set(
      'LATENCY_ARB',
      new LatencyArbStrategy(
        {
          feedWsUrl: process.env['SPORTS_FEED_WS_URL'] ?? 'wss://api.simulated-sports.io/feed',
          feedApiKey: process.env['SPORTS_FEED_API_KEY'],
          maxSweepUsdc: 500,
          stalePriceThreshold: 0.05,
          eventCooldownMs: 30_000,
        },
        this.configMap['LATENCY_ARB'],
        this.clob,
        this.risk,
      ),
    );

    // Strategy 4 — Logic Arb
    this.strategies.set(
      'LOGIC_ARB',
      new LogicArbStrategy(
        { scanIntervalMs: 5_000, maxPairsToTrack: 50 },
        this.configMap['LOGIC_ARB'],
        this.clob,
        this.risk,
      ),
    );

    // Strategy 5 — Negative Risk
    this.strategies.set(
      'NEGATIVE_RISK',
      new NegativeRiskStrategy(
        {
          marketGroups: [],
          minExcessThreshold: 0.03,
          scanIntervalMs: 10_000,
        },
        this.configMap['NEGATIVE_RISK'],
        this.clob,
        this.risk,
      ),
    );

    // Strategy 6/7 — Resolution Sniping
    this.strategies.set(
      'RESOLUTION_SNIPE',
      new ResolutionSnipingStrategy(
        {
          watchedMarkets: [],
          minSnipeMargin: 0.01,
          maxSnipeSizeUsdc: 500,
        },
        this.configMap['RESOLUTION_SNIPE'],
        this.clob,
        this.ctf,
        this.risk,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider as any,
      ),
    );

    // Strategy 8 — AI Agent
    this.strategies.set(
      'AI_AGENT',
      new IaAgentStrategy(
        {
          aiProvider: 'ANTHROPIC',
          confidenceThreshold: parseFloat(process.env['AI_CONFIDENCE_THRESHOLD'] ?? '0.90'),
          maxCallsPerMinute: 10,
          newsPollingIntervalMs: 3_000,
          watchedMarkets: [],
        },
        this.configMap['AI_AGENT'],
        this.clob,
        this.risk,
      ),
    );

    emitLog('INFO', `[StrategyRunner] ${this.strategies.size} strategies initialized`);
  }

  startAll(): void {
    for (const [id, strategy] of this.strategies) {
      if (this.configMap[id]?.enabled) {
        strategy.start();
      }
    }

    // Broadcast BotState snapshot every second
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000);

    // Refresh wallet balances every 30s
    void this.refreshBalances();
    this.balanceRefreshTimer = setInterval(() => void this.refreshBalances(), 30_000);

    // Start MarketDiscovery — feeds markets to all strategies automatically
    this.startMarketDiscovery();

    emitLog('INFO', '[StrategyRunner] All enabled strategies started');
  }

  private startMarketDiscovery(): void {
    const atomicArb   = this.strategies.get('ATOMIC_ARB')   as AtomicArbStrategy | undefined;
    const logicArb    = this.strategies.get('LOGIC_ARB')    as LogicArbStrategy | undefined;
    const negRisk     = this.strategies.get('NEGATIVE_RISK') as NegativeRiskStrategy | undefined;
    const resSnipe    = this.strategies.get('RESOLUTION_SNIPE') as ResolutionSnipingStrategy | undefined;
    const latencyArb  = this.strategies.get('LATENCY_ARB')  as LatencyArbStrategy | undefined;
    const aiAgent     = this.strategies.get('AI_AGENT')     as IaAgentStrategy | undefined;

    const discovery = MarketDiscovery.getInstance(DEFAULT_DISCOVERY_CONFIG);

    discovery.registerHandlers({
      onCryptoMarkets: (markets) => atomicArb?.setMarkets?.(markets),
      onSportsMarkets: (markets) => {
        latencyArb?.setMarkets?.(markets);
        resSnipe?.addMarkets?.(markets);
      },
      onAllLiquidMarkets: (markets) => {
        logicArb?.setMarkets?.(markets);
        aiAgent?.setWatchedMarkets?.(markets.slice(0, 10));
      },
      onEventGroups: (groups) => negRisk?.setEventGroups?.(groups),
      onNearExpiryMarkets: (markets) => resSnipe?.addMarkets?.(markets),
    });

    discovery.start();
  }

  stopAll(): void {
    for (const strategy of this.strategies.values()) {
      strategy.stop();
    }
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.balanceRefreshTimer) clearInterval(this.balanceRefreshTimer);
  }

  /** Records a completed trade for win rate tracking */
  recordTradeResult(pnl: number): void {
    this.totalTrades++;
    if (pnl > 0) this.winningTrades++;
  }

  private async refreshBalances(): Promise<void> {
    try {
      const address = this.wallet.address;
      this.cachedUsdcBalance = await this.ctf.getUsdcBalance(address);

      const provider = this.wallet.provider;
      if (provider) {
        const balWei = await provider.getBalance(address);
        this.cachedPolBalance = parseFloat(
          (Number(balWei) / 1e18).toFixed(4),
        );
      }
    } catch {
      // Non-fatal — keep showing last known values
    }
  }

  startStrategy(id: StrategyId): void {
    const strategy = this.strategies.get(id);
    if (!strategy) throw new Error(`Strategy ${id} not found`);
    strategy.start();
    emitLog('INFO', `[StrategyRunner] Strategy ${id} started`);
  }

  stopStrategy(id: StrategyId): void {
    const strategy = this.strategies.get(id);
    if (!strategy) return;
    strategy.stop();
    emitLog('INFO', `[StrategyRunner] Strategy ${id} stopped`);
  }

  activateKillSwitch(): void {
    this.stopAll();
    this.risk.activateKillSwitch();

    void this.clob.cancelAllOrders().catch((err) => {
      emitLog('ERROR', `[KillSwitch] CLOB cancel-all failed: ${String(err)}`);
    });
  }

  deactivateKillSwitch(): void {
    this.risk.deactivateKillSwitch();
    emitLog('WARN', '[StrategyRunner] Kill switch deactivated — restart strategies manually');
  }

  updateConfig(id: StrategyId, partial: Partial<StrategyConfig>): void {
    const existing = this.configMap[id];
    this.configMap[id] = { ...existing, ...partial };

    BotWebSocketServer.getInstance().broadcast('CONFIG_UPDATED', {
      strategyId: id,
      config: this.configMap[id],
    });

    emitLog('INFO', `[StrategyRunner] Config updated for ${id}`, partial);
  }

  private broadcastSnapshot(): void {
    const riskState = this.risk.getState();

    const strategyStatuses: Record<string, StrategyStatus> = {};
    const strategyMetrics: Record<string, Record<string, number | string>> = {};

    for (const [id, strategy] of this.strategies) {
      strategyStatuses[id] = strategy.status;
      strategyMetrics[id] = strategy.getMetrics();
    }

    const botState: BotState = {
      strategies: strategyStatuses as Record<StrategyId, StrategyStatus>,
      strategyMetrics: strategyMetrics as Record<StrategyId, Record<string, number | string>>,
      totalPnL: riskState.cumulativePnL,
      realizedPnL: riskState.cumulativePnL,
      unrealizedPnL: 0,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      walletBalanceUsdc: this.cachedUsdcBalance,
      walletBalancePol: this.cachedPolBalance,
      isKillSwitchActive: riskState.killSwitchActive,
      activeOrders: riskState.positionCount,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      lastUpdated: Date.now(),
    };

    BotWebSocketServer.getInstance().broadcast('BOT_STATE_UPDATE', botState);
  }

  getStrategy(id: StrategyId): AnyStrategy | undefined {
    return this.strategies.get(id);
  }

  getConfigMap(): ConfigMap {
    return { ...this.configMap };
  }
}
