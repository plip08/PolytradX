import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface AllocationProfile {
  marketMaking: number;
  atomicArbitrage: number;
  other: number;
}

export interface PositionSizing {
  targetUsd: number;
  maximumUsd: number;
}

export class RiskManager {
  private allocation: AllocationProfile;

  constructor(allocation: AllocationProfile = config.riskAllocation) {
    this.allocation = allocation;
  }

  estimateKellyFraction(winProbability: number, lossProbability: number, gainRatio: number): number {
    if (winProbability <= 0 || lossProbability <= 0 || gainRatio <= 0) {
      return 0;
    }

    const f = winProbability - lossProbability / gainRatio;
    const normalized = Math.max(0, Math.min(f, 1));

    logger.debug("Kelly fraction", { winProbability, lossProbability, gainRatio, f, normalized });
    return normalized;
  }

  allocateBudget(strategyKey: keyof AllocationProfile, capitalUsd: number): PositionSizing {
    const allocationPct = this.allocation[strategyKey] ?? 0;
    const targetUsd = capitalUsd * allocationPct;
    const maximumUsd = targetUsd * 1.5;

    logger.debug("Allocated budget", { strategyKey, allocationPct, targetUsd, maximumUsd });

    return {
      targetUsd,
      maximumUsd,
    };
  }

  sizeTrade(decisionEdge: number, capitalUsd: number, strategyKey: keyof AllocationProfile): number {
    const profile = this.allocateBudget(strategyKey, capitalUsd);
    const rawKelly = this.estimateKellyFraction(decisionEdge, 1 - decisionEdge, decisionEdge / Math.max(1e-6, 1 - decisionEdge));
    const tradeUsd = Math.min(profile.maximumUsd, Math.max(0, profile.targetUsd * rawKelly));

    logger.debug("Sized trade", { strategyKey, decisionEdge, rawKelly, tradeUsd });
    return tradeUsd;
  }

  validateTradeSize(tradeUsd: number): boolean {
    const valid = tradeUsd > 0 && Number.isFinite(tradeUsd);
    if (!valid) {
      logger.warn("Invalid trade size detected", { tradeUsd });
    }
    return valid;
  }
}
