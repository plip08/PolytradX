import { describe, expect, it, vi } from 'vitest';

// updateConfig/setDryRun broadcast via the WS singleton — stub it.
vi.mock('../src/core/wsServer.js', () => ({
  BotWebSocketServer: { getInstance: () => ({ broadcast: () => undefined }) },
}));

import { StrategyRunner } from '../src/services/strategyRunner.js';

type Stub = Record<string, unknown>;
const proto = StrategyRunner.prototype as unknown as {
  updateConfig: (this: Stub, id: string, partial: Record<string, unknown>) => void;
  setDryRun: (this: Stub, enabled: boolean) => void;
};

describe('StrategyRunner.updateConfig — must mutate in place', () => {
  it('preserves the config object reference (the one the running strategy holds)', () => {
    const cfg = { id: 'ATOMIC_ARB', dryRun: true, enabled: true, capitalAllocationUsd: 60 };
    const stub: Stub = { configMap: { ATOMIC_ARB: cfg } };

    proto.updateConfig.call(stub, 'ATOMIC_ARB', { dryRun: false, capitalAllocationUsd: 80 });

    // same object reference → the strategy sees the change without a restart
    expect((stub.configMap as Record<string, unknown>)['ATOMIC_ARB']).toBe(cfg);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.capitalAllocationUsd).toBe(80);
  });
});

describe('StrategyRunner.setDryRun — flips every strategy in place', () => {
  it('sets dryRun on all configs without replacing the objects', () => {
    const atomic = { dryRun: true };
    const logic = { dryRun: true };
    const stub: Stub = { configMap: { ATOMIC_ARB: atomic, LOGIC_ARB: logic } };

    proto.setDryRun.call(stub, false); // go LIVE

    expect(atomic.dryRun).toBe(false);
    expect(logic.dryRun).toBe(false);
    expect((stub.configMap as Record<string, unknown>)['ATOMIC_ARB']).toBe(atomic);

    proto.setDryRun.call(stub, true); // back to simulation
    expect(atomic.dryRun).toBe(true);
    expect(logic.dryRun).toBe(true);
  });
});
