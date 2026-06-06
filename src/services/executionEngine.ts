import { Wallet, Contract, type Provider, type TransactionRequest, type TransactionResponse } from "ethers";
import { Prisma } from "@prisma/client";
import { RpcProviderManager } from "../integrations/rpcProvider.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { CircuitBreaker, type TradeOutcome } from "./circuitBreaker.js";
import { persistence } from "./persistence.js";
import { NonceManager } from "./nonceManager.js";

export interface ExecutionOptions {
  maxGasPriceGwei?: number;
  targetSlippagePct?: number;
  deadlineMs?: number;
}

export interface ExecutionMetadata {
  strategyName?: string;
  marketId?: string;
  side?: "BUY" | "SELL" | "MERGE" | "UNKNOWN";
  quantityUsd?: number;
  expectedEdgePct?: number;
  tradeSizeUsd?: number;
  priceUsd?: number;
  slippagePct?: number;
  notes?: string;
}

export class ExecutionEngine {
  private wallet: Wallet;
  private providerManager: RpcProviderManager;
  private provider: Provider;
  private circuitBreaker: CircuitBreaker;
  private nonceManager: NonceManager;

  constructor(providerManager: RpcProviderManager, circuitBreaker: CircuitBreaker) {
    this.providerManager = providerManager;
    this.provider = providerManager.getProvider();
    this.wallet = new Wallet(config.privateKey, this.provider);
    this.circuitBreaker = circuitBreaker;
    this.nonceManager = new NonceManager(this.provider, this.wallet.address);
  }

  async getCurrentBaseFee(): Promise<bigint> {
    const block = await this.provider.getBlock("latest");
    return block?.baseFeePerGas ?? 0n;
  }

  private async buildEip1559Transaction(tx: TransactionRequest): Promise<TransactionRequest> {
    const baseFee = await this.getCurrentBaseFee();
    const maxPriorityFeePerGas = 3n * 10n ** 9n;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

    return {
      ...tx,
      type: 2,
      maxPriorityFeePerGas,
      maxFeePerGas,
    } as TransactionRequest;
  }

  private async persistExecutionTrade(
    txHash: string,
    metadata: ExecutionMetadata | undefined,
    status: "PENDING" | "CONFIRMED" | "FAILED" | "REVERTED" | "SIMULATED",
  ): Promise<void> {
    const tradeSizeUsd = metadata?.tradeSizeUsd ?? metadata?.quantityUsd ?? 0;
    const side = metadata?.side === "SELL" ? "SELL" : "BUY";
    const priceUsd = metadata?.priceUsd ?? 0;

    await persistence.recordTrade({
      marketId: metadata?.marketId ?? "unknown",
      outcome: metadata?.side ?? "UNKNOWN",
      strategy: metadata?.strategyName ?? "unknown",
      side,
      walletAddress: this.wallet.address,
      txHash,
      status,
      executedAt: new Date(),
      priceUsd: priceUsd.toFixed(12),
      quantity: (metadata?.quantityUsd ?? 0).toFixed(12),
      notionalUsd: tradeSizeUsd.toFixed(12),
      slippagePct: (metadata?.slippagePct ?? 0).toFixed(8),
      gasFeeUsd: "0",
      networkFeeGwei: "0",
      notes: metadata?.notes ?? (config.simulationMode ? "Simulated execution" : "Pending execution"),
      metadata: metadata as Prisma.JsonValue,
    });
  }

  private async waitForReceipt(
    response: TransactionResponse,
    txHash: string,
    metadata?: ExecutionMetadata,
  ): Promise<void> {
    try {
      const receipt = await response.wait(1);
      if (!receipt) {
        throw new Error("Missing transaction receipt.");
      }

      const receiptAny = receipt as any;
      const success = receiptAny.status === 1;
      const status = success ? "CONFIRMED" : "REVERTED";
      const effectiveGasPrice = receiptAny.effectiveGasPrice ?? receiptAny.gasPrice ?? 0n;
      const gasUsed = receiptAny.gasUsed ?? 0n;
      const gasFeeUsd = Number(gasUsed * effectiveGasPrice) / 1e18;
      const networkFeeGwei = Number(effectiveGasPrice) / 1e9;

      if (typeof response.nonce === "number") {
        this.nonceManager.confirmNonce(response.nonce);
      }

      await persistence.updateTradeStatus(txHash, status, {
        gasUsed,
        gasFeeUsd: gasFeeUsd.toFixed(12),
        networkFeeGwei: networkFeeGwei.toFixed(9),
        executedAt: new Date(),
        notes: status === "CONFIRMED" ? "Transaction confirmed" : "Transaction reverted",
      });

      if (metadata) {
        this.circuitBreaker.registerTradeOutcome(this.estimateTradeOutcome(metadata));
      }

      logger.info("Transaction receipt processed", {
        txHash,
        status,
        gasFeeUsd,
        networkFeeGwei,
      });
    } catch (error) {
      logger.warn("Transaction receipt wait failed", { txHash, error });
      await persistence.updateTradeStatus(txHash, "PENDING", {
        notes: "Receipt wait failed, leaving trade pending",
      });
    }
  }

