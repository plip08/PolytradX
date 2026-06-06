import { randomUUID } from "node:crypto";
import { BotCommand } from "../types/redis.js";
import { logger } from "../utils/logger.js";
import { persistence } from "./persistence.js";
import { redisBus } from "./redisBus.js";

const SYSTEM_COMMAND_INTERVAL_MS = 60_000;

export class AutonomousCommandProducer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private isStarted = false;

  constructor(private readonly strategyNames: string[]) {}

  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.interval = setInterval(() => {
      void this.publishHeartbeatCommand();
    }, SYSTEM_COMMAND_INTERVAL_MS);

    void this.publishHeartbeatCommand();
    logger.info("Autonomous command producer started", { intervalMs: SYSTEM_COMMAND_INTERVAL_MS });
  }

  stop(): void {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info("Autonomous command producer stopped");
  }

  private async publishHeartbeatCommand(): Promise<void> {
    const command: BotCommand = {
      commandId: randomUUID(),
      action: "FORCE_REBALANCE",
      strategyId: "system",
      payload: {
        reason: "autonomous-heartbeat",
        activeStrategies: this.strategyNames,
      },
      userId: "system",
      source: "system",
      timestamp: Date.now(),
      priority: "HIGH",
    };

    try {
      const entryId = await redisBus.enqueueCommand(command);
      await persistence.recordAuditLog({
        userId: "system",
        eventType: "system_command",
        action: "enqueue_force_rebalance",
        resource: "commands:bot",
        details: JSON.parse(JSON.stringify({ command, entryId })),
        source: "system",
      });
      logger.info("Autonomous command enqueued", { commandId: command.commandId, entryId });
    } catch (error) {
      logger.error("Autonomous command enqueue failed", error);
    }
  }
}
