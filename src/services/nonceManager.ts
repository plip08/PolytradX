import type { Provider } from "ethers";

export class NonceManager {
  private nextNonce: number | null = null;
  private pendingNonces = new Set<number>();
  private lastSyncedAt = 0;

  constructor(
    private readonly provider: Provider,
    private readonly walletAddress: string,
    private readonly syncIntervalMs = 30_000,
  ) {}

  private async syncChainNonce(): Promise<void> {
    const currentNonce = await this.provider.getTransactionCount(this.walletAddress, "pending");
    this.lastSyncedAt = Date.now();
    if (this.nextNonce === null || currentNonce > this.nextNonce) {
      this.nextNonce = currentNonce;
    }
  }

  async initialize(): Promise<void> {
    await this.syncChainNonce();
  }

  async getNextNonce(): Promise<number> {
    if (this.nextNonce === null) {
      await this.initialize();
    }

    if (Date.now() - this.lastSyncedAt > this.syncIntervalMs) {
      await this.syncChainNonce();
    }

    if (this.nextNonce === null) {
      throw new Error("NonceManager failed to initialize.");
    }

    const nonce = this.nextNonce;
    this.pendingNonces.add(nonce);
    this.nextNonce += 1;
    return nonce;
  }

  markPending(nonce: number): void {
    this.pendingNonces.add(nonce);
    if (this.nextNonce === null || nonce >= this.nextNonce) {
      this.nextNonce = nonce + 1;
    }
  }

  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    if (this.nextNonce === null || nonce >= this.nextNonce) {
      this.nextNonce = nonce + 1;
    }
  }

  markFailed(nonce: number): void {
    this.pendingNonces.delete(nonce);
    if (this.nextNonce === null || nonce < this.nextNonce) {
      this.nextNonce = nonce;
    }
  }

  async resync(): Promise<void> {
    await this.syncChainNonce();
  }

  getPendingCount(): number {
    return this.pendingNonces.size;
  }

  getStatus(): {
    nextNonce: number | null;
    pendingCount: number;
    pendingNonces: number[];
    lastSyncedAt: number;
  } {
    return {
      nextNonce: this.nextNonce,
      pendingCount: this.pendingNonces.size,
      pendingNonces: Array.from(this.pendingNonces).sort((a, b) => a - b),
      lastSyncedAt: this.lastSyncedAt,
    };
  }
}
