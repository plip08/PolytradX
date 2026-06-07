/**
 * FRONTEND TYPE DEFINITIONS
 * Mirrors backend types for type-safe WS message handling
 */

export type AiProvider = 'ANTHROPIC' | 'OPENAI' | 'GROK' | 'GOOGLE';

export interface AiModelMeta {
  id: string;
  label: string;
  contextWindow: number;
  reasoning: boolean;
}

export type AiModelsMap = Record<AiProvider, AiModelMeta[]>;

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  ANTHROPIC: 'Anthropic (Claude)',
  OPENAI: 'OpenAI (GPT)',
  GROK: 'xAI (Grok)',
  GOOGLE: 'Google (Gemini)',
};

export const PROVIDER_COLORS: Record<AiProvider, string> = {
  ANTHROPIC: 'text-orange-400 border-orange-500/50',
  OPENAI:    'text-green-400 border-green-500/50',
  GROK:      'text-sky-400 border-sky-500/50',
  GOOGLE:    'text-blue-400 border-blue-500/50',
};

export type Side = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'PARTIALLY_FILLED' | 'PENDING';
export type StrategyStatus = 'IDLE' | 'SCANNING' | 'EXECUTING' | 'ERROR' | 'PAUSED' | 'DISABLED';
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

export interface TradeExecution {
  id: string;
  strategyId: StrategyId;
  marketId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  pnl?: number;
  txHash?: string;
  timestamp: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'SIMULATED';
  gasUsed?: string;
  polygonscanUrl?: string;
}

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  strategyId?: StrategyId;
  data?: unknown;
  timestamp: number;
}

export interface StrategyConfig {
  id: StrategyId;
  enabled: boolean;
  maxSlippagePct: number;
  minProfitUsd: number;
  capitalAllocationUsd: number;
  gasStrategy: GasStrategy;
  dryRun: boolean;
  customParams: Record<string, unknown>;
}

export type ConfigMap = Record<StrategyId, StrategyConfig>;

export interface AiAnalysis {
  id: string;
  newsItem: {
    id: string;
    headline: string;
    content: string;
    source: string;
    timestamp: number;
  };
  rawPrompt: string;
  reasoning: string;
  extractedProbability: number;
  confidence: number;
  signal: 'BUY_YES' | 'BUY_NO' | 'NO_ACTION';
  targetMarketId?: string;
  modelUsed: string;
  latencyMs: number;
  timestamp: number;
}

export interface PnlSnapshot {
  timestamp: number;
  cumulativePnL: number;
}

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  ATOMIC_ARB: 'Atomic Arbitrage',
  MARKET_MAKER: 'Market Maker',
  LATENCY_ARB: 'Latency Arb',
  LOGIC_ARB: 'Logic Arb',
  NEGATIVE_RISK: 'Negative Risk',
  RESOLUTION_SNIPE: 'Resolution Sniper',
  AI_AGENT: 'AI Agent',
};

export const STRATEGY_DESCRIPTIONS: Record<StrategyId, string> = {
  ATOMIC_ARB: 'Buys YES+NO simultaneously and merges for $1.00',
  MARKET_MAKER: 'Delta-neutral bid/ask market making with < 100ms rebalance',
  LATENCY_ARB: 'Sweeps stale liquidity on critical sports events',
  LOGIC_ARB: 'Exploits logical price inconsistencies across correlated markets',
  NEGATIVE_RISK: 'Buys NO tokens when sum of YES prices > 1.0 in categorical markets',
  RESOLUTION_SNIPE: 'Snipes winning tokens priced < $0.99 before market closes',
  AI_AGENT: 'LLM-powered news analysis → high-confidence trading signals',
};
