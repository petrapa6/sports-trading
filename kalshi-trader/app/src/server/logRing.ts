import { EventEmitter } from 'node:events';

export type LogMode = 'live' | 'dry_run' | null;

/** One log line as the UI sees it (SSE `/api/live`, Settings → Diagnostics). */
export interface LogEntry {
  /** Monotonic sequence number, so the browser can de-duplicate after a reconnect. */
  seq: number;
  time: string;
  level: string;
  msg: string;
  /** Every trading-related line carries its mode (SPEC.md §8); `null` for everything else. */
  mode: LogMode;
}

const LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export const LOG_RING_SIZE = 50;

/**
 * Ring buffer of the most recent log lines, fed by Pino as an extra destination stream
 * (`createLogger(level, ring)`). Fastify's per-request lines (`incoming request` /
 * `request completed`, recognisable by their `req` / `res` objects) are not kept: they would push
 * every useful line out of the buffer within seconds of the UI polling.
 */
export class LogRing extends EventEmitter<{ line: [LogEntry] }> {
  private readonly entries: LogEntry[] = [];
  private seq = 0;

  constructor(private readonly size = LOG_RING_SIZE) {
    super();
    this.setMaxListeners(0);
  }

  /** Pino destination interface: one JSON line per call. */
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.length === 0) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if ('req' in obj || 'res' in obj) continue;
      const mode = obj['mode'] === 'live' || obj['mode'] === 'dry_run' ? obj['mode'] : null;
      const level =
        typeof obj['level'] === 'number' ? (LEVELS[obj['level']] ?? String(obj['level'])) : 'info';
      const time = typeof obj['time'] === 'string' ? obj['time'] : new Date().toISOString();
      this.push({ time, level, msg: typeof obj['msg'] === 'string' ? obj['msg'] : '', mode });
    }
  }

  push(entry: Omit<LogEntry, 'seq'>): LogEntry {
    const full = { ...entry, seq: ++this.seq };
    this.entries.push(full);
    if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size);
    this.emit('line', full);
    return full;
  }

  /** The last `n` lines, oldest first. */
  last(n = this.size): LogEntry[] {
    return this.entries.slice(-n);
  }
}
