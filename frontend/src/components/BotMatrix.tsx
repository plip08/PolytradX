/**
 * VIEW 2 — BOT CONTROL MATRIX
 *
 * 7-card grid, one per strategy.
 * Each card: toggle, status badge, strategy-specific metrics, description.
 * Toggle calls backend API and optimistically updates local state.
 */

'use client';

import { useState } from 'react';
import { useBotStore, selectStrategyStatus, selectStrategyMetrics } from '../store/botStore';
import { botApi } from '../hooks/useWebSocket';
import { clsx } from 'clsx';
import type { StrategyId, StrategyStatus } from '../types/index';
import { STRATEGY_LABELS, STRATEGY_DESCRIPTIONS } from '../types/index';

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<StrategyStatus, { dot: string; text: string; label: string }> = {
  IDLE: { dot: 'bg-slate-500', text: 'text-slate-400', label: 'Idle' },
  SCANNING: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-400', label: 'Scanning' },
  EXECUTING: { dot: 'bg-yellow-400 animate-ping', text: 'text-yellow-400', label: 'Executing' },
  ERROR: { dot: 'bg-red-500', text: 'text-red-400', label: 'Error' },
  PAUSED: { dot: 'bg-orange-400', text: 'text-orange-400', label: 'Paused' },
  DISABLED: { dot: 'bg-slate-600', text: 'text-slate-500', label: 'Disabled' },
};

