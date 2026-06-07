/**
 * VIEW 4 — LIVE TERMINAL LOGS & TRADE HISTORY
 *
 * - Virtualized log list (react-virtuoso) — handles 500+ entries without lag
 * - Strict semantic color-coding by log level
 * - Auto-scroll to bottom (unless user scrolls up)
 * - Filter by level / strategy
 * - Trade history table with Polygonscan links
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useBotStore } from '../store/botStore';
import { clsx } from 'clsx';
import type { LogLevel, StrategyId, LogEntry, TradeExecution } from '../types/index';
import { STRATEGY_LABELS } from '../types/index';

// ─── Log Level Styling ────────────────────────────────────────────────────────

const LOG_COLORS: Record<LogLevel, string> = {
  SUCCESS: 'text-green-400',
  INFO: 'text-slate-300',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-400',
  DEBUG: 'text-slate-500',
};

const LOG_PREFIXES: Record<LogLevel, string> = {
  SUCCESS: '✓',
  INFO: '·',
  WARN: '⚠',
  ERROR: '✕',
  DEBUG: '»',
};

// ─── Log Row ──────────────────────────────────────────────────────────────────

function LogRow({ entry }: { entry: LogEntry }): React.ReactElement {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });

  return (
    <div className="flex gap-2 px-3 py-0.5 hover:bg-slate-800/40 group font-mono text-xs leading-5">
      <span className="text-slate-600 shrink-0 w-24">{time}</span>
      <span className={clsx('shrink-0 w-4', LOG_COLORS[entry.level])}>
        {LOG_PREFIXES[entry.level]}
      </span>
      {entry.strategyId && (
        <span className="text-slate-500 shrink-0 text-[10px] bg-slate-800 px-1 rounded self-center">
          {entry.strategyId.replace('_', '')}
        </span>
      )}
      <span className={clsx(LOG_COLORS[entry.level], 'break-all')}>{entry.message}</span>
    </div>
  );
}

// ─── Log Terminal ─────────────────────────────────────────────────────────────

type LevelFilter = LogLevel | 'ALL';
type StrategyFilter = StrategyId | 'ALL';

function LogTerminal(): React.ReactElement {
  const allLogs = useBotStore((s) => s.logs);
  const clearLogs = useBotStore((s) => s.clearLogs);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>('ALL');

  const filtered = allLogs.filter((l) => {
    if (levelFilter !== 'ALL' && l.level !== levelFilter) return false;
    if (strategyFilter !== 'ALL' && l.strategyId !== strategyFilter) return false;
    return true;
  });

  const LEVELS: LevelFilter[] = ['ALL', 'SUCCESS', 'INFO', 'WARN', 'ERROR'];
  const STRATEGIES: StrategyFilter[] = [
    'ALL',
    'ATOMIC_ARB',
    'MARKET_MAKER',
    'LATENCY_ARB',
    'LOGIC_ARB',
    'NEGATIVE_RISK',
    'RESOLUTION_SNIPE',
    'AI_AGENT',
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-700">
        <div className="flex gap-1">
          {LEVELS.map((lvl) => (
            <button
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={clsx(
                'px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold transition-colors',
                levelFilter === lvl
                  ? lvl === 'ALL'
                    ? 'bg-slate-600 text-white'
                    : `bg-slate-700 ${LOG_COLORS[lvl as LogLevel]}`
                  : 'text-slate-600 hover:text-slate-400',
              )}
            >
              {lvl}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-slate-700" />

        <select
          value={strategyFilter}
          onChange={(e) => setStrategyFilter(e.target.value as StrategyFilter)}
          className="bg-slate-800 border border-slate-700 text-slate-400 text-xs rounded px-2 py-0.5"
        >
          {STRATEGIES.map((id) => (
            <option key={id} value={id}>
              {id === 'ALL' ? 'All Strategies' : STRATEGY_LABELS[id as StrategyId]}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              autoScroll
                ? 'border-green-600 text-green-400 bg-green-900/20'
                : 'border-slate-700 text-slate-500',
            )}
          >
            {autoScroll ? '↓ Auto' : '↑ Paused'}
          </button>
          <button
            onClick={clearLogs}
            className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Virtualized log list */}
      <div className="flex-1 bg-slate-900 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600 text-sm font-mono">
            No logs yet…
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={filtered}
            followOutput={autoScroll ? 'smooth' : false}
            atBottomStateChange={(atBottom) => setAutoScroll(atBottom)}
            itemContent={(_, entry) => <LogRow entry={entry} />}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}

// ─── Trade History Table ──────────────────────────────────────────────────────

function TradeTable(): React.ReactElement {
  const trades = useBotStore((s) => s.trades);

  return (
    <div className="overflow-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-slate-700">
            {['Time', 'Strategy', 'Side', 'Size', 'Price', 'P&L', 'Status', 'Tx'].map(
              (h) => (
                <th
                  key={h}
                  className="text-left text-slate-500 uppercase text-[10px] tracking-wider py-2 px-3 font-semibold"
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 ? (
            <tr>
              <td colSpan={8} className="text-center text-slate-600 py-8">
                No trades yet
              </td>
            </tr>
          ) : (
            trades.map((t) => (
              <TradeRow key={t.id} trade={t} />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function TradeRow({ trade }: { trade: TradeExecution }): React.ReactElement {
  const time = new Date(trade.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const pnl = trade.pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-slate-500';
  const sideColor = trade.side === 'BUY' ? 'text-sky-400' : 'text-orange-400';

  const statusMap = {
    SUCCESS: 'text-green-400',
    FAILED: 'text-red-400',
    PENDING: 'text-yellow-400',
    SIMULATED: 'text-violet-400',
  };

  return (
    <tr className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
      <td className="py-1.5 px-3 text-slate-500">{time}</td>
      <td className="py-1.5 px-3 text-slate-400">
        {STRATEGY_LABELS[trade.strategyId] ?? trade.strategyId}
      </td>
      <td className={clsx('py-1.5 px-3 font-semibold', sideColor)}>{trade.side}</td>
      <td className="py-1.5 px-3 text-slate-300">{trade.size.toFixed(2)}</td>
      <td className="py-1.5 px-3 text-slate-300">{trade.price.toFixed(4)}</td>
      <td className={clsx('py-1.5 px-3 font-semibold', pnlColor)}>
        {pnl !== 0 ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '—'}
      </td>
      <td className={clsx('py-1.5 px-3', statusMap[trade.status])}>{trade.status}</td>
      <td className="py-1.5 px-3">
        {trade.polygonscanUrl ? (
          <a
            href={trade.polygonscanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline"
          >
            {trade.txHash?.slice(0, 8)}…
          </a>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
    </tr>
  );
}

// ─── Live Logs Composite View ─────────────────────────────────────────────────

export function LiveLogs(): React.ReactElement {
  const [tab, setTab] = useState<'terminal' | 'trades'>('terminal');

  return (
    <div className="flex flex-col h-full space-y-0">
      <div className="flex items-center justify-between pb-3">
        <h2 className="text-lg font-bold text-white">Live Terminal</h2>
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['terminal', 'trades'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'px-3 py-1 rounded text-xs font-medium transition-colors capitalize',
                tab === t ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {t === 'terminal' ? 'Terminal' : 'Trade History'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden">
        {tab === 'terminal' ? (
          <div className="h-[500px] flex flex-col">
            <LogTerminal />
          </div>
        ) : (
          <div className="h-[500px] overflow-auto p-2">
            <TradeTable />
          </div>
        )}
      </div>
    </div>
  );
}
