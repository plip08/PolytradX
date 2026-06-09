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
 *   CORRELATED        → NOT a guaranteed arb — see detectDiscrepancy. Never auto-generated.
 *
 * Auto-generation: only sound A_IMPLIES_B pairs are built, from "threshold ladders" —
 * markets sharing an identical question stem + expiry + direction that differ only by a
 * numeric level (e.g. "BTC reaches $90k / $100k / $110k by Dec 31"). Reaching a higher
 * level implies reaching every lower one, so prices must be monotone; an inversion is a
 * guaranteed arb. Same-category "correlation" pairing is unsound and was removed.
 */

import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  LogicPair,
  LogicDiscrepancy,
  MarketInfo,
  OrderBook,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
} from '../types/index.js';

interface LogicArbParams {
  scanIntervalMs: number;      // how often to re-scan all pairs
  maxPairsToTrack: number;
}

const GTE_KEYWORDS = /\b(reach|reaches|hit|hits|exceed|exceeds|above|over|surpass|surpasses|greater than|more than|at least|top)\b/i;
const LTE_KEYWORDS = /\b(below|under|less than|fall below|drop to|dip below|beneath)\b/i;

// Blanks date expressions so the two rungs of a TIME ladder ("…by Sep 30" vs "…by Dec 31")
// collapse to one skeleton. The time axis itself comes from the structured
// expirationTimestamp, not from parsing these — this only removes dates from the group key.
const DATE_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\bend of\b|\b20\d{2}\b|\bq[1-4]\b/gi;

export interface Classified {
  market: MarketInfo;
  level: number;        // parsed $ / unit threshold
  deadline: number;     // expirationTimestamp
  direction: 'GTE' | 'LTE';
  byDeadline: boolean;  // cumulative "…by <date>" market — required for time laddering
  skeleton: string;     // question with level + dates blanked → identifies a market family
}

/**
 * Classify a market for ladder grouping. Returns null unless the question is a threshold
 * market with a clear comparison direction and a real $ / unit level. Bare integers
 * (quarters "Q2", chart "#1", plain dates) are intentionally rejected to avoid mis-pairing.
 */
