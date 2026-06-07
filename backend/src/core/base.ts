/**
 * CORE INFRASTRUCTURE — RPC Manager, CTF Contract bindings, EIP-712 Auth
 *
 * Responsibilities:
 *  - WebSocket + HTTP provider with automatic fallback chain
 *  - Keep-alive heartbeat to detect stale WS connections
 *  - EIP-712 typed-data signing for Polymarket CLOB gasless orders
 *  - CTF and CLOB contract ABI definitions
 *  - Singleton provider access pattern
 */

import {
  ethers,
  WebSocketProvider,
  JsonRpcProvider,
  Wallet,
  Contract,
  TypedDataDomain,
  TypedDataField,
} from 'ethers';
import { logger } from '../utils/logger.js';
import type { RpcConfig, GasPrices, GasStrategy } from '../types/index.js';

// ─── Contract ABIs (minimal, production-complete) ─────────────────────────────

export const CTF_ABI = [
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external',
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
  'function balanceOf(address owner, uint256 id) external view returns (uint256)',
  'function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) external view returns (bool)',
  'event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount, uint[] payoutNumerators)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
] as const;

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const;

export const NEG_RISK_ADAPTER_ABI = [
  'function convertPositions(bytes32 conditionId, uint256 amount) external',
  'function mergePositions(bytes32 conditionId, uint256 amount) external',
] as const;

// ─── EIP-712 Domain for Polymarket CLOB ──────────────────────────────────────

const CLOB_EIP712_DOMAIN: TypedDataDomain = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137,
} as const;

const CLOB_EIP712_TYPES: Record<string, TypedDataField[]> = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'message', type: 'string' },
  ],
} as const;

const ORDER_EIP712_TYPES: Record<string, TypedDataField[]> = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
} as const;

export const CLOB_EXCHANGE_DOMAIN: TypedDataDomain = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: 137,
  verifyingContract: process.env['CTF_EXCHANGE_ADDRESS'] ?? '',
} as const;

// ─── Provider Manager ─────────────────────────────────────────────────────────

export class ProviderManager {
  private static instance: ProviderManager | null = null;

  private httpProvider: JsonRpcProvider;
  private wsProvider: WebSocketProvider | null = null;
  private fallbackProviders: JsonRpcProvider[];
  private currentProviderIndex = 0;
  private wsHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly HEARTBEAT_INTERVAL_MS = 15_000;
  private readonly config: RpcConfig;

  private constructor(config: RpcConfig) {
    this.config = config;
    this.httpProvider = new JsonRpcProvider(config.httpUrl, config.chainId, {
      staticNetwork: true,
      batchMaxCount: 10,
    });
    this.fallbackProviders = config.fallbackHttpUrls.map(
      (url) =>
        new JsonRpcProvider(url, config.chainId, {
          staticNetwork: true,
          batchMaxCount: 5,
        }),
    );
  }

  static getInstance(config?: RpcConfig): ProviderManager {
    if (!ProviderManager.instance) {
      if (!config) throw new Error('ProviderManager not initialized');
      ProviderManager.instance = new ProviderManager(config);
    }
    return ProviderManager.instance;
  }

  async connectWebSocket(): Promise<WebSocketProvider> {
    try {
      this.wsProvider = new WebSocketProvider(this.config.wsUrl, this.config.chainId);
      this.startHeartbeat();
      logger.info('[RPC] WebSocket connected', { url: this.config.wsUrl });
      return this.wsProvider;
    } catch (err) {
      logger.error('[RPC] WebSocket connection failed', { err });
      throw err;
    }
  }

