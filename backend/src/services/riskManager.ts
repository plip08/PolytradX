/**
 * RISK MANAGER
 *
 * Global pre-trade and post-trade risk controls:
 *  - Max capital exposure per strategy
 *  - Global daily loss limit (circuit breaker)
 *  - Max slippage enforcement
 *  - Concurrent position count limits
 *  - Kill switch integration
 */

import { logger, emitLog } from '../utils/logger.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import type { StrategyId, StrategyConfig, TradeExecution } from '../types/index.js';

interface RiskState {
  sessionStartPnL: number;
  cumulativePnL: number;
  dailyPnL: number;
  dailyResetTimestamp: number;
  positionCount: number;
  isCircuitBreakerOpen: boolean;
  killSwitchActive: boolean;
  strategyExposure: Record<string, number>; // strategyId → current exposure USD
  totalExposure: number;
}

interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedSize?: number; // if size was clamped
}

export class RiskManager {
  private static instance: RiskManager | null = null;

  private state: RiskState = {
    sessionStartPnL: 0,
    cumulativePnL: 0,
    dailyPnL: 0,
    dailyResetTimestamp: Date.now(),
    positionCount: 0,
    isCircuitBreakerOpen: false,
    killSwitchActive: false,
    strategyExposure: {},
    totalExposure: 0,
  };

  private readonly MAX_DAILY_LOSS_USD = 500;
  private readonly MAX_POSITIONS = 20;

  // Not readonly — can be updated at runtime when settings change
  private maxTotalExposureUsd = parseFloat(process.env['MAX_GLOBAL_CAPITAL_USD'] ?? '10000');

  /** Call after updating MAX_GLOBAL_CAPITAL_USD in process.env */
  updateCapitalLimit(): void {
    this.maxTotalExposureUsd = parseFloat(process.env['MAX_GLOBAL_CAPITAL_USD'] ?? '10000');
    emitLog('INFO', `[RiskManager] Capital limit updated to $${this.maxTotalExposureUsd}`);
  }

  private constructor() {
    // Reset daily P&L at midnight UTC
    setInterval(() => this.checkDailyReset(), 60_000);
  }

  static getInstance(): RiskManager {
    if (!RiskManager.instance) {
      RiskManager.instance = new RiskManager();
    }
    return RiskManager.instance;
  }

  /** Pre-trade check — call before every order placement */
  checkPreTrade(
    strategyId: StrategyId,
    config: StrategyConfig,
    tradeValueUsd: number,
    expectedSlippagePct: number,
  ): RiskCheckResult {
    // Kill switch overrides everything
    if (this.state.killSwitchActive) {
      return { approved: false, reason: 'Kill switch is active' };
    }

    // Circuit breaker
    if (this.state.isCircuitBreakerOpen) {
      return { approved: false, reason: 'Circuit breaker open — daily loss limit hit' };
    }

    // Slippage check
    if (expectedSlippagePct > config.maxSlippagePct) {
      return {
        approved: false,
        reason: `Slippage ${(expectedSlippagePct * 100).toFixed(2)}% exceeds limit ${(config.maxSlippagePct * 100).toFixed(2)}%`,
      };
    }

    // Strategy capital allocation
    const strategyExposure = this.state.strategyExposure[strategyId] ?? 0;
    if (strategyExposure + tradeValueUsd > config.capitalAllocationUsd) {
      const headroom = Math.max(0, config.capitalAllocationUsd - strategyExposure);
      if (headroom < config.minProfitUsd) {
        return {
          approved: false,
          reason: `Strategy capital exhausted ($${strategyExposure.toFixed(2)} / $${config.capitalAllocationUsd})`,
        };
      }
      return {
        approved: true,
        adjustedSize: headroom,
        reason: 'Size clamped to strategy allocation headroom',
      };
    }

    // Global exposure
    if (this.state.totalExposure + tradeValueUsd > this.maxTotalExposureUsd) {
      return {
        approved: false,
        reason: `Global exposure limit hit ($${this.state.totalExposure.toFixed(2)} / $${this.maxTotalExposureUsd})`,
      };
    }

    // Position count
    if (this.state.positionCount >= this.MAX_POSITIONS) {
      return { approved: false, reason: `Max concurrent positions (${this.MAX_POSITIONS}) reached` };
    }

    return { approved: true };
  }

