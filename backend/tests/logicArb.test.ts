import { describe, expect, it } from 'vitest';
import { classifyMarket, LogicArbStrategy } from '../src/strategies/logicArb.js';
import type { MarketInfo, StrategyConfig } from '../src/types/index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let nextId = 1;
function market(question: string, opts: Partial<MarketInfo> = {}): MarketInfo {
  const id = opts.id ?? `m${nextId++}`;
  return {
    id,
    question,
    description: '',
    yesTokenId: `${id}-yes`,
    noTokenId: `${id}-no`,
    conditionId: `${id}-cond`,
    collateralToken: '0xUSDC',
    expirationTimestamp: opts.expirationTimestamp ?? 1_900_000_000_000,
    resolved: false,
    category: opts.category ?? 'crypto',
    tags: [],
    volume: opts.volume ?? 100_000,
    ...opts,
  };
}

const CONFIG = { capitalAllocationUsd: 20 } as unknown as StrategyConfig;
function makeStrategy(): LogicArbStrategy {
  // setMarkets only touches config + emitLog; clob/risk are unused there.
  return new LogicArbStrategy(
    { scanIntervalMs: 60_000, maxPairsToTrack: 20 },
    CONFIG,
    {} as never,
    {} as never,
  );
}

// ─── classifyMarket: level extraction ──────────────────────────────────────────

describe('classifyMarket — level extraction', () => {
  const cases: Array<[string, number]> = [
    ['Will Bitcoin reach $90k by Dec 31?', 90_000],
    ['Will Bitcoin reach $100,000 by Dec 31?', 100_000],
    ['Will Adobe Q2 total ARR be above $27.0B?', 27e9],
    ['Will Pump.fun reach $0.0042 by December 31, 2026?', 0.0042],
    ['Will Tesla close above $400 on June 9?', 400],
  ];
  it.each(cases)('%s → %d', (q, expected) => {
    expect(classifyMarket(market(q))?.level).toBe(expected);
  });

  it('does not read the "b" of a trailing "by" as billions ("$115 by" ≠ 115e9)', () => {
    expect(classifyMarket(market('Will Crude Oil hit $115 by end of June?'))?.level).toBe(115);
  });
});

// ─── classifyMarket: direction + rejection ─────────────────────────────────────

describe('classifyMarket — direction & rejection', () => {
  it('detects GTE direction', () => {
    expect(classifyMarket(market('Will BTC reach $100k by Dec?'))?.direction).toBe('GTE');
    expect(classifyMarket(market('Will BTC be above $100k by Dec?'))?.direction).toBe('GTE');
  });

  it('detects LTE direction', () => {
    expect(classifyMarket(market('Will BTC fall below $80k by Dec?'))?.direction).toBe('LTE');
  });

  it('rejects markets with no comparison direction (different teams are not a ladder)', () => {
    expect(classifyMarket(market('Will Uzbekistan win the 2026 FIFA World Cup?'))).toBeNull();
    expect(classifyMarket(market('Will France win the 2026 FIFA World Cup?'))).toBeNull();
  });

  it('rejects bare years / non-$ integers as levels', () => {
    expect(classifyMarket(market('Will Trump win in 2028?'))).toBeNull();
  });

  it('flags cumulative "by <date>" markets as time-ladderable', () => {
    expect(classifyMarket(market('Will BTC hit $150k by June 30?'))?.byDeadline).toBe(true);
    expect(classifyMarket(market('Will BTC close above $400 on June 9?'))?.byDeadline).toBe(false);
  });

  it('groups rungs that differ only by date into one skeleton', () => {
    const a = classifyMarket(market('Will Bitcoin hit $150k by September 30?'));
    const b = classifyMarket(market('Will Bitcoin hit $150k by December 31, 2026?'));
    expect(a?.skeleton).toBe(b?.skeleton);
  });
});

// ─── setMarkets: ladder generation ──────────────────────────────────────────────

describe('LogicArbStrategy.setMarkets — ladder generation', () => {
  it('builds a TIME ladder: earlier "by" deadline implies the later one', () => {
    const jun = market('Will Bitcoin hit $150k by June 30, 2026?', { expirationTimestamp: 1_900_000_000_000 });
    const dec = market('Will Bitcoin hit $150k by December 31, 2026?', { expirationTimestamp: 1_950_000_000_000 });
    const s = makeStrategy();
    s.setMarkets([jun, dec]);
    const pairs = s.getPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.relation).toBe('A_IMPLIES_B');
    expect(pairs[0]!.marketA.marketId).toBe(jun.id); // earlier deadline = implier
    expect(pairs[0]!.marketB.marketId).toBe(dec.id);
  });

  it('builds a PRICE ladder: higher GTE level implies the lower one', () => {
    const t = 1_900_000_000_000;
    const lo = market('Will Bitcoin reach $100k by Dec 31, 2026?', { expirationTimestamp: t });
    const hi = market('Will Bitcoin reach $110k by Dec 31, 2026?', { expirationTimestamp: t });
    const s = makeStrategy();
    s.setMarkets([lo, hi]);
    const pairs = s.getPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.marketA.marketId).toBe(hi.id); // higher level = implier
    expect(pairs[0]!.marketB.marketId).toBe(lo.id);
  });

  it('builds NO pair from unrelated same-category markets (the old phantom bug)', () => {
    const s = makeStrategy();
    s.setMarkets([
      market('Will Uzbekistan win the 2026 FIFA World Cup?', { category: 'sports' }),
      market('Will France win the 2026 FIFA World Cup?', { category: 'sports' }),
    ]);
    expect(s.getPairs()).toHaveLength(0);
  });

  it('does NOT time-ladder point-in-time ("on <date>") markets', () => {
    const s = makeStrategy();
    s.setMarkets([
      market('Will Tesla close above $400 on June 9?', { expirationTimestamp: 1_900_000_000_000 }),
      market('Will Tesla close above $400 on July 9?', { expirationTimestamp: 1_950_000_000_000 }),
    ]);
    expect(s.getPairs()).toHaveLength(0);
  });

  it('does NOT pair rungs that differ in both level and deadline', () => {
    const s = makeStrategy();
    s.setMarkets([
      market('Will Bitcoin hit $150k by June 30, 2026?', { expirationTimestamp: 1_900_000_000_000 }),
      market('Will Bitcoin hit $200k by December 31, 2026?', { expirationTimestamp: 1_950_000_000_000 }),
    ]);
    expect(s.getPairs()).toHaveLength(0);
  });
});