function StatusBadge({ status }: { status: StrategyStatus }): React.ReactElement {
  const cfg = STATUS_STYLES[status];
  return (
    <div className={clsx('flex items-center gap-1.5 text-xs font-medium', cfg.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', cfg.dot)} />
      {cfg.label}
    </div>
  );
}

// ─── Toggle Switch ────────────────────────────────────────────────────────────

function StrategyToggle({
  id,
  isEnabled,
  status,
}: {
  id: StrategyId;
  isEnabled: boolean;
  status: StrategyStatus;
}): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const setStrategyStatus = useBotStore((s) => s.setStrategyStatus);
  const isKillSwitch = useBotStore((s) => s.isKillSwitchActive);

  const handleToggle = async (): Promise<void> => {
    if (loading || isKillSwitch) return;
    setLoading(true);
    try {
      if (isEnabled) {
        setStrategyStatus(id, 'IDLE');
        await botApi.stopStrategy(id);
      } else {
        setStrategyStatus(id, 'SCANNING');
        await botApi.startStrategy(id);
      }
    } catch (err) {
      setStrategyStatus(id, status);
      useBotStore.getState().addToast({
        type: 'error',
        title: 'Strategy toggle failed',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading || isKillSwitch}
      className={clsx(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none',
        isEnabled ? 'bg-green-500' : 'bg-slate-600',
        (loading || isKillSwitch) && 'opacity-50 cursor-not-allowed',
      )}
      aria-label={isEnabled ? `Stop ${id}` : `Start ${id}`}
    >
      <span
        className={clsx(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
          isEnabled ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}

// ─── Metrics Display ──────────────────────────────────────────────────────────

function MetricRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}): React.ReactElement {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={clsx('font-mono font-medium', color ?? 'text-slate-300')}>
        {typeof value === 'number' && isNaN(value) ? '—' : value}
      </span>
    </div>
  );
}

const STRATEGY_METRIC_LABELS: Record<StrategyId, Record<string, string>> = {
  ATOMIC_ARB:       { marketsWatched: 'Marchés surveillés', mergeCount: 'Merges', totalPnL: 'P&L ($)' },
  MARKET_MAKER:     { earnedSpread: 'Spread ($)', inventory: 'Inventory' },
  LATENCY_ARB:      { totalSweeps: 'Sweeps', totalPnL: 'P&L ($)' },
  LOGIC_ARB:        { trackedPairs: 'Paires', totalArbs: 'Arbs', totalPnL: 'P&L ($)' },
  NEGATIVE_RISK:    { trackedGroups: 'Groupes', maxCurrentExcess: 'Excès max', totalArbs: 'Arbs', totalPnL: 'P&L ($)' },
  RESOLUTION_SNIPE: { watchedMarkets: 'Marchés < 6h', totalSnipes: 'Snipes', totalPnL: 'P&L ($)' },
  AI_AGENT:         { totalAnalyses: 'Analyses', totalSignals: 'Signaux', aiProvider: 'AI' },
};

// ─── Strategy Card ────────────────────────────────────────────────────────────

const STRATEGY_ICONS: Record<StrategyId, string> = {
  ATOMIC_ARB: '⚛️',
  MARKET_MAKER: '📊',
  LATENCY_ARB: '⚡',
  LOGIC_ARB: '🧩',
  NEGATIVE_RISK: '🔄',
  RESOLUTION_SNIPE: '🎯',
  AI_AGENT: '🤖',
};

function StrategyCard({ id }: { id: StrategyId }): React.ReactElement {
  const status = useBotStore(selectStrategyStatus(id));
  const metrics = useBotStore(selectStrategyMetrics(id));
  const isEnabled = status !== 'IDLE' && status !== 'DISABLED' && status !== 'ERROR';
  const metricLabels = STRATEGY_METRIC_LABELS[id];

  return (
    <div
      className={clsx(
        'bg-slate-800/60 border rounded-xl p-4 flex flex-col gap-3 transition-all',
        isEnabled ? 'border-slate-600' : 'border-slate-700/50',
        status === 'EXECUTING' && 'ring-1 ring-yellow-500/30',
        status === 'ERROR' && 'border-red-500/50 bg-red-500/5',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl" role="img">{STRATEGY_ICONS[id]}</span>
          <div>
            <h3 className="text-slate-200 text-sm font-semibold">{STRATEGY_LABELS[id]}</h3>
            <StatusBadge status={status} />
          </div>
        </div>
        <StrategyToggle id={id} isEnabled={isEnabled} status={status} />
      </div>

      {/* Description */}
      <p className="text-slate-500 text-xs leading-relaxed">{STRATEGY_DESCRIPTIONS[id]}</p>

      {/* Metrics */}
      <div className="space-y-1.5 pt-2 border-t border-slate-700/50">
        {Object.entries(metricLabels).map(([key, label]) => {
          const raw = metrics[key];
          const value = raw !== undefined ? String(raw) : '—';
          const isPnl = key === 'totalPnL';
          const color = isPnl
            ? Number(raw) >= 0
              ? 'text-green-400'
              : 'text-red-400'
            : undefined;
          return <MetricRow key={key} label={label} value={value} color={color} />;
        })}
      </div>
    </div>
  );
}

// ─── Bot Matrix ───────────────────────────────────────────────────────────────

const ACTIVE_STRATEGIES: StrategyId[]   = ['ATOMIC_ARB', 'NEGATIVE_RISK', 'RESOLUTION_SNIPE', 'LOGIC_ARB'];
const INACTIVE_STRATEGIES: StrategyId[] = ['MARKET_MAKER', 'LATENCY_ARB', 'AI_AGENT'];

const INACTIVE_REASON: Record<string, string> = {
  MARKET_MAKER: 'Nécessite $5k+ de capital',
  LATENCY_ARB:  'Nécessite un feed sportif (Betfair)',
  AI_AGENT:     'Trop coûteux en API calls à ce stade',
};

function DisabledCard({ id }: { id: StrategyId }): React.ReactElement {
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex flex-col gap-2 opacity-50">
      <div className="flex items-center gap-2">
        <span className="text-xl grayscale" role="img">{STRATEGY_ICONS[id]}</span>
        <div>
          <h3 className="text-slate-400 text-sm font-semibold">{STRATEGY_LABELS[id]}</h3>
          <span className="text-[10px] text-slate-600 font-medium uppercase tracking-wider">Désactivée</span>
        </div>
      </div>
      <p className="text-slate-600 text-xs">{INACTIVE_REASON[id]}</p>
    </div>
  );
}

export function BotMatrix(): React.ReactElement {
  const isKillSwitch = useBotStore((s) => s.isKillSwitchActive);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Strategy Control Matrix</h2>
        {isKillSwitch && (
          <div className="px-3 py-1 bg-red-500/20 border border-red-500 text-red-400 text-xs rounded-full font-semibold">
            KILL SWITCH ACTIVE
          </div>
        )}
      </div>

      {/* Active strategies */}
      <div>
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-3 font-semibold">
          Actives — capital total $180
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {ACTIVE_STRATEGIES.map((id) => (
            <StrategyCard key={id} id={id} />
          ))}
        </div>
      </div>

      {/* Disabled strategies */}
      <div>
        <p className="text-xs text-slate-600 uppercase tracking-wider mb-3 font-semibold">
          Désactivées (infrastructure manquante)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {INACTIVE_STRATEGIES.map((id) => (
            <DisabledCard key={id} id={id} />
          ))}
        </div>
      </div>
    </div>
  );
}
