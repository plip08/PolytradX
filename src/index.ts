import { logger } from "./utils/logger.js";
import { config, validateAppConfig } from "./config/env.js";
import { validateSecurityConfig } from "./api/auth.js";
import { RpcProviderManager } from "./integrations/rpcProvider.js";
import { PolymarketClient } from "./integrations/polymarketClient.js";
import { MarketScanner } from "./services/marketScanner.js";
import { MarketDataCache } from "./services/marketDataCache.js";
import { DataStore } from "./services/dataStore.js";
import { RiskManager } from "./services/riskManager.js";
import { ExecutionEngine } from "./services/executionEngine.js";
import { ExecutionManager } from "./services/executionManager.js";
import { StrategyEngine } from "./services/strategyEngine.js";
import { StrategyDispatcher } from "./services/strategyDispatcher.js";
import { StrategyWorkerManager } from "./services/strategyWorkerManager.js";
import { MarketRiskMonitor } from "./services/marketRiskMonitor.js";
import { RiskDecisionEngine } from "./services/riskDecisionEngine.js";
import { BotState } from "./services/botState.js";
import { AtomicArbitrage } from "./strategies/atomicArbitrage.js";
import { LiquidityClaimer } from "./strategies/liquidityClaimer.js";
import { LatencyArbitrage } from "./strategies/latencyArbitrage.js";
import { LogicArbitrage } from "./strategies/logicArbitrage.js";
import { NegativeRisk } from "./strategies/negativeRisk.js";
import { ResolutionSniping } from "./strategies/resolutionSniping.js";
import { OracleMonitoring } from "./strategies/oracleMonitoring.js";
import { AiAgentConnector } from "./strategies/aiAgentConnector.js";
import type { MarketState } from "./types/market.js";

async function bootstrap(): Promise<void> {
  validateAppConfig();
  validateSecurityConfig();
  logger.info("Initializing Polymarket Quant Bot...");
  logger.info("RPC endpoints", config.rpcUrls);

  const marketDataCache = new MarketDataCache();
  const rpcProvider = new RpcProviderManager();
  const polymarketClient = new PolymarketClient(config.polymarketApiKey);
  const scanner = new MarketScanner(polymarketClient);
  const dataStore = new DataStore();
  await dataStore.connect();
  const riskManager = new RiskManager();
  const circuitBreaker = new (await import("./services/circuitBreaker.js")).CircuitBreaker();
  const riskController = new (await import("./services/riskController.js")).RiskController(circuitBreaker, riskManager);
  const riskDecisionEngine = new RiskDecisionEngine({
    spreadThresholdPct: 0.05,
    volatilityThresholdPct: 0.15,
    liquidityDropThresholdPct: 0.4,
    orderBookDepthThresholdPct: 0.25,
    staleMarketMs: 30_000,
  });
  const executionEngine = new ExecutionEngine(rpcProvider, circuitBreaker);

  const strategies = [
    new AtomicArbitrage(executionEngine, riskManager),
    new LiquidityClaimer(executionEngine, riskManager),
    new LatencyArbitrage(executionEngine, riskManager),
    new LogicArbitrage(executionEngine, riskManager),
    new NegativeRisk(executionEngine, riskManager),
    new ResolutionSniping(executionEngine, riskManager),
    new OracleMonitoring(executionEngine, riskManager),
    new AiAgentConnector(executionEngine, riskManager),
  ];

  const botState = new BotState(strategies.map((strategy) => strategy.name));
  const executionManager = new ExecutionManager(executionEngine, riskController, botState);
  const strategyWorkerManager = new StrategyWorkerManager();
  const strategyEngine = new StrategyEngine(strategies, executionManager, botState, strategyWorkerManager);

  const marketRiskMonitor = new MarketRiskMonitor(riskDecisionEngine, botState);

  const dispatcher = new StrategyDispatcher(
    strategyEngine,
    () => marketDataCache.getAllStates(),
    1,
  );

  const commandConsumer = new (await import("./services/botCommandConsumer.js")).BotCommandConsumer(
    strategies,
    () => marketDataCache.getAllStates(),
    circuitBreaker,
    botState,
  );

  const autonomousProducer = new (await import("./services/autonomousCommandProducer.js")).AutonomousCommandProducer(
    strategies.map((strategy) => strategy.name),
  );

  await scanner.start(async (state) => {
    marketDataCache.updateState(state);
    await dataStore.cacheMarketState(state);
    await marketRiskMonitor.onMarketUpdate(state);
  });

  marketRiskMonitor.start();
  await commandConsumer.start();
  autonomousProducer.start();
  dispatcher.start();

  process.on("SIGINT", async () => {
    logger.info("Shutdown requested, stopping bot.");
    dispatcher.stop();
    await commandConsumer.stop();
    process.exit(0);
  });
}

bootstrap().catch((error) => {
  logger.error("Bootstrap failed", error);
  process.exit(1);
});
