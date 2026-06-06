import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/services/circuitBreaker.js";

const createOutcome = (lossUsd: number) => ({
  profitUsd: 0,
  lossUsd,
  timestamp: Date.now(),
  strategyId: "test-strategy",
  marketId: "test-market",
  reason: "test loss",
});

describe("CircuitBreaker", () => {
  it("blocks execution after a single trade that exceeds max single loss", () => {
    const circuitBreaker = new CircuitBreaker();
    circuitBreaker.registerTradeOutcome(createOutcome(999999));
    expect(circuitBreaker.canExecute()).toBe(false);
  });

  it("resets and allows execution after reset", () => {
    const circuitBreaker = new CircuitBreaker();
    circuitBreaker.registerTradeOutcome(createOutcome(999999));
    circuitBreaker.reset();
    expect(circuitBreaker.canExecute()).toBe(true);
  });
});
