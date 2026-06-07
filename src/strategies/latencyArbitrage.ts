import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";
import { config } from "../config/env.js";

export class LatencyArbitrage implements Strategy {
  public readonly name = "LatencyArbitrage";
  public isEnabled = true;
  private previousStates = new Map<string, MarketState>();

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { marketId, isActive, receivedAt, lastUpdate, midPrice } = state;

    logger.debug("LatencyArbitrage evaluate", { marketId, receivedAt, lastUpdate });

    if (!isActive || !midPrice) {
      return null;
    }

    const previous = this.previousStates.get(marketId);
    this.previousStates.set(marketId, state);

    if (!previous || !previous.midPrice) {
      return null;
    }

    const timeDelta = receivedAt - previous.receivedAt;
    const priceDelta = Math.abs(midPrice - previous.midPrice);
    const priceChangePct = priceDelta / previous.midPrice;

    // Detect stale data (delayed price update) + significant price movement
    const staleThreshold = config.marketDataStaleThresholdMs ?? 2000;
    if (timeDelta > staleThreshold && priceChangePct > 0.02) {
      const edge = priceChangePct * 0.5;
      const tradeSizeUsd = this.riskManager.sizeTrade(edge, 100_000, "latencyArbitrage");

      if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
        return null;
      }

      const side = midPrice > previous.midPrice ? "SELL" : "BUY";

      return {
        marketId,
        expectedEdge: edge,
        tradeSizeUsd,
        type: side,
        side,
        limitPriceUsd: midPrice,
        reason: `Latency arbitrage: ${(priceChangePct * 100).toFixed(2)}% price change over ${timeDelta}ms`,
      };
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing LatencyArbitrage", { decision });

      const txHash = await this.executionEngine.placeOrder({
        marketId: decision.marketId,
        side: decision.side === "BUY" ? "BUY" : "SELL",
        price: decision.limitPriceUsd ?? 0,
        size: decision.tradeSizeUsd,
        strategyName: this.name,
        expectedEdge: decision.expectedEdge,
        reason: decision.reason,
      });

      return {
        success: true,
        executedTxHash: txHash,
        message: `LatencyArbitrage executed for market ${decision.marketId}`,
      };
    } catch (error) {
      logger.error("LatencyArbitrage execution failed", error);
      return {
        success: false,
        message: `LatencyArbitrage failed: ${(error as Error).message}`,
      };
    }
  }
}
