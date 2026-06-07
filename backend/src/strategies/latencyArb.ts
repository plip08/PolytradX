/**
 * STRATEGY 3 — LATENCY ARBITRAGE
 *
 * Exploits the information lag between real-world sports events
 * and Polymarket's order book price updates.
 *
 * Architecture:
 *   1. WS connection to a sports data provider (Betfair / Pinnacle format)
 *   2. In-memory hash map: sportEventId → [polymarket tokenId, expectedPostEventPrice]
 *   3. On critical event (goal, match end, etc.): check if Polymarket price
 *      still reflects pre-event state
 *   4. If yes, fire a market order to sweep all available stale liquidity
 *      before market suspension
 *
 * Latency budget: < 50ms from event detection to order submission
 */

import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  SportEvent,
  OrderBook,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
} from '../types/index.js';

interface LatencyArbParams {
  feedWsUrl: string;       // WebSocket URL for sports data feed
  feedApiKey?: string;
  maxSweepUsdc: number;    // max capital per sweep event
  stalePriceThreshold: number;  // e.g. 0.05 = fire if price differs 5% from expected
  eventCooldownMs: number;      // min ms between sweeps for same market
}

interface SportMapping {
  sportEventId: string;
  polymarketTokenId: string;
  polymarketMarketId: string;
  expectedYesPriceAfterEvent: number;  // where price should be AFTER event resolves
  criticalEventTrigger: 'GOAL' | 'THREE_POINTER' | 'TOUCHDOWN' | 'MATCH_END' | 'NONE';
}

export class LatencyArbStrategy {
  public readonly strategyId = 'LATENCY_ARB' as const;
  public status: StrategyStatus = 'IDLE';

  private feedWs: WebSocket | null = null;
  private readonly eventMappings = new Map<string, SportMapping>();
  private readonly lastSweepTime = new Map<string, number>(); // marketId → timestamp
  private totalSweeps = 0;
  private totalPnL = 0;

  constructor(
    private readonly params: LatencyArbParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly risk: RiskManager,
  ) {}

  /** Called by MarketDiscovery with current sports markets — registers them for monitoring */
  setMarkets(markets: import('../types/index.js').MarketInfo[]): void {
    // Auto-register sports markets with placeholder mappings
    // Real mapping (sportEventId) must come from your sports feed integration
    for (const m of markets) {
      if (!this.eventMappings.has(m.id)) {
        this.eventMappings.set(m.id, {
          sportEventId: m.id,
          polymarketTokenId: m.yesTokenId,
          polymarketMarketId: m.id,
          expectedYesPriceAfterEvent: 0.99,
          criticalEventTrigger: 'MATCH_END',
        });
      }
    }
    emitLog('INFO', `[LatencyArb] Tracking ${this.eventMappings.size} sports markets`, undefined, this.strategyId);
  }

