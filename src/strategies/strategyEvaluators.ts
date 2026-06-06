import { config } from "../config/env.js";
import type { MarketState } from "../types/market.js";
import type { StrategyDecision } from "../types/strategy.js";

function estimateKellyFraction(edge: number): number {
  return Math.max(0, Math.min(edge, 1));
}

function allocateBudget(strategyKey: keyof typeof config.riskAllocation, capitalUsd: number) {
  const allocationPct = config.riskAllocation[strategyKey] ?? 0;
  const targetUsd = capitalUsd * allocationPct;
  const maximumUsd = targetUsd * 1.5;
  return { targetUsd, maximumUsd };
}

export function sizeTrade(decisionEdge: number, capitalUsd: number, strategyKey: keyof typeof config.riskAllocation): number {
  const profile = allocateBudget(strategyKey, capitalUsd);
  const rawKelly = estimateKellyFraction(decisionEdge);
  return Math.min(profile.maximumUsd, Math.max(0, profile.targetUsd * rawKelly));
}

export function validateTradeSize(tradeUsd: number): boolean {
  return tradeUsd > 0 && Number.isFinite(tradeUsd);
}

export function evaluateAtomicArbitrage(state: MarketState): StrategyDecision | null {
  const yesPrice = state.yesPrice ?? state.bestBid?.price ?? 0;
  const noPrice = state.noPrice ?? state.bestAsk?.price ?? 0;
  const combined = yesPrice + noPrice;

  if (!state.isActive || combined <= 0 || combined >= 0.98) {
    return null;
  }

  const edge = 0.98 - combined;
  const tradeSizeUsd = sizeTrade(edge, config.initialCapitalUsd, "atomicArbitrage");
  if (!validateTradeSize(tradeSizeUsd)) {
    return null;
  }

  return {
    strategyName: "AtomicArbitrage",
    marketId: state.marketId,
    expectedEdge: edge,
    tradeSizeUsd,
    reason: `YES + NO arbitrage detected at ${combined.toFixed(4)} (edge ${edge.toFixed(6)})`,
  };
}
