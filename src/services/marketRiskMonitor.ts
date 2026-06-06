import { randomUUID } from "node:crypto";
import type { MarketState } from "../types/market.js";
import type { BotCommand } from "../types/redis.js";
import { logger } from "../utils/logger.js";
import { redisBus } from "./redisBus.js";
import { persistence } from "./persistence.js";
import type { BotState } from "./botState.js";
import type { RiskDecisionEngine, RiskDecision } from "./riskDecisionEngine.js";

export interface MarketRiskMonitorOptions {
  monitoredMarkets: string[];
  spreadThresholdPct: number;
  volatilityThresholdPct: number;
  liquidityDropThresholdPct: number;
  orderBookDepthThresholdPct: number;
  staleMarketMs: number;
}

export class MarketRiskMonitor {
  private lastMarketState: Map<string, MarketState> = new Map();
  private active = false;

  constructor(private readonly riskDecisionEngine: RiskDecisionEngine, private readonly botState: BotState) {}

  start(): void {
    this.active = true;
    logger.info("MarketRiskMonitor started");
  }

  stop(): void {
    this.active = false;
    logger.info("MarketRiskMonitor stopped");
  }

  async onMarketUpdate(state: MarketState): Promise<void> {
    if (!this.active) {
      return;
    }

    const previous = this.lastMarketState.get(state.marketId);
    this.lastMarketState.set(state.marketId, state);

    const decisions = this.riskDecisionEngine.evaluateMarketState(state, previous);
    if (decisions.length === 0) {
      return;
    }

    for (const decision of decisions) {
      await this.handleRiskDecision(state, decision);
    }
  }

  private async handleRiskDecision(state: MarketState, decision: RiskDecision): Promise<void> {
    await this.recordRiskEvent(state.marketId, decision.signalType, decision.severity === "HIGH" ? "CRITICAL" : "WARN", decision.details);
    this.botState.registerAlert({
      type: "RISK",
      severity: decision.severity,
      message: decision.message,
      details: JSON.parse(JSON.stringify(decision.details)),
    });

    if (decision.emergency) {
      await this.publishCommand(this.buildEmergencyCloseCommand(state.marketId, decision));
      return;
    }

    await this.publishCommand(this.buildPauseStrategyCommand(state.marketId, decision));
  }

  private buildEmergencyCloseCommand(marketId: string, decision: RiskDecision): BotCommand {
    return {
      commandId: randomUUID(),
      action: "EMERGENCY_STOP",
      strategyId: `market:${marketId}`,
      payload: {
        marketId,
        reason: decision.message,
        signal: decision.signalType,
        details: decision.details,
      },
      userId: "market-risk-monitor",
      source: "system",
      timestamp: Date.now(),
      priority: "HIGH",
    };
  }

  private buildPauseStrategyCommand(marketId: string, decision: RiskDecision): BotCommand {
    return {
      commandId: randomUUID(),
      action: "PAUSE_STRATEGY",
      strategyId: `market:${marketId}`,
      payload: {
        marketId,
        signal: decision.signalType,
        details: decision.details,
      },
      userId: "market-risk-monitor",
      source: "system",
      timestamp: Date.now(),
      priority: decision.severity === "HIGH" ? "HIGH" : "NORMAL",
    };
  }


  private async publishCommand(command: BotCommand): Promise<void> {
    try {
      const entryId = await redisBus.enqueueCommand(command);
      logger.warn("MarketRiskMonitor published risk command", { command: command.commandId, entryId, action: command.action, payload: command.payload });
    } catch (error) {
      logger.error("MarketRiskMonitor failed to publish command", error);
    }
  }

  private async recordRiskEvent(marketId: string, signalType: string, severity: "INFO" | "WARN" | "CRITICAL", details: Record<string, unknown>): Promise<void> {
    try {
      await persistence.recordRiskEvent({
        marketId,
        signalType,
        severity,
        details: JSON.parse(JSON.stringify(details)),
      });
    } catch (error) {
      logger.error("Failed to persist market risk event", error);
    }
  }
}
