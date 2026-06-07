/**
 * WEBSOCKET BROADCAST SERVER
 *
 * Responsibilities:
 *  - Single WebSocketServer broadcasting to all connected frontends
 *  - Typed message envelope with sequence IDs for ordering guarantees
 *  - Automatic JSON serialization with BigInt support
 *  - Client heartbeat / ping-pong to detect dead connections
 *  - Rate-limited broadcast for high-frequency events (order book updates)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { logger } from '../utils/logger.js';
import type { WsMessage, WsMessageType } from '../types/index.js';

const HEARTBEAT_INTERVAL_MS = 20_000;
const PING_TIMEOUT_MS = 10_000;

// Minimum interval between order book broadcasts per market (ms)
const OB_THROTTLE_MS = 50;

interface ConnectedClient extends WebSocket {
  isAlive: boolean;
  clientId: string;
}

export class BotWebSocketServer {
  private static instance: BotWebSocketServer | null = null;

  private readonly wss: WebSocketServer;
  private sequenceId = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly lastBroadcastTime = new Map<string, number>();

  private constructor(port: number) {
    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const client = ws as ConnectedClient;
      client.isAlive = true;
      client.clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      logger.info('[WSServer] Client connected', {
        clientId: client.clientId,
        ip: req.socket.remoteAddress,
        totalClients: this.wss.clients.size,
      });

      client.on('pong', () => {
        client.isAlive = true;
      });

      client.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as { type: string };
          if (msg.type === 'PING') {
            client.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          }
        } catch {
          // ignore malformed client messages
        }
      });

      client.on('close', () => {
        logger.info('[WSServer] Client disconnected', { clientId: client.clientId });
      });

      client.on('error', (err) => {
        logger.warn('[WSServer] Client error', { clientId: client.clientId, err });
      });
    });

    this.wss.on('error', (err) => {
      logger.error('[WSServer] Server error', { err });
    });

    server.listen(port, () => {
      logger.info(`[WSServer] Listening on ws://0.0.0.0:${port}`);
    });

    this.startHeartbeat();
  }

  static getInstance(port?: number): BotWebSocketServer {
    if (!BotWebSocketServer.instance) {
      if (!port) throw new Error('WSServer not initialized');
      BotWebSocketServer.instance = new BotWebSocketServer(port);
    }
    return BotWebSocketServer.instance;
  }

  /** Broadcast to ALL connected clients (no throttle) */
  broadcast<T>(type: WsMessageType, payload: T): void {
    const msg: WsMessage<T> = {
      type,
      payload,
      timestamp: Date.now(),
      sequenceId: ++this.sequenceId,
    };
    const serialized = this.serialize(msg);

    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  }

  /**
   * Throttled broadcast for high-frequency events.
   * throttleKey should uniquely identify the stream (e.g. "OB:tokenId")
   */
  broadcastThrottled<T>(
    type: WsMessageType,
    payload: T,
    throttleKey: string,
    throttleMs = OB_THROTTLE_MS,
  ): boolean {
    const last = this.lastBroadcastTime.get(throttleKey) ?? 0;
    if (Date.now() - last < throttleMs) return false;

    this.lastBroadcastTime.set(throttleKey, Date.now());
    this.broadcast(type, payload);
    return true;
  }

  getClientCount(): number {
    return this.wss.clients.size;
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.wss.clients) {
        const client = ws as ConnectedClient;
        if (!client.isAlive) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
        setTimeout(() => {
          if (!client.isAlive && client.readyState === WebSocket.OPEN) {
            client.terminate();
          }
        }, PING_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** BigInt-safe JSON serializer */
  private serialize(data: unknown): string {
    return JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  }

  destroy(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.wss.close();
    BotWebSocketServer.instance = null;
  }
}
