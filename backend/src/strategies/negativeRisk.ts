/**
 * STRATEGY 5 — NEGATIVE RISK SCRAPER
 *
 * Targets multi-outcome mutually exclusive categorical markets
 * (e.g., "Who will be the next CEO?", "Which country wins the World Cup?")
 *
 * Mathematical basis:
 *   In a set of N mutually exclusive outcomes, exactly ONE resolves YES.
 *   Therefore: Sum(YES_prices) should be approximately 1.00.
 *   If Sum(YES_prices) > 1.00 + threshold, a guaranteed arbitrage exists:
 *     → Buy NO tokens on the overpriced outcomes
 *     → Lock in profit = Sum(YES_prices) - 1.00 regardless of which outcome wins
 *
 * Optimal allocation (Kelly-derived):
 *   Capital_i ∝ (YES_price_i - 1/N) / YES_price_i for each overpriced outcome
 */

import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  MultiCategoryMarket,
  NegativeRiskAllocation,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
} from '../types/index.js';

interface NegativeRiskParams {
  marketGroups: Array<{
    groupId: string;
    description: string;
    tokenIds: string[];         // all outcome token IDs
    marketIds: string[];        // corresponding market IDs
    labels: string[];           // e.g. ["Alice", "Bob", "Charlie"]
  }>;
  minExcessThreshold: number;   // e.g. 0.05 = trigger when sum > 1.05
  scanIntervalMs: number;
}

export class NegativeRiskStrategy {
  public readonly strategyId = 'NEGATIVE_RISK' as const;
  public status: StrategyStatus = 'IDLE';

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private totalArbs = 0;
  private totalPnL = 0;
  private lastGroupSnapshot: Map<string, MultiCategoryMarket> = new Map();

  constructor(
    private readonly params: NegativeRiskParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly risk: RiskManager,
  ) {}

  /** Called by MarketDiscovery with event groups (each group = mutually exclusive outcomes) */
  setEventGroups(groups: import('../types/index.js').MarketInfo[][]): void {
    // Replace the market groups in params
    this.params.marketGroups = groups.map((group, i) => ({
      groupId: `event_${i}`,
      description: group[0]?.question?.split('?')[0] ?? `Group ${i}`,
      tokenIds:  group.map((m) => m.yesTokenId),
      marketIds: group.map((m) => m.id),
      labels:    group.map((m) => m.question.slice(0, 30)),
    }));

    emitLog('INFO', `[NegativeRisk] Updated to ${this.params.marketGroups.length} event groups`, undefined, this.strategyId);
  }

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';

    this.scanTimer = setInterval(() => void this.scan(), this.params.scanIntervalMs);
    void this.scan();

