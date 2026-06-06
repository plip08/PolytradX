import type { Prisma } from "@prisma/client";

export type StrategyStateLabel = "IDLE" | "SCANNING" | "EXECUTING" | "COOLDOWN" | "ERROR";

export interface StrategySnapshotState {
  strategyId: string;
  enabled: boolean;
  state: StrategyStateLabel;
  lastDecisionAt: number;
  lastExecutionAt?: number;
  currentPositionUsd: number;
  currentEdge?: number;
  recentStatus?: string;
  cooldownRemainingMs?: number;
}

export interface BotPositionEntry {
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  quantityUsd: number;
  avgEntryPriceUsd: number;
  markPriceUsd: number;
  unrealisedPnlUsd: number;
  openSinceMs: number;
  liquidityAvailableUsd?: number;
}

export interface AlertEntry {
  type: "SLIPPAGE" | "LIQUIDITY" | "RPC_FAIL" | "ORDER_FAIL" | "RISK";
  severity: "LOW" | "MEDIUM" | "HIGH";
  message: string;
  timestamp?: number;
  details?: Record<string, unknown>;
}

export type AlertSnapshot = Omit<AlertEntry, "timestamp"> & { timestamp: number };

export class BotState {
  private strategies = new Map<string, StrategySnapshotState>();
  private positions: BotPositionEntry[] = [];
  private alerts: AlertEntry[] = [];
  private logs: Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; timestamp: number }> = [];

  constructor(strategyNames: string[]) {
    for (const strategyName of strategyNames) {
      this.strategies.set(strategyName, {
        strategyId: strategyName,
        enabled: true,
        state: "SCANNING",
        lastDecisionAt: Date.now(),
        currentPositionUsd: 0,
      });
    }
  }

  reportStrategyDecision(strategyId: string, data: Partial<StrategySnapshotState>): void {
    const current = this.strategies.get(strategyId);
    if (!current) {
      return;
    }

    this.strategies.set(strategyId, {
      ...current,
      ...data,
      strategyId,
      lastDecisionAt: data.lastDecisionAt ?? current.lastDecisionAt,
    });
  }

  reportStrategyExecution(strategyId: string, success: boolean, message: string, data?: Partial<StrategySnapshotState>): void {
    const current = this.strategies.get(strategyId);
    if (!current) {
      return;
    }

    this.strategies.set(strategyId, {
      ...current,
      ...data,
      state: success ? "SCANNING" : "ERROR",
      recentStatus: message,
      lastExecutionAt: Date.now(),
    });
  }

  registerPosition(position: BotPositionEntry): void {
    const existingIndex = this.positions.findIndex(
      (entry) => entry.marketId === position.marketId && entry.outcome === position.outcome && entry.side === position.side,
    );
    if (existingIndex >= 0) {
      this.positions[existingIndex] = position;
    } else {
      this.positions.unshift(position);
    }
    if (this.positions.length > 100) {
      this.positions.length = 100;
    }
  }

  closePosition(marketId: string, outcome: string): void {
    this.positions = this.positions.filter((entry) => !(entry.marketId === marketId && entry.outcome === outcome));
  }

  updateStrategyEnabled(strategyId: string, enabled: boolean): void {
    const current = this.strategies.get(strategyId);
    if (!current) {
      return;
    }

    this.strategies.set(strategyId, {
      ...current,
      enabled,
      state: enabled ? "SCANNING" : "IDLE",
      recentStatus: enabled ? "Enabled by command" : "Disabled by command",
      lastDecisionAt: Date.now(),
    });
  }

  registerAlert(alert: AlertEntry): void {
    this.alerts.unshift({ ...alert, timestamp: Date.now() });
    if (this.alerts.length > 100) {
      this.alerts.length = 100;
    }
  }

  getStrategySnapshot(): StrategySnapshotState[] {
    return Array.from(this.strategies.values());
  }

  getPositions(): BotPositionEntry[] {
    return this.positions.slice(0, 25);
  }

  getCurrentExposureUsd(): number {
    return this.positions.reduce((total, position) => total + position.quantityUsd, 0);
  }

  getExposureForMarket(marketId: string): number {
    return this.positions
      .filter((entry) => entry.marketId === marketId)
      .reduce((total, entry) => total + entry.quantityUsd, 0);
  }

  getOpenPositions(): BotPositionEntry[] {
    return [...this.positions];
  }

  registerLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
    this.logs.unshift({ level, message, timestamp: Date.now() });
    if (this.logs.length > 200) {
      this.logs.length = 200;
    }
  }

  getAlerts(): AlertSnapshot[] {
    return this.alerts.slice(0, 25).map((alert) => ({
      ...alert,
      timestamp: alert.timestamp ?? Date.now(),
    }));
  }

  getRecentLogs(): Array<{ level: "INFO" | "WARN" | "ERROR"; message: string; timestamp: number }> {
    return this.logs.slice(0, 25);
  }
}
