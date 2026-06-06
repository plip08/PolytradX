"use client";

import { useMemo, useState } from "react";
import { useBotTelemetry } from "../hooks/useBotTelemetry";
import { useBotStore } from "../store/useBotStore";
import { EmergencyKillSwitch } from "../components/dashboard/EmergencyKillSwitch";
import { RiskPanel } from "../components/dashboard/RiskPanel";
import { StrategyCard } from "../components/dashboard/StrategyCard";

const CONTROL_API = process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "/api/control";

async function sendControlCommand(command: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${CONTROL_API}/${command}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Control request failed: ${response.status} ${text}`);
  }
  return response.json();
}

export default function HomePage() {
  const [tokenInput, setTokenInput] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [submitDisabled, setSubmitDisabled] = useState(false);

  const token = useBotStore((state) => state.token);
  const setToken = useBotStore((state) => state.setToken);
  const wsConnected = useBotStore((state) => state.wsConnected);
  const executionMode = useBotStore((state) => state.executionMode);
  const setExecutionMode = useBotStore((state) => state.setExecutionMode);
  const totalBalanceUsd = useBotStore((state) => state.totalBalanceUsd);
  const circuitBreaker = useBotStore((state) => state.circuitBreaker);
  const strategies = useBotStore((state) => state.strategies);
  const recentAlerts = useBotStore((state) => state.recentAlerts);

  useBotTelemetry();

  const connectionLabel = wsConnected ? "Connected" : "Disconnected";
  const connectionAccent = wsConnected ? "text-emerald-300" : "text-rose-400";

  const handleTokenSubmit = () => {
    setToken(tokenInput.trim());
    setStatusMessage("Telemetry token updated. Reconnecting...");
  };

  const handleModeToggle = async () => {
    const nextMode = executionMode === "LIVE" ? "DRY_RUN" : "LIVE";
    setSubmitDisabled(true);
    setStatusMessage("Updating execution mode...");
    try {
      await sendControlCommand("mode", { mode: nextMode });
      setExecutionMode(nextMode);
      setStatusMessage(`Execution mode set to ${nextMode}.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to change mode.");
    } finally {
      setSubmitDisabled(false);
    }
  };

  const handleActivateKill = async () => {
    setStatusMessage("Sending emergency halt...");
    try {
      await sendControlCommand("halt");
      setStatusMessage("Emergency halt activated.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to activate halt.");
    }
  };

  const handleResetSystem = async () => {
    setStatusMessage("Resetting trading bot state...");
    try {
      await sendControlCommand("reset");
      setStatusMessage("System reset requested.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to reset system.");
    }
  };

  const statusPanel = useMemo(
    () => (
      <div className="grid gap-4 sm:grid-cols-3">
        <StatBlock label="WS Connection" value={connectionLabel} accent={connectionAccent} />
        <StatBlock label="Mode" value={executionMode} accent="text-sky-300" />
        <StatBlock label="Total Capital" value={`$${totalBalanceUsd.toFixed(2)}`} accent="text-emerald-300" />
      </div>
    ),
    [connectionAccent, connectionLabel, executionMode, totalBalanceUsd],
  );

  return (
    <main className="min-h-screen px-6 py-8 text-slate-100 sm:px-10 lg:px-14">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="rounded-3xl border border-slate-800 bg-slate-950/90 p-8 shadow-xl shadow-slate-950/20 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-slate-500">Control Room</p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Polymarket Trading Dashboard</h1>
              <p className="mt-3 max-w-2xl text-slate-400">
                Monitor trade health, manage risk, and control execution mode from a responsive dark-mode operations panel.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:w-[360px]">
              <button
                type="button"
                onClick={handleModeToggle}
                disabled={submitDisabled}
                className="inline-flex h-14 items-center justify-center rounded-3xl bg-sky-500 px-5 text-base font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Toggle {executionMode === "LIVE" ? "Dry Run" : "Live"}
              </button>
              <div className="rounded-3xl border border-slate-800 bg-slate-900 p-4 text-slate-300">
                <p className="text-sm uppercase tracking-[0.25em] text-slate-500">Telemetry token</p>
                <p className="mt-3 text-base text-slate-100">{token ? "Configured" : "Not connected"}</p>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl shadow-slate-950/20">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Telemetry</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">Connection settings</h2>
                </div>
                <span className={`rounded-2xl px-4 py-2 text-sm font-semibold ${connectionAccent}`}>{connectionLabel}</span>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <label className="block rounded-3xl border border-slate-800 bg-slate-900 p-4 text-slate-200">
                  <span className="text-sm text-slate-400">Telemetry JWT</span>
                  <input
                    type="text"
                    value={tokenInput}
                    onChange={(event) => setTokenInput(event.target.value)}
                    placeholder="Paste token"
                    className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-500/30"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleTokenSubmit}
                    className="inline-flex h-14 w-full items-center justify-center rounded-3xl bg-emerald-500 px-5 text-base font-semibold text-slate-950 transition hover:bg-emerald-400"
                  >
                    Save Token
                  </button>
                </div>
              </div>
            </div>

            {statusPanel}

            <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl shadow-slate-950/20">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operational status</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">Strategy performance</h2>
                </div>
                <p className="text-sm text-slate-400">Real-time strategy health and execution state.</p>
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {strategies.length > 0 ? (
                  strategies.slice(0, 6).map((strategy) => <StrategyCard key={strategy.strategyId} strategy={strategy} />)
                ) : (
                  <div className="col-span-full rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
                    No strategy telemetry available yet.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <RiskPanel circuitBreaker={circuitBreaker} recentAlerts={recentAlerts} />
            <EmergencyKillSwitch onActivate={handleActivateKill} onReset={handleResetSystem} disabled={!wsConnected} />
          </div>
        </section>

        {statusMessage ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-950/90 px-6 py-4 text-slate-100 shadow-xl shadow-slate-950/20">
            <p className="text-sm text-slate-400">Status</p>
            <p className="mt-2 text-base">{statusMessage}</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function StatBlock({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-sm shadow-slate-950/20">
      <p className="text-sm uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className={`mt-4 text-3xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}
