/**
 * STRATEGY 1 — ATOMIC ARBITRAGE (multi-market)
 *
 * Scans ALL crypto markets provided by MarketDiscovery.
 * For each market: monitors YES + NO order books simultaneously.
 * If bestAsk_YES + bestAsk_NO < 1.00 - targetMargin:
 *   1. Buy YES (FOK) + Buy NO (FOK) in parallel
 *   2. CTF.mergePositions() → redeem $1.00 USDC per pair
 * Guaranteed profit = 1.00 - totalCost (minus gas)
 *
 * Latency target: < 200ms from detection to both orders submitted
 */

import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { CtfClient } from '../services/ctfClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  OrderBook,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
  MarketInfo,
} from '../types/index.js';

interface AtomicArbParams {
  targetMargin: number;      // minimum net profit per pair, e.g. 0.005 = 0.5%
  maxPositionUsdc: number;   // max capital per trade
  collateralToken: string;   // USDC contract address
}

interface MarketState {
  market: MarketInfo;
  lastYesOb: OrderBook | null;
  lastNoOb: OrderBook | null;
  unsubscribeYes: (() => void) | null;
  unsubscribeNo: (() => void) | null;
}

interface ArbitrageOpportunity {
  market: MarketInfo;
  yesOb: OrderBook;
  noOb: OrderBook;
  bestAskYes: number;
  bestAskNo: number;
  combinedCost: number;
  netProfit: number;
  optimalSize: number;
}

export class AtomicArbStrategy {
  public readonly strategyId = 'ATOMIC_ARB' as const;
  public status: StrategyStatus = 'IDLE';

  private readonly marketStates = new Map<string, MarketState>(); // marketId → state
  private isExecuting = false;
  private mergeCount = 0;
  private totalPnL = 0;

  constructor(
    private readonly params: AtomicArbParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly ctf: CtfClient,
    private readonly risk: RiskManager,
  ) {}

  // ─── Market management ────────────────────────────────────────────────────

  /** Called by MarketDiscovery with fresh crypto market list */
  setMarkets(markets: MarketInfo[]): void {
    const newIds = new Set(markets.map((m) => m.id));

    // Unsubscribe markets no longer in the list
    for (const [id, state] of this.marketStates) {
      if (!newIds.has(id)) {
        state.unsubscribeYes?.();
        state.unsubscribeNo?.();
        this.marketStates.delete(id);
      }
    }

    // Subscribe to new markets
    for (const market of markets) {
      if (this.marketStates.has(market.id)) continue;
      this.subscribeToMarket(market);
    }

    emitLog('INFO', `[AtomicArb] Tracking ${this.marketStates.size} markets`, undefined, this.strategyId);
    this.broadcastStatus();
  }

