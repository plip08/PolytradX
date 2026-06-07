/**
 * VIEW 5 — AI INTEL VIEW
 *
 * Split screen:
 *  Left  — live news feed (scrollable, newest first)
 *  Right — AI structured analysis: reasoning, probability gauge, signal
 */

'use client';

import { useState, useEffect } from 'react';
import { useBotStore } from '../store/botStore';
import { clsx } from 'clsx';
import type { AiAnalysis, AiProvider, AiModelsMap } from '../types/index';
import { PROVIDER_LABELS, PROVIDER_COLORS } from '../types/index';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const API_KEY = process.env['NEXT_PUBLIC_API_KEY'] ?? '';

// ─── Provider / Model Selector ────────────────────────────────────────────────

function AiProviderSelector(): React.ReactElement {
  const [models, setModels] = useState<AiModelsMap | null>(null);
  const [modelsFetchError, setModelsFetchError] = useState(false);
  const [activeProvider, setActiveProvider] = useState<AiProvider>('ANTHROPIC');
  const [activeModel, setActiveModel] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Fetch models with exponential backoff retry (5 attempts)
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      let delay = 1_000;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const r = await fetch(`${API_URL}/ai/models`, { headers: { 'x-api-key': API_KEY } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json() as AiModelsMap;
          if (cancelled) return;
          setModels(data);
          setModelsFetchError(false);
          const first = data[activeProvider]?.[0];
          if (first) setActiveModel(first.id);
          return;
        } catch {
          if (cancelled) return;
          if (attempt === 4) { setModelsFetchError(true); return; }
          await new Promise<void>((res) => setTimeout(res, delay));
          delay = Math.min(delay * 2, 16_000);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When provider changes, reset model to first available
  const handleProviderChange = (p: AiProvider): void => {
    setActiveProvider(p);
    const first = models?.[p]?.[0];
    if (first) setActiveModel(first.id);
  };

  const handleApply = async (): Promise<void> => {
    setSaving(true);
    try {
      const r = await fetch(`${API_URL}/ai/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ provider: activeProvider, model: activeModel }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      useBotStore.getState().addToast({
        type: 'error',
        title: 'AI provider update failed',
        description: err instanceof Error ? err.message : 'Could not reach the backend',
      });
    } finally {
      setSaving(false);
    }
  };

  const providers: AiProvider[] = ['ANTHROPIC', 'OPENAI', 'GROK', 'GOOGLE'];
  const currentModels = models?.[activeProvider] ?? [];
  const selectedModel = currentModels.find((m) => m.id === activeModel);

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-3">
      <h3 className="text-slate-300 text-sm font-semibold">AI Provider & Model</h3>

      {/* Provider tabs */}
      <div className="flex flex-wrap gap-1.5">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => handleProviderChange(p)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
              activeProvider === p
                ? `bg-slate-700 ${PROVIDER_COLORS[p]}`
                : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600',
            )}
          >
            {PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Model list */}
      {models ? (
        <div className="space-y-1 max-h-48 overflow-auto">
          {currentModels.map((m) => (
            <button
              key={m.id}
              onClick={() => setActiveModel(m.id)}
              className={clsx(
                'w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-all',
                activeModel === m.id
                  ? 'bg-slate-700 border border-slate-500 text-white'
                  : 'hover:bg-slate-800 text-slate-400 border border-transparent',
              )}
            >
              <div className="flex items-center gap-2">
                {m.reasoning && (
                  <span className="text-[9px] px-1 py-0.5 bg-violet-500/20 border border-violet-500/50 text-violet-400 rounded">
                    reasoning
                  </span>
                )}
                <span className="font-medium">{m.label}</span>
              </div>
              <span className="text-slate-600 text-[10px]">
                {m.contextWindow >= 1_000_000
                  ? `${(m.contextWindow / 1_000_000).toFixed(1)}M ctx`
                  : `${Math.round(m.contextWindow / 1000)}k ctx`}
              </span>
            </button>
          ))}
        </div>
      ) : modelsFetchError ? (
        <div className="text-red-400 text-xs py-2">
          Failed to load models — backend unreachable
        </div>
      ) : (
        <div className="text-slate-500 text-xs py-2">Loading models…</div>
      )}

      {/* Apply button */}
      <div className="flex items-center justify-between pt-1">
        <div className="text-[10px] text-slate-600">
          {selectedModel ? `Context: ${selectedModel.contextWindow >= 1_000_000 ? `${(selectedModel.contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(selectedModel.contextWindow / 1000)}k`} tokens` : ''}
        </div>
        <button
          onClick={handleApply}
          disabled={saving || !activeModel}
          className={clsx(
            'px-4 py-1.5 rounded-lg text-xs font-semibold transition-all',
            saved
              ? 'bg-green-600/20 border border-green-600 text-green-400'
              : 'bg-violet-600/20 border border-violet-500 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40',
          )}
        >
          {saving ? 'Applying…' : saved ? '✓ Applied' : 'Apply to Bot'}
        </button>
      </div>
    </div>
  );
}

// ─── Confidence Gauge ─────────────────────────────────────────────────────────

function ConfidenceGauge({ confidence }: { confidence: number }): React.ReactElement {
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 90
      ? 'text-green-400 stroke-green-400'
      : pct >= 70
        ? 'text-yellow-400 stroke-yellow-400'
        : 'text-red-400 stroke-red-400';

  const r = 36;
  const circumference = 2 * Math.PI * r;
  const dashoffset = circumference * (1 - confidence);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 96 96">
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            stroke="#1e293b"
            strokeWidth="8"
          />
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashoffset}
            className={clsx('transition-all duration-500', color.split(' ')[1])}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={clsx('text-xl font-bold font-mono', color.split(' ')[0])}>
            {pct}%
          </span>
        </div>
      </div>
      <span className="text-slate-500 text-xs">AI Confidence</span>
    </div>
  );
}

// ─── Probability Bar ──────────────────────────────────────────────────────────

function ProbabilityBar({ probability }: { probability: number }): React.ReactElement {
  const pct = Math.round(probability * 100);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">NO Resolution</span>
        <span className="text-slate-400">YES Resolution</span>
      </div>
      <div className="relative h-3 bg-slate-700 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
        {/* Center line */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-500 opacity-50" />
      </div>
      <div className="flex justify-between text-[10px] text-slate-600">
        <span>0%</span>
        <span className="text-slate-400 font-bold">{pct}% YES</span>
        <span>100%</span>
      </div>
    </div>
  );
}

// ─── Signal Badge ─────────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: AiAnalysis['signal'] }): React.ReactElement {
  const map = {
    BUY_YES: { label: '▲ BUY YES', color: 'bg-green-500/20 border-green-500 text-green-400' },
    BUY_NO: { label: '▼ BUY NO', color: 'bg-red-500/20 border-red-500 text-red-400' },
    NO_ACTION: { label: '— NO ACTION', color: 'bg-slate-700/50 border-slate-600 text-slate-400' },
  };

  const cfg = map[signal];

  return (
    <div className={clsx('inline-flex items-center px-3 py-1.5 rounded-lg border text-sm font-bold', cfg.color)}>
      {cfg.label}
    </div>
  );
}

// ─── Analysis Panel ───────────────────────────────────────────────────────────

function AnalysisPanel({ analysis }: { analysis: AiAnalysis }): React.ReactElement {
  const time = new Date(analysis.timestamp).toLocaleTimeString();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-slate-200 text-sm font-semibold line-clamp-2">
            {analysis.newsItem.headline}
          </h3>
          <p className="text-slate-500 text-xs mt-0.5">
            {time} · {analysis.modelUsed} · {analysis.latencyMs}ms
          </p>
        </div>
        <SignalBadge signal={analysis.signal} />
      </div>

      {/* Confidence + Probability */}
      <div className="flex items-center gap-6">
        <ConfidenceGauge confidence={analysis.confidence} />
        <div className="flex-1">
          <ProbabilityBar probability={analysis.extractedProbability} />
        </div>
      </div>

      {/* Reasoning */}
      <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
        <h4 className="text-slate-400 text-xs uppercase tracking-wider mb-2">AI Reasoning</h4>
        <p className="text-slate-300 text-xs leading-relaxed font-mono whitespace-pre-wrap">
          {analysis.reasoning}
        </p>
      </div>

      {/* Target market */}
      {analysis.targetMarketId && (
        <div className="text-xs text-slate-500">
          Target market:{' '}
          <span className="text-slate-300 font-mono">{analysis.targetMarketId}</span>
        </div>
      )}
    </div>
  );
}

// ─── News Feed ────────────────────────────────────────────────────────────────

function NewsFeedPanel(): React.ReactElement {
  const analyses = useBotStore((s) => s.aiAnalyses);

  return (
    <div className="flex flex-col gap-2 overflow-auto">
      {analyses.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-slate-600">
          <span className="text-4xl mb-2">📰</span>
          <p className="text-sm">No news ingested yet</p>
          <p className="text-xs mt-1">Waiting for AI agent feed…</p>
        </div>
      ) : (
        analyses.map((a) => (
          <NewsCard key={a.id} analysis={a} />
        ))
      )}
    </div>
  );
}

function NewsCard({ analysis }: { analysis: AiAnalysis }): React.ReactElement {
  const latestAnalysis = useBotStore((s) => s.latestAnalysis);
  const isLatest = latestAnalysis?.id === analysis.id;
  const time = new Date(analysis.newsItem.timestamp).toLocaleTimeString();

  const signalColor = {
    BUY_YES: 'border-l-green-500',
    BUY_NO: 'border-l-red-500',
    NO_ACTION: 'border-l-slate-600',
  }[analysis.signal];

  return (
    <div
      className={clsx(
        'border border-slate-700 rounded-lg p-3 border-l-2 transition-all cursor-default',
        signalColor,
        isLatest && 'bg-slate-800/60 ring-1 ring-slate-600',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-slate-300 text-xs font-medium leading-tight">
          {analysis.newsItem.headline}
        </p>
        <span className="text-slate-600 text-[10px] shrink-0">{time}</span>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-slate-500 text-[10px]">{analysis.newsItem.source}</span>
        <span className="text-slate-700">·</span>
        <span className="text-[10px] font-mono text-slate-400">
          conf: {Math.round(analysis.confidence * 100)}%
        </span>
        <span className="text-slate-700">·</span>
        <span
          className={clsx(
            'text-[10px] font-bold',
            analysis.signal === 'BUY_YES'
              ? 'text-green-400'
              : analysis.signal === 'BUY_NO'
                ? 'text-red-400'
                : 'text-slate-500',
          )}
        >
          {analysis.signal}
        </span>
      </div>
    </div>
  );
}

// ─── AI Intel View ────────────────────────────────────────────────────────────

export function AiIntel(): React.ReactElement {
  const latestAnalysis = useBotStore((s) => s.latestAnalysis);
  const totalAnalyses = useBotStore((s) => s.aiAnalyses.length);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">AI Intelligence</h2>
        <div className="text-xs text-slate-500">{totalAnalyses} analyses</div>
      </div>

      {/* Provider / Model selector — full width at top */}
      <AiProviderSelector />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: News Feed */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <h3 className="text-slate-400 text-xs uppercase tracking-wider mb-3">
            News Stream
          </h3>
          <div className="max-h-[600px] overflow-auto space-y-2">
            <NewsFeedPanel />
          </div>
        </div>

        {/* Right: Analysis */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <h3 className="text-slate-400 text-xs uppercase tracking-wider mb-3">
            Structural Analysis
          </h3>
          {latestAnalysis ? (
            <AnalysisPanel analysis={latestAnalysis} />
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-slate-600">
              <span className="text-4xl mb-2">🤖</span>
              <p className="text-sm">No analysis yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
