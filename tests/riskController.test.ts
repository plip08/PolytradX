import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/services/circuitBreaker.js";
import { RiskController } from "../src/services/riskController.js";
import { RiskManager } from "../src/services/riskManager.js";

const riskController = new RiskController(new CircuitBreaker(), new RiskManager());

const validDecision = {
  marketId: "test-market",
  expectedEdge: 0.01,
  tradeSizeUsd: 1000,
  reason: "Test decision",
  type: "BUY",
  side: "BUY",
};

describe("RiskController", () => {
  it("allows execution for a valid decision", () => {
    expect(riskController.canExecuteDecision(validDecision, 0, 0)).toBe(true);
  });

  it("blocks execution when expected edge is below threshold", () => {
    expect(riskController.canExecuteDecision({ ...validDecision, expectedEdge: 0 }, 0, 0)).toBe(false);
  });

  it("blocks execution when trade size exceeds max order limit", () => {
    expect(riskController.canExecuteDecision({ ...validDecision, tradeSizeUsd: 9999999 }, 0, 0)).toBe(false);
  });

  it("blocks execution when market position would exceed max market position", () => {
    expect(riskController.canExecuteDecision(validDecision, 0, 1000000000)).toBe(false);
  });
});
