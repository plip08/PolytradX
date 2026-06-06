import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const envFile = path.join(root, ".env");
const exampleFile = path.join(root, ".env.example");

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
} else if (fs.existsSync(exampleFile)) {
  dotenv.config({ path: exampleFile });
}

process.env.NODE_ENV ??= "test";
process.env.POLYGON_RPC_URLS ??= "https://polygon-rpc.com";
process.env.PRIVATE_KEY ??= "0x" + "1".repeat(64);
process.env.API_KEYS ??= "testkey:operator:operator";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.TOTP_SECRET ??= "test-totp-secret";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.DATABASE_URL ??= "postgresql://postgres:password@127.0.0.1:5432/polymarket";
process.env.POLYMARKET_API_KEY ??= "test-polymarket-api-key";
process.env.CTF_CONTRACT_ADDRESS ??= "0x0000000000000000000000000000000000000000";
