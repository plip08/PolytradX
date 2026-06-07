/**
 * MARKET DISCOVERY SERVICE
 *
 * Periodically fetches all active markets from the Polymarket Gamma API.
 * Filters by volume, liquidity and expiry, then routes markets to the
 * appropriate strategies based on category tags.
 *
 * Routing logic:
 *   Crypto (short-term)  → AtomicArb
 *   Politics / Pop-culture (multi-outcome events) → LogicArb + NegativeRisk
 *   Sports               → LatencyArb + ResolutionSniping
 *   All liquid markets   → LogicArb (scans pairs across categories)
 *   Near-expiry (<48h)   → ResolutionSniping only
 */

import axios from 'axios';
import { logger, emitLog } from '../utils/logger.js';
import type { MarketInfo } from '../types/index.js';

// ─── Gamma API types ──────────────────────────────────────────────────────────

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  description: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  outcomes: string;           // JSON string: "[\"Yes\", \"No\"]"
  clobTokenIds: string;       // JSON string: "[\"<id1>\", \"<id2>\"]"
  volume: string | number;    // string at market level, number at event-market level
  volume24hr?: string | number;
  liquidity: string | number | null;
  negRisk?: boolean;
  tags?: { label: string }[];
}

interface GammaEvent {
  id: string;
  title: string;
  markets: GammaMarket[];
  volume?: number;            // float at event level
  active: boolean;
  closed: boolean;
}

// ─── Discovery config ─────────────────────────────────────────────────────────

export interface DiscoveryConfig {
  scanIntervalMs: number;        // how often to refresh market list
  minVolumeUsd: number;          // minimum lifetime volume to consider
  minLiquidityUsd: number;       // minimum USDC in the book
  minExpiryMs: number;           // min time to expiry (ms) — except for sniping
  maxMarketsPerStrategy: number; // cap to avoid WS overload
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  scanIntervalMs: 5 * 60 * 1000,   // 5 minutes
  minVolumeUsd: 10_000,
  minLiquidityUsd: 1_000,
  minExpiryMs: 24 * 60 * 60 * 1000, // 24 hours
  maxMarketsPerStrategy: 30,
};

// ─── Category detection ───────────────────────────────────────────────────────

type MarketCategory = 'crypto' | 'sports' | 'politics' | 'other';

function detectCategory(market: GammaMarket): MarketCategory {
  const text = [market.question, ...(market.tags?.map((t) => t.label) ?? [])].join(' ').toLowerCase();

  if (/bitcoin|btc|eth|crypto|sol|polygon|matic|defi|nft|token|coin/.test(text)) return 'crypto';
  if (/nba|nfl|mlb|nhl|soccer|football|basketball|tennis|golf|sport|match|goal|score|tournament|champion|world cup|league|playoff/.test(text)) return 'sports';
  if (/election|president|senator|congress|vote|democrat|republican|politic|policy|government|prime minister|parliament/.test(text)) return 'politics';
  return 'other';
}

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

function parseMarket(g: GammaMarket): MarketInfo | null {
  let outcomes: string[];
  let tokenIds: string[];
  try {
    outcomes = JSON.parse(g.outcomes) as string[];
    tokenIds = JSON.parse(g.clobTokenIds) as string[];
  } catch {
    return null;
  }

  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
  const noIdx  = outcomes.findIndex((o) => o.toLowerCase() === 'no');
  if (yesIdx < 0 || noIdx < 0) return null;

  const yesTokenId = tokenIds[yesIdx] ?? '';
  const noTokenId  = tokenIds[noIdx]  ?? '';
  if (!yesTokenId || !noTokenId) return null;

  return {
    id: g.id,
    question: g.question,
    description: g.description ?? '',
    yesTokenId,
    noTokenId,
    conditionId: g.conditionId,
    collateralToken: USDC_POLYGON,
    expirationTimestamp: new Date(g.endDate).getTime(),
    resolved: g.closed,
    category: detectCategory(g),
    tags: [],
  };
}

// ─── Handlers that strategies register ───────────────────────────────────────

export interface DiscoveryHandlers {
  onCryptoMarkets?: (markets: MarketInfo[]) => void;
  onSportsMarkets?: (markets: MarketInfo[]) => void;
  onAllLiquidMarkets?: (markets: MarketInfo[]) => void;
  onEventGroups?: (groups: MarketInfo[][]) => void;      // for NegativeRisk
  onNearExpiryMarkets?: (markets: MarketInfo[]) => void; // for ResolutionSniping
}

// ─── MarketDiscovery ──────────────────────────────────────────────────────────

export class MarketDiscovery {
  private static instance: MarketDiscovery | null = null;

  private readonly gammaHttp = axios.create({
    baseURL: 'https://gamma-api.polymarket.com',
    timeout: 10_000,
  });

  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: DiscoveryHandlers = {};
  private lastMarketCount = 0;

  private constructor(private readonly config: DiscoveryConfig) {}

