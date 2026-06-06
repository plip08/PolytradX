export type ExecutionMode = "LIVE" | "DRY_RUN";

export type CircuitBreakerStatus = "NORMAL" | "WARNING" | "BLOCKED";

export interface CircuitBreakerState {
  status: CircuitBreakerStatus;
  haltedUntil: number | null;
  currentCapitalUsd: number;
  peakCapitalUsd: number;
  troughCapitalUsd: number;
  consecutiveLosses: number;
  drawdownPct: number;
}

export interface RiskAlert {
  type: "SLIPPAGE" | "LIQUIDITY" | "RPC_FAIL" | "ORDER_FAIL" | "RISK";
  severity: "LOW" | "MEDIUM" | "HIGH";
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface StrategySnapshot {
  strategyId: string;
  enabled: boolean;
  state: "IDLE" | "SCANNING" | "EXECUTING" | "COOLDOWN" | "ERROR";
  lastDecisionAt: number;
  lastExecutionAt?: number;
  currentPositionUsd: number;
  currentEdge?: number;
  recentStatus?: string;
  cooldownRemainingMs?: number;
  allocationPct?: number;
  pnlUsd?: number;
}

export interface BotSnapshot {
  snapshotId: string;
  timestamp: number;
  botVersion: string;
  uptimeMs: number;
  health: {
    polygonConnection: "CONNECTED" | "DEGRADED" | "DISCONNECTED";
    redisConnection: "CONNECTED" | "DISCONNECTED";
    postgresConnection: "CONNECTED" | "DISCONNECTED";
    lastErrorAt?: number;
  };
  pnl: {
    sessionPnLUsd: number;
    realisedPnLUsd: number;
    unrealisedPnLUsd: number;
    totalCapitalUsd: number;
    availableUsd: number;
  };
  circuitBreaker: CircuitBreakerState;
  strategies: StrategySnapshot[];
  recentAlerts: RiskAlert[];
  executionMode?: ExecutionMode;
}
