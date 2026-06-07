import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

interface AISignal {
  marketId: string;
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;
  targetPrice: number;
  reasoning: string;
}

export class AiAgentConnector implements Strategy {
  public readonly name = "AiAgentConnector";
  public isEnabled = false; // Disabled by default until AI agent is configured
  private aiSignals = new Map<string, AISignal>();

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  /**
   * This method should be called by an external AI agent to provide trading signals
   */
  public updateAISignal(signal: AISignal): void {
    this.aiSignals.set(signal.marketId, signal);
    logger.info("AI signal updated", { marketId: signal.marketId, recommendation: signal.recommendation });
  }

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const { marketId, isActive, midPrice } = state;

    logger.debug("AiAgentConnector evaluate", { marketId });

    if (!isActive || !midPrice) {
      return null;
    }

    const aiSignal = this.aiSignals.get(marketId);

    if (!aiSignal || aiSignal.recommendation === "HOLD") {
      return null;
    }

    // AI must have high confidence (>75%) to trigger a trade
    if (aiSignal.confidence < 0.75) {
      return null;
    }

    const priceDivergence = Math.abs(midPrice - aiSignal.targetPrice) / aiSignal.targetPrice;
    const edge = priceDivergence * aiSignal.confidence;
    const tradeSizeUsd = this.riskManager.sizeTrade(edge, 75_000, "aiAgentConnector");

    if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
      return null;
    }

    return {
      marketId,
      expectedEdge: edge,
      tradeSizeUsd,
      type: aiSignal.recommendation,
      side: aiSignal.recommendation,
      limitPriceUsd: aiSignal.targetPrice,
      reason: `AI Signal (${(aiSignal.confidence * 100).toFixed(0)}% confidence): ${aiSignal.reasoning}`,
    };
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      logger.info("Executing AiAgentConnector", { decision });

      const txHash = await this.executionEngine.placeOrder({
        marketId: decision.marketId,
        side: decision.side === "BUY" ? "BUY" : "SELL",
        price: decision.limitPriceUsd ?? 0,
        size: decision.tradeSizeUsd,
        strategyName: this.name,
        expectedEdge: decision.expectedEdge,
        reason: decision.reason,
      });

      // Clear the signal after execution
      this.aiSignals.delete(decision.marketId);

      return {
        success: true,
        executedTxHash: txHash,
        message: `AiAgentConnector executed for market ${decision.marketId}`,
      };
    } catch (error) {
      logger.error("AiAgentConnector execution failed", error);
      return {
        success: false,
        message: `AiAgentConnector failed: ${(error as Error).message}`,
      };
    }
  }
}
