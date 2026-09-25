import { destination, multistream, pino, type Logger } from 'pino';
import type { LogLevel } from '../config.js';
import type { LogRing } from './logRing.js';

/**
 * Pino JSON logger writing to stdout (the Home Assistant Log tab) and, when given, to the in-memory
 * ring buffer behind the SSE log tail (`GET /api/live`).
 */
export function createLogger(
  level: LogLevel = 'info',
  ring?: LogRing,
  stdout: { write(chunk: string): unknown } = destination({ dest: 1, sync: true }),
): Logger {
  const options = {
    level,
    base: { app: 'kalshi-trader' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['privateKey', '*.privateKey', 'kalshiPrivateKey', '*.kalshiPrivateKey', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  };
  if (!ring) return pino(options);
  return pino(
    options,
    multistream([
      { level, stream: stdout },
      { level, stream: ring },
    ]),
  );
}