  /** Register a sports event ↔ Polymarket market mapping */
  registerMapping(mapping: SportMapping): void {
    this.eventMappings.set(mapping.sportEventId, mapping);
    emitLog('INFO', `[LatencyArb] Registered mapping: ${mapping.sportEventId} → ${mapping.polymarketMarketId}`);
  }

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';
    this.connectFeed();
    emitLog('INFO', '[LatencyArb] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    this.feedWs?.close();
    this.feedWs = null;
    this.status = 'IDLE';
    emitLog('INFO', '[LatencyArb] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  private connectFeed(): void {
    const headers: Record<string, string> = {};
    if (this.params.feedApiKey) headers['Authorization'] = `Bearer ${this.params.feedApiKey}`;

    this.feedWs = new WebSocket(this.params.feedWsUrl, { headers });

    this.feedWs.on('open', () => {
      emitLog('INFO', '[LatencyArb] Sports feed connected', undefined, this.strategyId);
      // Subscribe to all registered event IDs
      const eventIds = [...this.eventMappings.keys()];
      this.feedWs?.send(JSON.stringify({ action: 'subscribe', eventIds }));
    });

    this.feedWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as SportEvent;
        this.handleFeedEvent(event);
      } catch {
        // ignore
      }
    });

    this.feedWs.on('close', () => {
      emitLog('WARN', '[LatencyArb] Feed disconnected — reconnecting in 1s', undefined, this.strategyId);
      setTimeout(() => {
        if (this.status === 'SCANNING' || this.status === 'EXECUTING') {
          this.connectFeed();
        }
      }, 1000);
    });

    this.feedWs.on('error', (err) => {
      emitLog('ERROR', `[LatencyArb] Feed error: ${String(err)}`, undefined, this.strategyId);
    });
  }

  private handleFeedEvent(event: SportEvent): void {
    if (!event.criticalEvent || event.criticalEvent.type === 'NONE') return;

    const mapping = this.eventMappings.get(event.eventId);
    if (!mapping) return;

    if (event.criticalEvent.type !== mapping.criticalEventTrigger) return;

    const lastSweep = this.lastSweepTime.get(mapping.polymarketMarketId) ?? 0;
    if (Date.now() - lastSweep < this.params.eventCooldownMs) return;

    emitLog(
      'WARN',
      `[LatencyArb] Critical event detected: ${event.criticalEvent.description} for ${event.homeTeam} vs ${event.awayTeam}`,
      { eventId: event.eventId, score: event.score },
      this.strategyId,
    );

    void this.sweep(event, mapping);
  }

  private async sweep(event: SportEvent, mapping: SportMapping): Promise<void> {
    this.status = 'EXECUTING';
    this.broadcastStatus();
    this.lastSweepTime.set(mapping.polymarketMarketId, Date.now());

    const sweepStart = Date.now();

    try {
      // Fetch current order book (should be cached from WS feed)
      const ob = await this.clob.getOrderBook(mapping.polymarketTokenId);

      // Determine if there is a price lag
      const currentPrice = ob.midPrice;
      const expectedPrice = mapping.expectedYesPriceAfterEvent;
      const priceDelta = Math.abs(currentPrice - expectedPrice);
      const priceDeltaPct = priceDelta / expectedPrice;

      if (priceDeltaPct < this.params.stalePriceThreshold) {
        emitLog(
          'INFO',
          `[LatencyArb] No lag for ${mapping.polymarketMarketId} — current=${currentPrice.toFixed(4)} expected=${expectedPrice.toFixed(4)} delta=${(priceDeltaPct * 100).toFixed(2)}%`,
          undefined,
          this.strategyId,
        );
        return;
      }

      // Determine sweep direction
      const side: 'BUY' | 'SELL' = expectedPrice > currentPrice ? 'BUY' : 'SELL';
      const levels = side === 'BUY' ? ob.asks : ob.bids;

      // Estimate slippage
      const estimatedSlippage = this.risk.estimateSlippage(
        this.params.maxSweepUsdc / currentPrice,
        side,
        levels,
        currentPrice,
      );

      const riskCheck = this.risk.checkPreTrade(
        this.strategyId,
        this.config,
        this.params.maxSweepUsdc,
        estimatedSlippage,
      );

      if (!riskCheck.approved) {
        emitLog('WARN', `[LatencyArb] Risk blocked sweep: ${riskCheck.reason}`, undefined, this.strategyId);
        return;
      }

      const sweepSize = this.params.maxSweepUsdc / currentPrice;
      const sweepPrice =
        side === 'BUY'
          ? ob.bestAsk * (1 + this.config.maxSlippagePct) // aggressive ask sweep
          : ob.bestBid * (1 - this.config.maxSlippagePct); // aggressive bid sweep

      const orderResp = await this.clob.placeOrder({
        marketId: mapping.polymarketMarketId,
        tokenId: mapping.polymarketTokenId,
        side,
        type: 'MARKET',
        price: sweepPrice,
        size: sweepSize,
        slippageTolerance: this.config.maxSlippagePct,
      });

      const sweepMs = Date.now() - sweepStart;
      const expectedPnL = Math.abs(expectedPrice - currentPrice) * sweepSize;

      this.totalSweeps++;
      this.totalPnL += expectedPnL;

      const execution: TradeExecution = {
        id: uuidv4(),
        strategyId: this.strategyId,
        marketId: mapping.polymarketMarketId,
        tokenId: mapping.polymarketTokenId,
        side,
        price: orderResp.averageFillPrice ?? sweepPrice,
        size: orderResp.filledAmount ?? sweepSize,
        pnl: expectedPnL,
        timestamp: Date.now(),
        status: 'SUCCESS',
      };

      this.risk.recordTrade(execution);
      BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);
      BotWebSocketServer.getInstance().broadcast('SPORT_EVENT_UPDATE', event);

      emitLog(
        'SUCCESS',
        `[LatencyArb] Sweep executed in ${sweepMs}ms | ${side} ${sweepSize.toFixed(2)} @ lag ${(priceDeltaPct * 100).toFixed(2)}% | est.pnl=$${expectedPnL.toFixed(2)}`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      this.status = 'ERROR';
      emitLog('ERROR', `[LatencyArb] Sweep failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      if (this.status !== 'ERROR') this.status = 'SCANNING';
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
      totalSweeps: this.totalSweeps,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
      mappedEvents: this.eventMappings.size,
    };
  }
}