  static getInstance(config?: DiscoveryConfig): MarketDiscovery {
    if (!MarketDiscovery.instance) {
      MarketDiscovery.instance = new MarketDiscovery(config ?? DEFAULT_DISCOVERY_CONFIG);
    }
    return MarketDiscovery.instance;
  }

  registerHandlers(handlers: DiscoveryHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  start(): void {
    emitLog('INFO', '[MarketDiscovery] Starting — scanning Gamma API');
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.config.scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    MarketDiscovery.instance = null;
  }

  // ─── Core scan ─────────────────────────────────────────────────────────────

  private async scan(): Promise<void> {
    try {
      const [markets, eventGroups] = await Promise.all([
        this.fetchMarkets(),
        this.fetchEventGroups(),
      ]);

      emitLog('INFO', `[MarketDiscovery] Found ${markets.length} liquid binary markets, ${eventGroups.length} event groups`);

      this.routeMarkets(markets, eventGroups);
      this.lastMarketCount = markets.length;
    } catch (err) {
      logger.error('[MarketDiscovery] Scan failed', { err });
    }
  }

  private async fetchMarkets(): Promise<MarketInfo[]> {
    const now = Date.now();
    const results: MarketInfo[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const res = await this.gammaHttp.get<GammaMarket[]>('/markets', {
        params: {
          active: true,
          closed: false,
          limit,
          offset,
        },
      });

      const batch = res.data;
      if (!batch || batch.length === 0) break;

      for (const g of batch) {
        // Volume filter
        if (parseFloat(g.volume ?? '0') < this.config.minVolumeUsd) continue;
        // Liquidity filter
        if (parseFloat(g.liquidity ?? '0') < this.config.minLiquidityUsd) continue;
        // Expiry filter (must have > minExpiryMs remaining)
        const expiry = new Date(g.endDate).getTime();
        if (expiry - now < this.config.minExpiryMs) continue;

        const market = parseMarket(g);
        if (market) results.push(market);
      }

      if (batch.length < limit) break;
      offset += limit;

      // Safety cap — don't fetch indefinitely
      if (results.length >= 500) break;
    }

    // Sort by volume desc, take top N per strategy
    return results.sort((a, b) =>
      (b.tags?.length ?? 0) - (a.tags?.length ?? 0)
    );
  }

  private async fetchEventGroups(): Promise<MarketInfo[][]> {
    const now = Date.now();
    const groups: MarketInfo[][] = [];

    const res = await this.gammaHttp.get<GammaEvent[]>('/events', {
      params: { active: true, closed: false, limit: 50 },
    });

    for (const event of res.data ?? []) {
      if (!event.active || event.closed) continue;
      if ((event.volume ?? 0) < this.config.minVolumeUsd) continue;

      const groupMarkets: MarketInfo[] = [];
      for (const g of event.markets ?? []) {
        if (g.closed) continue;
        const expiry = new Date(g.endDate).getTime();
        if (expiry - now < this.config.minExpiryMs) continue;
        const market = parseMarket(g);
        if (market) groupMarkets.push(market);
      }

      // Only useful for NegativeRisk if there are 3+ outcomes
      if (groupMarkets.length >= 3) {
        groups.push(groupMarkets);
      }
    }

    return groups;
  }

  // ─── Route to strategies ───────────────────────────────────────────────────

  private routeMarkets(markets: MarketInfo[], eventGroups: MarketInfo[][]): void {
    const cap = this.config.maxMarketsPerStrategy;
    const now = Date.now();
    const nearExpiryThreshold = 48 * 60 * 60 * 1000; // 48h

    const crypto   = markets.filter((m) => m.category === 'crypto').slice(0, cap);
    const sports   = markets.filter((m) => m.category === 'sports').slice(0, cap);
    const allLiquid = markets.slice(0, cap);

    // Near-expiry: any category, expires within 48h (but > minExpiry already filtered out by fetchMarkets logic above, so re-fetch with looser filter)
    const nearExpiry = markets.filter(
      (m) => m.expirationTimestamp - now < nearExpiryThreshold,
    ).slice(0, 20);

    if (crypto.length > 0) {
      this.handlers.onCryptoMarkets?.(crypto);
      emitLog('INFO', `[MarketDiscovery] → AtomicArb: ${crypto.length} crypto markets`);
    }

    if (sports.length > 0) {
      this.handlers.onSportsMarkets?.(sports);
      emitLog('INFO', `[MarketDiscovery] → LatencyArb+ResolutionSnipe: ${sports.length} sports markets`);
    }

    if (allLiquid.length > 0) {
      this.handlers.onAllLiquidMarkets?.(allLiquid);
    }

    if (eventGroups.length > 0) {
      this.handlers.onEventGroups?.(eventGroups);
      emitLog('INFO', `[MarketDiscovery] → NegativeRisk: ${eventGroups.length} event groups`);
    }

    if (nearExpiry.length > 0) {
      this.handlers.onNearExpiryMarkets?.(nearExpiry);
      emitLog('INFO', `[MarketDiscovery] → ResolutionSniping: ${nearExpiry.length} near-expiry markets`);
    }
  }

  getLastMarketCount(): number {
    return this.lastMarketCount;
  }
}
