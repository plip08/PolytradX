/**
 * STRATEGY 2 — DELTA-NEUTRAL MARKET MAKER / LIQUIDITY CLAIMER
 *
 * Algorithm:
 *   1. Compute midPrice from live order book
 *   2. Compute order book imbalance to adjust delta
 *   3. Place Bid = midPrice - spread/2 - imbalance_adjustment
 *      Place Ask = midPrice + spread/2 + imbalance_adjustment
 *   4. On ANY mid-price shift > rebalanceThreshold, cancel stale orders
 *      and repost within <100ms
 *   5. Track inventory to maintain delta-neutral positioning
 *
 * Revenue sources:
 *   - Earned spread on each filled pair
 *   - Rebates from Polymarket for providing liquidity
 */

import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  OrderBook,
  ClobOrderResponse,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
} from '../types/index.js';

interface MarketMakerParams {
  marketId: string;
  tokenId: string;                 // YES token to make market on
  targetSpreadBps: number;         // half-spread in basis points (e.g. 50 = 0.5%)
  orderSizeUsdc: number;           // size of each limit order
  maxInventoryTokens: number;      // max long/short inventory
  rebalanceThresholdPct: number;   // min mid-price move to trigger repost (e.g. 0.003 = 0.3%)
  imbalanceAdjustmentFactor: number; // 0–1, how aggressively to skew for imbalance
}

interface ActiveOrders {
  bidOrderId: string | null;
  askOrderId: string | null;
  bidPrice: number;
  askPrice: number;
  postedAt: number;
}

export class MarketMakerStrategy {
  public readonly strategyId = 'MARKET_MAKER' as const;
  public status: StrategyStatus = 'IDLE';

  private activeOrders: ActiveOrders = {
    bidOrderId: null,
    askOrderId: null,
    bidPrice: 0,
    askPrice: 0,
    postedAt: 0,
  };