  /** Must be called after each trade for accounting */
  recordTrade(execution: TradeExecution): void {
    const tradeValueUsd = execution.price * execution.size;

    // Only open positions increment exposure — CLOSED/CANCELLED trades do not
    if (execution.status === 'PENDING') {
      const stratId = execution.strategyId;
      this.state.strategyExposure[stratId] =
        (this.state.strategyExposure[stratId] ?? 0) + tradeValueUsd;
      this.state.totalExposure += tradeValueUsd;
      this.state.positionCount++;
    }

    // Record realized P&L only (not unrealized estimates)
    if (execution.pnl !== undefined && execution.status !== 'PENDING') {
      this.state.cumulativePnL += execution.pnl;
      this.state.dailyPnL += execution.pnl;
      this.checkCircuitBreaker();
    }

    BotWebSocketServer.getInstance().broadcast('PNL_UPDATE', {
      cumulativePnL: this.state.cumulativePnL,
      dailyPnL: this.state.dailyPnL,
    });
  }

  /** Call when a position is closed */
  releaseExposure(strategyId: StrategyId, closedValueUsd: number): void {
    this.state.strategyExposure[strategyId] = Math.max(
      0,
      (this.state.strategyExposure[strategyId] ?? 0) - closedValueUsd,
    );
    this.state.totalExposure = Math.max(0, this.state.totalExposure - closedValueUsd);
    this.state.positionCount = Math.max(0, this.state.positionCount - 1);
  }

  /** Estimate slippage for a given order against the current book */
  estimateSlippage(
    orderSize: number,
    orderSide: 'BUY' | 'SELL',
    levels: Array<{ price: number; size: number }>,
    midPrice: number,
  ): number {
    let remaining = orderSize;
    let totalCost = 0;

    for (const level of levels) {
      const fill = Math.min(remaining, level.size);
      totalCost += fill * level.price;
      remaining -= fill;
      if (remaining <= 0) break;
    }

    if (remaining > 0) return 1.0; // can't fully fill — 100% slippage signal

    const avgPrice = totalCost / orderSize;
    return Math.abs(avgPrice - midPrice) / midPrice;
  }

  activateKillSwitch(): void {
    this.state.killSwitchActive = true;
    emitLog('ERROR', 'KILL SWITCH ACTIVATED — all trading halted');
    BotWebSocketServer.getInstance().broadcast('KILL_SWITCH_ACTIVATED', { timestamp: Date.now() });
  }

  deactivateKillSwitch(): void {
    this.state.killSwitchActive = false;
    emitLog('WARN', 'Kill switch deactivated — trading resumed');
  }

  isKillSwitchActive(): boolean {
    return this.state.killSwitchActive;
  }

  /** Must be called explicitly by operator after reviewing losses — never auto-resets */
  resetCircuitBreaker(): void {
    if (!this.state.isCircuitBreakerOpen) return;
    this.state.isCircuitBreakerOpen = false;
    this.state.dailyPnL = 0;
    this.state.dailyResetTimestamp = Date.now();
    emitLog('WARN', '[RiskManager] Circuit breaker manually reset by operator — trading resumed');
    BotWebSocketServer.getInstance().broadcast('CIRCUIT_BREAKER_RESET', { timestamp: Date.now() });
  }

  private checkCircuitBreaker(): void {
    if (this.state.dailyPnL < -this.MAX_DAILY_LOSS_USD && !this.state.isCircuitBreakerOpen) {
      this.state.isCircuitBreakerOpen = true;
      emitLog(
        'ERROR',
        `[RiskManager] Circuit breaker OPEN — daily loss $${Math.abs(this.state.dailyPnL).toFixed(2)} exceeds limit $${this.MAX_DAILY_LOSS_USD} — MANUAL RESET REQUIRED`,
      );
      BotWebSocketServer.getInstance().broadcast('CIRCUIT_BREAKER_OPEN', {
        dailyLoss: this.state.dailyPnL,
        limit: this.MAX_DAILY_LOSS_USD,
        timestamp: Date.now(),
      });
    }
  }

  private checkDailyReset(): void {
    const now = new Date();
    const reset = new Date(this.state.dailyResetTimestamp);
    if (now.getUTCDate() !== reset.getUTCDate() && !this.state.isCircuitBreakerOpen) {
      // Only auto-reset daily P&L counter — never auto-reset a tripped circuit breaker
      this.state.dailyPnL = 0;
      this.state.dailyResetTimestamp = Date.now();
      logger.info('[RiskManager] Daily P&L counter reset (circuit breaker unchanged)');
    }
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }
}
