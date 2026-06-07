/**
 * ============================================================
 * POLYMARKET QUANT BOT — Shared Type Definitions
 * ============================================================
 *
 * REQUIRED NPM PACKAGES (backend):
 * ─────────────────────────────────
 * Runtime:
 *   ethers@^6.13.0
 *   @polymarket/clob-client@^2.x
 *   ws@^8.18.0
 *   axios@^1.7.0
 *   dotenv@^16.4.0
 *   winston@^3.13.0
 *   openai@^4.52.0
 *   @anthropic-ai/sdk@^0.27.0
 *   express@^4.19.0
 *   cors@^2.8.5
 *   @prisma/client@^5.16.0
 *   prisma@^5.16.0
 *   uuid@^10.0.0
 *
 * Dev / Types:
 *   typescript@^5.5.0
 *   ts-node@^10.9.0
 *   @types/node@^22.0.0
 *   @types/ws@^8.5.0
 *   @types/express@^4.17.0
 *   @types/cors@^2.8.0
 *   @types/uuid@^10.0.0
 *   tsup@^8.0.0
 *
 * REQUIRED NPM PACKAGES (frontend):
 * ──────────────────────────────────
 *   next@^14.2.0
 *   react@^18.3.0
 *   react-dom@^18.3.0
 *   tailwindcss@^3.4.0
 *   zustand@^4.5.0
 *   lightweight-charts@^4.1.0
 *   react-virtuoso@^4.7.0
 *   @radix-ui/react-switch@^1.1.0
 *   @radix-ui/react-slider@^1.2.0
 *   @radix-ui/react-toast@^1.2.0
 *   @radix-ui/react-dialog@^1.1.0
 *   @radix-ui/react-badge@^1.0.0
 *   clsx@^2.1.0
 *   tailwind-merge@^2.3.0
 *   lucide-react@^0.400.0
 *   recharts@^2.12.0
 *   @types/react@^18.3.0
 *   @types/react-dom@^18.3.0
 */

// ─── Primitive Enumerations ───────────────────────────────────────────────────

export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'FOK' | 'IOC';
export type OrderStatus =
  | 'OPEN'
  | 'FILLED'
  | 'CANCELLED'
  | 'PARTIALLY_FILLED'
  | 'PENDING';

export type StrategyStatus =
  | 'IDLE'
  | 'SCANNING'
  | 'EXECUTING'
  | 'ERROR'
  | 'PAUSED'
  | 'DISABLED';

export type StrategyId =
  | 'ATOMIC_ARB'
  | 'MARKET_MAKER'
  | 'LATENCY_ARB'
  | 'LOGIC_ARB'
  | 'NEGATIVE_RISK'
  | 'RESOLUTION_SNIPE'
  | 'AI_AGENT';

export type GasStrategy = 'STANDARD' | 'FAST' | 'FRONTRUN';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';
export type Outcome = 'YES' | 'NO';

// ─── Order Book Types ─────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;    // 0-1 range (USDC)
  size: number;     // token units
}

export interface OrderBook {
  tokenId: string;
  marketId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
  // Derived convenience fields
  midPrice: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  bidDepth: number;   // total liquidity on bid side (USDC)
  askDepth: number;   // total liquidity on ask side (USDC)
  imbalance: number;  // (bidDepth - askDepth) / (bidDepth + askDepth)
}

// ─── CLOB / Order Types ───────────────────────────────────────────────────────

export interface ClobOrder {
  id?: string;
  marketId: string;
  tokenId: string;
  side: Side;
  type: OrderType;
  price: number;
  size: number;
  slippageTolerance?: number; // pct, e.g. 0.02 = 2%
  signature?: string;         // EIP-712 sig for gasless orders
  salt?: string;
  status?: OrderStatus;
  filledAmount?: number;
  averageFillPrice?: number;
  createdAt?: number;
  expiresAt?: number;
}

export interface ClobOrderResponse {
  orderId: string;
  status: OrderStatus;
  transactionHash?: string;
  filledAmount?: number;
  averageFillPrice?: number;
}

// ─── Trade & Execution Types ──────────────────────────────────────────────────

export interface TradeExecution {
  id: string;
  strategyId: StrategyId;
  marketId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  slippage?: number;
  pnl?: number;
  txHash?: string;
  timestamp: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'SIMULATED';
  gasUsed?: bigint;
  gasCostUsdc?: number;
  errorMessage?: string;
  polygonscanUrl?: string;
}

// ─── Strategy Configuration ───────────────────────────────────────────────────

export interface StrategyConfig {
  id: StrategyId;
  enabled: boolean;
  maxSlippagePct: number;       // e.g. 0.02 = 2%
  minProfitUsd: number;         // minimum expected profit to trigger execution
  capitalAllocationUsd: number; // max capital per strategy loop
  gasStrategy: GasStrategy;
  dryRun: boolean;
  customParams: Record<string, unknown>;
}

export type ConfigMap = Record<StrategyId, StrategyConfig>;

// ─── Bot Global State ─────────────────────────────────────────────────────────

export interface BotState {
  strategies: Record<StrategyId, StrategyStatus>;
  strategyMetrics: Record<StrategyId, Record<string, number | string>>;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  walletBalanceUsdc: number;
  walletBalancePol: number;
  isKillSwitchActive: boolean;
  activeOrders: number;
  uptime: number;
  lastUpdated: number;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  strategyId?: StrategyId;
  data?: unknown;
  timestamp: number;
}

// ─── Gas / RPC ────────────────────────────────────────────────────────────────

export interface GasPrices {
  baseFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  estimatedCostWei: bigint;
  estimatedCostUsdc: number;
}

