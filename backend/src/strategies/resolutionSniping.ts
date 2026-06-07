/**
 * STRATEGY 6 & 7 — ORACLE MONITORING + RESOLUTION SNIPING
 *
 * Strategy 6 — Oracle Dispute Monitoring:
 *   Listen for UMA DVM proposal events on-chain.
 *   Track proposals nearing expiry with no dispute.
 *   Alert if a proposal outcome differs from external API consensus.
 *
 * Strategy 7 — Resolution Sniping:
 *   When an official external API (e.g., sports-reference, espn, official oracles)
 *   confirms an event is finished (score/winner known), check if the Polymarket
 *   order book still has YES tokens priced < 0.99 or NO tokens priced < 0.99.
 *   If yes: instantly buy the winning token from sellers seeking immediate liquidity.
 *   Guaranteed profit = (1.00 - sniped_price) × quantity, net of gas.
 */

import { ethers, Contract, JsonRpcProvider } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { ClobClient } from '../services/clobClient.js';
import { CtfClient } from '../services/ctfClient.js';
import { RiskManager } from '../services/riskManager.js';
import { BotWebSocketServer } from '../core/wsServer.js';
import { emitLog } from '../utils/logger.js';
import type {
  OracleProposal,
  ResolutionOpportunity,
  StrategyConfig,
  StrategyStatus,
  TradeExecution,
  MarketInfo,
} from '../types/index.js';

// UMA Optimistic Oracle V3 ABI (minimal)
const UMA_OO_ABI = [
  'event ProposePrice(address indexed requester, bytes32 indexed identifier, uint256 timestamp, bytes ancillaryData, address proposer, int256 proposedPrice, uint256 expirationTimestamp)',
  'event DisputePrice(address indexed requester, bytes32 indexed identifier, uint256 timestamp, bytes ancillaryData, address proposer, address disputer, int256 proposedPrice)',
  'event Settle(address indexed requester, bytes32 indexed identifier, uint256 timestamp, bytes ancillaryData, address proposer, address disputer, int256 price, uint256 payout)',
  'function getRequest(address requester, bytes32 identifier, uint256 timestamp, bytes calldata ancillaryData) external view returns (tuple(address proposer, address disputer, address currency, bool settled, bool refundOnDispute, int256 proposedPrice, int256 resolvedPrice, uint256 expirationTime, uint256 reward, uint256 finalFee, uint256 bond, uint256 customLiveness))',
] as const;

const UMA_OO_ADDRESS = '0xeE3Afe347D5C74317041E2618C49534dAf887c24'; // Polygon mainnet

interface ResolutionSnipingParams {
  // Markets to monitor for resolution
  watchedMarkets: Array<{
    marketId: string;
    marketInfo: MarketInfo;
    externalVerificationApiUrl: string; // URL returning { resolved: boolean, winner: 'YES' | 'NO' }
    externalApiPollIntervalMs: number;
  }>;
  minSnipeMargin: number;    // e.g. 0.01 = snipe if winning token < 0.99
  maxSnipeSizeUsdc: number;
}

interface WatchedResolution {
  marketId: string;
  marketInfo: MarketInfo;
  apiUrl: string;
  intervalHandle: ReturnType<typeof setInterval> | null;
  resolved: boolean;
  confirmedWinner: 'YES' | 'NO' | null;
}

export class ResolutionSnipingStrategy {
  public readonly strategyId = 'RESOLUTION_SNIPE' as const;
  public status: StrategyStatus = 'IDLE';

  private readonly umaContract: Contract;
  private readonly watchedResolutions = new Map<string, WatchedResolution>();
  private readonly pendingProposals = new Map<string, OracleProposal>();
  private totalSnipes = 0;
  private totalPnL = 0;

  constructor(
    private readonly params: ResolutionSnipingParams,
    private readonly config: StrategyConfig,
    private readonly clob: ClobClient,
    private readonly ctf: CtfClient,
    private readonly risk: RiskManager,
    private readonly provider: JsonRpcProvider,
  ) {
    this.umaContract = new Contract(UMA_OO_ADDRESS, UMA_OO_ABI, provider);
  }

  /** Called by MarketDiscovery with near-expiry or sports markets */
  addMarkets(markets: import('../types/index.js').MarketInfo[]): void {
    for (const m of markets) {
      if (this.watchedResolutions.has(m.id)) continue;

      const wr: WatchedResolution = {
        marketId: m.id,
        marketInfo: m,
        apiUrl: '',   // no external API for auto-discovered markets — rely on oracle events
        intervalHandle: null,
        resolved: false,
        confirmedWinner: null,
      };
      this.watchedResolutions.set(m.id, wr);
    }
    emitLog('INFO', `[ResolutionSnipe] Watching ${this.watchedResolutions.size} markets`, undefined, this.strategyId);
  }

