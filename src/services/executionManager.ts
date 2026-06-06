import { logger } from "../utils/logger.js";
import type { ExecutionEngine } from "./executionEngine.js";
import type { RiskController } from "./riskController.js";
import type { BotState } from "./botState.js";
import type { Strategy, StrategyDecision, StrategyResult } from "../types/strategy.js";

interface ExecutionTask {
  strategy: Strategy;
  decision: StrategyDecision;
  resolve: (result: StrategyResult) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

export class ExecutionManager {
  private readonly executionQueue: ExecutionTask[] = [];
  private isProcessing = false;

  constructor(
    private readonly executionEngine: ExecutionEngine,
    private readonly riskController: RiskController,
    private readonly botState: BotState,
  ) {}

  async executeStrategy(strategy: Strategy, decision: StrategyDecision): Promise<StrategyResult> {
    return new Promise<StrategyResult>((resolve, reject) => {
      const task: ExecutionTask = {
        strategy,
        decision,
        resolve,
        reject,
        createdAt: Date.now(),
      };

      this.executionQueue.push(task);
      this.botState.registerLog("INFO", `${strategy.name}: queued execution task for market ${decision.marketId}`);
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    while (this.executionQueue.length > 0) {
      const task = this.executionQueue.shift()!;
      try {
        const result = await this.executeTask(task.strategy, task.decision);
        task.resolve(result);
      } catch (error) {
        task.reject(error as Error);
      }
    }
    this.isProcessing = false;
  }

  private async executeTask(strategy: Strategy, decision: StrategyDecision): Promise<StrategyResult> {
    const currentExposureUsd = this.botState.getCurrentExposureUsd();
    const marketExposureUsd = this.botState.getExposureForMarket(decision.marketId);

    if (!this.riskController.canExecuteDecision(decision, currentExposureUsd, marketExposureUsd)) {
      const message = "Blocked by risk controller";
      this.botState.registerLog("WARN", `${strategy.name}: ${message}`);
      return { success: false, message };
    }

    this.botState.reportStrategyDecision(strategy.name, {
      state: "EXECUTING",
      lastDecisionAt: Date.now(),
      currentEdge: decision.expectedEdge,
      currentPositionUsd: decision.tradeSizeUsd,
      recentStatus: decision.reason,
    });

    try {
      this.botState.registerLog("INFO", `${strategy.name}: executing decision for market ${decision.marketId}`);
      const result = await strategy.execute(decision);

      if (result.success && result.position) {
        this.botState.registerPosition({
          marketId: result.position.marketId,
          outcome: result.position.outcome,
          side: result.position.side,
          quantityUsd: result.position.quantityUsd,
          avgEntryPriceUsd: result.position.avgEntryPriceUsd,
          markPriceUsd: result.position.markPriceUsd,
          unrealisedPnlUsd: result.position.unrealisedPnlUsd,
          openSinceMs: Date.now(),
          liquidityAvailableUsd: result.position.liquidityAvailableUsd,
        });
      }

      this.botState.reportStrategyExecution(strategy.name, result.success, result.message, {
        currentPositionUsd: decision.tradeSizeUsd,
      });

      this.botState.registerLog(
        result.success ? "INFO" : "WARN",
        `${strategy.name}: ${result.message}`,
      );

      return result;
    } catch (error) {
      const message = `Execution manager failed for ${strategy.name}: ${(error as Error).message}`;
      logger.error(message, error);
      this.botState.registerLog("ERROR", message);
      this.botState.reportStrategyExecution(strategy.name, false, message, {
        state: "ERROR",
      });
      return { success: false, message };
    }
  }

  getQueueLength(): number {
    return this.executionQueue.length;
  }
}
