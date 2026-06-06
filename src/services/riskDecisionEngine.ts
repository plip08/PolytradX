import type { MarketState } from "../types/market.js";

export type RiskSignalType = "spread" | "volatility" | "liquidity" | "depth" | "stale";
export type RiskSignalSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface RiskDecision {
  marketId: string;
  signalType: RiskSignalType;
  severity: RiskSignalSeverity;
  message: string;
  details: Record<string, unknown>;
  emergency: boolean;
}

export interface RiskDecisionEngineOptions {
  monitoredMarkets: string[];
  spreadThresholdPct: number;
  volatilityThresholdPct: number;
  liquidityDropThresholdPct: number;
  orderBookDepthThresholdPct: number;
  staleMarketMs: number;
}

export class RiskDecisionEngine {
  private readonly options: RiskDecisionEngineOptions;

  constructor(options?: Partial<RiskDecisionEngineOptions>) {
    this.options = {
      monitoredMarkets: [],
      spreadThresholdPct: 0.05,
      volatilityThresholdPct: 0.15,
      liquidityDropThresholdPct: 0.4,
      orderBookDepthThresholdPct: 0.25,
      staleMarketMs: 30_000,
      ...options,
    };
  }

  evaluateMarketState(state: MarketState, previousState?: MarketState): RiskDecision[] {
    if (this.options.monitoredMarkets.length > 0 && !this.options.monitoredMarkets.includes(state.marketId)) {
      return [];
    }

    const decisions: RiskDecision[] = [];

    const spreadDecision = this.evaluateSpread(state);
    if (spreadDecision) decisions.push(spreadDecision);

    const volatilityDecision = this.evaluateVolatility(state, previousState);
    if (volatilityDecision) decisions.push(volatilityDecision);

    const liquidityDecision = this.evaluateLiquidity(state, previousState);
    if (liquidityDecision) decisions.push(liquidityDecision);

    const depthDecision = this.evaluateOrderBookDepth(state);
    if (depthDecision) decisions.push(depthDecision);

    const staleDecision = this.evaluateFreshness(state);
    if (staleDecision) decisions.push(staleDecision);

    return decisions;
  }

  private evaluateSpread(state: MarketState): RiskDecision | null {
    const spread = state.bestAsk && state.bestBid ? (state.bestAsk.price - state.bestBid.price) / Math.max(state.bestBid.price, 1e-6) : null;
    if (spread === null || spread < this.options.spreadThresholdPct) {
      return null;
    }

    return {
      marketId: state.marketId,
      signalType: "spread",
      severity: "HIGH",
      message: `Spread ${((spread ?? 0) * 100).toFixed(2)}% exceeds threshold ${this.options.spreadThresholdPct * 100}%`,
      details: {
        spread,
        bestBid: state.bestBid,
        bestAsk: state.bestAsk,
      },
      emergency: true,
    };
  }

  private evaluateVolatility(state: MarketState, previous?: MarketState): RiskDecision | null {
    if (!previous || previous.midPrice === undefined || state.midPrice === undefined) {
      return null;
    }

    const changePct = Math.abs(state.midPrice - previous.midPrice) / Math.max(previous.midPrice, 1e-6);
    if (changePct < this.options.volatilityThresholdPct) {
      return null;
    }

    return {
      marketId: state.marketId,
      signalType: "volatility",
      severity: "MEDIUM",
      message: `Volatility spike ${((changePct ?? 0) * 100).toFixed(2)}% exceeds threshold ${this.options.volatilityThresholdPct * 100}%`,
      details: {
        changePct,
        previousMidPrice: previous.midPrice,
        currentMidPrice: state.midPrice,
      },
      emergency: false,
    };
  }

  private evaluateLiquidity(state: MarketState, previous?: MarketState): RiskDecision | null {
    if (!previous) {
      return null;
    }

    const drop = (previous.liquidity - state.liquidity) / Math.max(previous.liquidity, 1e-6);
    if (drop < this.options.liquidityDropThresholdPct) {
      return null;
    }

    return {
      marketId: state.marketId,
      signalType: "liquidity",
      severity: "MEDIUM",
      message: `Liquidity dropped ${((drop ?? 0) * 100).toFixed(2)}%`,
      details: {
        previousLiquidity: previous.liquidity,
        currentLiquidity: state.liquidity,
        drop,
      },
      emergency: false,
    };
  }

  private evaluateOrderBookDepth(state: MarketState): RiskDecision | null {
    const topDepth = (levels: { price: number; size: number }[]) => levels.slice(0, 3).reduce((sum, level) => sum + level.size, 0);
    const bidDepth = topDepth(state.orderBook.bids);
    const askDepth = topDepth(state.orderBook.asks);
    const totalDepth = bidDepth + askDepth;

    if (totalDepth <= 0) {
      return {
        marketId: state.marketId,
        signalType: "depth",
        severity: "MEDIUM",
        message: "Order book depth is missing or zero",
        details: { bidDepth, askDepth },
        emergency: false,
      };
    }

    const depthRatio = Math.min(bidDepth, askDepth) / Math.max(totalDepth, 1);
    if (depthRatio >= this.options.orderBookDepthThresholdPct) {
      return null;
    }

    return {
      marketId: state.marketId,
      signalType: "depth",
      severity: "MEDIUM",
      message: `Shallow order book depth ratio ${((depthRatio ?? 0) * 100).toFixed(2)}%`,
      details: { bidDepth, askDepth, depthRatio },
      emergency: false,
    };
  }

  private evaluateFreshness(state: MarketState): RiskDecision | null {
    if (Date.now() - state.lastUpdate <= this.options.staleMarketMs) {
      return null;
    }

    return {
      marketId: state.marketId,
      signalType: "stale",
      severity: "MEDIUM",
      message: `Market data stale for ${Date.now() - state.lastUpdate}ms`,
      details: { lastUpdate: state.lastUpdate, staleMarketMs: this.options.staleMarketMs },
      emergency: false,
    };
  }
}
