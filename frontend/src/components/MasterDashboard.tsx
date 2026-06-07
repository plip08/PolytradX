/**
 * VIEW 1 — MASTER DASHBOARD
 *
 * - Panic Button (Global Kill Switch)
 * - Real-time P&L tracker + win rate gauge
 * - Wallet balances (USDC & POL)
 * - Cumulative P&L chart (lightweight-charts)
 * - Bot uptime + connection status
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, LineData, Time } from 'lightweight-charts';
import { useBotStore } from '../store/botStore';
import { botApi } from '../hooks/useWebSocket';
import { clsx } from 'clsx';

// ─── Kill Switch Button ───────────────────────────────────────────────────────

function KillSwitchButton(): React.ReactElement {
  const isActive = useBotStore((s) => s.isKillSwitchActive);
  const setKillSwitch = useBotStore((s) => s.setKillSwitch);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleActivate = async (): Promise<void> => {
    if (!confirmOpen) { setConfirmOpen(true); return; }
    setLoading(true);
    try {
      await botApi.activateKillSwitch();
      setKillSwitch(true);
    } catch (err) {
      useBotStore.getState().addToast({
        type: 'error',
        title: 'Kill switch failed',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setLoading(false);
      setConfirmOpen(false);
    }
  };

  const handleDeactivate = async (): Promise<void> => {
    setLoading(true);
    try {
      await botApi.deactivateKillSwitch();
      setKillSwitch(false);
    } catch (err) {
      useBotStore.getState().addToast({
        type: 'error',
        title: 'Resume failed',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setLoading(false);
    }
  };

  if (isActive) {
    return (
      <button
        onClick={handleDeactivate}
        disabled={loading}
        className="flex items-center gap-2 px-6 py-3 bg-yellow-500/20 border border-yellow-500 text-yellow-400 rounded-lg font-bold text-sm hover:bg-yellow-500/30 transition-all"
      >
        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
        {loading ? 'Resuming…' : 'KILL SWITCH ACTIVE — Click to Resume'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {confirmOpen && (
        <span className="text-red-400 text-sm font-semibold animate-pulse">
          Confirm? Click again to halt ALL trading
        </span>
      )}
      <button
        onClick={handleActivate}
        disabled={loading}
        className={clsx(
          'flex items-center gap-2 px-6 py-3 rounded-lg font-bold text-sm transition-all',
          confirmOpen
            ? 'bg-red-600 border border-red-400 text-white animate-pulse shadow-lg shadow-red-600/30'
            : 'bg-red-500/10 border border-red-500 text-red-400 hover:bg-red-500/20',
        )}
      >
        <span className="text-lg">⚡</span>
        {loading ? 'Halting…' : 'PANIC — Kill Switch'}
      </button>
    </div>
  );
}

// ─── P&L Chart ────────────────────────────────────────────────────────────────

function PnlChart(): React.ReactElement {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const pnlSeries = useBotStore((s) => s.pnlSeries);

  useEffect(() => {
    if (!chartRef.current) return;

    const chart = createChart(chartRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true },
      width: chartRef.current.clientWidth,
      height: 220,
    });

    const series = chart.addLineSeries({
      color: '#22c55e',
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v: number) => `$${v.toFixed(2)}` },
    });

    chartApiRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (chartRef.current) {
        chart.resize(chartRef.current.clientWidth, 220);
      }
    });
    ro.observe(chartRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || pnlSeries.length === 0) return;

    // Deduplicate by second-precision timestamp (keep last value), then sort asc
    const byTime = new Map<number, number>();
    for (const s of pnlSeries) {
      byTime.set(Math.floor(s.timestamp / 1000), s.cumulativePnL);
    }

    const data: LineData[] = Array.from(byTime.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time: time as Time, value }));

    seriesRef.current.setData(data);
  }, [pnlSeries]);

  return <div ref={chartRef} className="w-full" />;
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color = 'text-white',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-slate-400 text-xs uppercase tracking-wider">{label}</span>
      <span className={clsx('text-2xl font-bold font-mono', color)}>{value}</span>
      {sub && <span className="text-slate-500 text-xs">{sub}</span>}
    </div>
  );
}

// ─── Connection Badge ─────────────────────────────────────────────────────────

function ConnectionBadge(): React.ReactElement {
  const wsStatus = useBotStore((s) => s.wsStatus);

  const statusMap = {
    CONNECTED: { dot: 'bg-green-400', label: 'Live', text: 'text-green-400' },
    CONNECTING: { dot: 'bg-yellow-400 animate-pulse', label: 'Connecting', text: 'text-yellow-400' },
    DISCONNECTED: { dot: 'bg-red-500', label: 'Disconnected', text: 'text-red-400' },
    ERROR: { dot: 'bg-red-500 animate-pulse', label: 'Error', text: 'text-red-400' },
  };

  const cfg = statusMap[wsStatus];

  return (
    <div className={clsx('flex items-center gap-2 text-sm', cfg.text)}>
      <span className={clsx('w-2 h-2 rounded-full', cfg.dot)} />
      {cfg.label}
    </div>
  );
}

// ─── Uptime Display ───────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ─── Master Dashboard ─────────────────────────────────────────────────────────

export function MasterDashboard(): React.ReactElement {
  const botState = useBotStore((s) => s.botState);
  const totalPnL = useBotStore((s) => s.totalPnL);

  const pnlColor =
    totalPnL > 0 ? 'text-green-400' : totalPnL < 0 ? 'text-red-400' : 'text-slate-400';

  const winRatePct = botState ? (botState.winRate * 100).toFixed(1) : '—';

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Polymarket Quant Bot</h1>
          <p className="text-slate-400 text-sm">
            Uptime: {botState ? formatUptime(botState.uptime) : '—'} •{' '}
            {botState?.activeOrders ?? 0} active orders
          </p>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionBadge />
          <KillSwitchButton />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total P&L"
          value={`$${totalPnL.toFixed(2)}`}
          color={pnlColor}
          sub="Since session start"
        />
        <StatCard
          label="Win Rate"
          value={`${winRatePct}%`}
          sub={`${botState?.winningTrades ?? 0} / ${botState?.totalTrades ?? 0} trades`}
          color="text-sky-400"
        />
        <StatCard
          label="USDC Balance"
          value={`$${(botState?.walletBalanceUsdc ?? 0).toFixed(2)}`}
          color="text-slate-200"
        />
        <StatCard
          label="POL Balance"
          value={(botState?.walletBalancePol ?? 0).toFixed(4)}
          sub="For gas"
          color="text-violet-400"
        />
      </div>

      {/* P&L Chart */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
        <h2 className="text-slate-300 text-sm font-semibold mb-3 uppercase tracking-wider">
          Cumulative P&L
        </h2>
        <PnlChart />
      </div>
    </div>
  );
}
