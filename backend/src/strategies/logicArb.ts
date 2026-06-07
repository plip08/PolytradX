/**
 * STRATEGY 4 — LOGIC ARBITRAGE
 *
 * Exploits logical dependencies between markets.
 * Example: If P(BTC > 100k) > P(BTC > 90k), the latter must be >= the former
 *          (because 100k implies 90k). Any inversion is a guaranteed arb.
 *
 * Supported relations:
 *   A_IMPLIES_B       → P(A) <= P(B) must hold. If P(A) > P(B): buy B
 *   B_IMPLIES_A       → P(B) <= P(A) must hold. If P(B) > P(A): buy A
 *   MUTUALLY_EXCLUSIVE → P(A) + P(B) < 1.0 must hold. If sum > 1: arb exists
 *   CORRELATED        → P(A) and P(B) should track within a band
 */

import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  LogicPair,
  LogicDiscrepancy,
  OrderBook,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
} from '../types/index.js';

interface LogicArbParams {
  scanIntervalMs: number;      // how often to re-scan all pairs
  maxPairsToTrack: number;
}

export class LogicArbStrategy {
  public readonly strategyId = 'LOGIC_ARB' as const;
  public status: StrategyStatus = 'IDLE';

  private readonly pairs: LogicPair[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private totalArbs = 0;
  private totalPnL = 0;

  constructor(
    private readonly params: LogicArbParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly risk: RiskManager,
  ) {}

  /** Called by MarketDiscovery — auto-generates CORRELATED pairs across all liquid markets */
  setMarkets(markets: import('../types/index.js').MarketInfo[]): void {
    // Clear existing auto-generated pairs (keep manually added ones if any)
    this.pairs.length = 0;

    const cap = this.params.maxPairsToTrack;

    // Group by category, generate all same-category pairs with CORRELATED relation
    const byCategory = new Map<string, typeof markets>();
    for (const m of markets) {
      const cat = m.category ?? 'other';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(m);
    }

    for (const [, group] of byCategory) {
      for (let i = 0; i < group.length && this.pairs.length < cap; i++) {
        for (let j = i + 1; j < group.length && this.pairs.length < cap; j++) {
          const mA = group[i]!;
          const mB = group[j]!;
          this.pairs.push({
            id: `auto_${mA.id}_${mB.id}`,
            description: `${mA.question.slice(0, 30)} ↔ ${mB.question.slice(0, 30)}`,
            marketA: { marketId: mA.id, tokenId: mA.yesTokenId, side: 'YES' as const },
            marketB: { marketId: mB.id, tokenId: mB.yesTokenId, side: 'YES' as const },
            relation: 'CORRELATED',
            minDiscrepancyPct: 0.05,
            maxPositionUsd: this.config.capitalAllocationUsd / 10,
          });
        }
      }
    }

    emitLog('INFO', `[LogicArb] Auto-generated ${this.pairs.length} pairs from ${markets.length} markets`, undefined, this.strategyId);
  }

  addPair(pair: LogicPair): void {
    if (this.pairs.length >= this.params.maxPairsToTrack) {
      throw new Error(`Max pairs limit (${this.params.maxPairsToTrack}) reached`);
    }
    this.pairs.push(pair);
    emitLog('INFO', `[LogicArb] Pair added: ${pair.description}`);
  }

  removePair(pairId: string): void {
    const idx = this.pairs.findIndex((p) => p.id === pairId);
    if (idx >= 0) this.pairs.splice(idx, 1);
  }

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';

    this.scanTimer = setInterval(() => void this.scanAllPairs(), this.params.scanIntervalMs);
    void this.scanAllPairs(); // immediate first scan

    emitLog('INFO', '[LogicArb] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.status = 'IDLE';
    emitLog('INFO', '[LogicArb] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  private async scanAllPairs(): Promise<void> {
    if (this.pairs.length === 0 || this.status === 'IDLE') return;

    // Fetch all order books in parallel
    const bookPromises = this.pairs.flatMap((pair) => [
      this.clob.getOrderBook(pair.marketA.tokenId).catch(() => null),
      this.clob.getOrderBook(pair.marketB.tokenId).catch(() => null),
    ]);

    const books = await Promise.all(bookPromises);

    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      if (!pair) continue;
      const obA = books[i * 2];
      const obB = books[i * 2 + 1];
      if (!obA || !obB) continue;

      const discrepancy = this.detectDiscrepancy(pair, obA, obB);
      if (discrepancy) {
        emitLog(
          'WARN',
          `[LogicArb] Discrepancy: ${pair.description} | A=${discrepancy.priceA.toFixed(4)} B=${discrepancy.priceB.toFixed(4)} gap=${(discrepancy.discrepancyPct * 100).toFixed(2)}%`,
          undefined,
          this.strategyId,
        );
        await this.executeArb(discrepancy);
      }
    }
  }

  private detectDiscrepancy(
    pair: LogicPair,
    obA: OrderBook,
    obB: OrderBook,
  ): LogicDiscrepancy | null {
    const priceA = obA.midPrice;
    const priceB = obB.midPrice;

    let discrepancyPct = 0;
    let expectedAction: LogicDiscrepancy['expectedAction'] | null = null;

    switch (pair.relation) {
      case 'A_IMPLIES_B':
        // P(A) > P(B) is logically inconsistent → buy B (undervalued)
        if (priceA > priceB + pair.minDiscrepancyPct) {
          discrepancyPct = (priceA - priceB) / priceB;
          expectedAction = 'BUY_B';
        }
        break;

      case 'B_IMPLIES_A':
        // P(B) > P(A) is logically inconsistent → buy A (undervalued)
        if (priceB > priceA + pair.minDiscrepancyPct) {
          discrepancyPct = (priceB - priceA) / priceA;
          expectedAction = 'BUY_A';
        }
        break;

      case 'MUTUALLY_EXCLUSIVE':
        // P(A) + P(B) > 1 → both cannot both resolve YES
        if (priceA + priceB > 1.0 + pair.minDiscrepancyPct) {
          discrepancyPct = priceA + priceB - 1.0;
          // Short the overvalued one (buy NO of whichever has higher price)
          expectedAction = priceA > priceB ? 'SELL_A_BUY_B' : 'BUY_B';
        }
        break;

      case 'CORRELATED':
        // Price deviation beyond expected correlation band
        if (Math.abs(priceA - priceB) > pair.minDiscrepancyPct) {
          discrepancyPct = Math.abs(priceA - priceB);
          expectedAction = priceA < priceB ? 'BUY_A' : 'BUY_B';
        }
        break;
    }

    if (!expectedAction) return null;

    const positionSize = Math.min(pair.maxPositionUsd, this.config.capitalAllocationUsd);
    const expectedProfitUsd = discrepancyPct * positionSize;

    if (expectedProfitUsd < this.config.minProfitUsd) return null;

    return { pair, priceA, priceB, discrepancyPct, expectedAction, expectedProfitUsd };
  }

  private async executeArb(d: LogicDiscrepancy): Promise<void> {
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const execId = uuidv4();

    try {
      let targetTokenId: string;
      let targetMarketId: string;
      let side: 'BUY' | 'SELL';
      let targetPrice: number;

      switch (d.expectedAction) {
        case 'BUY_B':
          targetTokenId = d.pair.marketB.tokenId;
          targetMarketId = d.pair.marketB.marketId;
          side = 'BUY';
          targetPrice = d.priceB;
          break;
        case 'BUY_A':
          targetTokenId = d.pair.marketA.tokenId;
          targetMarketId = d.pair.marketA.marketId;
          side = 'BUY';
          targetPrice = d.priceA;
          break;
        case 'SELL_A_BUY_B':
          // Simplified: just buy the undervalued leg
          targetTokenId = d.pair.marketB.tokenId;
          targetMarketId = d.pair.marketB.marketId;
          side = 'BUY';
          targetPrice = d.priceB;
          break;
      }

      const positionUsdc = Math.min(d.pair.maxPositionUsd, this.config.capitalAllocationUsd);
      const orderSize = positionUsdc / targetPrice!;

      const riskCheck = this.risk.checkPreTrade(
        this.strategyId,
        this.config,
        positionUsdc,
        0.01,
      );

      if (!riskCheck.approved) {
        emitLog('WARN', `[LogicArb] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
        return;
      }

      const resp = await this.clob.placeOrder({
        marketId: targetMarketId!,
        tokenId: targetTokenId!,
        side: side!,
        type: 'LIMIT',
        price: targetPrice! * (1 + 0.005),
        size: orderSize,
      });

      this.totalArbs++;
      this.totalPnL += d.expectedProfitUsd;

      const execution: TradeExecution = {
        id: execId,
        strategyId: this.strategyId,
        marketId: targetMarketId!,
        tokenId: targetTokenId!,
        side: side!,
        price: targetPrice!,
        size: orderSize,
        pnl: d.expectedProfitUsd,
        timestamp: Date.now(),
        status: 'SUCCESS',
      };

      this.risk.recordTrade(execution);
      BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);

      emitLog(
        'SUCCESS',
        `[LogicArb] Arb executed: ${d.pair.description} | action=${d.expectedAction} | est.profit=$${d.expectedProfitUsd.toFixed(2)}`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      emitLog('ERROR', `[LogicArb] Execution failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      this.status = 'SCANNING';
      this.broadcastStatus();
    }
  }

  private broadcastStatus(): void {
    BotWebSocketServer.getInstance().broadcast('STRATEGY_STATUS_UPDATE', {
      strategyId: this.strategyId,
      status: this.status,
      metrics: this.getMetrics(),
    });
  }

  getMetrics(): Record<string, number | string> {
    return {
      trackedPairs: this.pairs.length,
      totalArbs: this.totalArbs,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
    };
  }
}
