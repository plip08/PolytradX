import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../lib/prisma.js";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role?: "admin" | "operator" | "viewer";
  totpSecretEncrypted: string;
}

export interface CreateTradeInput {
  marketId: string;
  assetId?: string;
  outcome: string;
  strategy: string;
  side: "BUY" | "SELL";
  walletAddress: string;
  txHash: string;
  status?: "PENDING" | "CONFIRMED" | "FAILED" | "REVERTED" | "SIMULATED";
  executedAt?: Date;
  priceUsd: string;
  quantity: string;
  notionalUsd: string;
  slippagePct: string;
  gasUsed?: bigint;
  gasFeeUsd?: string;
  networkFeeGwei?: string;
  botSnapshotId?: string;
  notes?: string;
  metadata?: Prisma.JsonValue;
  executedById?: string;
}

export interface CreateRiskEventInput {
  marketId: string;
  signalType: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  source?: string;
  details: Prisma.InputJsonValue;
}

export const persistence = {
  getUserByEmail: (email: string) =>
    prisma.user.findUnique({ where: { email } }),

  getUserById: (id: string) =>
    prisma.user.findUnique({ where: { id } }),

  createUser: (input: CreateUserInput) =>
    prisma.user.create({ data: { ...input } }),

  updateUser2faSecret: (userId: string, totpSecretEncrypted: string) =>
    prisma.user.update({ where: { id: userId }, data: { totpSecretEncrypted } }),

  incrementFailedLogin: (userId: string) =>
    prisma.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } }),

  resetFailedLogin: (userId: string) =>
    prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } }),

  recordAuditLog: (data: {
    userId?: string;
    eventType: string;
    action: string;
    resource?: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    source?: string;
    details: Prisma.JsonValue;
  }) =>
    prisma.auditLog.create({ data: data as Prisma.AuditLogCreateInput }),

  recordRiskEvent: (input: CreateRiskEventInput) =>
    prisma.marketRiskEvent.create({ data: {
      marketId: input.marketId,
      signalType: input.signalType,
      severity: input.severity,
      source: input.source ?? "market-risk-monitor",
      details: input.details,
    } }),

  getRiskEvents: (options: {
    marketId?: string;
    take?: number;
    skip?: number;
  }) =>
    prisma.marketRiskEvent.findMany({
      where: {
        marketId: options.marketId ?? undefined,
      },
      orderBy: { createdAt: "desc" },
      take: options.take ?? 50,
      skip: options.skip ?? 0,
    }),

  getStrategyConfigs: () =>
    prisma.strategyConfig.findMany({ orderBy: { strategyName: "asc" } }),

  getStrategyConfigByName: (strategyName: string) =>
    prisma.strategyConfig.findUnique({ where: { strategyName } }),

  ping: async (): Promise<boolean> => {
    try {
      const result = await prisma.$queryRaw`SELECT 1 as result`;
      return Boolean(result);
    } catch {
      return false;
    }
  },

  upsertStrategyConfig: (strategyName: string, data: Partial<{
    enabled: boolean;
    allocationPct: string;
    maxPositionUsd: string;
    thresholdValue?: string;
    cooldownSeconds: number;
    maxSlippagePct: string;
    parameters: Prisma.InputJsonValue;
  }>) => {
    const updateData = {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.allocationPct !== undefined ? { allocationPct: data.allocationPct } : {}),
      ...(data.maxPositionUsd !== undefined ? { maxPositionUsd: data.maxPositionUsd } : {}),
      ...(data.thresholdValue !== undefined ? { thresholdValue: data.thresholdValue } : {}),
      ...(data.cooldownSeconds !== undefined ? { cooldownSeconds: data.cooldownSeconds } : {}),
      ...(data.maxSlippagePct !== undefined ? { maxSlippagePct: data.maxSlippagePct } : {}),
      ...(data.parameters !== undefined ? { parameters: data.parameters as Prisma.InputJsonValue } : {}),
    } as Prisma.StrategyConfigUpdateInput;

    return prisma.strategyConfig.upsert({
      where: { strategyName },
      update: updateData,
      create: {
        strategyName,
        enabled: data.enabled ?? false,
        allocationPct: data.allocationPct ?? "0",
        maxPositionUsd: data.maxPositionUsd ?? "0",
        thresholdValue: data.thresholdValue,
        cooldownSeconds: data.cooldownSeconds ?? 0,
        maxSlippagePct: data.maxSlippagePct ?? "0.006",
        parameters: data.parameters ?? {},
      },
    });
  },

  recordTrade: (input: CreateTradeInput) =>
    prisma.tradesHistory.create({ data: input as Prisma.TradesHistoryCreateInput }),

  updateTradeStatus: (txHash: string, status: CreateTradeInput["status"], updates?: Partial<{
    gasUsed: bigint;
    gasFeeUsd: string;
    networkFeeGwei: string;
    executedAt: Date;
    notes: string;
  }>) =>
    prisma.tradesHistory.update({
      where: { txHash },
      data: {
        status,
        ...(updates?.gasUsed !== undefined ? { gasUsed: updates.gasUsed } : {}),
        ...(updates?.gasFeeUsd !== undefined ? { gasFeeUsd: updates.gasFeeUsd } : {}),
        ...(updates?.networkFeeGwei !== undefined ? { networkFeeGwei: updates.networkFeeGwei } : {}),
        ...(updates?.executedAt !== undefined ? { executedAt: updates.executedAt } : {}),
        ...(updates?.notes !== undefined ? { notes: updates.notes } : {}),
      },
    }),

  getTrades: (options: {
    take?: number;
    skip?: number;
    strategy?: string;
    from?: Date;
    to?: Date;
  }) =>
    prisma.tradesHistory.findMany({
      where: {
        strategy: options.strategy ?? undefined,
        executedAt: {
          gte: options.from ?? undefined,
          lte: options.to ?? undefined,
        },
      },
      orderBy: { executedAt: "desc" },
      take: options.take ?? 50,
      skip: options.skip ?? 0,
    }),
};
