import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, validateAppConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { redisBus } from "../services/redisBus.js";
import { persistence } from "../services/persistence.js";
import { metrics } from "../services/metrics.js";
import { apiAuthHook, resolveApiUser, validateSecurityConfig, type ApiUser } from "./auth.js";
import type { Prisma } from "@prisma/client";
import type { BotCommand } from "../types/redis.js";

interface CommandRequest {
  action: BotCommand["action"];
  strategyId: string;
  payload?: Record<string, unknown>;
  priority?: "HIGH" | "NORMAL" | "LOW";
  correlationId?: string;
}

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.addHook("onClose", async () => {
    try {
      await redisBus.disconnect();
    } catch (error) {
      logger.warn("Error while disconnecting Redis client on server close", error);
    }
  });

  server.addHook("onResponse", async (request, reply) => {
    metrics.incrementRequestCount(request.method, request.routerPath ?? request.url, String(reply.statusCode));
  });

  server.addHook("preHandler", async (request, reply) => {
    if (request.routerPath?.startsWith("/health") || request.routerPath === "/metrics") {
      return;
    }
    await apiAuthHook(request, reply);
  });

  server.get("/health/live", async () => ({
    status: "up",
    timestamp: Date.now(),
  }));

  server.get("/health/ready", async () => {
    const redisHealthy = await redisBus.ping().catch(() => false);
    const dbHealthy = await persistence.ping().catch(() => false);
    const status = redisHealthy && dbHealthy ? "ok" : "degraded";

    metrics.setRedisHealth(redisHealthy);
    metrics.setDatabaseHealth(dbHealthy);
    metrics.setHealthStatus(status === "ok");

    return {
      status,
      timestamp: Date.now(),
      apiPort: process.env.API_PORT ?? 3000,
      redisHealthy,
      dbHealthy,
    };
  });

  server.get("/health", async () => {
    const redisHealthy = await redisBus.ping().catch(() => false);
    const dbHealthy = await persistence.ping().catch(() => false);
    const status = redisHealthy && dbHealthy ? "ok" : "degraded";

    metrics.setRedisHealth(redisHealthy);
    metrics.setDatabaseHealth(dbHealthy);
    metrics.setHealthStatus(status === "ok");

    return {
      status,
      timestamp: Date.now(),
      apiPort: process.env.API_PORT ?? 3000,
      redisHealthy,
      dbHealthy,
    };
  });

  server.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", metrics.register.contentType);
    return await metrics.register.metrics();
  });

  server.post<{ Body: CommandRequest }>(
    "/api/commands",
    async (request, reply) => {
      const body = request.body;
      if (!body?.action || !body.strategyId) {
        return reply.status(400).send({ error: "action and strategyId are required" });
      }

      const user = resolveApiUser(request) as ApiUser;
      const command: BotCommand = {
        commandId: randomUUID(),
        action: body.action,
        strategyId: body.strategyId,
        payload: body.payload ?? {},
        userId: user.userId,
        source: "api",
        timestamp: Date.now(),
        correlationId: body.correlationId,
        priority: body.priority,
      };

      const entryId = await redisBus.enqueueCommand(command);
      await persistence.recordAuditLog({
        userId: user.userId,
        eventType: "api_command",
        action: "enqueue_command",
        resource: "command",
        details: JSON.parse(JSON.stringify({ command, entryId, clientIp: request.ip, userAgent: request.headers["user-agent"] ?? null })),
        source: "api",
      });

      return { entryId, command };
    },
  );

  server.get("/api/snapshot", async () => {
    const snapshot = await redisBus.getLatestSnapshot();
    return { snapshot };
  });

  server.get("/api/circuit-breaker", async () => {
    const snapshot = await redisBus.getLatestSnapshot();
    return { circuitBreaker: snapshot?.circuitBreaker ?? null };
  });

  server.get("/api/strategy-config", async () => {
    const configs = await persistence.getStrategyConfigs();
    return { configs };
  });

  server.get<{ Querystring: { strategy?: string; take?: string; skip?: string; from?: string; to?: string } }>(
    "/api/trades",
    async (request) => {
      const strategy = request.query.strategy;
      const take = request.query.take ? Number(request.query.take) : undefined;
      const skip = request.query.skip ? Number(request.query.skip) : undefined;
      const from = request.query.from ? new Date(request.query.from) : undefined;
      const to = request.query.to ? new Date(request.query.to) : undefined;
      const trades = await persistence.getTrades({
        strategy,
        take,
        skip,
        from,
        to,
      });
      return { trades };
    },
  );

  server.get<{ Querystring: { marketId?: string; take?: string } }>("/api/risk-events", async (request) => {
    const marketId = request.query.marketId;
    const take = request.query.take ? Number(request.query.take) : undefined;
    const events = await persistence.getRiskEvents({ marketId, take });
    return { events };
  });

  server.put<{ Params: { strategyName: string }; Body: Record<string, unknown> }>(
    "/api/strategy-config/:strategyName",
    async (request, reply) => {
      const strategyName = request.params.strategyName;
      const body = request.body;
      if (!body) {
        return reply.status(400).send({ error: "Request body is required" });
      }

      const authUser = resolveApiUser(request) as ApiUser;
      const configData = {
        enabled: body.enabled as boolean | undefined,
        allocationPct: typeof body.allocationPct === "string" ? body.allocationPct : undefined,
        maxPositionUsd: typeof body.maxPositionUsd === "string" ? body.maxPositionUsd : undefined,
        thresholdValue: typeof body.thresholdValue === "string" ? body.thresholdValue : undefined,
        cooldownSeconds: typeof body.cooldownSeconds === "number" ? body.cooldownSeconds : undefined,
        maxSlippagePct: typeof body.maxSlippagePct === "string" ? body.maxSlippagePct : undefined,
        parameters: body.parameters as Prisma.JsonValue | undefined,
      };

      const updated = await persistence.upsertStrategyConfig(strategyName, configData as any);
      await persistence.recordAuditLog({
        userId: authUser.userId,
        eventType: "api_strategy_config",
        action: "update_strategy_config",
        resource: strategyName,
        details: { config: configData, strategyName, clientIp: request.ip },
        source: "api",
      });

      return { updated };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  validateAppConfig();
  validateSecurityConfig();
  await redisBus.connect();
  const server = buildServer();
  const address = await server.listen({
    port: parseInt(process.env.API_PORT ?? "3000", 10),
    host: "0.0.0.0",
  });
  logger.info("API server started", { address, redisUrl: config.redisUrl });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  startServer().catch((error) => {
    logger.error("API server failed to start", error);
    process.exit(1);
  });
}
