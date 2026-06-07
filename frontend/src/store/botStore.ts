/**
 * ZUSTAND GLOBAL STATE STORE
 *
 * Single source of truth for all real-time bot data.
 * Updated exclusively via WebSocket message handlers.
 * Components subscribe to atomic slices to minimize re-renders.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  BotState,
  LogEntry,
  TradeExecution,
  AiAnalysis,
  ConfigMap,
  StrategyId,
  StrategyStatus,
  PnlSnapshot,
} from '../types/index';

const MAX_LOGS = 500;
const MAX_TRADES = 200;
const MAX_PNL_SNAPSHOTS = 3600; // 1h at 1 update/s

let _toastSeq = 0;

export interface Toast {
  id: string;
  type: 'error' | 'success' | 'warning' | 'info';
  title: string;
  description?: string;
  duration?: number;
}

interface BotStore {
  // Connection state
  wsStatus: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  setWsStatus: (status: BotStore['wsStatus']) => void;

  // Bot state snapshot
  botState: BotState | null;
  setBotState: (state: BotState) => void;

  // Strategy status overrides (for instant UI feedback)
  strategyStatuses: Partial<Record<StrategyId, StrategyStatus>>;
  setStrategyStatus: (id: StrategyId, status: StrategyStatus) => void;

  // Execution log
  logs: LogEntry[];
  appendLog: (entry: LogEntry) => void;
  clearLogs: () => void;

  // Trade history
  trades: TradeExecution[];
  appendTrade: (trade: TradeExecution) => void;

  // AI Analyses
  aiAnalyses: AiAnalysis[];
  latestAnalysis: AiAnalysis | null;
  appendAiAnalysis: (analysis: AiAnalysis) => void;

  // P&L time series (for chart)
  pnlSeries: PnlSnapshot[];
  appendPnlSnapshot: (snap: PnlSnapshot) => void;

  // Config
  config: ConfigMap | null;
  setConfig: (config: ConfigMap) => void;
  patchStrategyConfig: (id: StrategyId, patch: Partial<ConfigMap[StrategyId]>) => void;

  // Kill switch
  isKillSwitchActive: boolean;
  setKillSwitch: (active: boolean) => void;

  // Toast notifications
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;

  // Derived totals (computed on each BotState update)
  totalPnL: number;
  winRate: number;
  activeOrders: number;
}

export const useBotStore = create<BotStore>()(
  subscribeWithSelector((set, get) => ({
    wsStatus: 'CONNECTING',
    setWsStatus: (wsStatus) => set({ wsStatus }),

    botState: null,
    setBotState: (botState) =>
      set({
        botState,
        totalPnL: botState.totalPnL,
        winRate: botState.winRate,
        activeOrders: botState.activeOrders,
        isKillSwitchActive: botState.isKillSwitchActive,
        // Merge strategy statuses from snapshot (WS override takes precedence for 2s)
        strategyStatuses: {
          ...botState.strategies,
          ...get().strategyStatuses,
        },
      }),

    strategyStatuses: {},
    setStrategyStatus: (id, status) =>
      set((state) => ({
        strategyStatuses: { ...state.strategyStatuses, [id]: status },
      })),

    logs: [],
    appendLog: (entry) =>
      set((state) => ({
        logs: [entry, ...state.logs].slice(0, MAX_LOGS),
      })),
    clearLogs: () => set({ logs: [] }),

    trades: [],
    appendTrade: (trade) =>
      set((state) => ({
        trades: [trade, ...state.trades].slice(0, MAX_TRADES),
      })),

    aiAnalyses: [],
    latestAnalysis: null,
    appendAiAnalysis: (analysis) =>
      set((state) => ({
        latestAnalysis: analysis,
        aiAnalyses: [analysis, ...state.aiAnalyses].slice(0, 50),
      })),

    pnlSeries: [],
    appendPnlSnapshot: (snap) =>
      set((state) => ({
        pnlSeries: [...state.pnlSeries, snap].slice(-MAX_PNL_SNAPSHOTS),
      })),

    config: null,
    setConfig: (config) => set({ config }),
    patchStrategyConfig: (id, patch) =>
      set((state) => {
        if (!state.config) return state;
        return {
          config: {
            ...state.config,
            [id]: { ...state.config[id], ...patch },
          },
        };
      }),

    isKillSwitchActive: false,
    setKillSwitch: (active) => set({ isKillSwitchActive: active }),

    toasts: [],
    addToast: (toast) =>
      set((state) => ({
        toasts: [...state.toasts, { ...toast, id: `t${++_toastSeq}` }],
      })),
    removeToast: (id) =>
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      })),

    totalPnL: 0,
    winRate: 0,
    activeOrders: 0,
  })),
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectStrategyStatus = (id: StrategyId) => (state: BotStore): StrategyStatus =>
  state.strategyStatuses[id] ?? state.botState?.strategies[id] ?? 'IDLE';

export const selectStrategyMetrics = (id: StrategyId) => (state: BotStore) =>
  state.botState?.strategyMetrics[id] ?? {};

export const selectErrorLogs = (state: BotStore): LogEntry[] =>
  state.logs.filter((l) => l.level === 'ERROR');

export const selectTradesByStrategy = (id: StrategyId) => (state: BotStore): TradeExecution[] =>
  state.trades.filter((t) => t.strategyId === id);

export const selectWsConnected = (state: BotStore): boolean =>
  state.wsStatus === 'CONNECTED';
