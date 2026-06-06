import { create } from "zustand";
import type { BotSnapshot, CircuitBreakerState, ExecutionMode, RiskAlert, StrategySnapshot } from "../types";

interface BotStore {
  token: string;
  setToken: (token: string) => void;
  wsConnected: boolean;
  setWsConnected: (connected: boolean) => void;
  executionMode: ExecutionMode;
  setExecutionMode: (mode: ExecutionMode) => void;
  totalBalanceUsd: number;
  circuitBreaker: CircuitBreakerState;
  strategies: StrategySnapshot[];
  recentAlerts: RiskAlert[];
  applySnapshot: (snapshot: BotSnapshot) => void;
}

const defaultCircuitBreaker: CircuitBreakerState = {
  status: "NORMAL",
  haltedUntil: null,
  currentCapitalUsd: 0,
  peakCapitalUsd: 0,
  troughCapitalUsd: 0,
  consecutiveLosses: 0,
  drawdownPct: 0,
};

export const useBotStore = create<BotStore>((set) => ({
  token: "",
  setToken: (token) => set({ token }),
  wsConnected: false,
  setWsConnected: (connected) => set({ wsConnected: connected }),
  executionMode: "LIVE",
  setExecutionMode: (mode) => set({ executionMode: mode }),
  totalBalanceUsd: 0,
  circuitBreaker: defaultCircuitBreaker,
  strategies: [],
  recentAlerts: [],
  applySnapshot: (snapshot) => {
    set({
      executionMode: snapshot.executionMode ?? "LIVE",
      totalBalanceUsd: snapshot.pnl.totalCapitalUsd,
      circuitBreaker: snapshot.circuitBreaker,
      strategies: snapshot.strategies,
      recentAlerts: snapshot.recentAlerts.slice(0, 20),
    });
  },
}));
