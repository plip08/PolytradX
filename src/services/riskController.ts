import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { RiskManager } from "./riskManager.js";
import type { StrategyDecision } from "../types/strategy.js";

export class RiskController {
  constructor(private readonly circuitBreaker: CircuitBreaker, private readonly riskManager: RiskManager) {}

  canExecuteDecision(
    decision: StrategyDecision,
    currentExposureUsd = 0,
    marketExposureUsd = 0,
  ): boolean {
    if (!this.circuitBreaker.canExecute()) {
      logger.warn("RiskController blocked execution: circuit breaker open", {
        strategyDecision: decision,
        currentExposureUsd,
        marketExposureUsd,
      });
      return false;
    }

    if (!this.riskManager.validateTradeSize(decision.tradeSizeUsd)) {
      logger.warn("RiskController blocked execution: invalid trade size", { decision });
      return false;
    }

    if (decision.expectedEdge < config.minStrategyEdgePct) {
      logger.warn("RiskController blocked execution: expected edge below threshold", {
        decision,
        minStrategyEdgePct: config.minStrategyEdgePct,
      });
      return false;
    }

    if (decision.tradeSizeUsd > config.maxOrderUsd) {
      logger.warn("RiskController blocked execution: trade size exceeds max order limit", {
        decision,
        maxOrderUsd: config.maxOrderUsd,
      });
      return false;
    }

    if (marketExposureUsd + decision.tradeSizeUsd > config.maxMarketPositionUsd) {
      logger.warn("RiskController blocked execution: market position limit exceeded", {
        decision,
        marketExposureUsd,
        maxMarketPositionUsd: config.maxMarketPositionUsd,
      });
      return false;
    }

    const maxPositionUsd = config.maxPositionUsd;
    if (currentExposureUsd + decision.tradeSizeUsd > maxPositionUsd) {
      logger.warn("RiskController blocked execution: exposure limit exceeded", {
        decision,
        currentExposureUsd,
        maxPositionUsd,
      });
      return false;
    }

    return true;
  }
}
