import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";

export class MarketDataCache {
  private readonly stateByMarket = new Map<string, MarketState>();

  updateState(state: MarketState): void {
    this.stateByMarket.set(state.marketId, state);
    logger.debug("MarketDataCache updated", { marketId: state.marketId, lastUpdate: state.lastUpdate, receivedAt: state.receivedAt });
  }

  isFresh(state: MarketState, maxAgeMs: number): boolean {
    return Date.now() - state.receivedAt <= maxAgeMs;
  }

  getState(marketId: string): MarketState | undefined {
    return this.stateByMarket.get(marketId);
  }

  getAllStates(): MarketState[] {
    return Array.from(this.stateByMarket.values());
  }

  getMarketIds(): string[] {
    return Array.from(this.stateByMarket.keys());
  }

  clear(): void {
    this.stateByMarket.clear();
    logger.info("MarketDataCache cleared");
  }
}
