/**
 * VIEW 3 — HOT-RELOAD CONFIGURATION PANEL
 *
 * Live-editable sliders and inputs for each strategy.
 * PATCH requests are sent on blur/commit, not on every keystroke.
 * Config is persisted in-memory on backend and broadcast via WS.
 */

'use client';

import { useState, useCallback } from 'react';
import { useBotStore } from '../store/botStore';
import { botApi } from '../hooks/useWebSocket';
import { clsx } from 'clsx';
import type { StrategyId, GasStrategy, StrategyConfig } from '../types/index';
import { STRATEGY_LABELS } from '../types/index';

// ─── Slider ───────────────────────────────────────────────────────────────────

function SliderInput({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}): React.ReactElement {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-200 font-mono font-medium">
          {value.toFixed(step < 1 ? 2 : 0)}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-700"
        style={{
          background: `linear-gradient(to right, #3b82f6 ${pct}%, #334155 ${pct}%)`,
        }}
      />
      <div className="flex justify-between text-[10px] text-slate-600">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ─── Gas Strategy Selector ────────────────────────────────────────────────────

const GAS_LABELS: Record<GasStrategy, { label: string; color: string; desc: string }> = {
  STANDARD: { label: 'Standard', color: 'text-slate-300', desc: '1x base fee' },
  FAST: { label: 'Fast', color: 'text-sky-400', desc: '1.5x base fee' },
  FRONTRUN: { label: 'Frontrun', color: 'text-orange-400', desc: '2.5x base fee' },
};

function GasSelector({
  value,
  onChange,
}: {
  value: GasStrategy;
  onChange: (v: GasStrategy) => void;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <span className="text-slate-400 text-xs">Gas Strategy</span>
      <div className="flex gap-2">
        {(Object.keys(GAS_LABELS) as GasStrategy[]).map((g) => {
          const cfg = GAS_LABELS[g];
          return (
            <button
              key={g}
              onClick={() => onChange(g)}
              className={clsx(
                'flex-1 py-1.5 px-2 rounded text-xs font-medium border transition-all',
                value === g
                  ? `bg-slate-700 border-slate-500 ${cfg.color}`
                  : 'bg-slate-800/50 border-slate-700 text-slate-500 hover:border-slate-600',
              )}
              title={cfg.desc}
            >
              {cfg.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Strategy Config Form ─────────────────────────────────────────────────────

function StrategyConfigForm({ id }: { id: StrategyId }): React.ReactElement {
  const config = useBotStore((s) => s.config?.[id]);
  const patchStrategyConfig = useBotStore((s) => s.patchStrategyConfig);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const patch = useCallback(
    async (partial: Partial<StrategyConfig>) => {
      patchStrategyConfig(id, partial);
      setSaving(true);
      try {
        await botApi.updateConfig(id, partial);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        useBotStore.getState().addToast({
          type: 'error',
          title: 'Config save failed',
          description: err instanceof Error ? err.message : 'Could not reach the backend',
        });
      } finally {
        setSaving(false);
      }
    },
    [id, patchStrategyConfig],
  );

  if (!config) {
    return <div className="text-slate-500 text-xs">Loading config…</div>;
  }

  return (
    <div className="space-y-4">
      <SliderInput
        label="Max Slippage"
        value={config.maxSlippagePct * 100}
        min={0}
        max={10}
        step={0.1}
        unit="%"
        onChange={(v) => void patch({ maxSlippagePct: v / 100 })}
      />

      <SliderInput
        label="Min Profit Trigger"
        value={config.minProfitUsd}
        min={0.1}
        max={50}
        step={0.1}
        unit="$"
        onChange={(v) => void patch({ minProfitUsd: v })}
      />

      <SliderInput
        label="Capital Allocation"
        value={config.capitalAllocationUsd}
        min={100}
        max={10_000}
        step={100}
        unit="$"
        onChange={(v) => void patch({ capitalAllocationUsd: v })}
      />

      <GasSelector
        value={config.gasStrategy}
        onChange={(v) => void patch({ gasStrategy: v })}
      />

      {/* Dry Run Toggle */}
      <div className="flex items-center justify-between">
        <span className="text-slate-400 text-xs">Dry Run (simulation)</span>
        <button
          onClick={() => void patch({ dryRun: !config.dryRun })}
          className={clsx(
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
            config.dryRun ? 'bg-yellow-500' : 'bg-slate-600',
          )}
        >
          <span
            className={clsx(
              'inline-block h-3 w-3 rounded-full bg-white transform transition-transform',
              config.dryRun ? 'translate-x-5' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Save feedback */}
      {(saving || saved) && (
        <div
          className={clsx(
            'text-xs font-medium text-center py-1 rounded',
            saved ? 'text-green-400' : 'text-slate-400',
          )}
        >
          {saving ? 'Saving…' : '✓ Saved'}
        </div>
      )}
    </div>
  );
}

// ─── Config Panel ─────────────────────────────────────────────────────────────

const STRATEGY_IDS: StrategyId[] = [
  'ATOMIC_ARB',
  'MARKET_MAKER',
  'LATENCY_ARB',
  'LOGIC_ARB',
  'NEGATIVE_RISK',
  'RESOLUTION_SNIPE',
  'AI_AGENT',
];

export function ConfigPanel(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<StrategyId>('ATOMIC_ARB');

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">Hot-Reload Configuration</h2>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 border-b border-slate-700 pb-2">
        {STRATEGY_IDS.map((id) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              'px-3 py-1.5 rounded-t text-xs font-medium transition-all',
              activeTab === id
                ? 'bg-slate-700 text-white border border-slate-600 border-b-slate-700'
                : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {STRATEGY_LABELS[id]}
          </button>
        ))}
      </div>

      {/* Active strategy config */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
        <h3 className="text-slate-300 text-sm font-semibold mb-4">
          {STRATEGY_LABELS[activeTab]} — Parameters
        </h3>
        <StrategyConfigForm id={activeTab} />
      </div>

      {/* Info box */}
      <div className="bg-slate-800/30 border border-slate-700/50 rounded-lg p-3">
        <p className="text-slate-500 text-xs">
          Changes take effect immediately — no restart required.
          Config is applied in-memory and broadcast to all connected clients via WebSocket.
        </p>
      </div>
    </div>
  );
}
