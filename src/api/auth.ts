import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface ApiUser {
  key: string;
  userId: string;
  role: "admin" | "operator" | "viewer";
}

export function resolveApiUser(request: FastifyRequest): ApiUser | null {
  const authorization = String(request.headers.authorization ?? "").trim();
  const xApiKey = String(request.headers["x-api-key"] ?? "").trim();
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : authorization;
  const apiKey = xApiKey || token;

  if (!apiKey) {
    return null;
  }

  return config.apiKeys.find((item) => item.key === apiKey) ?? null;
}

export function validateSecurityConfig(): void {
  const missing: string[] = [];
  if (config.apiKeys.length === 0) {
    missing.push("API_KEYS");
  }
  if (!config.jwtSecret) {
    missing.push("JWT_SECRET");
  }
  if (!config.totpSecret) {
    missing.push("TOTP_SECRET");
  }

  if (missing.length > 0) {
    logger.error(
      "FATAL: Missing required security environment variables.",
      { missing, message: "The process cannot start in insecure mode." },
    );
    process.exit(1);
  }
}

export async function apiAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = resolveApiUser(request);
  if (!user) {
    logger.warn("Unauthorized API request", { path: request.routerPath, method: request.method });
    reply.status(401).send({ error: "Unauthorized" });
    return;
  }

  (request as FastifyRequest & { apiUser?: ApiUser }).apiUser = user;
}
