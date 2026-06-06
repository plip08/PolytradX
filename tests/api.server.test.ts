import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";

const app = buildServer();
let server: import("http").Server;

beforeAll(async () => {
  await app.ready();
  server = app.server;
});

afterAll(async () => {
  await app.close();
});

describe("API server health and metrics", () => {
  it("responds to /health with health metadata", async () => {
    const response = await supertest(server).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status");
    expect(response.body).toHaveProperty("redisHealthy");
    expect(response.body).toHaveProperty("dbHealthy");
  });

  it("responds to /health/live with liveness status", async () => {
    const response = await supertest(server).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "up", timestamp: expect.any(Number) });
  });

  it("responds to /health/ready with readiness status", async () => {
    const response = await supertest(server).get("/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status");
    expect(response.body).toHaveProperty("redisHealthy");
    expect(response.body).toHaveProperty("dbHealthy");
  });

  it("exposes Prometheus metrics at /metrics", async () => {
    const response = await supertest(server).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("polymarket_bot_");
  });
});
