import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TradeOutcome {
  profitUsd: number;
  lossUsd: number;
  timestamp: number;
  strategyId?: string;
  marketId?: string;
  reason?: string;
}

export class CircuitBreaker {
  private consecutiveLosses = 0;
  private peakCapitalUsd = config.initialCapitalUsd;
  private troughCapitalUsd = config.initialCapitalUsd;
  private currentCapitalUsd = config.initialCapitalUsd;
  private haltedUntil: number | null = null;
  private dailyLossUsd = 0;
  private lastLossWindowStart = Date.now();
  private lastOpenReason: string | null = null;

  canExecute(): boolean {
    if (this.haltedUntil && Date.now() < this.haltedUntil) {
      logger.warn("Circuit breaker open, execution blocked", {
        haltedUntil: new Date(this.haltedUntil).toISOString(),
        currentCapitalUsd: this.currentCapitalUsd,
        consecutiveLosses: this.consecutiveLosses,
        dailyLossUsd: this.dailyLossUsd,
        lastOpenReason: this.lastOpenReason,
      });
      return false;
    }

    return true;
  }

  registerTradeOutcome(outcome: TradeOutcome): void {
    const now = Date.now();
    if (now - this.lastLossWindowStart > config.circuitBreakerLossWindowMs) {
      this.dailyLossUsd = 0;
      this.lastLossWindowStart = now;
    }

    const netPnl = outcome.profitUsd - outcome.lossUsd;
    if (netPnl < 0) {
      this.dailyLossUsd += Math.abs(netPnl);
    }

    this.currentCapitalUsd += netPnl;
    this.peakCapitalUsd = Math.max(this.peakCapitalUsd, this.currentCapitalUsd);
    this.troughCapitalUsd = Math.min(this.troughCapitalUsd, this.currentCapitalUsd);

    if (netPnl < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }

    const drawdown = (this.peakCapitalUsd - this.currentCapitalUsd) / Math.max(this.peakCapitalUsd, 1e-6);
    const maxDrawdownReached = drawdown >= config.maxDrawdownPct;
    const maxLossesReached = this.consecutiveLosses >= config.maxConsecutiveLosses;
    const maxDailyLossReached = this.dailyLossUsd >= config.maxDailyLossUsd;
    const maxSingleLossReached = outcome.lossUsd >= config.maxSingleLossUsd;

    if (maxDrawdownReached || maxLossesReached || maxDailyLossReached || maxSingleLossReached) {
      this.haltedUntil = Date.now() + config.circuitBreakerCooldownMs;
      this.lastOpenReason = this.buildOpenReason({
        drawdown,
        maxDrawdownReached,
        maxLossesReached,
        maxDailyLossReached,
        maxSingleLossReached,
        outcome,
      });

      logger.error("Circuit breaker triggered", {
        drawdown,
        consecutiveLosses: this.consecutiveLosses,
        dailyLossUsd: this.dailyLossUsd,
        haltedUntil: new Date(this.haltedUntil).toISOString(),
        strategyId: outcome.strategyId,
        marketId: outcome.marketId,
        reason: outcome.reason,
        openReason: this.lastOpenReason,
      });
    }
  }

  private buildOpenReason(context: {
    drawdown: number;
    maxDrawdownReached: boolean;
    maxLossesReached: boolean;
    maxDailyLossReached: boolean;
    maxSingleLossReached: boolean;
    outcome: TradeOutcome;
  }): string {
    const reasons: string[] = [];
    if (context.maxDrawdownReached) {
      reasons.push(`drawdown >= ${config.maxDrawdownPct}`);
    }
    if (context.maxLossesReached) {
      reasons.push(`consecutive losses >= ${config.maxConsecutiveLosses}`);
    }
    if (context.maxDailyLossReached) {
      reasons.push(`daily loss >= ${config.maxDailyLossUsd}`);
    }
    if (context.maxSingleLossReached) {
      reasons.push(`single loss >= ${config.maxSingleLossUsd}`);
    }
    if (context.outcome.reason) {
      reasons.push(`trade reason: ${context.outcome.reason}`);
    }
    return reasons.join("; ");
  }

  reset(): void {
    this.consecutiveLosses = 0;
    this.peakCapitalUsd = config.initialCapitalUsd;
    this.troughCapitalUsd = config.initialCapitalUsd;
    this.currentCapitalUsd = config.initialCapitalUsd;
    this.haltedUntil = null;
    this.dailyLossUsd = 0;
    this.lastLossWindowStart = Date.now();
    this.lastOpenReason = null;
    logger.info("Circuit breaker reset", { initialCapitalUsd: config.initialCapitalUsd });
  }

  getStatus(): {
    isHalted: boolean;
    haltedUntil: number | null;
    currentCapitalUsd: number;
    peakCapitalUsd: number;
    troughCapitalUsd: number;
    consecutiveLosses: number;
    drawdownPct: number;
    dailyLossUsd: number;
    lastOpenReason: string | null;
  } {
    return {
      isHalted: !!this.haltedUntil && Date.now() < this.haltedUntil,
      haltedUntil: this.haltedUntil,
      currentCapitalUsd: this.currentCapitalUsd,
      peakCapitalUsd: this.peakCapitalUsd,
      troughCapitalUsd: this.troughCapitalUsd,
      consecutiveLosses: this.consecutiveLosses,
      drawdownPct: (this.peakCapitalUsd - this.currentCapitalUsd) / Math.max(this.peakCapitalUsd, 1e-6),
      dailyLossUsd: this.dailyLossUsd,
      lastOpenReason: this.lastOpenReason,
    };
  }
}
