import { logger } from "../utils/logger.js";
import type { MarketState } from "../types/market.js";
import { PolymarketClient } from "../integrations/polymarketClient.js";

export class MarketScanner {
  private stateByMarket = new Map<string, MarketState>();

  constructor(private readonly client: PolymarketClient) {}

  getMarketState(marketId: string): MarketState | undefined {
    return this.stateByMarket.get(marketId);
  }

  getAllStates(): MarketState[] {
    return Array.from(this.stateByMarket.values());
  }

  async start(onStateUpdate: (state: MarketState) => void): Promise<void> {
    await this.client.subscribeMarketUpdates((state) => {
      const receivedAt = state.receivedAt ?? Date.now();
      const stateWithReceivedAt = { ...state, receivedAt };
      const current = this.stateByMarket.get(stateWithReceivedAt.marketId);
      if (current && stateWithReceivedAt.receivedAt <= current.receivedAt) {
        return;
      }

      this.stateByMarket.set(stateWithReceivedAt.marketId, stateWithReceivedAt);
      onStateUpdate(stateWithReceivedAt);
    });
  }
}
