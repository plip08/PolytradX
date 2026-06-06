"use client";

import type { StrategySnapshot } from "../../types";

interface StrategyCardProps {
  strategy: StrategySnapshot;
}

const stateStyles: Record<string, string> = {
  IDLE: "bg-slate-800 text-slate-200",
  SCANNING: "bg-amber-700/10 text-amber-200",
  EXECUTING: "bg-emerald-700/10 text-emerald-200",
  COOLDOWN: "bg-sky-700/10 text-sky-200",
  ERROR: "bg-rose-700/10 text-rose-200",
};

export function StrategyCard({ strategy }: StrategyCardProps) {
  return (
    <article className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl shadow-slate-950/20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Strategy</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">{strategy.strategyId}</h3>
        </div>
        <span className={`rounded-2xl px-3 py-1 text-sm font-semibold ${stateStyles[strategy.state] ?? "bg-slate-800 text-slate-300"}`}>
          {strategy.state}
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <DataPoint label="Position" value={`$${strategy.currentPositionUsd.toFixed(2)}`} />
        <DataPoint label="Edge" value={strategy.currentEdge !== undefined ? `${strategy.currentEdge.toFixed(2)}%` : "—"} />
        <DataPoint label="PnL" value={strategy.pnlUsd !== undefined ? `$${strategy.pnlUsd.toFixed(2)}` : "—"} />
        <DataPoint label="Allocation" value={strategy.allocationPct !== undefined ? `${strategy.allocationPct.toFixed(1)}%` : "—"} />
      </div>

      <div className="mt-6 space-y-2 rounded-3xl border border-slate-800 bg-slate-900 p-4 text-slate-300">
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>Last decision</span>
          <span>{new Date(strategy.lastDecisionAt).toLocaleTimeString()}</span>
        </div>
        {strategy.lastExecutionAt ? (
          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>Last execution</span>
            <span>{new Date(strategy.lastExecutionAt).toLocaleTimeString()}</span>
          </div>
        ) : null}
        {strategy.cooldownRemainingMs ? (
          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>Cooldown</span>
            <span>{Math.ceil(strategy.cooldownRemainingMs / 1000)}s</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function DataPoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl bg-slate-900 p-4 text-white shadow-sm shadow-slate-950/20">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}
