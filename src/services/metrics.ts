import { Counter, Gauge, collectDefaultMetrics, Registry } from "prom-client";

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "polymarket_bot_" });

const apiRequestCounter = new Counter({
  name: "polymarket_bot_api_requests_total",
  help: "Total number of API requests received",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

const healthStatusGauge = new Gauge({
  name: "polymarket_bot_health_status",
  help: "Overall API health status (1 = ok, 0 = degraded)",
  registers: [registry],
});

const redisHealthGauge = new Gauge({
  name: "polymarket_bot_redis_up",
  help: "Redis connectivity status (1 = up, 0 = down)",
  registers: [registry],
});

const databaseHealthGauge = new Gauge({
  name: "polymarket_bot_database_up",
  help: "Database connectivity status (1 = up, 0 = down)",
  registers: [registry],
});

export const metrics = {
  register: registry,

  incrementRequestCount: (method: string, route: string, status: string) => {
    apiRequestCounter.labels(method, route, status).inc();
  },

  setHealthStatus: (healthy: boolean) => {
    healthStatusGauge.set(healthy ? 1 : 0);
  },

  setRedisHealth: (healthy: boolean) => {
    redisHealthGauge.set(healthy ? 1 : 0);
  },

  setDatabaseHealth: (healthy: boolean) => {
    databaseHealthGauge.set(healthy ? 1 : 0);
  },
};
