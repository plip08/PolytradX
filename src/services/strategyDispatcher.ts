import { logger } from "../utils/logger.js";
import type { MarketState } from "../types/market.js";
import type { StrategyEngine } from "./strategyEngine.js";

export class StrategyDispatcher {
  private isRunning = false;

  constructor(
    private readonly strategyEngine: StrategyEngine,
    private readonly getMarketStates: () => MarketState[],
    private readonly cycleMs = 1,
  ) {}

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    const loop = async (): Promise<void> => {
      if (!this.isRunning) {
        return;
      }

      const states = this.getMarketStates();
      try {
        await this.strategyEngine.processMarketStates(states);
      } catch (error) {
        logger.error("Strategy dispatcher loop failed", { error });
      }

      setTimeout(loop, this.cycleMs);
    };

    void loop();
  }

  stop(): void {
    this.isRunning = false;
    logger.info("Strategy dispatcher stopped.");
  }
}
