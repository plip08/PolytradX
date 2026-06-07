/**
 * WINSTON LOGGER — structured logging with WS broadcast integration
 */

import winston from 'winston';
import type { LogLevel, LogEntry } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

const { combine, timestamp, colorize, printf, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level.toUpperCase()}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    process.env['NODE_ENV'] === 'production' ? json() : combine(colorize(), consoleFormat),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 50 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

/** Convert winston level to our LogLevel type */
function toLogLevel(winstonLevel: string): LogLevel {
  const map: Record<string, LogLevel> = {
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
    debug: 'DEBUG',
    verbose: 'DEBUG',
  };
  return map[winstonLevel] ?? 'INFO';
}

/** Callback registered by WS server to forward logs to frontend */
let wsLogForwarder: ((entry: LogEntry) => void) | null = null;

export function registerWsLogForwarder(fn: (entry: LogEntry) => void): void {
  wsLogForwarder = fn;
}

/** Wrapper that logs AND broadcasts to frontend */
export function emitLog(
  level: LogLevel,
  message: string,
  data?: unknown,
  strategyId?: LogEntry['strategyId'],
): void {
  const entry: LogEntry = {
    id: uuidv4(),
    level,
    message,
    strategyId,
    data,
    timestamp: Date.now(),
  };

  // Map custom levels to valid Winston levels
  const winstonLevel = level === 'SUCCESS' ? 'info' : level.toLowerCase();
  logger.log(winstonLevel, message, data ?? {});
  wsLogForwarder?.(entry);
}
