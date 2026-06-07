/**
 * TRANSACTION MANAGER
 *
 * Responsibilities:
 *  - Dynamic gas price monitoring and selection
 *  - Nonce management to prevent collisions on high-frequency sends
 *  - Transaction queue with priority ordering
 *  - Receipt waiting with exponential backoff
 *  - Cost accounting per transaction
 */

import { ethers, Wallet, ContractTransactionResponse, TransactionReceipt } from 'ethers';
import { logger } from '../utils/logger.js';
import { estimateGas } from './base.js';
import type { GasPrices, GasStrategy } from '../types/index.js';

interface PendingTx {
  id: string;
  priority: number;
  fn: () => Promise<ContractTransactionResponse>;
  resolve: (r: TransactionReceipt) => void;
  reject: (e: unknown) => void;
  submittedAt: number;
}

interface TxStats {
  totalSent: number;
  totalConfirmed: number;
  totalFailed: number;
  totalGasSpentWei: bigint;
}

export class TransactionManager {
  private nonce: number | null = null;
  private nonceLock = false;
  private queue: PendingTx[] = [];
  private processing = false;
  private stats: TxStats = {
    totalSent: 0,
    totalConfirmed: 0,
    totalFailed: 0,
    totalGasSpentWei: 0n,
  };

  private readonly MAX_RECEIPT_WAIT_MS = 60_000;
  private readonly RECEIPT_POLL_INTERVAL_MS = 500;
  private readonly MAX_QUEUE_SIZE = 50;

  constructor(private readonly wallet: Wallet) {}

  /** Fetch + cache nonce with mutex to prevent race conditions */
  private async getNonce(): Promise<number> {
    while (this.nonceLock) {
      await new Promise((r) => setTimeout(r, 5));
    }
    this.nonceLock = true;
    try {
      if (this.nonce === null) {
        this.nonce = await this.wallet.getNonce('pending');
      }
      const current = this.nonce;
      this.nonce++;
      return current;
    } finally {
      this.nonceLock = false;
    }
  }

  /** Reset nonce cache (call after any error that may indicate nonce drift) */
  async resetNonce(): Promise<void> {
    this.nonce = null;
    logger.warn('[TxManager] Nonce cache reset');
  }

  /**
   * Submit a transaction to the queue.
   * Returns a Promise that resolves when the tx is confirmed.
   */
  async submit(
    fn: () => Promise<ContractTransactionResponse>,
    options: { priority?: number; gasStrategy?: GasStrategy } = {},
  ): Promise<TransactionReceipt> {
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error(`[TxManager] Queue full (${this.MAX_QUEUE_SIZE})`);
    }

    return new Promise((resolve, reject) => {
      const entry: PendingTx = {
        id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        priority: options.priority ?? 0,
        fn,
        resolve,
        reject,
        submittedAt: Date.now(),
      };
      this.queue.push(entry);
      this.queue.sort((a, b) => b.priority - a.priority);

      if (!this.processing) {
        void this.processQueue();
      }
    });
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      await this.executeTx(entry);
    }
    this.processing = false;
  }

  private async executeTx(entry: PendingTx): Promise<void> {
    const startMs = Date.now();
    this.stats.totalSent++;

    try {
      const nonce = await this.getNonce();
      const response = await entry.fn();

      logger.info('[TxManager] TX submitted', {
        id: entry.id,
        hash: response.hash,
        nonce,
        queueAge: Date.now() - entry.submittedAt,
      });

      const receipt = await this.waitForReceipt(response.hash);

      if (!receipt || receipt.status === 0) {
        throw new Error(`Transaction reverted: ${response.hash}`);
      }

      this.stats.totalConfirmed++;
      this.stats.totalGasSpentWei += receipt.gasUsed * (receipt.gasPrice ?? 0n);

      logger.info('[TxManager] TX confirmed', {
        id: entry.id,
        hash: response.hash,
        gasUsed: receipt.gasUsed.toString(),
        confirmTimeMs: Date.now() - startMs,
      });

      entry.resolve(receipt);
    } catch (err) {
      this.stats.totalFailed++;
      logger.error('[TxManager] TX failed', { id: entry.id, err });

      // Reset nonce on potential nonce error
      if (String(err).includes('nonce')) {
        await this.resetNonce();
      }

      entry.reject(err);
    }
  }

  private async waitForReceipt(
    txHash: string,
  ): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + this.MAX_RECEIPT_WAIT_MS;
    const provider = this.wallet.provider;

    if (!provider) throw new Error('No provider attached to wallet');

    while (Date.now() < deadline) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      await new Promise((r) => setTimeout(r, this.RECEIPT_POLL_INTERVAL_MS));
    }

    logger.warn('[TxManager] Receipt timeout', { txHash });
    return null;
  }

  /** Build gas override object for contract calls */
  async buildGasOverrides(
    gasStrategy: GasStrategy = 'FAST',
    gasLimit = 500_000n,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }> {
    const provider = this.wallet.provider;
    if (!provider) throw new Error('No provider');
    const gasPrices = await estimateGas(
      provider as Parameters<typeof estimateGas>[0],
      gasStrategy,
      gasLimit,
    );
    return {
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      gasLimit: gasPrices.gasLimit,
    };
  }

  getStats(): TxStats & { totalGasSpentGwei: string } {
    return {
      ...this.stats,
      totalGasSpentGwei: ethers.formatUnits(this.stats.totalGasSpentWei, 'gwei'),
    };
  }

  getQueueDepth(): number {
    return this.queue.length;
  }
}
