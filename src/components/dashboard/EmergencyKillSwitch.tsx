"use client";

import { useState } from "react";

interface EmergencyKillSwitchProps {
  onActivate: () => Promise<void>;
  onReset: () => Promise<void>;
  disabled?: boolean;
}

export function EmergencyKillSwitch({ onActivate, onReset, disabled = false }: EmergencyKillSwitchProps) {
  const [busy, setBusy] = useState(false);

  const handleActivate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onActivate();
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl shadow-slate-950/20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Emergency Control</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Kill switch</h2>
        </div>
        <span className="inline-flex items-center rounded-2xl bg-slate-900 px-4 py-2 text-sm text-slate-300">
          {disabled ? "Protected" : "Ready"}
        </span>
      </div>

      <p className="mt-4 text-slate-400">
        Use the emergency kill switch to immediately suspend trading activity. This will send a strong stop command to the bot control API.
      </p>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={handleActivate}
          className="inline-flex h-14 flex-1 items-center justify-center rounded-3xl bg-rose-500 px-6 text-base font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Processing…" : "Activate Kill Switch"}
        </button>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={handleReset}
          className="inline-flex h-14 flex-1 items-center justify-center rounded-3xl bg-slate-800 px-6 text-base font-semibold text-slate-200 shadow-lg shadow-slate-950/20 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset System
        </button>
      </div>
    </section>
  );
}
