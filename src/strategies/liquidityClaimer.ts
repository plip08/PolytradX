import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";

export class LiquidityClaimer implements Strategy {
  public readonly name = "LiquidityClaimer";
  public isEnabled = true;

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    logger.debug("LiquidityClaimer evaluate", { marketId: context.currentState.marketId });
    return null;
  }

  async execute(_decision: StrategyDecision): Promise<StrategyResult> {
    logger.info("LiquidityClaimer execute placeholder");
    return { success: true, message: "LiquidityClaimer placeholder executed." };
  }
}
