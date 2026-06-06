import { createClient, type RedisClientType } from "@redis/client";
import { Pool } from "pg";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { MarketState } from "../types/market.js";

export class DataStore {
  private redis: RedisClientType;
  private pool: Pool;

  constructor() {
    this.redis = createClient({ url: config.redisUrl });
    this.pool = new Pool({ connectionString: config.postgresUrl });
  }

  async connect(): Promise<void> {
    this.redis.on("error", (error) => logger.warn("Redis client error", error));
    await this.redis.connect();
    await this.pool.connect();
    logger.info("Connected to Redis and PostgreSQL.");
  }

  async cacheMarketState(state: MarketState): Promise<void> {
    try {
      await this.redis.set(`market:${state.marketId}`, JSON.stringify(state), { EX: 10 });
      logger.debug("Cached market state", state.marketId);
    } catch (error) {
      logger.warn("Unable to cache market state", error);
    }
  }

  async getCachedMarketState(marketId: string): Promise<MarketState | null> {
    try {
      const payload = await this.redis.get(`market:${marketId}`);
      return payload ? (JSON.parse(payload) as MarketState) : null;
    } catch (error) {
      logger.warn("Unable to read cached market state", error);
      return null;
    }
  }

  async persistTrade(record: {
    strategy: string;
    marketId: string;
    edge: number;
    sizeUsd: number;
    txHash?: string;
    outcome?: string;
    timestamp: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO trade_history(strategy, market_id, edge, size_usd, tx_hash, outcome, created_at)
         VALUES($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
        [record.strategy, record.marketId, record.edge, record.sizeUsd, record.txHash ?? null, record.outcome ?? null, record.timestamp],
      );
      logger.debug("Persisted trade record", record.marketId);
    } catch (error) {
      logger.warn("Unable to persist trade record", error);
    }
  }
}
