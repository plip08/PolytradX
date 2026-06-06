import { describe, expect, it } from "vitest";
import { evaluateAtomicArbitrage } from "../src/strategies/strategyEvaluators.js";

describe("Strategy Evaluators", () => {
  it("returns a decision when atomic arbitrage opportunity exists", () => {
    const state = {
      marketId: "market-1",
      isActive: true,
      yesPrice: 0.3,
      noPrice: 0.3,
      bestBid: { price: 0.3, size: 100 },
      bestAsk: { price: 0.3, size: 100 },
    };

    const decision = evaluateAtomicArbitrage(state as any);
    expect(decision).not.toBeNull();
    expect(decision?.strategyName).toBe("AtomicArbitrage");
    expect(decision?.tradeSizeUsd).toBeGreaterThan(0);
  });

  it("returns null when there is no arbitrage edge", () => {
    const state = {
      marketId: "market-2",
      isActive: true,
      yesPrice: 0.6,
      noPrice: 0.5,
      bestBid: { price: 0.6, size: 100 },
      bestAsk: { price: 0.5, size: 100 },
    };

    expect(evaluateAtomicArbitrage(state as any)).toBeNull();
  });
});
