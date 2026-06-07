import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

export class NegativeRisk implements Strategy {
  public readonly name = "NegativeRisk";
  public isEnabled = true;

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { marketId, isActive, yesPrice, noPrice, orderBook } = state;

    logger.debug("NegativeRisk evaluate", { marketId, yesPrice, noPrice });

    if (!isActive || !yesPrice || !noPrice) {
      return null;
    }

    const combined = yesPrice + noPrice;

    // Negative risk: when YES + NO < 1.00, buying both is risk-free profit at resolution
    if (combined < 0.97) {
      const edge = 1.0 - combined;
      const tradeSizeUsd = this.riskManager.sizeTrade(edge, 200_000, "negativeRisk");

      if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
        return null;
      }

      return {
        marketId,
        expectedEdge: edge,
        tradeSizeUsd,
        type: "BUY",
        side: "BUY",
        reason: `Negative risk detected: YES (${yesPrice.toFixed(4)}) + NO (${noPrice.toFixed(4)}) = ${combined.toFixed(4)} < 1.00`,
      };
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing NegativeRisk", { decision });

      // Execute both YES and NO positions to lock in risk-free profit
      const halfSize = decision.tradeSizeUsd / 2;

      const yesTxHash = await this.executionEngine.placeOrder({
        marketId: decision.marketId,
        side: "BUY",
        price: 0.5,
        size: halfSize,
        strategyName: this.name,
        expectedEdge: decision.expectedEdge,
        reason: `${decision.reason} (YES side)`,
      });

      const noTxHash = await this.executionEngine.placeOrder({
        marketId: decision.marketId,
        side: "BUY",
        price: 0.5,
        size: halfSize,
        strategyName: this.name,
        expectedEdge: decision.expectedEdge,
        reason: `${decision.reason} (NO side)`,
      });

      return {
        success: true,
        executedTxHash: `${yesTxHash},${noTxHash}`,
        message: `NegativeRisk executed for market ${decision.marketId} (both sides)`,
      };
    } catch (error) {
      logger.error("NegativeRisk execution failed", error);
      return {
        success: false,
        message: `NegativeRisk failed: ${(error as Error).message}`,
      };
    }
  }
}
