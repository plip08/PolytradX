/**
 * TRADE STORE — best-effort Postgres persistence of executed trades.
 *
 * Design rules:
 *  - Persistence is NEVER on the critical trading path. A DB outage must not stop the
 *    bot from trading: connect() degrades gracefully, persist() swallows its own errors.
 *  - Idempotent: upsert keyed on TradeExecution.id, so a PENDING → SUCCESS update (or a
 *    retried write) reconciles the same row instead of duplicating it.
 */

import { PrismaClient } from '@prisma/client';
import { logger, emitLog } from '../utils/logger.js';
import type { TradeExecution } from '../types/index.js';

/** Pure mapping TradeExecution → bot_trades row. Exported for testing. */
export function toBotTradeRow(execution: TradeExecution, walletAddress: string) {
  return {
    id: execution.id,
    strategyId: execution.strategyId,
    marketId: execution.marketId,
    tokenId: execution.tokenId,
    walletAddress,
    side: execution.side,
    status: execution.status,
    priceUsd: execution.price,
    size: execution.size,
    notionalUsd: execution.price * execution.size,
    slippagePct: execution.slippage ?? null,
    pnlUsd: execution.pnl ?? null,
    txHash: execution.txHash ?? null,
    gasUsed: execution.gasUsed ?? null,
    gasCostUsd: execution.gasCostUsdc ?? null,
    errorMessage: execution.errorMessage ?? null,
    polygonscanUrl: execution.polygonscanUrl ?? null,
    executedAt: new Date(execution.timestamp),
  };
}

export class TradeStore {
  private prisma: PrismaClient | null = null;
  private enabled = false;

  constructor(private readonly walletAddress: string) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Try to connect. Returns false (and disables persistence) if DB is unset/unreachable. */
  async connect(): Promise<boolean> {
    if (!process.env['DATABASE_URL']) {
      emitLog('WARN', '[TradeStore] DATABASE_URL not set — trade persistence disabled');
      return false;
    }
    try {
      this.prisma = new PrismaClient();
      await this.prisma.$connect();
      this.enabled = true;
      emitLog('INFO', '[TradeStore] Connected — persisting trades to Postgres');
      return true;
    } catch (err) {
      emitLog('WARN', `[TradeStore] DB connect failed — running WITHOUT persistence: ${String(err)}`);
      await this.prisma?.$disconnect().catch(() => undefined);
      this.prisma = null;
      this.enabled = false;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.prisma?.$disconnect().catch(() => undefined);
    this.prisma = null;
    this.enabled = false;
  }

  /** Best-effort idempotent persist. Never throws into the caller (the trading path). */
  async persist(execution: TradeExecution): Promise<void> {
    if (!this.enabled || !this.prisma) return;
    const row = toBotTradeRow(execution, this.walletAddress);
    try {
      await this.prisma.botTrade.upsert({
        where: { id: row.id },
        create: row,
        update: {
          status: row.status,
          pnlUsd: row.pnlUsd,
          txHash: row.txHash,
          gasUsed: row.gasUsed,
          gasCostUsd: row.gasCostUsd,
          errorMessage: row.errorMessage,
          polygonscanUrl: row.polygonscanUrl,
        },
      });
    } catch (err) {
      logger.warn('[TradeStore] persist failed (trade still executed)', {
        id: row.id,
        err: String(err),
      });
    }
  }
}
