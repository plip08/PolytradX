import { beforeEach, describe, expect, it, vi } from 'vitest';

// handleProposePrice broadcasts via the WS singleton — stub it so the parser is testable.
vi.mock('../src/core/wsServer.js', () => ({
  BotWebSocketServer: { getInstance: () => ({ broadcast: () => undefined }) },
}));

import { ResolutionSnipingStrategy } from '../src/strategies/resolutionSniping.js';

type Stub = Record<string, unknown>;
const proto = ResolutionSnipingStrategy.prototype as unknown as {
  scanOracleEvents: (this: Stub) => Promise<void>;
  handleProposePrice: (this: Stub, log: unknown) => void;
  extractMarketId: (this: Stub, hex: string) => string;
};

function log(blockNumber: number) {
  return { blockNumber, args: {} };
}

function pollingStub(over: Partial<Stub> = {}): Stub {
  return {
    provider: { getBlockNumber: vi.fn(async () => 500) },
    umaContract: { queryFilter: vi.fn(async () => [] as unknown[]) },
    handleProposePrice: vi.fn(),
    handleSettle: vi.fn(),
    lastScannedBlock: 0,
    oracleScanInFlight: false,
    strategyId: 'RESOLUTION_SNIPE',
    ...over,
  };
}

describe('ResolutionSniping.scanOracleEvents — eth_getLogs block-window polling', () => {
  it('anchors at the head on the first tick and queries nothing', async () => {
    const stub = pollingStub({ lastScannedBlock: 0 });
    await proto.scanOracleEvents.call(stub);
    expect(stub.lastScannedBlock).toBe(500);
    expect((stub.umaContract as { queryFilter: ReturnType<typeof vi.fn> }).queryFilter).not.toHaveBeenCalled();
  });

  it('does nothing when no new blocks have been produced', async () => {
    const stub = pollingStub({ lastScannedBlock: 500 });
    await proto.scanOracleEvents.call(stub);
    expect(stub.lastScannedBlock).toBe(500);
    expect((stub.umaContract as { queryFilter: ReturnType<typeof vi.fn> }).queryFilter).not.toHaveBeenCalled();
  });

  it('queries the new (from..to) range and advances lastScannedBlock', async () => {
    const qf = vi.fn(async () => [] as unknown[]);
    const stub = pollingStub({
      lastScannedBlock: 100,
      provider: { getBlockNumber: vi.fn(async () => 105) },
      umaContract: { queryFilter: qf },
    });
    await proto.scanOracleEvents.call(stub);
    expect(qf).toHaveBeenCalledWith('ProposePrice', 101, 105);
    expect(qf).toHaveBeenCalledWith('Settle', 101, 105);
    expect(stub.lastScannedBlock).toBe(105);
  });

  it('caps each eth_getLogs call at ORACLE_MAX_BLOCK_RANGE (1000 blocks)', async () => {
    const qf = vi.fn(async () => [] as unknown[]);
    const stub = pollingStub({
      lastScannedBlock: 1000,
      provider: { getBlockNumber: vi.fn(async () => 3500) },
      umaContract: { queryFilter: qf },
    });
    await proto.scanOracleEvents.call(stub);
    const proposeRanges = qf.mock.calls.filter((c) => c[0] === 'ProposePrice').map((c) => [c[1], c[2]]);
    expect(proposeRanges).toEqual([
      [1001, 2000],
      [2001, 3000],
      [3001, 3500],
    ]);
    expect(stub.lastScannedBlock).toBe(3500);
  });

  it('does NOT advance past a range that errors (so the next tick retries it)', async () => {
    const stub = pollingStub({
      lastScannedBlock: 100,
      provider: { getBlockNumber: vi.fn(async () => 105) },
      umaContract: { queryFilter: vi.fn(async () => { throw new Error('filter timeout'); }) },
    });
    await expect(proto.scanOracleEvents.call(stub)).resolves.toBeUndefined(); // no throw
    expect(stub.lastScannedBlock).toBe(100);
  });

  it('skips entirely when a previous scan is still in flight', async () => {
    const getBlockNumber = vi.fn(async () => 500);
    const stub = pollingStub({ oracleScanInFlight: true, provider: { getBlockNumber } });
    await proto.scanOracleEvents.call(stub);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('forwards every ProposePrice log to the handler', async () => {
    const handleProposePrice = vi.fn();
    const stub = pollingStub({
      lastScannedBlock: 100,
      provider: { getBlockNumber: vi.fn(async () => 105) },
      umaContract: {
        queryFilter: vi.fn(async (name: string) => (name === 'ProposePrice' ? [log(101), log(102)] : [])),
      },
      handleProposePrice,
    });
    await proto.scanOracleEvents.call(stub);
    expect(handleProposePrice).toHaveBeenCalledTimes(2);
  });
});

describe('ResolutionSniping.handleProposePrice — log parsing', () => {
  let stub: Stub;
  beforeEach(() => {
    stub = {
      extractMarketId: () => 'mkt-1',
      pendingProposals: new Map(),
      strategyId: 'RESOLUTION_SNIPE',
    };
  });

  function proposeLog(proposedPrice: bigint) {
    return {
      blockNumber: 42,
      args: {
        requester: '0xRequester',
        identifier: '0xCondition',
        timestamp: 1700n,
        ancillaryData: '0x',
        proposedPrice,
        expirationTimestamp: 9999n,
      },
    };
  }

  it('builds a YES proposal (proposedPrice > 0) keyed by requester_timestamp', () => {
    proto.handleProposePrice.call(stub, proposeLog(1n));
    const proposals = stub.pendingProposals as Map<string, { proposedOutcome: string; marketId: string; blockNumber: number }>;
    const p = proposals.get('0xRequester_1700');
    expect(p).toBeDefined();
    expect(p!.proposedOutcome).toBe('YES');
    expect(p!.marketId).toBe('mkt-1');
    expect(p!.blockNumber).toBe(42);
  });

  it('builds a NO proposal when proposedPrice <= 0', () => {
    proto.handleProposePrice.call(stub, proposeLog(0n));
    const proposals = stub.pendingProposals as Map<string, { proposedOutcome: string }>;
    expect(proposals.get('0xRequester_1700')!.proposedOutcome).toBe('NO');
  });
});

describe('ResolutionSniping.extractMarketId — ancillary data decode', () => {
  it('decodes a hex-encoded marketId tag', () => {
    const hex = '0x' + Buffer.from('q: something marketId:abc-123 more', 'utf8').toString('hex');
    expect(proto.extractMarketId.call({}, hex)).toBe('abc-123');
  });

  it('returns "unknown" when no marketId tag is present', () => {
    const hex = '0x' + Buffer.from('no tag here', 'utf8').toString('hex');
    expect(proto.extractMarketId.call({}, hex)).toBe('unknown');
  });
});
