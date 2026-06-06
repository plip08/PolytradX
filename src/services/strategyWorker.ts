import { parentPort } from "worker_threads";
import type { MarketState } from "../types/market.js";
import type { StrategyDecision } from "../types/strategy.js";
import { evaluateAtomicArbitrage } from "../strategies/strategyEvaluators.js";

const MAX_DATA_AGE_MS = 2_000;

const port = parentPort;
if (!port) {
  throw new Error("Strategy worker must be executed from a worker thread.");
}

type WorkerRequest = {
  type: "EVALUATE_MARKET_STATES";
  requestId: number;
  states: MarketState[];
};

type WorkerResponse = {
  type: "EVALUATION_RESULT";
  requestId: number;
  decisions: StrategyDecision[];
};

type WorkerErrorResponse = {
  type: "EVALUATION_ERROR";
  requestId: number;
  error: string;
};

port.on("message", async (message: WorkerRequest) => {
  try {
    if (message.type !== "EVALUATE_MARKET_STATES") {
      return;
    }

    const now = Date.now();
    const decisions: StrategyDecision[] = [];

    for (const state of message.states) {
      if (!state.receivedAt || now - state.receivedAt > MAX_DATA_AGE_MS) {
        continue;
      }

      const atomicDecision = evaluateAtomicArbitrage(state);
      if (atomicDecision) {
        decisions.push(atomicDecision);
      }
    }

    const response: WorkerResponse = {
      type: "EVALUATION_RESULT",
      requestId: message.requestId,
      decisions,
    };
    port.postMessage(response);
  } catch (error) {
    const response: WorkerErrorResponse = {
      type: "EVALUATION_ERROR",
      requestId: message.requestId,
      error: (error as Error).message || "Unknown worker evaluation error",
    };
    port.postMessage(response);
  }
});
