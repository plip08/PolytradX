import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

export class OracleMonitoring implements Strategy {
  public readonly name = "OracleMonitoring";
  public isEnabled = true;
  private oracleStates = new Map<string, { lastCheck: number; oraclePrice?: number }>();

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { marketId, isActive, midPrice, resolution, receivedAt } = state;

    logger.debug("OracleMonitoring evaluate", { marketId, resolution });

    if (!isActive || !midPrice || resolution === null) {
      return null;
    }

    // Simulate oracle monitoring - in production, this would fetch real oracle data
    const oracleState = this.oracleStates.get(marketId);
    const now = receivedAt;

    if (!oracleState || now - oracleState.lastCheck > 60_000) {
      // Update oracle check timestamp
      this.oracleStates.set(marketId, { lastCheck: now, oraclePrice: midPrice });
      return null;
    }

    // Check if oracle price diverges from market price
    if (oracleState.oraclePrice) {
      const priceDivergence = Math.abs(midPrice - oracleState.oraclePrice);
      const divergencePct = priceDivergence / oracleState.oraclePrice;

      // If market price diverges significantly from oracle, arbitrage opportunity
      if (divergencePct > 0.05) {
        const edge = divergencePct * 0.5;
        const tradeSizeUsd = this.riskManager.sizeTrade(edge, 150_000, "oracleMonitoring");

        if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
          return null;
        }

        const side = midPrice < oracleState.oraclePrice ? "BUY" : "SELL";

        return {
          marketId,
          expectedEdge: edge,
          tradeSizeUsd,
          type: side,
          side,
          limitPriceUsd: midPrice,
          reason: `Oracle divergence: market ${(midPrice * 100).toFixed(1)}% vs oracle ${(oracleState.oraclePrice * 100).toFixed(1)}%`,
        };
      }
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing OracleMonitoring", { decision });

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
        message: `OracleMonitoring executed for market ${decision.marketId}`,
      };
    } catch (error) {
      logger.error("OracleMonitoring execution failed", error);
      return {
        success: false,
        message: `OracleMonitoring failed: ${(error as Error).message}`,
      };
    }
  }
}