  private estimateTradeOutcome(metadata: ExecutionMetadata | undefined): TradeOutcome {
    const expectedEdge = metadata?.expectedEdgePct ?? 0;
    const tradeSizeUsd = metadata?.tradeSizeUsd ?? metadata?.quantityUsd ?? 0;
    const profitUsd = tradeSizeUsd * expectedEdge;

    return {
      profitUsd: Math.max(0, profitUsd),
      lossUsd: Math.max(0, -profitUsd),
      timestamp: Date.now(),
      strategyId: metadata?.strategyName,
      marketId: metadata?.marketId,
      reason: metadata?.notes,
    };
  }

  async signAndSend(tx: TransactionRequest, metadata?: ExecutionMetadata): Promise<string> {
    if (!this.circuitBreaker.canExecute()) {
      const error = new Error("Circuit breaker is open: execution blocked.");
      logger.error(error.message);
      throw error;
    }

    let txHash: string;
    if (config.simulationMode) {
      txHash = `simulated-tx-${Date.now()}`;
      logger.info("Simulation mode: transaction not sent", { simulatedHash: txHash, to: tx.to, value: tx.value?.toString() });
      await this.persistExecutionTrade(txHash, metadata, "SIMULATED");
      this.circuitBreaker.registerTradeOutcome(this.estimateTradeOutcome(metadata));
      return txHash;
    }

    try {
      if (!tx.nonce) {
        tx.nonce = await this.nonceManager.getNextNonce();
      }
      const preparedTx = await this.buildEip1559Transaction(tx);
      const response = await this.wallet.sendTransaction(preparedTx);
      txHash = response.hash;
      logger.info("Submitted transaction", { hash: txHash, nonce: response.nonce, to: tx.to, value: tx.value?.toString() });
      await this.persistExecutionTrade(txHash, metadata, "PENDING");
      this.nonceManager.markPending(response.nonce);
      void this.waitForReceipt(response, txHash, metadata);
      return txHash;
    } catch (error) {
      logger.error("Transaction submission failed", error);
      throw error;
    }
  }

  async replaceTransaction(originalHash: string, replacementTx: TransactionRequest): Promise<string> {
    try {
      const receipt = await this.provider.getTransaction(originalHash);
      if (!receipt || !receipt.nonce) {
        throw new Error("Original transaction not found or invalid nonce.");
      }

      const replacement = {
        ...replacementTx,
        nonce: receipt.nonce,
        type: 2,
        maxPriorityFeePerGas: 4n * 10n ** 9n,
        maxFeePerGas: (await this.getCurrentBaseFee()) * 2n + 4n * 10n ** 9n,
      } as TransactionRequest;

      logger.info("Replacing stuck transaction", { originalHash, nonce: receipt.nonce.toString() });
      return this.signAndSend(replacement);
    } catch (error) {
      logger.error("Replace transaction failed", error);
      throw error;
    }
  }

  async sendContractTransaction(
    contract: Contract,
    methodName: string,
    args: unknown[],
    options?: ExecutionOptions,
    metadata?: ExecutionMetadata,
  ): Promise<string> {
    const populated = await (contract.populateTransaction as any)[methodName](...args);
    const tx = {
      ...populated,
      gasLimit: options?.deadlineMs ? undefined : 500_000,
    } as TransactionRequest;
    return this.signAndSend(tx, metadata);
  }

  async ensureSlippage(currentPrice: number, expectedPrice: number, option?: ExecutionOptions): Promise<boolean> {
    const maxSlippage = option?.targetSlippagePct ?? config.maxSlippagePct;
    const slippage = Math.abs(currentPrice - expectedPrice) / Math.max(expectedPrice, 1e-6);
    const allowed = slippage <= maxSlippage;
    if (!allowed) {
      logger.warn("Slippage too high", { currentPrice, expectedPrice, slippage, maxSlippage });
    }
    return allowed;
  }

  async prepareContract<T extends Contract>(address: string, abi: string[] | any[]): Promise<Contract> {
    return new Contract(address, abi, this.wallet);
  }
}