  private inventory = 0;           // net YES token inventory (positive = long)
  private totalEarnedSpread = 0;
  private totalFills = 0;
  private lastMidPrice = 0;
  private isRebalancing = false;
  private unsubscribe: (() => void) | null = null;
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly params: MarketMakerParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly risk: RiskManager,
  ) {}

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';

    this.unsubscribe = this.clob.subscribeToOrderBook(this.params.tokenId, (ob) => {
      void this.onOrderBookUpdate(ob);
    });

    emitLog('INFO', '[MarketMaker] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    this.unsubscribe?.();
    void this.cancelAllActiveOrders();
    this.status = 'IDLE';
    emitLog('INFO', '[MarketMaker] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  private async onOrderBookUpdate(ob: OrderBook): Promise<void> {
    if (this.isRebalancing || this.status === 'IDLE' || this.status === 'DISABLED') return;

    const midPrice = ob.midPrice;
    if (midPrice <= 0 || midPrice >= 1) return;

    const midShift = Math.abs(midPrice - this.lastMidPrice) / (this.lastMidPrice || midPrice);

    if (
      this.activeOrders.bidOrderId === null ||
      this.activeOrders.askOrderId === null ||
      midShift >= this.params.rebalanceThresholdPct
    ) {
      void this.rebalance(ob);
    }
  }

  private async rebalance(ob: OrderBook): Promise<void> {
    if (this.isRebalancing) return;
    this.isRebalancing = true;
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const rebalanceStart = Date.now();

    try {
      await this.cancelAllActiveOrders();

      if (this.config.dryRun) {
        const mid = ob.midPrice;
        const hs = mid * (this.params.targetSpreadBps / 10_000);
        emitLog('INFO', `[MarketMaker] DRY RUN — would quote bid=${(mid - hs).toFixed(4)} ask=${(mid + hs).toFixed(4)}`, undefined, this.strategyId);
        return;
      }

      const midPrice = ob.midPrice;
      const halfSpread = midPrice * (this.params.targetSpreadBps / 10_000);

      // Imbalance-adjusted pricing (skew quotes toward inventory reduction)
      const imbalanceAdj = ob.imbalance * halfSpread * this.params.imbalanceAdjustmentFactor;
      const inventoryAdj =
        -(this.inventory / this.params.maxInventoryTokens) * halfSpread * 0.5;

      const rawBid = midPrice - halfSpread + imbalanceAdj + inventoryAdj;
      const rawAsk = midPrice + halfSpread + imbalanceAdj + inventoryAdj;

      // Clamp to valid 0-1 range
      const bidPrice = Math.max(0.01, Math.min(0.99, rawBid));
      const askPrice = Math.max(0.01, Math.min(0.99, rawAsk));

      if (bidPrice >= askPrice) {
        emitLog('WARN', '[MarketMaker] Degenerate spread — skipping', undefined, this.strategyId);
        return;
      }

      const orderSize = this.params.orderSizeUsdc / midPrice;

      // Risk check for bid side
      const bidRisk = this.risk.checkPreTrade(
        this.strategyId,
        this.config,
        this.params.orderSizeUsdc,
        0,
      );

      if (!bidRisk.approved) {
        emitLog('WARN', `[MarketMaker] Risk blocked bid: ${bidRisk.reason}`, undefined, this.strategyId);
        return;
      }

      // Post new orders in parallel for minimum latency
      const [bidResp, askResp] = await Promise.all([
        this.clob
          .placeOrder({
            marketId: this.params.marketId,
            tokenId: this.params.tokenId,
            side: 'BUY',
            type: 'LIMIT',
            price: bidPrice,
            size: orderSize,
          })
          .catch((e): ClobOrderResponse => {
            emitLog('ERROR', `[MarketMaker] Bid placement failed: ${String(e)}`, undefined, this.strategyId);
            return { orderId: '', status: 'CANCELLED' };
          }),
        this.clob
          .placeOrder({
            marketId: this.params.marketId,
            tokenId: this.params.tokenId,
            side: 'SELL',
            type: 'LIMIT',
            price: askPrice,
            size: orderSize,
          })
          .catch((e): ClobOrderResponse => {
            emitLog('ERROR', `[MarketMaker] Ask placement failed: ${String(e)}`, undefined, this.strategyId);
            return { orderId: '', status: 'CANCELLED' };
          }),
      ]);

      this.activeOrders = {
        bidOrderId: bidResp.orderId || null,
        askOrderId: askResp.orderId || null,
        bidPrice,
        askPrice,
        postedAt: Date.now(),
      };

      this.lastMidPrice = midPrice;

      const rebalanceMs = Date.now() - rebalanceStart;
      const spreadBps = Math.round(((askPrice - bidPrice) / midPrice) * 10_000);

      emitLog(
        'INFO',
        `[MarketMaker] Rebalanced in ${rebalanceMs}ms | bid=${bidPrice.toFixed(4)} ask=${askPrice.toFixed(4)} spread=${spreadBps}bps`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      this.status = 'ERROR';
      emitLog('ERROR', `[MarketMaker] Rebalance failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      this.isRebalancing = false;
      if (this.status === 'EXECUTING') this.status = 'SCANNING';
      this.broadcastStatus();
    }
  }

  private async cancelAllActiveOrders(): Promise<void> {
    const cancels: Promise<void>[] = [];
    if (this.activeOrders.bidOrderId) {
      cancels.push(
        this.clob.cancelOrder(this.activeOrders.bidOrderId).catch(() => {
          // Order may already be filled
        }),
      );
    }
    if (this.activeOrders.askOrderId) {
      cancels.push(
        this.clob.cancelOrder(this.activeOrders.askOrderId).catch(() => {}),
      );
    }
    await Promise.all(cancels);
    this.activeOrders.bidOrderId = null;
    this.activeOrders.askOrderId = null;
  }

  /** Called by fill notification handler */
  onFill(orderId: string, fillPrice: number, fillSize: number, side: 'BUY' | 'SELL'): void {
    this.totalFills++;
    if (side === 'BUY') {
      this.inventory += fillSize;
      // Estimate earned spread when paired with a sell fill
      this.totalEarnedSpread += fillSize * (this.activeOrders.askPrice - fillPrice);
    } else {
      this.inventory -= fillSize;
      this.totalEarnedSpread += fillSize * (fillPrice - this.activeOrders.bidPrice);
    }

    emitLog(
      'SUCCESS',
      `[MarketMaker] Fill: ${side} ${fillSize.toFixed(2)} @ ${fillPrice.toFixed(4)} | inv=${this.inventory.toFixed(2)}`,
      undefined,
      this.strategyId,
    );

    this.broadcastStatus();
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
      inventory: parseFloat(this.inventory.toFixed(4)),
      earnedSpread: parseFloat(this.totalEarnedSpread.toFixed(4)),
      totalFills: this.totalFills,
      currentBid: this.activeOrders.bidPrice,
      currentAsk: this.activeOrders.askPrice,
      spreadBps: Math.round(
        ((this.activeOrders.askPrice - this.activeOrders.bidPrice) /
          (this.lastMidPrice || 0.5)) *
          10_000,
      ),
    };
  }
}
