'use client';

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { useBotStore } from '../store/botStore';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['NEXT_PUBLIC_API_KEY'] ?? '';

const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

type MaskedKey = { masked: string; configured: boolean };
type ApiKeys = Record<'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GROK_API_KEY' | 'GOOGLE_API_KEY', MaskedKey>;
type BotConfig = { DRY_RUN: string; MAX_GLOBAL_CAPITAL_USD: string; AI_CONFIDENCE_THRESHOLD: string; AI_PROVIDER: string };

// ─── Key Input Row ─────────────────────────────────────────────────────────────

const PROVIDER_META: Record<string, { label: string; prefix: string; color: string; hint: string }> = {
  ANTHROPIC_API_KEY: { label: 'Anthropic',  prefix: 'sk-ant-',  color: 'text-violet-400', hint: 'sk-ant-api03-...' },
  OPENAI_API_KEY:    { label: 'OpenAI',     prefix: 'sk-',      color: 'text-green-400',  hint: 'sk-proj-...' },
  GROK_API_KEY:      { label: 'xAI / Grok', prefix: 'xai-',     color: 'text-sky-400',    hint: 'xai-...' },
  GOOGLE_API_KEY:    { label: 'Google AI',  prefix: 'AIza',     color: 'text-yellow-400', hint: 'AIzaSy...' },
};

