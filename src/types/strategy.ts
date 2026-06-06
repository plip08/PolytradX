import type { MarketState } from "./market.js";

export interface StrategyDecision {
  strategyName?: string;
  marketId: string;
  expectedEdge: number;
  tradeSizeUsd: number;
  reason: string;
  type?: "BUY" | "SELL" | "HEDGE" | "CLOSE" | "NONE";
  side?: "BUY" | "SELL" | "MERGE" | "UNKNOWN";
  limitPriceUsd?: number;
  maxSlippagePct?: number;
}

export interface StrategyContext {
  currentState: MarketState;
}

export interface StrategyResult {
  success: boolean;
  executedTxHash?: string;
  message: string;
  position?: {
    marketId: string;
    outcome: string;
    side: "BUY" | "SELL";
    quantityUsd: number;
    avgEntryPriceUsd: number;
    markPriceUsd: number;
    unrealisedPnlUsd: number;
    liquidityAvailableUsd?: number;
  };
}

export interface Strategy {
  name: string;
  isEnabled: boolean;
  evaluate(context: StrategyContext): Promise<StrategyDecision | null>;
  execute(decision: StrategyDecision): Promise<StrategyResult>;
}
