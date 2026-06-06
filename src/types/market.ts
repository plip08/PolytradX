export type MarketTag = "YES" | "NO" | "MULTI" | "UNKNOWN";

export interface PriceLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

export interface MarketState {
  marketId: string;
  outcome: MarketTag;
  bestBid?: PriceLevel;
  bestAsk?: PriceLevel;
  midPrice?: number;
  liquidity: number;
  yesPrice?: number;
  noPrice?: number;
  openInterest: number;
  resolution: number | null;
  isActive: boolean;
  lastUpdate: number;
  receivedAt: number;
  orderBook: OrderBookSnapshot;
}