function ApiKeyRow({
  envKey,
  current,
  onSave,
}: {
  envKey: string;
  current: MaskedKey;
  onSave: (key: string, value: string) => Promise<void>;
}): React.ReactElement {
  const meta = PROVIDER_META[envKey] ?? { label: envKey, prefix: '', color: 'text-slate-300', hint: '' };
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await onSave(envKey, value.trim());
      setSaved(true);
      setEditing(false);
      setValue('');
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      useBotStore.getState().addToast({
        type: 'error',
        title: 'Failed to save API key',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-3 py-3 border-b border-slate-800 last:border-0">
      {/* Status dot */}
      <span
        className={clsx(
          'w-2 h-2 rounded-full shrink-0',
          current.configured ? 'bg-green-400' : 'bg-slate-600',
        )}
      />

      {/* Label */}
      <div className="w-32 shrink-0">
        <span className={clsx('text-xs font-semibold', meta.color)}>{meta.label}</span>
      </div>

      {/* Current value or input */}
      {editing ? (
        <input
          autoFocus
          type="password"
          placeholder={meta.hint}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); if (e.key === 'Escape') setEditing(false); }}
          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-violet-500"
        />
      ) : (
        <div className="flex-1 font-mono text-xs text-slate-400 truncate">
          {saved
            ? <span className="text-green-400">✓ Saved</span>
            : current.configured
              ? current.masked
              : <span className="text-slate-600 italic">not configured</span>}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 shrink-0">
        {editing ? (
          <>
            <button
              onClick={handleSave}
              disabled={saving || !value.trim()}
              className="px-3 py-1 text-xs rounded-lg bg-violet-600/30 border border-violet-500 text-violet-300 hover:bg-violet-600/50 disabled:opacity-40 transition-all"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setValue(''); }}
              className="px-3 py-1 text-xs rounded-lg bg-slate-700 border border-slate-600 text-slate-400 hover:text-slate-200 transition-all"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200 transition-all"
          >
            {current.configured ? 'Rotate' : 'Set key'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Bot Config Section ────────────────────────────────────────────────────────

function BotConfigSection({
  config,
  onSave,
}: {
  config: BotConfig;
  onSave: (updates: Partial<BotConfig>) => Promise<void>;
}): React.ReactElement {
  const [dryRun, setDryRun] = useState(config.DRY_RUN === 'true');
  const [capital, setCapital] = useState(parseFloat(config.MAX_GLOBAL_CAPITAL_USD));
  const [threshold, setThreshold] = useState(parseFloat(config.AI_CONFIDENCE_THRESHOLD) * 100);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync when config loads
  useEffect(() => {
    setDryRun(config.DRY_RUN === 'true');
    setCapital(parseFloat(config.MAX_GLOBAL_CAPITAL_USD));
    setThreshold(parseFloat(config.AI_CONFIDENCE_THRESHOLD) * 100);
  }, [config]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave({
        DRY_RUN: dryRun ? 'true' : 'false',
        MAX_GLOBAL_CAPITAL_USD: String(capital),
        AI_CONFIDENCE_THRESHOLD: (threshold / 100).toFixed(2),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      useBotStore.getState().addToast({
        type: 'error',
        title: 'Failed to save bot config',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Dry Run */}
      <div className="flex items-center justify-between py-3 border-b border-slate-800">
        <div>
          <span className="text-slate-200 text-sm font-medium">Dry Run</span>
          <p className="text-slate-500 text-xs mt-0.5">Simulate trades without sending real orders</p>
        </div>
        <button
          onClick={() => setDryRun((d) => !d)}
          className={clsx(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            dryRun ? 'bg-yellow-500' : 'bg-slate-600',
          )}
        >
          <span
            className={clsx(
              'inline-block h-4 w-4 rounded-full bg-white transform transition-transform',
              dryRun ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Capital */}
      <div className="space-y-2 py-3 border-b border-slate-800">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">Max Global Capital</span>
          <span className="text-slate-200 font-mono font-medium">${capital.toLocaleString()}</span>
        </div>
        <input
          type="range"
          min={500}
          max={100_000}
          step={500}
          value={capital}
          onChange={(e) => setCapital(parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, #3b82f6 ${((capital - 500) / 99500) * 100}%, #334155 ${((capital - 500) / 99500) * 100}%)`,
          }}
        />
        <div className="flex justify-between text-[10px] text-slate-600">
          <span>$500</span>
          <span>$100k</span>
        </div>
      </div>

      {/* AI Confidence Threshold */}
      <div className="space-y-2 py-3 border-b border-slate-800">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">AI Confidence Threshold</span>
          <span className="text-slate-200 font-mono font-medium">{threshold.toFixed(0)}%</span>
        </div>
        <input
          type="range"
          min={50}
          max={99}
          step={1}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, #8b5cf6 ${((threshold - 50) / 49) * 100}%, #334155 ${((threshold - 50) / 49) * 100}%)`,
          }}
        />
        <div className="flex justify-between text-[10px] text-slate-600">
          <span>50%</span>
          <span>99%</span>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className={clsx(
          'w-full py-2 rounded-lg text-sm font-semibold transition-all',
          saved
            ? 'bg-green-600/20 border border-green-600 text-green-400'
            : 'bg-violet-600/20 border border-violet-500 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40',
        )}
      >
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Bot Config'}
      </button>
    </div>
  );
}

// ─── Connection Info ───────────────────────────────────────────────────────────

function ConnectionInfo(): React.ReactElement {
  const rows = [
    { label: 'Backend API', value: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001' },
    { label: 'WebSocket', value: process.env['NEXT_PUBLIC_WS_URL'] ?? 'ws://localhost:8080' },
  ];

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
          <span className="text-slate-400 text-xs">{r.label}</span>
          <span className="text-slate-300 text-xs font-mono">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Settings Panel ────────────────────────────────────────────────────────────

export function Settings(): React.ReactElement {
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [botConfig, setBotConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API_URL}/settings`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { apiKeys: ApiKeys; botConfig: BotConfig };
      setApiKeys(data.apiKeys);
      setBotConfig(data.botConfig);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchSettings(); }, [fetchSettings]);

  const saveSettings = useCallback(async (updates: Record<string, string>): Promise<void> => {
    const res = await fetch(`${API_URL}/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
      throw new Error(err.error);
    }
    // Refresh masked values after save
    await fetchSettings();
  }, [fetchSettings]);

  const saveApiKey = useCallback(
    async (key: string, value: string): Promise<void> => {
      await saveSettings({ [key]: value });
    },
    [saveSettings],
  );

  const saveBotConfig = useCallback(
    async (updates: Partial<BotConfig>): Promise<void> => {
      await saveSettings(updates as Record<string, string>);
    },
    [saveSettings],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        Loading settings…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-slate-500">
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
        <button
          onClick={() => void fetchSettings()}
          className="px-4 py-1.5 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-500"
        >
          Retry
        </button>
      </div>
    );
  }

  const API_KEY_ENTRIES = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROK_API_KEY', 'GOOGLE_API_KEY',
  ] as const;

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-lg font-bold text-white">Settings</h2>

      {/* API Keys */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-slate-300 text-sm font-semibold">AI Provider API Keys</h3>
          <span className="text-[10px] text-slate-600 bg-slate-800 border border-slate-700 px-2 py-0.5 rounded">
            Stored in .env — never sent to browser
          </span>
        </div>
        <div>
          {API_KEY_ENTRIES.map((k) => (
            <ApiKeyRow
              key={k}
              envKey={k}
              current={apiKeys?.[k] ?? { masked: '', configured: false }}
              onSave={saveApiKey}
            />
          ))}
        </div>
        <p className="text-slate-600 text-[10px] mt-3">
          Keys are written to <span className="font-mono text-slate-500">backend/.env</span> and applied immediately — no restart needed.
        </p>
      </div>

      {/* Bot Config */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
        <h3 className="text-slate-300 text-sm font-semibold mb-4">Bot Configuration</h3>
        {botConfig && <BotConfigSection config={botConfig} onSave={saveBotConfig} />}
      </div>

      {/* Connection */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
        <h3 className="text-slate-300 text-sm font-semibold mb-4">Connection</h3>
        <ConnectionInfo />
      </div>
    </div>
  );
}
