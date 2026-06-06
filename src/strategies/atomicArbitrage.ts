import { Contract, type BigNumberish, parseUnits } from "ethers";
import type { Strategy, StrategyContext, StrategyDecision, StrategyResult } from "../types/strategy.js";
import type { MarketState } from "../types/market.js";
import { logger } from "../utils/logger.js";
import { ExecutionEngine } from "../services/executionEngine.js";
import { RiskManager } from "../services/riskManager.js";
import { config } from "../config/env.js";

const CTF_ABI = [
  "function mergePositions(address market, uint256 yesAmount, uint256 noAmount) external",
];

export class AtomicArbitrage implements Strategy {
  public readonly name = "AtomicArbitrage";
  public isEnabled = true;

  constructor(private readonly executionEngine: ExecutionEngine, private readonly riskManager: RiskManager) {}

  async evaluate(context: StrategyContext): Promise<StrategyDecision | null> {
    const state = context.currentState as MarketState;
    const yesPrice = state.yesPrice ?? state.orderBook.bids[0]?.price ?? 0;
    const noPrice = state.noPrice ?? state.orderBook.asks[0]?.price ?? 0;
    const combined = yesPrice + noPrice;

    logger.debug("AtomicArbitrage evaluate", { marketId: state.marketId, yesPrice, noPrice, combined });

    if (state.isActive && combined > 0 && combined < 0.98) {
      const edge = 0.98 - combined;
      const tradeSizeUsd = this.riskManager.sizeTrade(edge, 1_000_000, "atomicArbitrage");
      if (!this.riskManager.validateTradeSize(tradeSizeUsd)) {
        return null;
      }

      return {
        marketId: state.marketId,
        expectedEdge: edge,
        tradeSizeUsd,
        reason: `YES + NO price arbitrage detected at ${combined.toFixed(4)} USDC`,
      };
    }

    return null;
  }

  async execute(decision: StrategyDecision): Promise<StrategyResult> {
    try {
      if (!config.ctfContractAddress) {
        throw new Error("CTF contract address is not configured.");
      }

      const contract = await this.executionEngine.prepareContract(config.ctfContractAddress, CTF_ABI);
      const yesAmount = parseUnits((decision.tradeSizeUsd / 2).toFixed(6), 6);
      const noAmount = parseUnits((decision.tradeSizeUsd / 2).toFixed(6), 6);

      logger.info("Executing atomic arbitrage", { decision });
      const txHash = await this.executionEngine.sendContractTransaction(
        contract,
        "mergePositions",
        [decision.marketId, yesAmount, noAmount],
        {
          targetSlippagePct: 0.005,
        },
        {
          strategyName: this.name,
          marketId: decision.marketId,
          side: "MERGE",
          expectedEdgePct: decision.expectedEdge,
          tradeSizeUsd: decision.tradeSizeUsd,
          quantityUsd: decision.tradeSizeUsd,
          priceUsd: 0,
          slippagePct: 0,
          notes: decision.reason,
        },
      );

      return {
        success: true,
        executedTxHash: txHash,
        message: `Atomic arbitrage executed for market ${decision.marketId}.`,
      };
    } catch (error) {
      logger.error("Atomic arbitrage execution failed", error);
      return {
        success: false,
        message: `Atomic arbitrage failed: ${(error as Error).message}`,
      };
    }
  }
}
