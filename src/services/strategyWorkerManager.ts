import { Worker } from "worker_threads";
import { logger } from "../utils/logger.js";
import type { MarketState } from "../types/market.js";
import type { StrategyDecision } from "../types/strategy.js";

interface PendingRequest {
  resolve: (decisions: StrategyDecision[]) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

interface WorkerMessage {
  type: "EVALUATION_RESULT";
  requestId: number;
  decisions: StrategyDecision[];
}

interface WorkerErrorMessage {
  type: "EVALUATION_ERROR";
  requestId: number;
  error: string;
}

export class StrategyWorkerManager {
  private worker: Worker;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker = new Worker(new URL("./strategyWorker.ts", import.meta.url) as unknown as string, {
      // WorkerOptions typing may not include "module" in this environment.
      // The runtime should still accept it when using ESM worker files.
      type: "module",
    } as any);

    this.worker.on("message", (message: WorkerMessage | WorkerErrorMessage) => {
      if (message.type === "EVALUATION_RESULT") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          pending.resolve(message.decisions);
          this.pending.delete(message.requestId);
        }
      } else if (message.type === "EVALUATION_ERROR") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          pending.reject(new Error(message.error));
          this.pending.delete(message.requestId);
        }
      }
    });

    this.worker.on("error", (error) => {
      logger.error("Strategy worker encountered an error", error);
      for (const pending of this.pending.values()) {
        pending.reject(error as Error);
      }
      this.pending.clear();
    });

    this.worker.on("exit", (code) => {
      logger.warn("Strategy worker exited", { code });
      if (code !== 0) {
        logger.error("Strategy worker stopped unexpectedly and needs restart.");
      }
    });
  }

  async evaluateMarketStates(states: MarketState[]): Promise<StrategyDecision[]> {
    const requestId = this.requestId++;
    return new Promise<StrategyDecision[]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, createdAt: Date.now() });
      this.worker.postMessage({ type: "EVALUATE_MARKET_STATES", requestId, states });
    });
  }

  async shutdown(): Promise<void> {
    await this.worker.terminate();
  }
}