  private startHeartbeat(): void {
    this.wsHeartbeatInterval = setInterval(async () => {
      try {
        await this.wsProvider?.getBlockNumber();
      } catch {
        logger.warn('[RPC] WebSocket heartbeat failed — reconnecting…');
        await this.reconnectWebSocket();
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private async reconnectWebSocket(): Promise<void> {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error('[RPC] Max WS reconnect attempts reached — falling back to HTTP polling');
      this.clearHeartbeat();
      return;
    }
    this.reconnectAttempts++;
    const backoffMs = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    await new Promise((r) => setTimeout(r, backoffMs));

    try {
      this.wsProvider?.destroy();
      this.wsProvider = new WebSocketProvider(this.config.wsUrl, this.config.chainId);
      this.reconnectAttempts = 0;
      logger.info('[RPC] WebSocket reconnected');
    } catch (err) {
      logger.error('[RPC] Reconnect failed', { attempt: this.reconnectAttempts, err });
    }
  }

  private clearHeartbeat(): void {
    if (this.wsHeartbeatInterval) {
      clearInterval(this.wsHeartbeatInterval);
      this.wsHeartbeatInterval = null;
    }
  }

  /** Returns the active provider with round-robin fallback */
  async getProvider(): Promise<JsonRpcProvider> {
    try {
      await this.httpProvider.getBlockNumber();
      return this.httpProvider;
    } catch {
      logger.warn('[RPC] Primary provider down — switching to fallback');
      const fallback = this.fallbackProviders[
        this.currentProviderIndex % this.fallbackProviders.length
      ];
      this.currentProviderIndex++;
      if (!fallback) throw new Error('All RPC providers unavailable');
      return fallback;
    }
  }

  getWsProvider(): WebSocketProvider | null {
    return this.wsProvider;
  }

  destroy(): void {
    this.clearHeartbeat();
    this.wsProvider?.destroy();
    ProviderManager.instance = null;
  }
}

// ─── Wallet Manager ───────────────────────────────────────────────────────────

export class WalletManager {
  private wallet: Wallet;

  constructor(privateKey: string, provider: JsonRpcProvider) {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    if (normalizedKey.length !== 66) {
      throw new Error(`Invalid private key: expected 32 bytes (64 hex chars), got ${normalizedKey.length - 2}`);
    }
    this.wallet = new Wallet(normalizedKey, provider);
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  async signClobAuth(timestamp: string, nonce: string): Promise<string> {
    const message = `This message attests that I control the given wallet\n\nTimestamp: ${timestamp}\nNonce: ${nonce}`;
    const value = {
      address: this.wallet.address,
      timestamp,
      nonce,
      message,
    };
    return this.wallet.signTypedData(CLOB_EIP712_DOMAIN, CLOB_EIP712_TYPES, value);
  }

  async signClobOrder(orderStruct: Record<string, unknown>): Promise<string> {
    return this.wallet.signTypedData(CLOB_EXCHANGE_DOMAIN, ORDER_EIP712_TYPES, orderStruct);
  }

  async signMessage(message: string): Promise<string> {
    return this.wallet.signMessage(message);
  }
}

// ─── Contract Factory ─────────────────────────────────────────────────────────

export function createCtfContract(address: string, wallet: Wallet): Contract {
  return new Contract(address, CTF_ABI, wallet);
}

export function createErc20Contract(address: string, wallet: Wallet): Contract {
  return new Contract(address, ERC20_ABI, wallet);
}

export function createNegRiskAdapter(address: string, wallet: Wallet): Contract {
  return new Contract(address, NEG_RISK_ADAPTER_ABI, wallet);
}

// ─── Gas Estimation ───────────────────────────────────────────────────────────

const GAS_MULTIPLIERS: Record<GasStrategy, number> = {
  STANDARD: 1.0,
  FAST: 1.5,
  FRONTRUN: 2.5,
};

const POL_TO_USDC_RATE = 0.6; // approximate, should be fetched dynamically

export async function estimateGas(
  provider: JsonRpcProvider,
  strategy: GasStrategy = 'FAST',
  gasLimit = 500_000n,
): Promise<GasPrices> {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.gasPrice ?? 100_000_000_000n; // 100 gwei fallback
  const multiplier = BigInt(Math.round(GAS_MULTIPLIERS[strategy] * 100));

  const maxPriorityFeePerGas = ethers.parseUnits('30', 'gwei');
  const maxFeePerGas = (baseFee * multiplier) / 100n + maxPriorityFeePerGas;

  const estimatedCostWei = maxFeePerGas * gasLimit;
  const estimatedCostPol = Number(ethers.formatEther(estimatedCostWei));
  const estimatedCostUsdc = estimatedCostPol * POL_TO_USDC_RATE;

  return {
    baseFeePerGas: baseFee,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    estimatedCostWei,
    estimatedCostUsdc,
  };
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

/** Converts a conditionId + outcome index to a token ID (ERC-1155 position id) */
export function computePositionId(
  collateralToken: string,
  conditionId: string,
  indexSet: number,
): bigint {
  const collectionId = ethers.keccak256(
    ethers.solidityPacked(
      ['bytes32', 'uint256'],
      [ethers.ZeroHash, (1 << indexSet).toString()],
    ),
  );
  return BigInt(
    ethers.keccak256(
      ethers.solidityPacked(['address', 'bytes32'], [collateralToken, collectionId]),
    ),
  );
}

/** Builds auth headers for Polymarket CLOB REST API */
export async function buildClobAuthHeaders(
  wallet: WalletManager,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  const signature = await wallet.signClobAuth(timestamp, nonce);

  return {
    POLY_ADDRESS: wallet.getAddress(),
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce,
  };
}
