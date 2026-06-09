/**
 * GNOSIS CTF CONTRACT CLIENT
 *
 * Handles all on-chain interactions:
 *  - mergePositions (burn YES+NO → redeem $1 USDC)
 *  - splitPosition (split USDC → YES+NO tokens)
 *  - redeemPositions (claim winning tokens after resolution)
 *  - USDC allowance management
 *  - Position balance queries
 */

import { Contract, Wallet, TransactionReceipt } from 'ethers';
import { createCtfContract, createErc20Contract, createNegRiskAdapter } from '../core/base.js';
import { TransactionManager } from '../core/transactionManager.js';
import { logger, emitLog } from '../utils/logger.js';
import type { GasStrategy } from '../types/index.js';

const USDC_DECIMALS = 6;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

export class CtfClient {
  private static instance: CtfClient | null = null;

  private readonly ctf: Contract;
  private readonly usdc: Contract;
  private readonly negRiskAdapter: Contract | null = null;
  private readonly txManager: TransactionManager;

  private constructor(wallet: Wallet, txManager: TransactionManager) {
    this.ctf = createCtfContract(process.env['CTF_CONTRACT_ADDRESS'] ?? '', wallet);
    this.usdc = createErc20Contract(process.env['USDC_ADDRESS'] ?? '', wallet);
    this.txManager = txManager;

    const negRiskAddr = process.env['NEG_RISK_ADAPTER_ADDRESS'];
    if (negRiskAddr) {
      this.negRiskAdapter = createNegRiskAdapter(negRiskAddr, wallet);
    }
  }

  static getInstance(wallet: Wallet, txManager: TransactionManager): CtfClient {
    if (!CtfClient.instance) {
      CtfClient.instance = new CtfClient(wallet, txManager);
    }
    return CtfClient.instance;
  }

  // ─── USDC Allowance ───────────────────────────────────────────────────────

  async ensureUsdcAllowance(
    spender: string,
    requiredAmount: bigint,
    gasStrategy: GasStrategy = 'FAST',
  ): Promise<void> {
    const owner = await (this.usdc.runner as Wallet).getAddress();
    const allowance = (await this.usdc.allowance(owner, spender)) as bigint;

    if (allowance >= requiredAmount) return;

    const MaxUint256 = 2n ** 256n - 1n;
    const overrides = await this.txManager.buildGasOverrides(gasStrategy);

    await this.txManager.submit(
      () => this.usdc.approve(spender, MaxUint256, overrides) as ReturnType<typeof this.ctf.mergePositions>,
      { priority: 10 },
    );

    emitLog('INFO', `USDC approval granted to ${spender}`);
  }

  async getUsdcBalance(address: string): Promise<number> {
    const raw = (await this.usdc.balanceOf(address)) as bigint;
    return Number(raw) / 10 ** USDC_DECIMALS;
  }

  // ─── Position Management ──────────────────────────────────────────────────

  /**
   * Merge YES + NO positions to redeem $1.00 USDC per pair.
   * This is the core operation of Atomic Arbitrage.
   *
   * @param conditionId bytes32 condition identifier
   * @param amountTokens number of token pairs to merge (raw, not scaled)
   */
  async mergePositions(
    conditionId: string,
    collateralToken: string,
    amountTokens: bigint,
    gasStrategy: GasStrategy = 'FAST',
  ): Promise<TransactionReceipt> {
    const partition = [1n, 2n]; // [YES_INDEX_SET, NO_INDEX_SET]
    const overrides = await this.txManager.buildGasOverrides(gasStrategy, 300_000n);

    emitLog('INFO', `Merging ${amountTokens} position pairs`, { conditionId });

    return this.txManager.submit(
      () =>
        this.ctf.mergePositions(
          collateralToken,
          ZERO_BYTES32,
          conditionId,
          partition,
          amountTokens,
          overrides,
        ) as ReturnType<typeof this.ctf.mergePositions>,
      { priority: 20 },
    );
  }

  /**
   * Split USDC into YES + NO tokens.
   * Used to enter positions or provide liquidity.
   */
  async splitPosition(
    conditionId: string,
    collateralToken: string,
    amountUsdc: bigint,
    gasStrategy: GasStrategy = 'FAST',
  ): Promise<TransactionReceipt> {
    const partition = [1n, 2n];
    const exchangeAddr = process.env['CTF_EXCHANGE_ADDRESS'] ?? '';

    await this.ensureUsdcAllowance(exchangeAddr, amountUsdc, gasStrategy);

    const overrides = await this.txManager.buildGasOverrides(gasStrategy, 300_000n);

    return this.txManager.submit(
      () =>
        this.ctf.splitPosition(
          collateralToken,
          ZERO_BYTES32,
          conditionId,
          partition,
          amountUsdc,
          overrides,
        ) as ReturnType<typeof this.ctf.splitPosition>,
      { priority: 15 },
    );
  }

  /**
   * Redeem winning positions after market resolution.
   */
  async redeemPositions(
    conditionId: string,
    collateralToken: string,
    winningIndexSet: number,
    gasStrategy: GasStrategy = 'FAST',
  ): Promise<TransactionReceipt> {
    const overrides = await this.txManager.buildGasOverrides(gasStrategy, 200_000n);

    return this.txManager.submit(
      () =>
        this.ctf.redeemPositions(
          collateralToken,
          ZERO_BYTES32,
          conditionId,
          [winningIndexSet],
          overrides,
        ) as ReturnType<typeof this.ctf.redeemPositions>,
      { priority: 5 },
    );
  }

  async getTokenBalance(walletAddress: string, tokenId: bigint): Promise<bigint> {
    return (await this.ctf.balanceOf(walletAddress, tokenId)) as bigint;
  }

  async getTokenBalances(
    walletAddress: string,
    tokenIds: bigint[],
  ): Promise<bigint[]> {
    const addresses = new Array<string>(tokenIds.length).fill(walletAddress);
    return (await this.ctf.balanceOfBatch(addresses, tokenIds)) as bigint[];
  }

  /**
   * Ensure the CLOB exchange contract is approved to transfer CTF tokens.
   */
  async ensureCtfApproval(gasStrategy: GasStrategy = 'STANDARD'): Promise<void> {
    const owner = await (this.ctf.runner as Wallet).getAddress();
    const exchangeAddr = process.env['CTF_EXCHANGE_ADDRESS'] ?? '';
    const approved = (await this.ctf.isApprovedForAll(owner, exchangeAddr)) as boolean;

    if (approved) return;

    // ─── SAFETY GUARD ──────────────────────────────────────────────────────────
    // setApprovalForAll is a REAL on-chain transaction that spends gas. In dry-run
    // mode we must never broadcast it — log loudly and skip so a sandbox boot stays
    // 100% read-only / off-chain.
    if (process.env['DRY_RUN'] === 'true') {
      emitLog(
        'WARN',
        `[DRY_RUN] CTF → CLOB approval skipped — would have sent setApprovalForAll(${exchangeAddr}, true) from ${owner}. Run with DRY_RUN=false to approve for real.`,
      );
      return;
    }

    const overrides = await this.txManager.buildGasOverrides(gasStrategy);
    await this.txManager.submit(
      () =>
        this.ctf.setApprovalForAll(exchangeAddr, true, overrides) as ReturnType<
          typeof this.ctf.setApprovalForAll
        >,
      { priority: 10 },
    );

    emitLog('INFO', 'CTF → CLOB Exchange approval granted');
  }
}