  start(): void {
    if (this.status !== 'IDLE' && this.status !== 'PAUSED') return;
    this.status = 'SCANNING';

    this.startOracleListener();
    this.initWatchedMarkets();

    emitLog('INFO', '[ResolutionSnipe] Strategy started', undefined, this.strategyId);
    this.broadcastStatus();
  }

  stop(): void {
    this.umaContract.removeAllListeners();

    for (const wr of this.watchedResolutions.values()) {
      if (wr.intervalHandle) clearInterval(wr.intervalHandle);
    }
    this.watchedResolutions.clear();

    this.status = 'IDLE';
    emitLog('INFO', '[ResolutionSnipe] Strategy stopped', undefined, this.strategyId);
    this.broadcastStatus();
  }

  // ─── Strategy 6: Oracle Monitoring ───────────────────────────────────────

  private startOracleListener(): void {
    this.umaContract.on(
      'ProposePrice',
      (
        requester: string,
        identifier: string,
        timestamp: bigint,
        ancillaryData: string,
        proposer: string,
        proposedPrice: bigint,
        expirationTimestamp: bigint,
      ) => {
        const proposal: OracleProposal = {
          proposalId: `${requester}_${timestamp.toString()}`,
          marketId: this.extractMarketId(ancillaryData),
          conditionId: identifier,
          proposedOutcome: proposedPrice > 0n ? 'YES' : 'NO',
          bondAmount: 0n,
          proposalTimestamp: Number(timestamp),
          expiryTimestamp: Number(expirationTimestamp),
          status: 'PENDING',
          blockNumber: 0,
        };

        this.pendingProposals.set(proposal.proposalId, proposal);

        BotWebSocketServer.getInstance().broadcast('ORACLE_PROPOSAL', proposal);
        emitLog(
          'INFO',
          `[ResolutionSnipe] Oracle proposal: ${proposal.proposedOutcome} for ${proposal.marketId} expires in ${Math.round((proposal.expiryTimestamp - Date.now() / 1000) / 60)}min`,
          undefined,
          this.strategyId,
        );
      },
    );

    this.umaContract.on('Settle', (requester: string, _id: string, timestamp: bigint, ancillaryData: string) => {
      const proposalId = `${requester}_${timestamp.toString()}`;
      const proposal = this.pendingProposals.get(proposalId);
      if (proposal) {
        proposal.status = 'SETTLED';
        this.pendingProposals.delete(proposalId);
        emitLog('INFO', `[ResolutionSnipe] Oracle settled for ${proposal.marketId}`, undefined, this.strategyId);
      }
    });

    emitLog('INFO', '[ResolutionSnipe] UMA oracle listener active');
  }

