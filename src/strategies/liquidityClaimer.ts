import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

export class LiquidityClaimer implements Strategy {
  public readonly name = "LiquidityClaimer";
  public isEnabled = true;

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { orderBook, liquidity, isActive, marketId } = state;

    logger.debug("LiquidityClaimer evaluate", { marketId, liquidity });

    if (!isActive || orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      return null;
    }

    const bestBid = orderBook.bids[0];
    const bestAsk = orderBook.asks[0];
    const spread = bestAsk.price - bestBid.price;
    const spreadPct = spread / bestBid.price;

    // Detect wide spread with low liquidity (inefficient market)
    if (spreadPct > 0.03 && liquidity < 50_000) {
      const midPrice = (bestBid.price + bestAsk.price) / 2;
      const edge = spreadPct / 2;
      const tradeSizeUsd = this.riskManager.sizeTrade(edge, liquidity * 0.1, "liquidityClaimer");

      if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
        return null;
      }

      return {
        marketId,
        expectedEdge: edge,
        tradeSizeUsd,
        type: "BUY",
        side: "BUY",
        limitPriceUsd: midPrice,
        reason: `Wide spread (${(spreadPct * 100).toFixed(2)}%) with low liquidity ($${liquidity.toFixed(0)})`,
      };
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing LiquidityClaimer", { decision });

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
        message: `LiquidityClaimer executed for market ${decision.marketId}`,
      };
    } catch (error) {
      logger.error("LiquidityClaimer execution failed", error);
      return {
        success: false,
        message: `LiquidityClaimer failed: ${(error as Error).message}`,
      };
    }
  }
}