  private subscribeToMarket(market: MarketInfo): void {
    const state: MarketState = {
      market,
      lastYesOb: null,
      lastNoOb: null,
      unsubscribeYes: null,
      unsubscribeNo: null,
    };

    state.unsubscribeYes = this.clob.subscribeToOrderBook(market.yesTokenId, (ob) => {
      state.lastYesOb = ob;
      if (this.status === 'SCANNING') void this.evaluateMarket(state);
    });

    state.unsubscribeNo = this.clob.subscribeToOrderBook(market.noTokenId, (ob) => {
      state.lastNoOb = ob;
      if (this.status === 'SCANNING') void this.evaluateMarket(state);
    });

    this.marketStates.set(market.id, state);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';
    emitLog('INFO', `[AtomicArb] Started — watching ${this.marketStates.size} markets`, undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    for (const state of this.marketStates.values()) {
      state.unsubscribeYes?.();
      state.unsubscribeNo?.();
    }
    this.marketStates.clear();
    this.status = 'IDLE';
    emitLog('INFO', '[AtomicArb] Stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  // ─── Core logic ───────────────────────────────────────────────────────────

  private async evaluateMarket(state: MarketState): Promise<void> {
    if (this.isExecuting || !state.lastYesOb || !state.lastNoOb) return;

    const opp = this.detectOpportunity(state);
    if (!opp) return;

    const riskCheck = this.risk.checkPreTrade(
      this.strategyId,
      this.config,
      opp.optimalSize * opp.combinedCost,
      0,
    );

    if (!riskCheck.approved) {
      emitLog('WARN', `[AtomicArb] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
      return;
    }

    await this.execute(opp);
  }

  private detectOpportunity(state: MarketState): ArbitrageOpportunity | null {
    const yesOb = state.lastYesOb!;
    const noOb  = state.lastNoOb!;

    // We BUY → hit existing SELL orders → use bestAsk
    const bestAskYes = yesOb.bestAsk;
    const bestAskNo  = noOb.bestAsk;

    if (!bestAskYes || !bestAskNo) return null;

    const combinedCost = bestAskYes + bestAskNo;
    const grossProfit  = 1.0 - combinedCost;
    const gasCost      = 0.005; // ~$0.005 per merge on Polygon
    const netProfit    = grossProfit - gasCost;

    if (netProfit < this.params.targetMargin) return null;

    const yesSize = yesOb.asks[0]?.size ?? 0;
    const noSize  = noOb.asks[0]?.size ?? 0;
    const capSize = this.params.maxPositionUsdc / combinedCost;
    const optimalSize = Math.min(yesSize, noSize, capSize);

    if (optimalSize < 1) return null;

    emitLog(
      'INFO',
      `[AtomicArb] Opportunity on "${state.market.question.slice(0, 50)}…" YES@${bestAskYes.toFixed(4)} + NO@${bestAskNo.toFixed(4)} → profit=$${(netProfit * optimalSize).toFixed(2)}`,
      undefined,
      this.strategyId,
    );

    return { market: state.market, yesOb, noOb, bestAskYes, bestAskNo, combinedCost, netProfit, optimalSize };
  }

  private async execute(opp: ArbitrageOpportunity): Promise<void> {
    if (this.config.dryRun) {
      emitLog(
        'INFO',
        `[AtomicArb] DRY RUN — ${opp.optimalSize.toFixed(2)} pairs @ ${opp.combinedCost.toFixed(4)} → +$${(opp.netProfit * opp.optimalSize).toFixed(2)}`,
        undefined,
        this.strategyId,
      );
      return;
    }

    this.isExecuting = true;
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const execId = uuidv4();
    const t0 = Date.now();

    try {
      const [yesOrder, noOrder] = await Promise.all([
        this.clob.placeOrder({
          marketId: opp.market.id,
          tokenId: opp.market.yesTokenId,
          side: 'BUY',
          type: 'FOK',
          price: opp.bestAskYes * (1 + this.config.maxSlippagePct),
          size: opp.optimalSize,
        }),
        this.clob.placeOrder({
          marketId: opp.market.id,
          tokenId: opp.market.noTokenId,
          side: 'BUY',
          type: 'FOK',
          price: opp.bestAskNo * (1 + this.config.maxSlippagePct),
          size: opp.optimalSize,
        }),
      ]);

      if (yesOrder.status !== 'FILLED' || noOrder.status !== 'FILLED') {
        emitLog('WARN', `[AtomicArb] Partial fill YES:${yesOrder.status} NO:${noOrder.status} — aborting merge`, undefined, this.strategyId);
        return;
      }

      const amountTokens = BigInt(Math.floor(opp.optimalSize * 1e6));
      const receipt = await this.ctf.mergePositions(
        opp.market.conditionId,
        opp.market.collateralToken ?? this.params.collateralToken,
        amountTokens,
        this.config.gasStrategy,
      );

      const gasCostPol  = Number(receipt.gasUsed ?? 0n) * Number(receipt.gasPrice ?? 100_000_000_000n) / 1e18;
      const gasCostUsdc = gasCostPol * 0.6;
      const pnl = opp.netProfit * opp.optimalSize - gasCostUsdc;

      this.mergeCount++;
      this.totalPnL += pnl;
      this.risk.releaseExposure(this.strategyId, opp.optimalSize * opp.combinedCost);

      const execution: TradeExecution = {
        id: execId,
        strategyId: this.strategyId,
        marketId: opp.market.id,
        tokenId: opp.market.yesTokenId,
        side: 'BUY',
        price: opp.combinedCost,
        size: opp.optimalSize,
        pnl,
        txHash: receipt.hash,
        timestamp: Date.now(),
        status: 'SUCCESS',
        gasUsed: receipt.gasUsed,
        polygonscanUrl: `https://polygonscan.com/tx/${receipt.hash}`,
      };

      this.risk.recordTrade(execution);
      BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);

      emitLog(
        'SUCCESS',
        `[AtomicArb] Merged in ${Date.now() - t0}ms | pnl=$${pnl.toFixed(4)} | total=${this.mergeCount}`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      this.status = 'ERROR';
      emitLog('ERROR', `[AtomicArb] Execution failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      this.isExecuting = false;
      if (this.status !== 'IDLE') this.status = 'SCANNING';
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
      marketsWatched: this.marketStates.size,
      mergeCount: this.mergeCount,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
    };
  }
}
