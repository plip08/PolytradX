import { afterEach, describe, expect, it, vi } from 'vitest';
import { CtfClient } from '../src/services/ctfClient.js';

// The DRY_RUN guard lives inside ensureCtfApproval. We exercise the real method body
// against a hand-built `this` (no ethers Contract, no singleton, no network) so the
// test is exactly "given approval is missing, does it broadcast a tx or not?".
const ensureCtfApproval = (
  CtfClient.prototype as unknown as { ensureCtfApproval: (g?: string) => Promise<void> }
).ensureCtfApproval;

function makeStub(approved: boolean) {
  return {
    ctf: {
      runner: { getAddress: async () => '0x0000000000000000000000000000000000000abc' },
      isApprovedForAll: vi.fn(async () => approved),
      setApprovalForAll: vi.fn(async () => ({ hash: '0xtx' })),
    },
    txManager: {
      buildGasOverrides: vi.fn(async () => ({})),
      submit: vi.fn(async () => undefined),
    },
  };
}

describe('CtfClient.ensureCtfApproval — DRY_RUN safety guard', () => {
  const prevDryRun = process.env['DRY_RUN'];
  afterEach(() => {
    if (prevDryRun === undefined) delete process.env['DRY_RUN'];
    else process.env['DRY_RUN'] = prevDryRun;
    vi.restoreAllMocks();
  });

  it('does NOT broadcast setApprovalForAll when DRY_RUN=true and approval is missing', async () => {
    process.env['DRY_RUN'] = 'true';
    const stub = makeStub(false);
    await ensureCtfApproval.call(stub, 'STANDARD');
    expect(stub.ctf.isApprovedForAll).toHaveBeenCalled(); // reading approval is fine
    expect(stub.txManager.submit).not.toHaveBeenCalled(); // but no transaction is sent
  });

  it('submits the approval tx when DRY_RUN=false and approval is missing', async () => {
    process.env['DRY_RUN'] = 'false';
    const stub = makeStub(false);
    await ensureCtfApproval.call(stub, 'STANDARD');
    expect(stub.txManager.submit).toHaveBeenCalledTimes(1);
  });

  it('skips entirely (no tx) when already approved, regardless of DRY_RUN', async () => {
    process.env['DRY_RUN'] = 'false';
    const stub = makeStub(true);
    await ensureCtfApproval.call(stub, 'STANDARD');
    expect(stub.txManager.submit).not.toHaveBeenCalled();
  });
});
