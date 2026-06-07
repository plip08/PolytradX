/**
 * STRATEGY 8 — AI AUTONOMOUS TRADING AGENT
 *
 * Supported providers: Anthropic (Claude), OpenAI (GPT), xAI (Grok), Google (Gemini)
 * Switched via AI_PROVIDER env var — no restart needed if hot-reloaded.
 *
 * Prompt engineering principles:
 *   - Chain-of-thought reasoning before final probability output
 *   - Structured JSON output to avoid parsing ambiguity
 *   - Context injection: current market prices sent in every prompt
 *   - Rate limiting: max N API calls / minute
 *   - Automatic fallback to next provider on rate-limit / error
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import { ClobClient } from '../services/clobClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  NewsItem,
  AiAnalysis,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
  MarketInfo,
} from '../types/index.js';

export type AiProvider = 'ANTHROPIC' | 'OPENAI' | 'GROK' | 'GOOGLE';

export const AI_MODELS: Record<AiProvider, Array<{ id: string; label: string; contextWindow: number; reasoning: boolean }>> = {
  ANTHROPIC: [
    { id: 'claude-opus-4-7',      label: 'Claude Opus 4.7',      contextWindow: 200_000, reasoning: true  },
    { id: 'claude-sonnet-4-6',    label: 'Claude Sonnet 4.6',    contextWindow: 200_000, reasoning: true  },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200_000, reasoning: false },
  ],
  OPENAI: [
    { id: 'gpt-4o',               label: 'GPT-4o',               contextWindow: 128_000, reasoning: false },
    { id: 'gpt-4o-mini',          label: 'GPT-4o Mini',          contextWindow: 128_000, reasoning: false },
    { id: 'o1',                   label: 'o1 (reasoning)',        contextWindow: 200_000, reasoning: true  },
    { id: 'o3-mini',              label: 'o3-mini (reasoning)',   contextWindow: 200_000, reasoning: true  },
    { id: 'o4-mini',              label: 'o4-mini (reasoning)',   contextWindow: 200_000, reasoning: true  },
  ],
  GROK: [
    { id: 'grok-3',               label: 'Grok 3',               contextWindow: 131_072, reasoning: false },
    { id: 'grok-3-mini',          label: 'Grok 3 Mini',          contextWindow: 131_072, reasoning: false },
    { id: 'grok-3-fast',          label: 'Grok 3 Fast',          contextWindow: 131_072, reasoning: false },
    { id: 'grok-2-1212',          label: 'Grok 2',               contextWindow: 131_072, reasoning: false },
    { id: 'grok-3-mini-fast',     label: 'Grok 3 Mini Fast',     contextWindow: 131_072, reasoning: true  },
  ],
  GOOGLE: [
    { id: 'gemini-2.5-pro',            label: 'Gemini 2.5 Pro',       contextWindow: 1_000_000, reasoning: true  },
    { id: 'gemini-2.5-flash',          label: 'Gemini 2.5 Flash',     contextWindow: 1_000_000, reasoning: true  },
    { id: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash',     contextWindow: 1_000_000, reasoning: false },
    { id: 'gemini-2.0-flash-lite',     label: 'Gemini 2.0 Flash Lite',contextWindow: 1_000_000, reasoning: false },
    { id: 'gemini-1.5-pro',            label: 'Gemini 1.5 Pro',       contextWindow: 2_000_000, reasoning: false },
    { id: 'gemini-1.5-flash',          label: 'Gemini 1.5 Flash',     contextWindow: 1_000_000, reasoning: false },
  ],
};

interface IaAgentParams {
  aiProvider: AiProvider;
  aiModel?: string;              // overrides env default if set
  confidenceThreshold: number;   // e.g. 0.90
  maxCallsPerMinute: number;     // rate limit
  newsPollingIntervalMs: number; // how often to check for new news
  watchedMarkets: MarketInfo[];  // markets to correlate news against
  fallbackProviders?: AiProvider[]; // automatic fallback order on error/rate-limit
}

interface LlmResponse {
  reasoning: string;
  probability: number;   // 0.0 – 1.0
  confidence: number;    // 0.0 – 1.0
  signal: 'BUY_YES' | 'BUY_NO' | 'NO_ACTION';
  targetMarketId?: string;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a quantitative prediction market analyst.
Your task: analyze a news item and determine its impact on a specific binary prediction market.

Rules:
1. Think step by step before concluding (chain-of-thought)
2. Output a probability (0.0–1.0) that the YES outcome is more likely GIVEN this news
3. Output a confidence score (0.0–1.0) representing certainty of your analysis
4. Only suggest trading if confidence >= 0.85 and edge >= 5 percentage points vs current price
5. Be conservative: NO_ACTION is always a valid choice

Output ONLY valid JSON in this exact format:
{
  "reasoning": "<step-by-step analysis>",
  "probability": <float 0-1>,
  "confidence": <float 0-1>,
  "signal": "BUY_YES" | "BUY_NO" | "NO_ACTION",
  "targetMarketId": "<marketId or null>"
}`;

// ─── Simulated News Stream (for testing / demo) ───────────────────────────────

const SIMULATED_NEWS: Omit<NewsItem, 'id' | 'timestamp'>[] = [
  {
    headline: 'Federal Reserve signals 50bps rate cut in September meeting',
    content: 'Fed Chair Powell indicated at Jackson Hole that the time has come for policy to adjust, with markets now pricing in a 50bps cut at the September FOMC meeting.',
    source: 'SIMULATED',
  },
  {
    headline: 'BTC breaks $70,000 all-time high on institutional demand surge',
    content: 'Bitcoin surged past $70,000 as BlackRock ETF recorded its largest single-day inflow of $1.2B. Analysts expect continuation toward $80k.',
    source: 'SIMULATED',
  },
  {
    headline: 'Spain wins 2026 World Cup Final against Brazil 2-1',
    content: 'Spain defeats Brazil in a thrilling World Cup final. Yamal scored the winner in extra time. Tournament ends with Spain as champions.',
    source: 'SIMULATED',
  },
];

export class IaAgentStrategy {
  public readonly strategyId = 'AI_AGENT' as const;
  public status: StrategyStatus = 'IDLE';

  // Provider clients — all initialised upfront, activated by params.aiProvider
  private anthropic: Anthropic;
  private openai: OpenAI;
  private grok: OpenAI;
  private google: GoogleGenerativeAI;

  private activeProvider: AiProvider;
  private newsQueue: NewsItem[] = [];
  private processingTimer: ReturnType<typeof setInterval> | null = null;
  private newsSimTimer: ReturnType<typeof setInterval> | null = null;
  private callTimestamps: number[] = [];
  private totalAnalyses = 0;
  private totalSignals = 0;
  private totalPnL = 0;
  public latestAnalysis: AiAnalysis | null = null;

  constructor(
    private readonly params: IaAgentParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly risk: RiskManager,
  ) {
    this.activeProvider = params.aiProvider;

    this.anthropic = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'] ?? 'missing',
    });

    this.openai = new OpenAI({
      apiKey: process.env['OPENAI_API_KEY'] ?? 'missing',
    });

    // Grok uses an OpenAI-compatible REST API — same SDK, different base URL + key
    this.grok = new OpenAI({
      apiKey: process.env['GROK_API_KEY'] ?? 'missing',
      baseURL: 'https://api.x.ai/v1',
    });

    this.google = new GoogleGenerativeAI(process.env['GOOGLE_API_KEY'] ?? 'missing');
  }

  /** Called by MarketDiscovery — sets the markets the AI monitors for news impact */
  setWatchedMarkets(markets: MarketInfo[]): void {
    this.params.watchedMarkets = markets;
    emitLog('INFO', `[IaAgent] Now watching ${markets.length} markets for news`, undefined, this.strategyId);
  }

  /** Reinitialize SDK clients after API key rotation */
  reloadApiKeys(): void {
    this.anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] ?? 'missing' });
    this.openai    = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] ?? 'missing' });
    this.grok      = new OpenAI({ apiKey: process.env['GROK_API_KEY'] ?? 'missing', baseURL: 'https://api.x.ai/v1' });
    this.google    = new GoogleGenerativeAI(process.env['GOOGLE_API_KEY'] ?? 'missing');
    emitLog('INFO', '[IaAgent] API keys reloaded', undefined, this.strategyId);
  }

  /** Hot-swap provider without restarting the strategy */
  setProvider(provider: AiProvider, model?: string): void {
    this.activeProvider = provider;
    if (model) this.params.aiModel = model;
    emitLog('INFO', `[IaAgent] Provider switched to ${provider}${model ? ` / ${model}` : ''}`, undefined, this.strategyId);
    this.broadcastStatus();
  }

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';

    // Process news queue
    this.processingTimer = setInterval(
      () => void this.processNextNews(),
      this.params.newsPollingIntervalMs,
    );

    // Simulate news feed for demo
    this.newsSimTimer = setInterval(() => this.injectSimulatedNews(), 15_000);
    this.injectSimulatedNews(); // immediate

    emitLog('INFO', '[IaAgent] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    if (this.processingTimer) clearInterval(this.processingTimer);
    if (this.newsSimTimer) clearInterval(this.newsSimTimer);
    this.status = 'IDLE';
    emitLog('INFO', '[IaAgent] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  /** External news injection (from real feed integrations) */
  ingestNews(item: NewsItem): void {
    this.newsQueue.push(item);
    emitLog('INFO', `[IaAgent] News ingested: "${item.headline}"`, undefined, this.strategyId);
  }

  private injectSimulatedNews(): void {
    const template = SIMULATED_NEWS[Math.floor(Math.random() * SIMULATED_NEWS.length)];
    if (!template) return;

    const item: NewsItem = {
      id: uuidv4(),
      timestamp: Date.now(),
      ...template,
    };
    this.newsQueue.push(item);
  }

  private async processNextNews(): Promise<void> {
    if (this.newsQueue.length === 0 || this.status !== 'SCANNING') return;
    if (!this.checkRateLimit()) return;

    const newsItem = this.newsQueue.shift()!;
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const startMs = Date.now();

    try {
      const analysis = await this.analyzeWithLlm(newsItem, startMs);
      this.latestAnalysis = analysis;
      this.totalAnalyses++;

      BotWebSocketServer.getInstance().broadcast('AI_ANALYSIS', analysis);

      emitLog(
        'INFO',
        `[IaAgent] Analysis: "${newsItem.headline}" → signal=${analysis.signal} prob=${analysis.extractedProbability.toFixed(2)} conf=${analysis.confidence.toFixed(2)}`,
        undefined,
        this.strategyId,
      );

      if (
        analysis.signal !== 'NO_ACTION' &&
        analysis.confidence >= this.params.confidenceThreshold &&
        analysis.targetMarketId
      ) {
        this.totalSignals++;
        await this.executeSignal(analysis);
      }
    } catch (err) {
      emitLog('ERROR', `[IaAgent] Analysis failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      this.status = 'SCANNING';
      this.broadcastStatus();
    }
  }

  private buildUserMessage(newsItem: NewsItem): string {
    const marketContext = this.params.watchedMarkets
      .map((m) => {
        const ob = this.clob.getCachedOrderBook(m.yesTokenId);
        return `- "${m.question}" (marketId: ${m.id}, YES price: ${ob?.midPrice?.toFixed(3) ?? 'unknown'})`;
      })
      .join('\n');

    return `NEWS ITEM:
Headline: ${newsItem.headline}
Content: ${newsItem.content}
Source: ${newsItem.source}
Timestamp: ${new Date(newsItem.timestamp).toISOString()}

MONITORED MARKETS:
${marketContext}

Analyze this news and determine if it creates a tradeable edge in any monitored market.`;
  }

  resolveModel(provider: AiProvider): string {
    if (this.params.aiModel) return this.params.aiModel;
    const defaults: Record<AiProvider, string> = {
      ANTHROPIC: process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-6',
      OPENAI:    process.env['OPENAI_MODEL']    ?? 'gpt-4o',
      GROK:      process.env['GROK_MODEL']      ?? 'grok-3',
      GOOGLE:    process.env['GOOGLE_MODEL']    ?? 'gemini-2.0-flash',
    };
    return defaults[provider];
  }

  private async callProvider(provider: AiProvider, userMessage: string): Promise<{ raw: string; model: string }> {
    const model = this.resolveModel(provider);

    switch (provider) {
      case 'ANTHROPIC': {
        const msg = await this.anthropic.messages.create({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        });
        return {
          raw: (msg.content[0] as { type: string; text: string }).text,
          model: `anthropic/${model}`,
        };
      }

      case 'OPENAI': {
        const completion = await this.openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
        });
        return {
          raw: completion.choices[0]?.message.content ?? '{}',
          model: `openai/${model}`,
        };
      }

      case 'GROK': {
        // xAI Grok uses OpenAI-compatible API — same interface, different base URL
        const completion = await this.grok.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
        });
        return {
          raw: completion.choices[0]?.message.content ?? '{}',
          model: `grok/${model}`,
        };
      }

      case 'GOOGLE': {
        const genModel: GenerativeModel = this.google.getGenerativeModel({
          model,
          systemInstruction: SYSTEM_PROMPT,
          generationConfig: { responseMimeType: 'application/json' },
        });
        const result = await genModel.generateContent(userMessage);
        return {
          raw: result.response.text(),
          model: `google/${model}`,
        };
      }
    }
  }

  private async analyzeWithLlm(newsItem: NewsItem, startMs: number): Promise<AiAnalysis> {
    const userMessage = this.buildUserMessage(newsItem);

    // Try active provider, then fallback chain on error
    const providerOrder: AiProvider[] = [
      this.activeProvider,
      ...(this.params.fallbackProviders ?? []).filter((p) => p !== this.activeProvider),
    ];

    let lastError: unknown;
    let rawResponse = '';
    let modelUsed = '';

    for (const provider of providerOrder) {
      try {
        const result = await this.callProvider(provider, userMessage);
        rawResponse = result.raw;
        modelUsed = result.model;
        break;
      } catch (err) {
        lastError = err;
        emitLog(
          'WARN',
          `[IaAgent] Provider ${provider} failed — trying next: ${String(err)}`,
          undefined,
          this.strategyId,
        );
      }
    }

    if (!rawResponse) throw lastError ?? new Error('All AI providers failed');

    const parsed = JSON.parse(rawResponse) as LlmResponse;

    return {
      id: uuidv4(),
      newsItem,
      rawPrompt: userMessage,
      reasoning: parsed.reasoning ?? '',
      extractedProbability: Math.max(0, Math.min(1, parsed.probability ?? 0.5)),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0)),
      signal: parsed.signal ?? 'NO_ACTION',
      targetMarketId: parsed.targetMarketId,
      modelUsed,
      latencyMs: Date.now() - startMs,
      timestamp: Date.now(),
    };
  }

  private async executeSignal(analysis: AiAnalysis): Promise<void> {
    const market = this.params.watchedMarkets.find((m) => m.id === analysis.targetMarketId);
    if (!market) {
      emitLog('WARN', `[IaAgent] Target market ${analysis.targetMarketId} not found`, undefined, this.strategyId);
      return;
    }

    const tokenId =
      analysis.signal === 'BUY_YES' ? market.yesTokenId : market.noTokenId;

    const ob = await this.clob.getOrderBook(tokenId);
    const price = ob.bestAsk;
    const sizeUsdc = this.config.capitalAllocationUsd * analysis.confidence;
    const size = sizeUsdc / price;

    const expectedEdge = analysis.extractedProbability - price;
    if (expectedEdge < 0.03) {
      emitLog(
        'WARN',
        `[IaAgent] Signal edge too thin (${(expectedEdge * 100).toFixed(2)}%) — skipping`,
        undefined,
        this.strategyId,
      );
      return;
    }

    const riskCheck = this.risk.checkPreTrade(this.strategyId, this.config, sizeUsdc, 0.02);
    if (!riskCheck.approved) {
      emitLog('WARN', `[IaAgent] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
      return;
    }

    const resp = await this.clob.placeOrder({
      marketId: market.id,
      tokenId,
      side: 'BUY',
      type: 'LIMIT',
      price: price * 1.01,
      size,
    });

    const pnl = expectedEdge * size;
    this.totalPnL += pnl;

    const execution: TradeExecution = {
      id: uuidv4(),
      strategyId: this.strategyId,
      marketId: market.id,
      tokenId,
      side: 'BUY',
      price,
      size,
      pnl,
      timestamp: Date.now(),
      status: 'SUCCESS',
    };

    this.risk.recordTrade(execution);
    BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);

    emitLog(
      'SUCCESS',
      `[IaAgent] Signal executed: ${analysis.signal} ${market.question} @ ${price.toFixed(4)} | conf=${(analysis.confidence * 100).toFixed(1)}%`,
      undefined,
      this.strategyId,
    );
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    this.callTimestamps = this.callTimestamps.filter((t) => t > windowStart);

    if (this.callTimestamps.length >= this.params.maxCallsPerMinute) {
      return false;
    }

    this.callTimestamps.push(now);
    return true;
  }

  private broadcastStatus(): void {
    BotWebSocketServer.getInstance().broadcast('STRATEGY_STATUS_UPDATE', {
      strategyId: this.strategyId,
      status: this.status,
      metrics: this.getMetrics(),
    });
  }

  getMetrics(): Record<string, number | string> {
    return {
      totalAnalyses: this.totalAnalyses,
      totalSignals: this.totalSignals,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
      queueDepth: this.newsQueue.length,
      latestConfidence: this.latestAnalysis?.confidence ?? 0,
      activeProvider: this.activeProvider,
      activeModel: this.resolveModel(this.activeProvider),
    };
  }
}
