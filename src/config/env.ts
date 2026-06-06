import dotenv from "dotenv";

dotenv.config();

export const config = {
  rpcUrls: process.env.POLYGON_RPC_URLS?.split(",").map((url) => url.trim()) || [],
  privateKey: process.env.PRIVATE_KEY ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  postgresUrl: process.env.DATABASE_URL ?? "postgresql://postgres:password@127.0.0.1:5432/polymarket",
  polymarketApiKey: process.env.POLYMARKET_API_KEY ?? "",
  riskAllocation: {
    marketMaking: 0.3,
    atomicArbitrage: 0.4,
    other: 0.3,
  },
  maxSlippagePct: parseFloat(process.env.MAX_SLIPPAGE_PCT ?? "0.6") / 100,
  orderTimeoutMs: parseInt(process.env.ORDER_TIMEOUT_MS ?? "180000", 10),
  ctfContractAddress: process.env.CTF_CONTRACT_ADDRESS ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "",
  totpSecret: process.env.TOTP_SECRET ?? "",
  simulationMode: process.env.SIMULATION_MODE === "true",
  initialCapitalUsd: parseFloat(process.env.INITIAL_CAPITAL_USD ?? "100000"),
  maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES ?? "3", 10),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT ?? "0.15"),
  maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD ?? "10000"),
  maxSingleLossUsd: parseFloat(process.env.MAX_SINGLE_LOSS_USD ?? "2500"),
  maxPositionUsd: parseFloat(process.env.MAX_POSITION_USD ?? "25000"),
  maxMarketPositionUsd: parseFloat(process.env.MAX_MARKET_POSITION_USD ?? "10000"),
  maxOrderUsd: parseFloat(process.env.MAX_ORDER_USD ?? "5000"),
  minStrategyEdgePct: parseFloat(process.env.MIN_STRATEGY_EDGE_PCT ?? "0.002"),
  circuitBreakerCooldownMs: parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? "3600000", 10),
  circuitBreakerLossWindowMs: parseInt(process.env.CIRCUIT_BREAKER_LOSS_WINDOW_MS ?? "86400000", 10),
  marketDataStaleThresholdMs: parseInt(process.env.MARKET_DATA_STALE_THRESHOLD_MS ?? "2000", 10),
  apiKeys: (process.env.API_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, userId, role] = entry.split(":").map((part) => part.trim());
      if (!key || !userId || !role) {
        throw new Error("API_KEYS must use key:userId:role format, comma separated.");
      }
      return {
        key,
        userId,
        role: role as "admin" | "operator" | "viewer",
      };
    }),
};

export function validateAppConfig(): void {
  if (config.rpcUrls.length === 0) {
    throw new Error("POLYGON_RPC_URLS must be set in environment variables.");
  }

  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY must be set in environment variables.");
  }
}

export function validateSecurityConfig(): void {
  const missingSecurity: string[] = [];
  if (config.apiKeys.length === 0) {
    missingSecurity.push("API_KEYS");
  }
  if (!config.jwtSecret) {
    missingSecurity.push("JWT_SECRET");
  }
  if (!config.totpSecret) {
    missingSecurity.push("TOTP_SECRET");
  }

  if (missingSecurity.length > 0) {
    console.error(
      `FATAL: Missing required security environment variables: ${missingSecurity.join(", ")}. The process cannot start in insecure mode.`,
    );
    process.exit(1);
  }
}
