/**
 * One-shot script to derive your Polymarket CLOB API credentials from your wallet.
 * Run once, then paste the output into .env.
 *
 * Usage:
 *   node --import tsx/esm scripts/get-api-key.mjs
 *   (or: node scripts/get-api-key.mjs  — it's plain ESM)
 */

import { readFileSync } from 'fs';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const CLOB_HOST = process.env.POLYMARKET_CLOB_API_URL ?? 'https://clob.polymarket.com';
const CHAIN_ID  = 137; // Polygon mainnet

const rawKey = process.env.PRIVATE_KEY ?? '';
if (!rawKey) {
  console.error('❌  PRIVATE_KEY not found in .env');
  process.exit(1);
}

const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const wallet = new Wallet(privateKey);

console.log(`Wallet address : ${wallet.address}`);
console.log(`CLOB host      : ${CLOB_HOST}`);
console.log('Deriving API credentials...\n');

// @polymarket/clob-client expects ethers v5's _signTypedData — patch for ethers v6
if (!wallet._signTypedData) {
  wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);
}

const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);

try {
  // createOrDeriveApiKey: creates if none exist, returns existing ones otherwise
  const creds = await client.createOrDeriveApiKey();

  console.log('✅  Success! Add these three lines to your .env:\n');
  console.log(`POLYMARKET_CLOB_API_KEY=${creds.key}`);
  console.log(`POLYMARKET_CLOB_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_CLOB_PASSPHRASE=${creds.passphrase}`);
  console.log('\nThese credentials are tied to your wallet address and do not expire.');
} catch (err) {
  console.error('❌  Failed:', err.message ?? err);
  console.error('\nPossible causes:');
  console.error('  - Network issue reaching Polymarket CLOB API');
  console.error('  - Your wallet has never interacted with Polymarket (needs at least one transaction)');
  process.exit(1);
}
