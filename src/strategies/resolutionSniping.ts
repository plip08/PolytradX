import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

export class ResolutionSniping implements Strategy {
  public readonly name = "ResolutionSniping";
  public isEnabled = true;
  private readonly resolutionWindowMs = 5 * 60 * 1000; // 5 minutes before resolution

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { marketId, isActive, resolution, yesPrice, noPrice, receivedAt } = state;

    logger.debug("ResolutionSniping evaluate", { marketId, resolution, isActive });

    if (!isActive || resolution === null || !yesPrice || !noPrice) {
      return null;
    }

    const now = receivedAt;
    const timeUntilResolution = resolution - now;

    // Check if we're within the sniping window before resolution
    if (timeUntilResolution > 0 && timeUntilResolution < this.resolutionWindowMs) {
      // Look for mispriced markets close to resolution
      const expectedOutcome = yesPrice > noPrice ? "YES" : "NO";
      const confidence = Math.max(yesPrice, noPrice);

      // Only snipe if there's high confidence (>90%) but price isn't at ceiling
      if (confidence > 0.90 && confidence < 0.98) {
        const edge = 0.99 - confidence;
        const tradeSizeUsd = this.riskManager.sizeTrade(edge, 100_000, "resolutionSniping");

        if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
          return null;
        }

        const side = expectedOutcome === "YES" ? "BUY" : "SELL";

        return {
          marketId,
          expectedEdge: edge,
          tradeSizeUsd,
          type: side,
          side,
          limitPriceUsd: confidence,
          reason: `Resolution sniping: ${(timeUntilResolution / 1000).toFixed(0)}s until resolution, ${expectedOutcome} at ${(confidence * 100).toFixed(1)}%`,
        };
      }
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing ResolutionSniping", { decision });

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
        message: `ResolutionSniping executed for market ${decision.marketId}`,
      };
    } catch (error) {
      logger.error("ResolutionSniping execution failed", error);
      return {
        success: false,
        message: `ResolutionSniping failed: ${(error as Error).message}`,
      };
    }
  }
}
