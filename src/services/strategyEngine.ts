import type { Strategy } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import type { BotState } from "./botState.js";
import type { ExecutionManager } from "./executionManager.js";
import type { StrategyWorkerManager } from "./strategyWorkerManager.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/env.js";
import type { StrategyDecision } from "../types/strategy.js";

export class StrategyEngine {
  constructor(
    private readonly strategies: Strategy[],
    private readonly executionManager: ExecutionManager,
    private readonly botState: BotState,
    private readonly strategyWorkerManager?: StrategyWorkerManager,
  ) {}

  async processMarketStates(states: MarketState[]): Promise<void> {
    if (!states?.length) {
      return;
    }

    const freshStates = states.filter((state) => {
      if (!state.receivedAt || Date.now() - state.receivedAt > config.marketDataStaleThresholdMs) {
        logger.warn("Skipping stale market state", {
          marketId: state.marketId,
          receivedAt: state.receivedAt,
          ageMs: Date.now() - (state.receivedAt ?? 0),
          thresholdMs: config.marketDataStaleThresholdMs,
        });
        return false;
      }
      return true;
    });

    if (freshStates.length === 0) {
      return;
    }

    if (this.strategyWorkerManager) {
      await this.evaluateUsingWorker(freshStates);
      return;
    }

    await Promise.all(freshStates.map((state) => this.processMarketStateInline(state)));
  }

  private async evaluateUsingWorker(states: MarketState[]): Promise<void> {
    let decisions: StrategyDecision[] = [];
    try {
      decisions = await this.strategyWorkerManager!.evaluateMarketStates(states);
    } catch (error) {
      logger.error("Strategy worker evaluation failed", error);
      await Promise.all(states.map((state) => this.processMarketStateInline(state)));
      return;
    }

    for (const decision of decisions) {
      if (!decision.strategyName) {
        logger.warn("Worker returned decision without strategyName", { decision });
        continue;
      }

      const strategy = this.strategies.find((strategyEntry) => strategyEntry.name === decision.strategyName);
      if (!strategy) {
        logger.warn("No local strategy instance matched worker decision", { strategyName: decision.strategyName, decision });
        continue;
      }

      await this.executeDecision(strategy, decision);
    }
  }

  private async processMarketStateInline(state: MarketState): Promise<void> {
    const enabledStrategies = this.strategies.filter((strategy) => strategy.isEnabled);

    for (const strategy of enabledStrategies) {
      try {
        const decision = await strategy.evaluate({ currentState: state });
        if (!decision) {
          this.botState.reportStrategyDecision(strategy.name, {
            state: "SCANNING",
            lastDecisionAt: Date.now(),
            recentStatus: "Scanning market",
          });
          continue;
        }

        await this.executeDecision(strategy, decision);
      } catch (error) {
        logger.error("Strategy engine error", { strategy: strategy.name, error });
        this.botState.reportStrategyExecution(strategy.name, false, "Strategy evaluation failed", {
          state: "ERROR",
        });
      }
    }
  }

  private async executeDecision(strategy: Strategy, decision: StrategyDecision): Promise<void> {
    if (!this.executionManager) {
      const message = "Execution manager unavailable";
      logger.error(message);
      return;
    }

    const result = await this.executionManager.executeStrategy(strategy, decision);
    this.botState.reportStrategyExecution(strategy.name, result.success, result.message, {
      currentPositionUsd: decision.tradeSizeUsd,
    });
  }
}
