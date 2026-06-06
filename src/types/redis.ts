export interface BotCommand {
  commandId: string;
  action:
    | "ENABLE_STRATEGY"
    | "DISABLE_STRATEGY"
    | "SET_STRATEGY_CONFIG"
    | "EMERGENCY_STOP"
    | "EMERGENCY_CLOSE_POSITION"
    | "RESUME_ALL"
    | "FORCE_REBALANCE"
    | "PAUSE_STRATEGY";
  strategyId: string;
  payload: Record<string, unknown>;
  userId: string;
  source: "api" | "system" | "scheduler";
  timestamp: number;
  correlationId?: string;
  priority?: "HIGH" | "NORMAL" | "LOW";
  signatureInterne?: string;
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
  strategies: Array<{
    strategyId: string;
    enabled: boolean;
    state: "IDLE" | "SCANNING" | "EXECUTING" | "COOLDOWN" | "ERROR";
    lastDecisionAt: number;
    lastExecutionAt?: number;
    currentPositionUsd: number;
    currentEdge?: number;
    recentStatus?: string;
    cooldownRemainingMs?: number;
  }>;
  positions: Array<{
    marketId: string;
    outcome: string;
    side: "BUY" | "SELL";
    quantityUsd: number;
    avgEntryPriceUsd: number;
    markPriceUsd: number;
    unrealisedPnlUsd: number;
    openSinceMs: number;
    liquidityAvailableUsd?: number;
  }>;
  recentLogs: Array<{
    level: "INFO" | "WARN" | "ERROR";
    code?: string;
    message: string;
    timestamp: number;
  }>;
  alerts: Array<{
    type: "SLIPPAGE" | "LIQUIDITY" | "RPC_FAIL" | "ORDER_FAIL" | "RISK";
    severity: "LOW" | "MEDIUM" | "HIGH";
    message: string;
    timestamp: number;
  }>;
  circuitBreaker: {
    isHalted: boolean;
    haltedUntil: number | null;
    currentCapitalUsd: number;
    peakCapitalUsd: number;
    troughCapitalUsd: number;
    consecutiveLosses: number;
    drawdownPct: number;
  };
}

export interface RedisLockValue {
  ownerId: string;
  strategyId: string;
  marketId: string;
  commandId?: string;
  txHashCandidate?: string;
  acquiredAt: number;
  expiresAt: number;
}
