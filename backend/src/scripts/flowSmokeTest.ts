/**
 * READ-ONLY FLOW SMOKE TEST
 *
 * Validates the market-data pipeline end-to-end against the LIVE public
 * Polymarket APIs — with ZERO wallet, ZERO auth, ZERO on-chain transactions.
 *
 *   1. MarketDiscovery → Gamma API   (markets, event groups, near-expiry)
 *   2. ClobClient.getOrderBook        → public /book endpoint
 *
 * Run:  npx tsx src/scripts/flowSmokeTest.ts
 */

import 'dotenv/config';
import { MarketDiscovery } from '../services/marketDiscovery.js';
import { ClobClient } from '../services/clobClient.js';
import type { MarketInfo } from '../types/index.js';

const SCAN_WAIT_MS = 15_000;

function log(step: string, msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[${step}] ${msg}`);
}

async function main() {
  log('BOOT', 'Read-only flow smoke test — no wallet, no on-chain, no orders');

  const captured: {
    crypto: MarketInfo[];
    sports: MarketInfo[];
    liquid: MarketInfo[];
    groups: MarketInfo[][];
    nearExpiry: MarketInfo[];
  } = { crypto: [], sports: [], liquid: [], groups: [], nearExpiry: [] };

  const discovery = MarketDiscovery.getInstance();
  discovery.registerHandlers({
    onCryptoMarkets:     (m) => { captured.crypto = m; },
    onSportsMarkets:     (m) => { captured.sports = m; },
    onAllLiquidMarkets:  (m) => { captured.liquid = m; },
    onEventGroups:       (g) => { captured.groups = g; },
    onNearExpiryMarkets: (m) => { captured.nearExpiry = m; },
  });

  log('DISCOVERY', 'Starting Gamma scan…');
  discovery.start();

  await new Promise((r) => setTimeout(r, SCAN_WAIT_MS));
  discovery.stop();

  log('DISCOVERY', `crypto=${captured.crypto.length} sports=${captured.sports.length} liquid=${captured.liquid.length} eventGroups=${captured.groups.length} nearExpiry=${captured.nearExpiry.length}`);

  const sample = captured.liquid[0] ?? captured.crypto[0] ?? captured.sports[0];
  if (!sample) {
    log('DISCOVERY', '❌ No markets returned — Gamma API unreachable or geo-blocked (check PROXY).');
    process.exit(1);
  }

  log('DISCOVERY', `✅ Sample market: "${sample.question.slice(0, 70)}"`);
  log('DISCOVERY', `   yesToken=${sample.yesTokenId.slice(0, 14)}… vol=${sample.volume ?? 'n/a'} cat=${sample.category}`);

  // ─── Order book flow ────────────────────────────────────────────────────────
  log('ORDERBOOK', 'Fetching live book for sample YES token via public /book…');
  try {
    const clob = ClobClient.getInstance();
    const ob = await clob.getOrderBook(sample.yesTokenId);
    log('ORDERBOOK', `✅ bids=${ob.bids.length} asks=${ob.asks.length} bestBid=${ob.bestBid} bestAsk=${ob.asks[0]?.price ?? 'n/a'} mid=${ob.midPrice} spread=${ob.spread}`);
  } catch (err) {
    log('ORDERBOOK', `❌ Book fetch failed: ${(err as Error).message}`);
    log('ORDERBOOK', '   (CLOB /book may be geo-restricted from this IP — try PROXY)');
  }

  log('DONE', 'Flow smoke test complete.');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[FATAL]', err);
  process.exit(1);
});
