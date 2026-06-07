/**
 * WEBSOCKET CLIENT HOOK
 *
 * Manages single persistent WS connection to backend.
 * Dispatches typed messages to Zustand store.
 * Implements automatic reconnection with exponential backoff.
 */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useBotStore } from '../store/botStore';
import type {
  WsMessage,
  BotState,
  LogEntry,
  TradeExecution,
  AiAnalysis,
  ConfigMap,
  StrategyId,
  StrategyStatus,
  PnlSnapshot,
} from '../types/index';

const WS_URL = process.env['NEXT_PUBLIC_WS_URL'] ?? 'ws://localhost:8080';
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;

export function useWebSocket(): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const {
    setWsStatus,
    setBotState,
    appendLog,
    appendTrade,
    appendAiAnalysis,
    appendPnlSnapshot,
    setConfig,
    setKillSwitch,
    setStrategyStatus,
  } = useBotStore();

  const handleMessage = useCallback(
    (event: MessageEvent<string>) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(event.data) as WsMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'BOT_STATE_UPDATE': {
          const state = msg.payload as BotState;
          setBotState(state);
          appendPnlSnapshot({
            timestamp: msg.timestamp,
            cumulativePnL: state.totalPnL,
          } satisfies PnlSnapshot);
          break;
        }

        case 'STRATEGY_STATUS_UPDATE': {
          const { strategyId, status } = msg.payload as {
            strategyId: StrategyId;
            status: StrategyStatus;
          };
          setStrategyStatus(strategyId, status);
          break;
        }

        case 'LOG_ENTRY':
          appendLog(msg.payload as LogEntry);
          break;

        case 'TRADE_EXECUTED':
          appendTrade(msg.payload as TradeExecution);
          break;

        case 'AI_ANALYSIS':
          appendAiAnalysis(msg.payload as AiAnalysis);
          break;

        case 'CONFIG_UPDATED': {
          const { config } = msg.payload as { config: ConfigMap };
          setConfig(config);
          break;
        }

        case 'KILL_SWITCH_ACTIVATED':
          setKillSwitch(true);
          break;

        case 'PNL_UPDATE': {
          const { cumulativePnL } = msg.payload as { cumulativePnL: number };
          appendPnlSnapshot({ timestamp: msg.timestamp, cumulativePnL });
          break;
        }

        default:
          break;
      }
    },
    [
      setBotState,
      appendLog,
      appendTrade,
      appendAiAnalysis,
      appendPnlSnapshot,
      setConfig,
      setKillSwitch,
      setStrategyStatus,
    ],
  );

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setWsStatus('CONNECTING');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setWsStatus('CONNECTED');
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsStatus('DISCONNECTED');
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsStatus('ERROR');
      ws.close();
    };
  }, [handleMessage, setWsStatus]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY_MS,
      );
      connect();
    }, reconnectDelayRef.current);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}

// ─── API call helpers ─────────────────────────────────────────────────────────

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['NEXT_PUBLIC_API_KEY'] ?? '';

async function apiCall<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error);
  }

  return res.json() as Promise<T>;
}

export const botApi = {
  activateKillSwitch: () => apiCall<void>('POST', '/kill-switch'),
  deactivateKillSwitch: () => apiCall<void>('DELETE', '/kill-switch'),
  resetCircuitBreaker: () => apiCall<void>('POST', '/circuit-breaker/reset'),
  startStrategy: (id: string) => apiCall<void>('POST', `/strategy/${id}/start`),
  stopStrategy: (id: string) => apiCall<void>('POST', `/strategy/${id}/stop`),
  updateConfig: (id: string, config: unknown) =>
    apiCall<void>('PATCH', `/strategy/${id}/config`, config),
  getConfig: () => apiCall<ConfigMap>('GET', '/config'),
};