export function classifyMarket(m: MarketInfo): Classified | null {
  const question = m.question;
  const direction: 'GTE' | 'LTE' | null =
    GTE_KEYWORDS.test(question) ? 'GTE' : LTE_KEYWORDS.test(question) ? 'LTE' : null;
  if (!direction) return null;

  // Extract the LEVEL — a $-amount or a unit-suffixed number, unit glued to the digits
  // (a space would let the "b" of a trailing "by" read as billions: "$115 by" → 115e9).
  const lm =
    question.match(/\$\s?(\d[\d,]*(?:\.\d+)?)([kmbt])?\b/i) ??
    question.match(/\b(\d[\d,]*(?:\.\d+)?)([kmbt])\b/i);
  if (!lm || lm.index === undefined) return null;

  let level = parseFloat(lm[1]!.replace(/,/g, ''));
  const unit = lm[2]?.toLowerCase();
  if (unit === 'k') level *= 1e3;
  else if (unit === 'm') level *= 1e6;
  else if (unit === 'b') level *= 1e9;
  else if (unit === 't') level *= 1e12;
  if (!Number.isFinite(level) || level <= 0) return null;

  const skeleton = (question.slice(0, lm.index) + '#' + question.slice(lm.index + lm[0].length))
    .replace(DATE_RE, '@')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*#\s*/g, '#')
    .replace(/(\s*@\s*)+/g, '@')
    .trim();

  return {
    market: m,
    level,
    deadline: m.expirationTimestamp,
    direction,
    byDeadline: /\bby\b/i.test(question),
    skeleton,
  };
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

  /**
   * Called by MarketDiscovery — auto-generates sound A_IMPLIES_B pairs from two kinds of
   * monotone ladder within a market family (same skeleton + direction):
   *   • price ladder — same deadline, different level   (reach $110k ⟹ reach $100k)
   *   • time  ladder — same level, different "by" deadline (hit by Sep ⟹ hit by Dec)
   * Both are guaranteed monotonicities, so any price inversion between rungs is a real arb.
   * Arbitrary same-category "correlation" pairs (the old behavior) are NOT generated.
   */
  setMarkets(markets: MarketInfo[]): void {
    // Clear existing auto-generated pairs (keep manually added ones if any)
    this.pairs.length = 0;

    const cap = this.params.maxPairsToTrack;

    const families = new Map<string, Classified[]>();
    for (const m of markets) {
      const c = classifyMarket(m);
      if (!c) continue;
      const key = `${c.skeleton}__${c.direction}`;
      const fam = families.get(key) ?? [];
      fam.push(c);
      families.set(key, fam);
    }

    const pushPair = (implier: Classified, consequent: Classified, kind: 'price' | 'time'): void => {
      this.pairs.push({
        id: `${kind}_${implier.market.id}_${consequent.market.id}`,
        description: `${implier.market.question.slice(0, 26)} ⟹ ${consequent.market.question.slice(0, 26)}`,
        marketA: { marketId: implier.market.id, tokenId: implier.market.yesTokenId, side: 'YES' as const },
        marketB: { marketId: consequent.market.id, tokenId: consequent.market.yesTokenId, side: 'YES' as const },
        relation: 'A_IMPLIES_B',
        minDiscrepancyPct: 0.02,
        maxPositionUsd: this.config.capitalAllocationUsd / 10,
      });
    };

    for (const fam of families.values()) {
      for (let i = 0; i < fam.length && this.pairs.length < cap; i++) {
        for (let j = i + 1; j < fam.length && this.pairs.length < cap; j++) {
          const a = fam[i]!;
          const b = fam[j]!;
          const sameLevel = a.level === b.level;
          const sameDeadline = a.deadline === b.deadline;

          if (sameDeadline && !sameLevel) {
            // Price ladder. GTE: higher level implies lower. LTE: lower level implies higher.
            // The implier (stronger, less likely event) becomes marketA → P(A) ≤ P(B).
            const aStronger = a.direction === 'GTE' ? a.level > b.level : a.level < b.level;
            const [impl, conseq] = aStronger ? [a, b] : [b, a];
            pushPair(impl, conseq, 'price');
          } else if (sameLevel && !sameDeadline && a.byDeadline && b.byDeadline) {
            // Time ladder: the earlier "by <date>" deadline implies the later one.
            const [impl, conseq] = a.deadline < b.deadline ? [a, b] : [b, a];
            pushPair(impl, conseq, 'time');
          }
          // differ in both dimensions, or identical → no single-step implication
        }
      }
    }

    emitLog('INFO', `[LogicArb] Built ${this.pairs.length} implication pairs from ${markets.length} markets`, undefined, this.strategyId);
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
        // P(A) + P(B) > 1 → impossible — sell the overvalued YES (buy its NO)
        if (priceA + priceB > 1.0 + pair.minDiscrepancyPct) {
          discrepancyPct = priceA + priceB - 1.0;
          // Buy NO on both overvalued outcomes — both legs required for the arb
          expectedAction = 'SELL_A_BUY_B';
        }
        break;

      case 'CORRELATED':
        // NOT a guaranteed arbitrage. A persistent price gap between two correlated
        // markets is usually real information, not a mispricing — there is no closing
        // leg that locks in the "gap" (unlike implication/exclusion). Treating it as an
        // arb produced phantom signals (e.g. two different World Cup teams). No action.
        break;
    }

    if (!expectedAction) return null;

    const positionSize = Math.min(pair.maxPositionUsd, this.config.capitalAllocationUsd);
    const expectedProfitUsd = discrepancyPct * positionSize;

    if (expectedProfitUsd < this.config.minProfitUsd) return null;

    return { pair, priceA, priceB, discrepancyPct, expectedAction, expectedProfitUsd };
  }

  private async executeArb(d: LogicDiscrepancy): Promise<void> {
    if (this.config.dryRun) {
      emitLog('INFO', `[LogicArb] DRY RUN — ${d.expectedAction} on ${d.pair.description} | est.profit=$${d.expectedProfitUsd.toFixed(2)}`, undefined, this.strategyId);
      return;
    }

    this.status = 'EXECUTING';
    this.broadcastStatus();

    const execId = uuidv4();
    const positionUsdc = Math.min(d.pair.maxPositionUsd, this.config.capitalAllocationUsd);

    const riskCheck = this.risk.checkPreTrade(this.strategyId, this.config, positionUsdc, 0.01);
    if (!riskCheck.approved) {
      emitLog('WARN', `[LogicArb] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
      this.status = 'SCANNING';
      this.broadcastStatus();
      return;
    }

    try {
      if (d.expectedAction === 'SELL_A_BUY_B') {
        // MUTUALLY_EXCLUSIVE: both legs required — buy NO on A and NO on B
        const sizeA = positionUsdc / 2 / (1 - d.priceA);
        const sizeB = positionUsdc / 2 / (1 - d.priceB);

        const [respA, respB] = await Promise.all([
          this.clob.placeOrder({
            marketId: d.pair.marketA.marketId,
            tokenId: d.pair.marketA.tokenId,
            side: 'SELL', // sell YES = effectively buy NO via CLOB
            type: 'LIMIT',
            price: d.priceA * (1 - 0.005),
            size: sizeA,
          }),
          this.clob.placeOrder({
            marketId: d.pair.marketB.marketId,
            tokenId: d.pair.marketB.tokenId,
            side: 'SELL',
            type: 'LIMIT',
            price: d.priceB * (1 - 0.005),
            size: sizeB,
          }),
        ]);

        this.totalArbs++;
        const execution: TradeExecution = {
          id: execId, strategyId: this.strategyId,
          marketId: d.pair.marketA.marketId, tokenId: d.pair.marketA.tokenId,
          side: 'SELL', price: d.priceA, size: sizeA,
          pnl: 0, // realized only at market resolution
          timestamp: Date.now(), status: 'PENDING',
        };
        this.risk.recordTrade(execution);
        BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', { ...execution, respA, respB });
      } else {
        // Single-leg: BUY_A or BUY_B
        const targetMarketId = d.expectedAction === 'BUY_A' ? d.pair.marketA.marketId : d.pair.marketB.marketId;
        const targetTokenId  = d.expectedAction === 'BUY_A' ? d.pair.marketA.tokenId  : d.pair.marketB.tokenId;
        const targetPrice    = d.expectedAction === 'BUY_A' ? d.priceA : d.priceB;
        const orderSize = positionUsdc / targetPrice;

        await this.clob.placeOrder({
          marketId: targetMarketId, tokenId: targetTokenId,
          side: 'BUY', type: 'LIMIT',
          price: targetPrice * (1 + 0.005), size: orderSize,
        });

        this.totalArbs++;
        const execution: TradeExecution = {
          id: execId, strategyId: this.strategyId,
          marketId: targetMarketId, tokenId: targetTokenId,
          side: 'BUY', price: targetPrice, size: orderSize,
          pnl: 0, // realized only when position closes
          timestamp: Date.now(), status: 'PENDING',
        };
        this.risk.recordTrade(execution);
        BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);
      }

      emitLog('SUCCESS', `[LogicArb] Position opened: ${d.pair.description} | action=${d.expectedAction} | est.profit=$${d.expectedProfitUsd.toFixed(2)}`, undefined, this.strategyId);
    } catch (err) {
      this.risk.releaseExposure(this.strategyId, positionUsdc);
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

  /** Read-only view of the currently tracked pairs (for inspection / tests). */
  getPairs(): readonly LogicPair[] {
    return this.pairs;
  }

  getMetrics(): Record<string, number | string> {
    return {
      trackedPairs: this.pairs.length,
      totalArbs: this.totalArbs,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
    };
  }
}
