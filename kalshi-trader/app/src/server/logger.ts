import { pino, type Logger } from 'pino';
import type { LogLevel } from '../config.js';

/** Pino JSON logger writing to stdout (the Home Assistant Log tab). */
export function createLogger(level: LogLevel = 'info'): Logger {
  return pino({
    level,
    base: { app: 'kalshi-trader' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['privateKey', '*.privateKey', 'kalshiPrivateKey', '*.kalshiPrivateKey', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  });
}
