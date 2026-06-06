import WebSocket from "ws";
import { logger } from "../utils/logger.js";
import type { MarketState, OrderBookSnapshot } from "../types/market.js";

export class PolymarketClient {
  private ws?: WebSocket;
  private clobClient: any;
  private readonly feedUrl = "wss://api.polymarket.com/clob-feed";
  private reconnectAttempts = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt = 0;

  constructor(private readonly apiKey: string) {}

  private async initializeClient(): Promise<void> {
    if (this.clobClient) {
      return;
    }

    try {
      const module = await import("@polymarket/clob-client");
      const ClobClient = module?.ClobClient ?? module?.default;
      const { Chain } = module;
      this.clobClient = new ClobClient("https://api.polymarket.com", Chain.POLYGON, undefined, undefined);
    } catch (error) {
      logger.warn("Unable to initialize Polymarket CLOB client, fallback enabled.", error);
      this.clobClient = null;
    }
  }

  async subscribeMarketUpdates(onUpdate: (state: MarketState) => void): Promise<void> {
    await this.initializeClient();
    logger.info("Starting Polymarket WebSocket subscriptions for market updates.");
    this.connectWebSocket(onUpdate);
  }

  private connectWebSocket(onUpdate: (state: MarketState) => void): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.stopHeartbeat();
      this.ws.terminate();
    }

    const url = `${this.feedUrl}${this.apiKey ? `?apiKey=${encodeURIComponent(this.apiKey)}` : ""}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Polymarket feed websocket connected.");
      this.reconnectAttempts = 0;
      this.lastPongAt = Date.now();
      this.startHeartbeat();
    });

    this.ws.on("message", (payload) => {
      try {
        const raw = JSON.parse(payload.toString());
        const message = raw.payload ?? raw.data ?? raw;
        const state = this.parseMarketPayload(message);
        if (state) {
          onUpdate(state);
        }
      } catch (error) {
        logger.warn("Invalid feed payload", error);
      }
    });

    this.ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    this.ws.on("close", (code) => {
      logger.warn("Polymarket feed websocket closed", { code, reconnectAttempt: this.reconnectAttempts });
      this.stopHeartbeat();
      setTimeout(() => this.connectWebSocket(onUpdate), Math.min(30_000, 2_000 * (this.reconnectAttempts + 1)));
      this.reconnectAttempts += 1;
    });

    this.ws.on("error", (error) => {
      logger.warn("Polymarket feed websocket error", error);
      this.ws?.terminate();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (Date.now() - this.lastPongAt > 15_000) {
        logger.warn("Polymarket websocket heartbeat failed, reconnecting.");
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private parseMarketPayload(data: any): MarketState | null {
    const payload = data?.payload ?? data?.data ?? data;
    const marketId = payload?.marketId ?? payload?.market_id ?? payload?.market?.id;
    const orderBook = payload?.orderBook ?? payload?.order_book ?? payload?.orderbook;
    if (!marketId || !orderBook) {
      return null;
    }

    const normalizeLevel = (level: any): { price: number; size: number } => ({
      price: Number(level?.price ?? level?.px ?? 0),
      size: Number(level?.size ?? level?.qty ?? 0),
    });

    const snapshot: OrderBookSnapshot = {
      bids: Array.isArray(orderBook.bids)
        ? orderBook.bids.map(normalizeLevel)
        : [],
      asks: Array.isArray(orderBook.asks)
        ? orderBook.asks.map(normalizeLevel)
        : [],
      timestamp: Date.now(),
    };

    const bestBid = snapshot.bids[0];
    const bestAsk = snapshot.asks[0];
    const midPrice = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : undefined;
    const receivedAt = Date.now();

    return {
      marketId: String(marketId),
      outcome: payload.outcome ?? payload.outcomeType ?? payload?.market?.outcome ?? "UNKNOWN",
      bestBid,
      bestAsk,
      yesPrice: Number(payload.yesPrice ?? payload.yes_price ?? bestBid?.price ?? 0),
      noPrice: Number(payload.noPrice ?? payload.no_price ?? bestAsk?.price ?? 0),
      midPrice,
      liquidity: Number(payload.liquidity ?? payload?.depth ?? 0),
      openInterest: Number(payload.openInterest ?? payload.open_interest ?? 0),
      resolution: payload.resolution ? Number(payload.resolution) : null,
      isActive: Boolean(payload.isActive ?? payload.is_active ?? true),
      lastUpdate: receivedAt,
      receivedAt,
      orderBook: snapshot,
    };
  }

  async fetchMarketState(marketId: string): Promise<MarketState> {
    await this.initializeClient();
    logger.debug("Fetching market state from Polymarket API", marketId);

    if (this.clobClient?.getMarketState) {
      const remote = await this.clobClient.getMarketState(marketId);
      return this.parseMarketPayload(remote) as MarketState;
    }

    const now = Date.now();
    return {
      marketId,
      outcome: "UNKNOWN",
      yesPrice: 0,
      noPrice: 0,
      bestBid: undefined,
      bestAsk: undefined,
      midPrice: undefined,
      liquidity: 0,
      openInterest: 0,
      resolution: null,
      isActive: true,
      lastUpdate: now,
      receivedAt: now,
      orderBook: { bids: [], asks: [], timestamp: now },
    };
  }

  async placeOrder(marketId: string, side: "buy" | "sell", quantity: number, price: number): Promise<string> {
    logger.info("Submitting order to Polymarket CLOB", { marketId, side, quantity, price });

    if (this.clobClient?.placeOrder) {
      return this.clobClient.placeOrder({ marketId, side, quantity, price });
    }

    return `simulated-order-${marketId}-${Date.now()}`;
  }

  calculateMidPrice(snapshot: OrderBookSnapshot): number {
    const bestBid = snapshot.bids[0]?.price ?? 0;
    const bestAsk = snapshot.asks[0]?.price ?? 0;
    return bestBid && bestAsk ? (bestBid + bestAsk) / 2 : Math.max(bestBid, bestAsk);
  }
}
