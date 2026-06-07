/**
 * ROOT PAGE — Multi-tab dashboard layout
 *
 * Tabs: Dashboard | Strategies | Config | Logs | AI Intel
 * Single persistent WS connection via useWebSocket hook.
 */

'use client';

import { useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { MasterDashboard } from '../components/MasterDashboard';
import { BotMatrix } from '../components/BotMatrix';
import { ConfigPanel } from '../components/ConfigPanel';
import { LiveLogs } from '../components/LiveLogs';
import { AiIntel } from '../components/AiIntel';
import { Settings } from '../components/Settings';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useBotStore } from '../store/botStore';
import { clsx } from 'clsx';

type Tab = 'dashboard' | 'strategies' | 'config' | 'logs' | 'ai' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'dashboard',  label: 'Dashboard',  icon: '📈' },
  { id: 'strategies', label: 'Strategies', icon: '⚙️' },
  { id: 'config',     label: 'Config',     icon: '🎛️' },
  { id: 'logs',       label: 'Logs',       icon: '📟' },
  { id: 'ai',         label: 'AI Intel',   icon: '🤖' },
  { id: 'settings',   label: 'Settings',   icon: '🔑' },
];

function NavBar({ active, setActive }: { active: Tab; setActive: (t: Tab) => void }): React.ReactElement {
  const wsStatus = useBotStore((s) => s.wsStatus);
  const isKillSwitch = useBotStore((s) => s.isKillSwitchActive);
  const totalPnL = useBotStore((s) => s.totalPnL);

  return (
    <nav className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <span className="text-violet-400 font-bold text-lg">⬡</span>
        <span className="text-slate-200 font-semibold text-sm hidden sm:block">Polymarket Quant</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
              active === tab.id
                ? 'bg-slate-700 text-white'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50',
            )}
          >
            <span>{tab.icon}</span>
            <span className="hidden md:block">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Status */}
      <div className="flex items-center gap-3 text-xs">
        {isKillSwitch && (
          <div className="px-2 py-1 bg-red-500/20 border border-red-500/50 text-red-400 rounded font-semibold animate-pulse">
            HALT
          </div>
        )}
        <div className="text-slate-400 font-mono hidden sm:block">
          P&L:{' '}
          <span className={totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
          </span>
        </div>
        <div
          className={clsx(
            'w-2 h-2 rounded-full',
            wsStatus === 'CONNECTED'
              ? 'bg-green-400'
              : wsStatus === 'CONNECTING'
                ? 'bg-yellow-400 animate-pulse'
                : 'bg-red-500',
          )}
          title={`WebSocket: ${wsStatus}`}
        />
      </div>
    </nav>
  );
}

function DisconnectBanner(): React.ReactElement | null {
  const wsStatus = useBotStore((s) => s.wsStatus);
  if (wsStatus !== 'DISCONNECTED' && wsStatus !== 'ERROR') return null;

  return (
    <div className="sticky top-[57px] z-40 flex items-center justify-center gap-2 py-2 bg-slate-950/90 border-b border-red-800/50 backdrop-blur text-red-400 text-xs font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
      {wsStatus === 'ERROR' ? 'Connection error' : 'Disconnected'} — data may be stale · Reconnecting…
    </div>
  );
}

export default function HomePage(): React.ReactElement {
  // Single persistent WS connection for the entire app
  useWebSocket();

  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

  return (
    <div className="min-h-screen flex flex-col">
      <NavBar active={activeTab} setActive={setActiveTab} />
      <DisconnectBanner />

      <main className="flex-1 p-6 max-w-[1800px] mx-auto w-full">
        {activeTab === 'dashboard' && (
          <ErrorBoundary label="Dashboard">
            <MasterDashboard />
          </ErrorBoundary>
        )}
        {activeTab === 'strategies' && (
          <ErrorBoundary label="Strategies">
            <BotMatrix />
          </ErrorBoundary>
        )}
        {activeTab === 'config' && (
          <ErrorBoundary label="Config">
            <ConfigPanel />
          </ErrorBoundary>
        )}
        {activeTab === 'logs' && (
          <ErrorBoundary label="Logs">
            <LiveLogs />
          </ErrorBoundary>
        )}
        {activeTab === 'ai' && (
          <ErrorBoundary label="AI Intel">
            <AiIntel />
          </ErrorBoundary>
        )}
        {activeTab === 'settings' && (
          <ErrorBoundary label="Settings">
            <Settings />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
