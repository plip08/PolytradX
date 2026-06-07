/**
 * POLYMARKET CLOB API CLIENT
 *
 * Wraps the Polymarket CLOB REST API and WebSocket feed.
 * All order submission uses gasless EIP-712 signatures.
 * Order book is kept in memory with atomic updates.
 */

import axios, { AxiosInstance } from 'axios';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ProxyAgent } from 'proxy-agent';
import { logger, emitLog } from '../utils/logger.js';
import { buildClobAuthHeaders, WalletManager } from '../core/base.js';
import type {
  OrderBook,
  OrderBookLevel,
  ClobOrder,
  ClobOrderResponse,
  MarketInfo,
  Side,
  OrderType,
} from '../types/index.js';

// ─── Types matching Polymarket CLOB API payloads ──────────────────────────────

interface RawOrderBookEntry {
  price: string;
  size: string;
}

interface RawOrderBook {
  market: string;
  asset_id: string;
  bids: RawOrderBookEntry[];
  asks: RawOrderBookEntry[];
  hash: string;
  timestamp: string;
}

interface RawOrderResponse {
  orderID: string;
  status: string;
  transactionHash?: string;
  matchedAmount?: string;
  averagePrice?: string;
  errorMsg?: string;
}

interface WsBookUpdateMessage {
  event_type: 'book' | 'price_change' | 'tick_size_change' | 'last_trade_price';
  asset_id: string;
  market: string;
  bids?: RawOrderBookEntry[];
  asks?: RawOrderBookEntry[];
  price?: string;
  side?: 'BUY' | 'SELL';
  size?: string;
  timestamp: string;
}

// ─── Order Book Cache ─────────────────────────────────────────────────────────

function parseOrderBook(raw: RawOrderBook): OrderBook {
  const bids: OrderBookLevel[] = raw.bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));
  const asks: OrderBookLevel[] = raw.asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));

  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  const bidDepth = bids.reduce((acc, l) => acc + l.price * l.size, 0);
  const askDepth = asks.reduce((acc, l) => acc + l.price * l.size, 0);
  const totalDepth = bidDepth + askDepth;
  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  return {
    tokenId: raw.asset_id,
    marketId: raw.market,
    bids,
    asks,
    timestamp: parseInt(raw.timestamp, 10) || Date.now(),
    midPrice,
    spread,
    bestBid,
    bestAsk,
    bidDepth,
    askDepth,
    imbalance,
  };
}

// ─── CLOB Client ──────────────────────────────────────────────────────────────

export class ClobClient {
  private static instance: ClobClient | null = null;

  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly proxyAgent: ProxyAgent | undefined;
  private walletManager: WalletManager | null = null;

  private ws: WebSocket | null = null;
  private wsSubscriptions = new Set<string>(); // tokenIds
  private readonly orderBookCache = new Map<string, OrderBook>(); // tokenId → OrderBook
  private readonly obUpdateCallbacks = new Map<string, Set<(ob: OrderBook) => void>>();

  private authHeaders: Record<string, string> = {};
  private authExpiry = 0;
  private readonly AUTH_TTL_MS = 5 * 60 * 1000; // 5 min

