import { describe, expect, it } from "vitest";
import { BotState } from "../src/services/botState.js";

describe("BotState", () => {
  it("updates strategy enabled state and manages positions", () => {
    const botState = new BotState(["StrategyA"]);
    botState.updateStrategyEnabled("StrategyA", false);
    const snapshot = botState.getStrategySnapshot().find((item) => item.strategyId === "StrategyA");
    expect(snapshot).toBeDefined();
    expect(snapshot?.enabled).toBe(false);

    botState.registerPosition({
      marketId: "m1",
      outcome: "YES",
      side: "BUY",
      quantityUsd: 1500,
      avgEntryPriceUsd: 0.5,
      markPriceUsd: 0.52,
      unrealisedPnlUsd: 30,
      openSinceMs: Date.now(),
      liquidityAvailableUsd: 10000,
    });

    expect(botState.getCurrentExposureUsd()).toBe(1500);
    botState.closePosition("m1", "YES");
    expect(botState.getCurrentExposureUsd()).toBe(0);
  });
});
