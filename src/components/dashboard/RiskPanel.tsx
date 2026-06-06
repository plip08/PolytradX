"use client";

import type { CircuitBreakerState, RiskAlert } from "../../types";

interface RiskPanelProps {
  circuitBreaker: CircuitBreakerState;
  recentAlerts: RiskAlert[];
}

const statusLabels = {
  NORMAL: "Operational",
  WARNING: "Watch",
  BLOCKED: "Halted",
} as const;

export function RiskPanel({ circuitBreaker, recentAlerts }: RiskPanelProps) {
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl shadow-slate-950/20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Risk & Circuit Breaker</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Safety status</h2>
        </div>
        <div className="rounded-2xl bg-slate-900 px-4 py-3 text-slate-200 shadow-inner shadow-slate-950/30">
          <p className="text-sm uppercase text-slate-500">Status</p>
          <p className="mt-1 text-xl font-semibold text-emerald-300">{statusLabels[circuitBreaker.status]}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Current capital" value={`$${circuitBreaker.currentCapitalUsd.toFixed(2)}`} />
        <Metric label="Peak capital" value={`$${circuitBreaker.peakCapitalUsd.toFixed(2)}`} />
        <Metric label="Drawdown" value={`${circuitBreaker.drawdownPct.toFixed(2)}%`} />
        <Metric label="Consecutive losses" value={`${circuitBreaker.consecutiveLosses}`} />
      </div>

      <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-900 p-4">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-500">Recent alerts</p>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-400">
            {recentAlerts.length}
          </span>
        </div>
        <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
          {recentAlerts.length === 0 ? (
            <p className="text-sm text-slate-400">No recent alerts. Systems are stable.</p>
          ) : (
            recentAlerts.map((alert) => (
              <div key={`${alert.type}-${alert.timestamp}`} className="rounded-2xl bg-slate-950 px-4 py-3 text-slate-200 shadow-sm shadow-slate-950/20">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-white">{alert.type}</p>
                  <span className="rounded-full bg-slate-800 px-2 py-1 text-xs uppercase text-slate-400">{alert.severity}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-400">{alert.message}</p>
                <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500">
                  {new Date(alert.timestamp).toLocaleTimeString()}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl bg-slate-900 p-5 text-white shadow-sm shadow-slate-950/20">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}
