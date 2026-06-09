import { describe, expect, it } from 'vitest';
import { MarketDiscovery } from '../src/services/marketDiscovery.js';
import type { MarketInfo } from '../src/types/index.js';

type Stub = Record<string, unknown>;
const fetchEventGroups = (
  MarketDiscovery.prototype as unknown as { fetchEventGroups: (this: Stub) => Promise<MarketInfo[][]> }
).fetchEventGroups;

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

function fakeMarket(id: string, closed = false) {
  return {
    id,
    conditionId: `${id}-cond`,
    question: `Will ${id} happen?`,
    description: '',
    endDate: FUTURE,
    active: true,
    closed,
    outcomes: '["Yes","No"]',
    clobTokenIds: `["${id}-yes","${id}-no"]`,
    volume: 50_000,
    liquidity: 5_000,
  };
}

function fakeEvent(opts: { id: string; negRisk?: boolean; nMarkets: number; volume?: number }) {
  return {
    id: opts.id,
    title: `Event ${opts.id}`,
    active: true,
    closed: false,
    volume: opts.volume ?? 100_000,
    negRisk: opts.negRisk,
    markets: Array.from({ length: opts.nMarkets }, (_, i) => fakeMarket(`${opts.id}-m${i}`)),
  };
}

function run(events: unknown[]): Promise<MarketInfo[][]> {
  const stub: Stub = {
    gammaHttp: { get: async () => ({ data: events }) },
    config: { minVolumeUsd: 1_000, minExpiryMs: 0 },
  };
  return fetchEventGroups.call(stub);
}

describe('MarketDiscovery.fetchEventGroups — only true neg-risk events', () => {
  it('emits a group for a negRisk=true event with 3+ live markets', async () => {
    const groups = await run([fakeEvent({ id: 'A', negRisk: true, nMarkets: 3 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('excludes negRisk=false events (thematic bundles of independent binaries)', async () => {
    const groups = await run([fakeEvent({ id: 'B', negRisk: false, nMarkets: 5 })]);
    expect(groups).toHaveLength(0);
  });

  it('excludes events missing the negRisk flag entirely', async () => {
    const groups = await run([fakeEvent({ id: 'C', negRisk: undefined, nMarkets: 4 })]);
    expect(groups).toHaveLength(0);
  });

  it('excludes negRisk=true events with fewer than 3 live markets', async () => {
    const groups = await run([fakeEvent({ id: 'D', negRisk: true, nMarkets: 2 })]);
    expect(groups).toHaveLength(0);
  });

  it('excludes events below the minimum volume threshold', async () => {
    const groups = await run([fakeEvent({ id: 'E', negRisk: true, nMarkets: 3, volume: 500 })]);
    expect(groups).toHaveLength(0);
  });

  it('picks only the valid neg-risk event out of a mixed batch', async () => {
    const groups = await run([
      fakeEvent({ id: 'good', negRisk: true, nMarkets: 4 }),
      fakeEvent({ id: 'bundle', negRisk: false, nMarkets: 6 }),
      fakeEvent({ id: 'tooFew', negRisk: true, nMarkets: 2 }),
      fakeEvent({ id: 'noFlag', nMarkets: 5 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(4);
    expect(groups[0]![0]!.id).toContain('good');
  });
});