export interface RpcConfig {
  httpUrl: string;
  wsUrl: string;
  fallbackHttpUrls: string[];
  chainId: number;       // 137 for Polygon mainnet
  timeoutMs: number;
}

// ─── Market Info ──────────────────────────────────────────────────────────────

export interface MarketInfo {
  id: string;
  question: string;
  description: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId: string;
  collateralToken: string;      // USDC address
  expirationTimestamp: number;
  resolved: boolean;
  resolvedOutcome?: Outcome;
  category: string;
  tags: string[];
}

// ─── Logic Arb Types ──────────────────────────────────────────────────────────

export interface LogicPair {
  id: string;
  description: string;
  marketA: { marketId: string; tokenId: string; side: Outcome };
  marketB: { marketId: string; tokenId: string; side: Outcome };
  relation: 'A_IMPLIES_B' | 'B_IMPLIES_A' | 'MUTUALLY_EXCLUSIVE' | 'CORRELATED';
  minDiscrepancyPct: number;  // minimum price gap to trigger
  maxPositionUsd: number;
}

export interface LogicDiscrepancy {
  pair: LogicPair;
  priceA: number;
  priceB: number;
  discrepancyPct: number;
  expectedAction: 'BUY_B' | 'BUY_A' | 'SELL_A_BUY_B';
  expectedProfitUsd: number;
}

// ─── Negative Risk Types ──────────────────────────────────────────────────────

export interface MultiCategoryMarket {
  groupId: string;
  description: string;
  outcomes: Array<{
    tokenId: string;
    marketId: string;
    label: string;
    yesPrice: number;
    noPrice: number;
    impliedProbability: number;
  }>;
  sumYesPrices: number;
  excessAboveOne: number;  // sumYesPrices - 1.0 = guaranteed profit pct
}

export interface NegativeRiskAllocation {
  market: MultiCategoryMarket;
  tradesRequired: Array<{
    tokenId: string;
    marketId: string;
    label: string;
    action: 'BUY_NO';
    price: number;
    size: number;
    expectedContribution: number;
  }>;
  totalCapitalRequired: number;
  expectedProfitUsd: number;
  profitPct: number;
}

// ─── Oracle / Resolution Sniping ──────────────────────────────────────────────

export interface OracleProposal {
  proposalId: string;
  marketId: string;
  conditionId: string;
  proposedOutcome: Outcome;
  bondAmount: bigint;
  proposalTimestamp: number;
  expiryTimestamp: number;
  status: 'PENDING' | 'DISPUTED' | 'SETTLED' | 'EXPIRED';
  blockNumber: number;
}

export interface ResolutionOpportunity {
  marketId: string;
  winningTokenId: string;
  losingTokenId: string;
  currentWinningPrice: number;  // should be ~1.0, if < 0.99 it's a snipe
  availableSize: number;
  expectedProfitPct: number;
  urgencyMs: number;           // estimated time before market closes
}

// ─── Sports Feed / Latency Arb ────────────────────────────────────────────────

export interface SportEvent {
  eventId: string;
  sport: 'SOCCER' | 'BASKETBALL' | 'TENNIS' | 'AMERICAN_FOOTBALL' | 'OTHER';
  competition: string;
  homeTeam: string;
  awayTeam: string;
  status: 'LIVE' | 'FINISHED' | 'PAUSED' | 'HALFTIME';
  score: { home: number; away: number };
  elapsedMinutes?: number;
  criticalEvent: {
    type: 'GOAL' | 'THREE_POINTER' | 'TOUCHDOWN' | 'MATCH_END' | 'NONE';
    description: string;
    timestamp: number;
  } | null;
  polymarketMappings: Array<{
    tokenId: string;
    marketId: string;
    relevantSide: Outcome;
    stalePriceThreshold: number; // if price differs > this from expected, fire
  }>;
}

// ─── AI Agent Types ───────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  headline: string;
  content: string;
  source: 'TWITTER' | 'NEWS_API' | 'RSS' | 'SIMULATED';
  url?: string;
  timestamp: number;
  relatedMarketIds?: string[];
  sentiment?: number; // -1 to 1
}

export interface AiAnalysis {
  id: string;
  newsItem: NewsItem;
  rawPrompt: string;
  reasoning: string;
  extractedProbability: number; // 0-1
  confidence: number;            // 0-1
  signal: 'BUY_YES' | 'BUY_NO' | 'NO_ACTION';
  targetMarketId?: string;
  targetTokenId?: string;
  targetPrice?: number;
  expectedEdgePct?: number;
  modelUsed: string;
  latencyMs: number;
  timestamp: number;
}

// ─── WebSocket Protocol ───────────────────────────────────────────────────────

export type WsMessageType =
  | 'BOT_STATE_UPDATE'
  | 'STRATEGY_STATUS_UPDATE'
  | 'TRADE_EXECUTED'
  | 'LOG_ENTRY'
  | 'ORDER_BOOK_UPDATE'
  | 'AI_ANALYSIS'
  | 'CONFIG_UPDATED'
  | 'KILL_SWITCH_ACTIVATED'
  | 'GAS_UPDATE'
  | 'ORACLE_PROPOSAL'
  | 'SPORT_EVENT_UPDATE'
  | 'PNL_UPDATE';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: number;
  sequenceId?: number;
}

// ─── P&L Snapshot (for charting) ─────────────────────────────────────────────

export interface PnlSnapshot {
  timestamp: number;
  cumulativePnL: number;
  sessionPnL: number;
  strategyBreakdown: Record<StrategyId, number>;
}
