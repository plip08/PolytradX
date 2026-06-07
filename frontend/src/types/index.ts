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
  ATOMIC_ARB:       'Atomic Arbitrage',
  MARKET_MAKER:     'Market Maker',
  LATENCY_ARB:      'Latency Arb',
  LOGIC_ARB:        'Logic Arb',
  NEGATIVE_RISK:    'Negative Risk',
  RESOLUTION_SNIPE: 'Resolution Sniper',
  AI_AGENT:         'AI Agent',
};

export const STRATEGY_DESCRIPTIONS: Record<StrategyId, string> = {
  ATOMIC_ARB:
    'Sur Polymarket, chaque marché binaire a deux tokens : YES et NO. Ensemble ils valent exactement $1.00 à la résolution. ' +
    'Si bestAsk(YES) + bestAsk(NO) < $1.00, le bot achète les deux simultanément en FOK, puis les fusionne (merge) on-chain pour encaisser $1.00. ' +
    'Profit garanti = $1.00 − coût combiné − gas. Capital : $60.',

  MARKET_MAKER:
    'Poste en permanence un bid et un ask autour du prix médian pour capter le spread. ' +
    'À chaque mouvement de prix > 0.5%, annule et re-poste les deux ordres en < 100ms. ' +
    'Revenus : spread encaissé + rebates Polymarket pour liquidité fournie. Nécessite $5k+ pour être compétitif.',

  LATENCY_ARB:
    'Connecté à un feed sportif en temps réel (WebSocket). Quand un événement critique survient (but, fin de match), ' +
    'vérifie si le carnet Polymarket reflète encore l\'ancien prix. ' +
    'Si le lag > 5%, sweep agressif de toute la liquidité obsolète avant suspension du marché. Nécessite un abonnement Betfair/Pinnacle.',

  LOGIC_ARB:
    'Certaines paires de marchés ont des relations logiques : si "BTC > $100k" cote 30%, ' +
    'alors "BTC > $90k" doit coter ≥ 30% (l\'implication logique l\'exige). ' +
    'Toute inversion détectée au-delà de 5% de spread déclenche un achat du token sous-évalué. Capital : $20.',

  NEGATIVE_RISK:
    'Dans un événement multi-outcomes (ex: "Qui sera le prochain président ?"), exactement un outcome résout YES. ' +
    'Donc la somme des prix YES doit être ≈ 1.0. Si elle dépasse 1.02, une arb mathématique existe : ' +
    'acheter les tokens NO des outcomes sur-évalués. Profit garanti = excès au-dessus de 1.0. Capital : $45.',

  RESOLUTION_SNIPE:
    'Scanne toutes les 60s les marchés expirant dans < 6h (84 marchés actuellement). ' +
    'Quand un marché résout mais que des vendeurs n\'ont pas encore mis à jour leurs ordres, ' +
    'le bot achète instantanément les tokens gagnants sous-cotés (ex: YES à $0.92 au lieu de $1.00). ' +
    'Profit garanti = $1.00 − prix_snipé − gas. Capital : $55.',

  AI_AGENT:
    'Analyse en continu les actualités et données de marché avec un LLM (Claude/GPT/Grok). ' +
    'Génère des signaux de trading quand la confiance dépasse le seuil configuré (90%). ' +
    'Utile pour anticiper des mouvements sur des marchés politiques ou d\'actualité. Désactivé : trop coûteux en tokens API.',
};