  private constructor() {
    this.baseUrl = process.env['POLYMARKET_CLOB_API_URL'] ?? 'https://clob.polymarket.com';
    this.wsUrl =
      process.env['POLYMARKET_WS_URL'] ??
      'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    const proxyUrl = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'];
    this.proxyAgent = proxyUrl ? new ProxyAgent({ getProxyForUrl: () => proxyUrl }) : undefined;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
      ...(this.proxyAgent ? { httpsAgent: this.proxyAgent } : {}),
    });
  }

  static getInstance(): ClobClient {
    if (!ClobClient.instance) {
      ClobClient.instance = new ClobClient();
    }
    return ClobClient.instance;
  }

  setWallet(wallet: WalletManager): void {
    this.walletManager = wallet;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (Date.now() < this.authExpiry && Object.keys(this.authHeaders).length > 0) {
      return this.authHeaders;
    }
    if (!this.walletManager) throw new Error('Wallet not configured');
    this.authHeaders = await buildClobAuthHeaders(this.walletManager);
    this.authExpiry = Date.now() + this.AUTH_TTL_MS;
    return this.authHeaders;
  }

  // ─── Market Data ──────────────────────────────────────────────────────────

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const cached = this.orderBookCache.get(tokenId);
    if (cached && Date.now() - cached.timestamp < 500) return cached; // <500ms cache

    const res = await this.http.get<RawOrderBook>('/book', {
      params: { token_id: tokenId },
    });
    const ob = parseOrderBook(res.data);
    this.orderBookCache.set(tokenId, ob);
    return ob;
  }

  async getMarket(marketId: string): Promise<MarketInfo> {
    const res = await this.http.get<{
      condition_id: string;
      question: string;
      description: string;
      tokens: Array<{ token_id: string; outcome: string }>;
      end_date_iso: string;
      closed: boolean;
      collateral_token: string;
    }>(`/markets/${marketId}`);

    const data = res.data;
    const yes = data.tokens.find((t) => t.outcome === 'Yes');
    const no = data.tokens.find((t) => t.outcome === 'No');

    return {
      id: marketId,
      question: data.question,
      description: data.description,
      yesTokenId: yes?.token_id ?? '',
      noTokenId: no?.token_id ?? '',
      conditionId: data.condition_id,
      collateralToken: data.collateral_token,
      expirationTimestamp: new Date(data.end_date_iso).getTime(),
      resolved: data.closed,
      category: '',
      tags: [],
    };
  }

  async searchMarkets(query: string, limit = 50): Promise<MarketInfo[]> {
    const res = await this.http.get<{ data: unknown[] }>('/markets', {
      params: { _q: query, limit },
    });
    // Simplified mapping — adapt to actual API shape
    return res.data.data.map((m: unknown) => m as MarketInfo);
  }

  // ─── Order Placement ──────────────────────────────────────────────────────

  async placeOrder(order: ClobOrder): Promise<ClobOrderResponse> {
    const headers = await this.getAuthHeaders();
    const salt = BigInt(Math.floor(Math.random() * 1e18));
    const tokenIdBig = BigInt(order.tokenId);
    const makerAmount = BigInt(Math.round(order.size * order.price * 1e6)); // USDC 6 decimals
    const takerAmount = BigInt(Math.round(order.size * 1e6));

    const orderStruct = {
      salt,
      maker: this.walletManager!.getAddress(),
      signer: this.walletManager!.getAddress(),
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: tokenIdBig,
      makerAmount,
      takerAmount,
      expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: 0n,
      feeRateBps: 0n,
      side: order.side === 'BUY' ? 0n : 1n,
      signatureType: 0n,
    };

    const signature = await this.walletManager!.signClobOrder(
      Object.fromEntries(
        Object.entries(orderStruct).map(([k, v]) => [k, v.toString()]),
      ),
    );

    const payload = {
      order: {
        ...Object.fromEntries(
          Object.entries(orderStruct).map(([k, v]) => [k, v.toString()]),
        ),
        signature,
      },
      owner: this.walletManager!.getAddress(),
      orderType: order.type === 'MARKET' ? 'MKT' : 'GTC',
    };

    const res = await this.http.post<RawOrderResponse>('/order', payload, {
      headers,
    });

    const raw = res.data;
    if (raw.errorMsg) {
      throw new Error(`CLOB order rejected: ${raw.errorMsg}`);
    }

    emitLog('INFO', `Order placed: ${order.side} ${order.size} @ ${order.price}`, {
      orderId: raw.orderID,
      strategyId: undefined,
    });

    return {
      orderId: raw.orderID,
      status: (raw.status as ClobOrderResponse['status']) ?? 'OPEN',
      transactionHash: raw.transactionHash,
      filledAmount: raw.matchedAmount ? parseFloat(raw.matchedAmount) : undefined,
      averageFillPrice: raw.averagePrice ? parseFloat(raw.averagePrice) : undefined,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    await this.http.delete(`/order/${orderId}`, { headers });
    emitLog('INFO', `Order cancelled: ${orderId}`);
  }

  async cancelAllOrders(): Promise<void> {
    const headers = await this.getAuthHeaders();
    await this.http.delete('/orders', { headers });
    emitLog('WARN', 'All orders cancelled — kill switch triggered');
  }

  async getOpenOrders(): Promise<ClobOrder[]> {
    const headers = await this.getAuthHeaders();
    const res = await this.http.get<{ data: ClobOrder[] }>('/orders', {
      headers,
      params: { status: 'OPEN' },
    });
    return res.data.data;
  }

  // ─── WebSocket Subscription ───────────────────────────────────────────────

  subscribeToOrderBook(
    tokenId: string,
    callback: (ob: OrderBook) => void,
  ): () => void {
    if (!this.obUpdateCallbacks.has(tokenId)) {
      this.obUpdateCallbacks.set(tokenId, new Set());
    }
    this.obUpdateCallbacks.get(tokenId)!.add(callback);

    if (!this.wsSubscriptions.has(tokenId)) {
      this.wsSubscriptions.add(tokenId);
      this.ensureWsConnection();
      this.sendWsSubscription(tokenId);
    }

    return () => {
      this.obUpdateCallbacks.get(tokenId)?.delete(callback);
    };
  }

  private wsReconnectDelay = 1_000;
  private readonly WS_MAX_RECONNECT_DELAY = 30_000;

  private ensureWsConnection(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.wsUrl, { agent: this.proxyAgent });

    this.ws.on('open', () => {
      logger.info('[CLOB WS] Connected');
      this.wsReconnectDelay = 1_000; // reset backoff on successful connect
      for (const tokenId of this.wsSubscriptions) {
        this.sendWsSubscription(tokenId);
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsBookUpdateMessage;
        this.handleWsMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on('close', () => {
      // Exponential backoff: 1s → 2s → 4s → … → 30s max
      logger.warn(`[CLOB WS] Disconnected — reconnecting in ${this.wsReconnectDelay / 1000}s`);
      setTimeout(() => {
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, this.WS_MAX_RECONNECT_DELAY);
        this.ensureWsConnection();
      }, this.wsReconnectDelay);
    });

    this.ws.on('error', (err) => {
      logger.error('[CLOB WS] Error', { err });
      // error always followed by close — backoff handled there
    });
  }

  private sendWsSubscription(tokenId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        auth: {},
        type: 'Market',
        markets: [],
        assets_ids: [tokenId],
      }),
    );
  }

  private handleWsMessage(msg: WsBookUpdateMessage): void {
    if (msg.event_type !== 'book' && msg.event_type !== 'price_change') return;

    const existing = this.orderBookCache.get(msg.asset_id);
    if (!existing) return;

    // Apply incremental update
    if (msg.bids || msg.asks) {
      const updatedOb: OrderBook = {
        ...existing,
        bids: msg.bids
          ? msg.bids.map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
          : existing.bids,
        asks: msg.asks
          ? msg.asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
          : existing.asks,
        timestamp: Date.now(),
      };

      updatedOb.bids.sort((a, b) => b.price - a.price);
      updatedOb.asks.sort((a, b) => a.price - b.price);
      updatedOb.bestBid = updatedOb.bids[0]?.price ?? 0;
      updatedOb.bestAsk = updatedOb.asks[0]?.price ?? 1;
      updatedOb.midPrice = (updatedOb.bestBid + updatedOb.bestAsk) / 2;
      updatedOb.spread = updatedOb.bestAsk - updatedOb.bestBid;

      this.orderBookCache.set(msg.asset_id, updatedOb);

      for (const cb of this.obUpdateCallbacks.get(msg.asset_id) ?? []) {
        cb(updatedOb);
      }
    }
  }

  getCachedOrderBook(tokenId: string): OrderBook | null {
    return this.orderBookCache.get(tokenId) ?? null;
  }
}
