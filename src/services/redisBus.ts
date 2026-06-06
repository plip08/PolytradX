import { createClient, type RedisClientType } from "@redis/client";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { BotCommand, BotSnapshot, RedisLockValue } from "../types/redis.js";

const COMMAND_STREAM = "commands:bot";
const SNAPSHOT_CHANNEL = "bot:snapshot";
const SNAPSHOT_KEY = "bot:latest_snapshot";

const RELEASE_LOCK_LUA = `
local value = redis.call("GET", KEYS[1])
if not value then
  return 0
end
local ok, payload = pcall(cjson.decode, value)
if not ok then
  return 0
end
if payload.ownerId ~= ARGV[1] then
  return 0
end
return redis.call("DEL", KEYS[1])
`;

export class RedisBus {
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;

  constructor() {
    this.client = createClient({ url: config.redisUrl });
    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.client.connect(),
      this.publisher.connect(),
      this.subscriber.connect(),
    ]);
  }

  async disconnect(): Promise<void> {
    const disconnections: Array<Promise<unknown>> = [];
    if (this.subscriber.isOpen) {
      disconnections.push(this.subscriber.disconnect());
    }
    if (this.publisher.isOpen) {
      disconnections.push(this.publisher.disconnect());
    }
    if (this.client.isOpen) {
      disconnections.push(this.client.disconnect());
    }
    await Promise.all(disconnections);
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.sendCommand(["PING"]);
      return String(result).toUpperCase() === "PONG";
    } catch {
      return false;
    }
  }

  async ensureCommandGroup(groupName: string): Promise<void> {
    try {
      await this.client.sendCommand([
        "XGROUP",
        "CREATE",
        COMMAND_STREAM,
        groupName,
        "$",
        "MKSTREAM",
      ]);
      logger.info(`Redis stream group created: ${groupName}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("BUSYGROUP")) {
        logger.info(`Redis group already exists: ${groupName}`);
        return;
      }
      throw error;
    }
  }

  async enqueueCommand(command: BotCommand): Promise<string> {
    const commandPayload = JSON.stringify(command);
    const entryId = await this.client.sendCommand([
      "XADD",
      COMMAND_STREAM,
      "*",
      "payload",
      commandPayload,
    ]);
    logger.debug(`Enqueued bot command ${command.commandId} as stream entry ${entryId}`);
    return String(entryId);
  }

  async readCommands(
    groupName: string,
    consumerName: string,
    count = 10,
    blockMs = 1000,
  ): Promise<Array<{ id: string; command: BotCommand }>> {
    const reply = await this.client.sendCommand([
      "XREADGROUP",
      "GROUP",
      groupName,
      consumerName,
      "COUNT",
      String(count),
      "BLOCK",
      String(blockMs),
      "STREAMS",
      COMMAND_STREAM,
      ">",
    ]);

    if (!reply) {
      return [];
    }

    type RedisStreamMessage = [string, Array<[string, string[]]>];
    const items: Array<{ id: string; command: BotCommand }> = [];
    const streams = reply as RedisStreamMessage[];

    for (const [, entries] of streams) {
      for (const [id, fields] of entries) {
        const payloadIndex = fields.findIndex((field) => field === "payload");
        if (payloadIndex === -1 || payloadIndex + 1 >= fields.length) {
          logger.warn(`Malformed Redis stream entry ${id} in ${COMMAND_STREAM}`);
          continue;
        }

        try {
          const payload = JSON.parse(fields[payloadIndex + 1]) as BotCommand;
          items.push({ id, command: payload });
        } catch (error) {
          logger.error(`Unable to parse Redis stream payload for entry ${id}: ${String(error)}`);
        }
      }
    }

    return items;
  }

  async acknowledgeCommand(groupName: string, entryId: string): Promise<number> {
    const result = await this.client.sendCommand([
      "XACK",
      COMMAND_STREAM,
      groupName,
      entryId,
    ]);
    return Number(result);
  }

  async publishSnapshot(snapshot: BotSnapshot): Promise<void> {
    const payload = JSON.stringify(snapshot);
    await Promise.all([
      this.client.sendCommand(["SET", SNAPSHOT_KEY, payload]),
      this.publisher.publish(SNAPSHOT_CHANNEL, payload),
    ]);
    logger.debug(`Published bot snapshot ${snapshot.snapshotId}`);
  }

  async getLatestSnapshot(): Promise<BotSnapshot | null> {
    const raw = await this.client.sendCommand(["GET", SNAPSHOT_KEY]);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(String(raw)) as BotSnapshot;
    } catch (error) {
      logger.error(`Failed to parse latest bot snapshot: ${String(error)}`);
      return null;
    }
  }

  async subscribeToSnapshots(
    onMessage: (message: BotSnapshot, channel: string) => Promise<void> | void,
  ): Promise<void> {
    await this.subscriber.subscribe(SNAPSHOT_CHANNEL, async (rawMessage) => {
      try {
        const parsed = JSON.parse(rawMessage) as BotSnapshot;
        await onMessage(parsed, SNAPSHOT_CHANNEL);
      } catch (error) {
        logger.error(`Invalid snapshot payload received on ${SNAPSHOT_CHANNEL}: ${String(error)}`);
      }
    });
  }

  async acquireLock(key: string, value: RedisLockValue, ttlMs: number): Promise<boolean> {
    const result = await this.client.sendCommand([
      "SET",
      key,
      JSON.stringify(value),
      "NX",
      "PX",
      String(ttlMs),
    ]);
    return result === "OK";
  }

  async releaseLock(key: string, ownerId: string): Promise<boolean> {
    const result = await this.client.sendCommand([
      "EVAL",
      RELEASE_LOCK_LUA,
      "1",
      key,
      ownerId,
    ]);
    return Number(result) === 1;
  }

  async getLockValue(key: string): Promise<RedisLockValue | null> {
    const raw = await this.client.sendCommand(["GET", key]);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(String(raw)) as RedisLockValue;
    } catch (error) {
      logger.error(`Invalid lock payload stored at ${key}: ${String(error)}`);
      return null;
    }
  }
}

export const redisBus = new RedisBus();