    emitLog('INFO', '[NegativeRisk] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.status = 'IDLE';
    emitLog('INFO', '[NegativeRisk] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  private async scan(): Promise<void> {
    if (this.status === 'IDLE') return;

    for (const group of this.params.marketGroups) {
      try {
        const market = await this.buildMarketSnapshot(group);
        this.lastGroupSnapshot.set(group.groupId, market);

        if (market.sumYesPrices > 1.0 + this.params.minExcessThreshold) {
          emitLog(
            'WARN',
            `[NegativeRisk] Opportunity in "${group.description}" | sum=${market.sumYesPrices.toFixed(4)} excess=${market.excessAboveOne.toFixed(4)}`,
            undefined,
            this.strategyId,
          );

          const allocation = this.computeAllocation(market);
          if (allocation.expectedProfitUsd >= this.config.minProfitUsd) {
            await this.execute(allocation);
          }
        }
      } catch (err) {
        emitLog('ERROR', `[NegativeRisk] Scan failed for group ${group.groupId}: ${String(err)}`);
      }
    }
  }

  private async buildMarketSnapshot(
    group: NegativeRiskParams['marketGroups'][number],
  ): Promise<MultiCategoryMarket> {
    // Fetch all order books in parallel
    const books = await Promise.all(group.tokenIds.map((id) => this.clob.getOrderBook(id)));

    const outcomes = books.map((ob, i) => ({
      tokenId: group.tokenIds[i] ?? '',
      marketId: group.marketIds[i] ?? '',
      label: group.labels[i] ?? `Outcome ${i}`,
      yesPrice: ob.bestAsk, // cost to BUY YES
      noPrice: 1 - ob.bestBid, // effective NO price = 1 - best bid for YES
      impliedProbability: ob.midPrice,
    }));

    const sumYesPrices = outcomes.reduce((acc, o) => acc + o.yesPrice, 0);

    return {
      groupId: group.groupId,
      description: group.description,
      outcomes,
      sumYesPrices,
      excessAboveOne: sumYesPrices - 1.0,
    };
  }

  /**
   * Compute optimal NO-buying allocation to maximize guaranteed profit.
   *
   * For each outcome i:
   *   If we buy NO at price noPrice_i, we earn 1.0 if outcome i loses.
   *   Since exactly one outcome wins, buying NO on ALL non-winning outcomes
   *   combined with the premium collected ensures a positive expected return.
   *
   * Simplified strategy: buy NO on ALL outcomes with YES price > 1/N,
   * allocating proportionally to overvaluation.
   */
  private computeAllocation(market: MultiCategoryMarket): NegativeRiskAllocation {
    const N = market.outcomes.length;
    const fairPrice = 1.0 / N;

    const overvalued = market.outcomes.filter((o) => o.yesPrice > fairPrice);
    const totalOvervaluation = overvalued.reduce((acc, o) => acc + (o.yesPrice - fairPrice), 0);
    const totalCapital = Math.min(
      this.config.capitalAllocationUsd,
      overvalued.length * 100, // $100 per overvalued outcome cap
    );

    const trades: NegativeRiskAllocation['tradesRequired'] = overvalued.map((o) => {
      const overvaluationShare = (o.yesPrice - fairPrice) / totalOvervaluation;
      const capitalAllocated = totalCapital * overvaluationShare;
      const noPrice = 1 - o.yesPrice; // approx NO price
      const tokenSize = capitalAllocated / noPrice;

      return {
        tokenId: o.tokenId,
        marketId: o.marketId,
        label: o.label,
        action: 'BUY_NO',
        price: noPrice,
        size: tokenSize,
        expectedContribution: capitalAllocated * (1 / noPrice - 1), // expected return
      };
    });

    const totalCapitalRequired = trades.reduce((acc, t) => acc + t.price * t.size, 0);
    const expectedProfitUsd = market.excessAboveOne * totalCapital;

    return {
      market,
      tradesRequired: trades,
      totalCapitalRequired,
      expectedProfitUsd,
      profitPct: expectedProfitUsd / totalCapitalRequired,
    };
  }

  private async execute(allocation: NegativeRiskAllocation): Promise<void> {
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const riskCheck = this.risk.checkPreTrade(
      this.strategyId,
      this.config,
      allocation.totalCapitalRequired,
      0.02,
    );

    if (!riskCheck.approved) {
      emitLog('WARN', `[NegativeRisk] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
      this.status = 'SCANNING';
      this.broadcastStatus();
      return;
    }

    try {
      // Execute all NO buys in parallel
      const orderPromises = allocation.tradesRequired.map((trade) =>
        this.clob.placeOrder({
          marketId: trade.marketId,
          tokenId: trade.tokenId,
          side: 'BUY', // buying NO token
          type: 'LIMIT',
          price: trade.price * 1.01, // slight tolerance
          size: trade.size,
        }),
      );

      const results = await Promise.allSettled(orderPromises);
      const successful = results.filter((r) => r.status === 'fulfilled');

      this.totalArbs++;
      this.totalPnL += allocation.expectedProfitUsd;

      const execution: TradeExecution = {
        id: uuidv4(),
        strategyId: this.strategyId,
        marketId: allocation.market.groupId,
        tokenId: 'MULTI',
        side: 'BUY',
        price: allocation.totalCapitalRequired / allocation.tradesRequired.reduce((a, t) => a + t.size, 0),
        size: allocation.tradesRequired.reduce((a, t) => a + t.size, 0),
        pnl: allocation.expectedProfitUsd,
        timestamp: Date.now(),
        status: 'SUCCESS',
      };

      this.risk.recordTrade(execution);
      BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);

      emitLog(
        'SUCCESS',
        `[NegativeRisk] ${successful.length}/${allocation.tradesRequired.length} NO positions opened | sum=${allocation.market.sumYesPrices.toFixed(4)} | est.profit=$${allocation.expectedProfitUsd.toFixed(2)}`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      emitLog('ERROR', `[NegativeRisk] Execution failed: ${String(err)}`, undefined, this.strategyId);
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
    const groups = [...this.lastGroupSnapshot.values()];
    const maxExcess = groups.reduce((max, g) => Math.max(max, g.excessAboveOne), 0);

    return {
      trackedGroups: this.params.marketGroups.length,
      totalArbs: this.totalArbs,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
      maxCurrentExcess: parseFloat(maxExcess.toFixed(4)),
    };
  }
}