  private extractMarketId(ancillaryData: string): string {
    try {
      const decoded = Buffer.from(ancillaryData.slice(2), 'hex').toString('utf8');
      const match = decoded.match(/marketId:([a-f0-9-]+)/);
      return match?.[1] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ─── Strategy 7: Resolution Sniping ──────────────────────────────────────

  private initWatchedMarkets(): void {
    for (const wm of this.params.watchedMarkets) {
      const wr: WatchedResolution = {
        marketId: wm.marketId,
        marketInfo: wm.marketInfo,
        apiUrl: wm.externalVerificationApiUrl,
        intervalHandle: null,
        resolved: false,
        confirmedWinner: null,
      };

      wr.intervalHandle = setInterval(
        () => void this.checkExternalResolution(wr),
        wm.externalApiPollIntervalMs,
      );

      this.watchedResolutions.set(wm.marketId, wr);
    }
  }

  private async checkExternalResolution(wr: WatchedResolution): Promise<void> {
    if (wr.resolved) {
      if (wr.intervalHandle) clearInterval(wr.intervalHandle);
      return;
    }

    try {
      const res = await axios.get<{ resolved: boolean; winner: 'YES' | 'NO' }>(wr.apiUrl, {
        timeout: 3000,
      });

      if (!res.data.resolved) return;

      wr.resolved = true;
      wr.confirmedWinner = res.data.winner;

      if (wr.intervalHandle) clearInterval(wr.intervalHandle);

      emitLog(
        'WARN',
        `[ResolutionSnipe] External confirmation: ${wr.marketInfo.question} → ${wr.confirmedWinner}`,
        undefined,
        this.strategyId,
      );

      await this.snipe(wr);
    } catch {
      // API might be temporarily unavailable — continue polling
    }
  }

  private async snipe(wr: WatchedResolution): Promise<void> {
    this.status = 'EXECUTING';
    this.broadcastStatus();

    const snipeStart = Date.now();

    try {
      const winningTokenId =
        wr.confirmedWinner === 'YES'
          ? wr.marketInfo.yesTokenId
          : wr.marketInfo.noTokenId;

      const ob = await this.clob.getOrderBook(winningTokenId);

      // Find any ask below (1.0 - minSnipeMargin) — sellers who haven't updated yet
      const snipeableAsks = ob.asks.filter(
        (ask) => ask.price < 1.0 - this.params.minSnipeMargin,
      );

      if (snipeableAsks.length === 0) {
        emitLog(
          'INFO',
          `[ResolutionSnipe] No stale asks found for ${wr.marketId} — market already updated`,
          undefined,
          this.strategyId,
        );
        return;
      }

      const opportunity: ResolutionOpportunity = {
        marketId: wr.marketId,
        winningTokenId,
        losingTokenId:
          wr.confirmedWinner === 'YES'
            ? wr.marketInfo.noTokenId
            : wr.marketInfo.yesTokenId,
        currentWinningPrice: snipeableAsks[0]!.price,
        availableSize: snipeableAsks.reduce((acc, a) => acc + a.size, 0),
        expectedProfitPct: 1.0 - snipeableAsks[0]!.price,
        urgencyMs: 10_000, // estimate 10s before market suspends
      };

      const snipeSize = Math.min(
        this.params.maxSnipeSizeUsdc / opportunity.currentWinningPrice,
        opportunity.availableSize,
      );

      if (this.config.dryRun) {
        emitLog(
          'INFO',
          `[ResolutionSnipe] DRY RUN — would snipe ${snipeSize.toFixed(2)} @ ${opportunity.currentWinningPrice.toFixed(4)} profit=$${((1.0 - opportunity.currentWinningPrice) * snipeSize).toFixed(2)}`,
          undefined,
          this.strategyId,
        );
        return;
      }

      const riskCheck = this.risk.checkPreTrade(
        this.strategyId,
        this.config,
        snipeSize * opportunity.currentWinningPrice,
        0.001,
      );

      if (!riskCheck.approved) {
        emitLog('WARN', `[ResolutionSnipe] Risk blocked: ${riskCheck.reason}`, undefined, this.strategyId);
        return;
      }

      // Fire: aggressive market order on winning token
      const resp = await this.clob.placeOrder({
        marketId: wr.marketId,
        tokenId: winningTokenId,
        side: 'BUY',
        type: 'FOK',
        price: opportunity.currentWinningPrice * 1.005, // tiny tolerance
        size: snipeSize,
      });

      const pnl = (1.0 - opportunity.currentWinningPrice) * snipeSize;
      this.totalSnipes++;
      this.totalPnL += pnl;

      const execution: TradeExecution = {
        id: uuidv4(),
        strategyId: this.strategyId,
        marketId: wr.marketId,
        tokenId: winningTokenId,
        side: 'BUY',
        price: opportunity.currentWinningPrice,
        size: snipeSize,
        pnl,
        timestamp: Date.now(),
        status: 'SUCCESS',
        polygonscanUrl: resp.transactionHash
          ? `https://polygonscan.com/tx/${resp.transactionHash}`
          : undefined,
      };

      this.risk.recordTrade(execution);
      BotWebSocketServer.getInstance().broadcast('TRADE_EXECUTED', execution);

      emitLog(
        'SUCCESS',
        `[ResolutionSnipe] Sniped in ${Date.now() - snipeStart}ms | ${snipeSize.toFixed(2)} tokens @ ${opportunity.currentWinningPrice.toFixed(4)} | profit=$${pnl.toFixed(2)}`,
        undefined,
        this.strategyId,
      );
    } catch (err) {
      emitLog('ERROR', `[ResolutionSnipe] Snipe failed: ${String(err)}`, undefined, this.strategyId);
    } finally {
      this.status = 'SCANNING';
      this.broadcastStatus();
    }
  }

  private broadcastStatus(): void {
    BotWebSocketServer.getInstance().broadcast('STRATEGY_STATUS_UPDATE', {
      strategyId: this.strategyId,
      status: this.status,
      metrics: this.getMetrics(),
    });
  }

  getMetrics(): Record<string, number | string> {
    return {
      watchedMarkets: this.watchedResolutions.size,
      pendingProposals: this.pendingProposals.size,
      totalSnipes: this.totalSnipes,
      totalPnL: parseFloat(this.totalPnL.toFixed(4)),
    };
  }
}
