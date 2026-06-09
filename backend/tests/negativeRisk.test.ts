import { describe, expect, it } from 'vitest';
import { NegativeRiskStrategy } from '../src/strategies/negativeRisk.js';
import type { MultiCategoryMarket, OrderBook } from '../src/types/index.js';

// buildMarketSnapshot / computeAllocation are the core of the NegativeRisk fixes
// (phantom-price tradeable guard + 404-resilient book fetch + allocation math).
// Exercise them directly against a stub `this` — no broadcasts, no network.
const buildMarketSnapshot = (
  NegativeRiskStrategy.prototype as unknown as {
    buildMarketSnapshot: (g: unknown) => Promise<MultiCategoryMarket>;
  }
).buildMarketSnapshot;
const computeAllocation = (
  NegativeRiskStrategy.prototype as unknown as {
    computeAllocation: (m: MultiCategoryMarket) => {
      tradesRequired: Array<{ action: string }>;
      expectedProfitUsd: number;
    };
  }
).computeAllocation;

function book(bestAsk: number, bestBid: number, asks?: OrderBook['asks']): OrderBook {
  return {
    tokenId: 't',
    marketId: 'm',
    bids: [],
    asks: asks ?? [{ price: bestAsk, size: 100 }],
    timestamp: 0,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    bestBid,
    bestAsk,
  } as unknown as OrderBook;
}

const GROUP = {
  groupId: 'g',
  description: 'd',
  tokenIds: ['a', 'b', 'c'],
  marketIds: ['ma', 'mb', 'mc'],
  labels: ['A', 'B', 'C'],
};

describe('NegativeRisk.buildMarketSnapshot — tradeable guard', () => {
  it('sums YES asks and is tradeable when every outcome has asks', async () => {
    const books: Record<string, OrderBook> = { a: book(0.5, 0.45), b: book(0.4, 0.35), c: book(0.25, 0.2) };
    const stub = { clob: { getOrderBook: async (id: string) => books[id] } };
    const snap = await buildMarketSnapshot.call(stub, GROUP);
    expect(snap.tradeable).toBe(true);
    expect(snap.sumYesPrices).toBeCloseTo(1.15, 5);
    expect(snap.excessAboveOne).toBeCloseTo(0.15, 5);
  });

  it('is NOT tradeable when an outcome has no asks (phantom bestAsk=1 must not count)', async () => {
    const books: Record<string, OrderBook> = { a: book(0.5, 0.45), b: book(1, 0, []), c: book(0.25, 0.2) };
    const stub = { clob: { getOrderBook: async (id: string) => books[id] } };
    const snap = await buildMarketSnapshot.call(stub, GROUP);
    expect(snap.tradeable).toBe(false);
  });

  it('survives a 404 on one leg (allSettled) and is NOT tradeable', async () => {
    const books: Record<string, OrderBook> = { a: book(0.5, 0.45), c: book(0.25, 0.2) };
    const stub = {
      clob: {
        getOrderBook: async (id: string) => {
          if (id === 'b') throw new Error('Request failed with status code 404');
          return books[id];
        },
      },
    };
    const snap = await buildMarketSnapshot.call(stub, GROUP);
    expect(snap.tradeable).toBe(false);
    expect(snap.outcomes[1]!.yesPrice).toBe(1); // missing leg defaults to 1
  });
});

describe('NegativeRisk.computeAllocation — profit math', () => {
  it('targets only overvalued outcomes; profit = excess × deployed capital', () => {
    const market: MultiCategoryMarket = {
      groupId: 'g',
      description: 'd',
      outcomes: [
        { tokenId: 'a', marketId: 'ma', label: 'A', yesPrice: 0.5, noPrice: 0.55, impliedProbability: 0.5 },
        { tokenId: 'b', marketId: 'mb', label: 'B', yesPrice: 0.4, noPrice: 0.65, impliedProbability: 0.4 },
        { tokenId: 'c', marketId: 'mc', label: 'C', yesPrice: 0.25, noPrice: 0.8, impliedProbability: 0.25 },
      ],
      sumYesPrices: 1.15,
      excessAboveOne: 0.15,
      tradeable: true,
    };
    const stub = { config: { capitalAllocationUsd: 45 } };
    const alloc = computeAllocation.call(stub, market);
    // fairPrice = 1/3 ≈ 0.333 → overvalued = A(0.5), B(0.4); C(0.25) excluded
    expect(alloc.tradesRequired).toHaveLength(2);
    expect(alloc.tradesRequired.every((t) => t.action === 'BUY_NO')).toBe(true);
    // deployed = min(45, 2×100) = 45; profit = 0.15 × 45
    expect(alloc.expectedProfitUsd).toBeCloseTo(0.15 * 45, 5);
  });
});
