import { randomUUID } from "node:crypto";
import { type Prisma } from "@prisma/client";
import { BotCommand, BotSnapshot } from "../types/redis.js";
import { Strategy } from "../types/strategy.js";
import { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/env.js";
import { persistence } from "./persistence.js";
import { redisBus } from "./redisBus.js";
import { type CircuitBreaker } from "./circuitBreaker.js";
import type { BotState } from "./botState.js";

const COMMAND_GROUP = "bot-command-consumers";
const SNAPSHOT_INTERVAL_MS = 5000;

export class BotCommandConsumer {
  private isRunning = false;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private readonly consumerName = `consumer:${process.pid}`;

  constructor(
    private readonly strategies: Strategy[],
    private readonly getMarketStates: () => MarketState[],
    private readonly circuitBreaker: CircuitBreaker,
    private readonly botState: BotState,
  ) {}

  async start(): Promise<void> {
    await redisBus.connect();
    await redisBus.ensureCommandGroup(COMMAND_GROUP);
    this.isRunning = true;
    this.startSnapshotPublisher();
    void this.processLoop();
    logger.info("Bot command consumer started", { group: COMMAND_GROUP, consumer: this.consumerName });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    try {
      await redisBus.disconnect();
      logger.info("Bot command consumer disconnected from Redis");
    } catch (error) {
      logger.warn("Error disconnecting bot command consumer", error);
    }
  }

  private startSnapshotPublisher(): void {
    void this.publishSnapshot();
    this.snapshotTimer = setInterval(() => {
      void this.publishSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const entries = await redisBus.readCommands(COMMAND_GROUP, this.consumerName, 10, 2000);
        for (const { id, command } of entries) {
          await this.handleCommand(command).catch((error) => {
            logger.error("Command handler failed", { id, command: command.commandId, action: command.action, error });
          });
          await redisBus.acknowledgeCommand(COMMAND_GROUP, id);
        }
      } catch (error) {
        logger.error("Bot command consumer loop failure", error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async handleCommand(command: BotCommand): Promise<void> {
    switch (command.action) {
      case "ENABLE_STRATEGY":
        this.setStrategyEnabled(command.strategyId, true);
        break;
      case "DISABLE_STRATEGY":
      case "PAUSE_STRATEGY":
        this.setStrategyEnabled(command.strategyId, false);
        break;
      case "RESUME_ALL":
        this.setAllStrategies(true);
        break;
      case "EMERGENCY_STOP":
      case "EMERGENCY_CLOSE_POSITION":
        this.setAllStrategies(false);
        logger.warn("Emergency stop/close triggered", { command: command.commandId, action: command.action, strategyId: command.strategyId });
        break;
      case "FORCE_REBALANCE":
        logger.info("Force rebalance requested", { command: command.commandId });
        break;
      case "SET_STRATEGY_CONFIG":
        await this.updateStrategyConfig(command);
        break;
      default:
        logger.warn("Unsupported bot command action", command.action);
    }
  }

  private setStrategyEnabled(strategyId: string, enabled: boolean): void {
    const strategy = this.strategies.find((item) => item.name === strategyId || item.name.toLowerCase() === strategyId.toLowerCase());
    if (!strategy) {
      logger.warn("Strategy not found for command", { strategyId });
      return;
    }

    strategy.isEnabled = enabled;
    this.botState.updateStrategyEnabled(strategy.name, enabled);
    logger.info("Strategy enabled state changed", { strategy: strategy.name, enabled });
  }

  private setAllStrategies(enabled: boolean): void {
    this.strategies.forEach((strategy) => {
      strategy.isEnabled = enabled;
      this.botState.updateStrategyEnabled(strategy.name, enabled);
    });
    logger.info("All strategies state updated", { enabled });
  }

  private async updateStrategyConfig(command: BotCommand): Promise<void> {
    const payload = command.payload as Record<string, unknown>;
    const configData = (payload.config ?? payload) as Record<string, unknown>;
    await persistence.upsertStrategyConfig(command.strategyId, {
      enabled: configData.enabled as boolean | undefined,
      allocationPct: typeof configData.allocationPct === "string" ? configData.allocationPct : undefined,
      maxPositionUsd: typeof configData.maxPositionUsd === "string" ? configData.maxPositionUsd : undefined,
      thresholdValue: typeof configData.thresholdValue === "string" ? configData.thresholdValue : undefined,
      cooldownSeconds: typeof configData.cooldownSeconds === "number" ? configData.cooldownSeconds : undefined,
      maxSlippagePct: typeof configData.maxSlippagePct === "string" ? configData.maxSlippagePct : undefined,
      parameters: configData.parameters as Prisma.InputJsonValue | undefined,
    });
    logger.info("Strategy configuration updated", { strategyId: command.strategyId });
  }

  private async publishSnapshot(): Promise<void> {
    const now = Date.now();
    const cbStatus = this.circuitBreaker.getStatus();
    const snapshot: BotSnapshot = {
      snapshotId: randomUUID(),
      timestamp: now,
      botVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
      health: {
        polygonConnection: "CONNECTED",
        redisConnection: "CONNECTED",
        postgresConnection: "CONNECTED",
      },
      pnl: {
        sessionPnLUsd: Number((cbStatus.currentCapitalUsd - config.initialCapitalUsd).toFixed(6)),
        realisedPnLUsd: 0,
        unrealisedPnLUsd: 0,
        totalCapitalUsd: cbStatus.currentCapitalUsd,
        availableUsd: cbStatus.currentCapitalUsd,
      },
      circuitBreaker: cbStatus,
      strategies: this.botState.getStrategySnapshot(),
      positions: this.botState.getPositions(),
      recentLogs: this.botState.getRecentLogs(),
      alerts: this.botState.getAlerts(),
    };

    await redisBus.publishSnapshot(snapshot);
  }
}
