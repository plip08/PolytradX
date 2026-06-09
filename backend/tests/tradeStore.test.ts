import { describe, expect, it } from 'vitest';
import { toBotTradeRow } from '../src/services/tradeStore.js';
import type { TradeExecution } from '../src/types/index.js';

function execution(overrides: Partial<TradeExecution> = {}): TradeExecution {
  return {
    id: 'exec-1',
    strategyId: 'ATOMIC_ARB',
    marketId: 'mkt-1',
    tokenId: 'tok-1',
    side: 'BUY',
    price: 0.42,
    size: 100,
    timestamp: 1_900_000_000_000,
    status: 'SUCCESS',
    ...overrides,
  };
}

describe('toBotTradeRow — TradeExecution → bot_trades row', () => {
  it('maps core fields and derives notional = price × size', () => {
    const row = toBotTradeRow(execution(), '0xWallet');
    expect(row).toMatchObject({
      id: 'exec-1',
      strategyId: 'ATOMIC_ARB',
      marketId: 'mkt-1',
      tokenId: 'tok-1',
      walletAddress: '0xWallet',
      side: 'BUY',
      status: 'SUCCESS',
      priceUsd: 0.42,
      size: 100,
    });
    expect(row.notionalUsd).toBeCloseTo(42, 9);
    expect(row.executedAt).toEqual(new Date(1_900_000_000_000));
  });

  it('nulls optional fields when absent (so Prisma stores NULL, not undefined)', () => {
    const row = toBotTradeRow(execution(), '0xWallet');
    expect(row.txHash).toBeNull();
    expect(row.pnlUsd).toBeNull();
    expect(row.slippagePct).toBeNull();
    expect(row.gasUsed).toBeNull();
    expect(row.gasCostUsd).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.polygonscanUrl).toBeNull();
  });

  it('carries through optional fields when present (incl. bigint gasUsed)', () => {
    const row = toBotTradeRow(
      execution({
        txHash: '0xabc',
        pnl: 1.25,
        slippage: 0.003,
        gasUsed: 21000n,
        gasCostUsdc: 0.01,
        polygonscanUrl: 'https://polygonscan.com/tx/0xabc',
      }),
      '0xWallet',
    );
    expect(row.txHash).toBe('0xabc');
    expect(row.pnlUsd).toBe(1.25);
    expect(row.slippagePct).toBe(0.003);
    expect(row.gasUsed).toBe(21000n);
    expect(row.gasCostUsd).toBe(0.01);
    expect(row.polygonscanUrl).toBe('https://polygonscan.com/tx/0xabc');
  });
});
