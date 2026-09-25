import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { KalshiEnv } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { LOG_RING_SIZE, type LogEntry, type LogMode, type LogRing } from './logRing.js';
import { authOf } from './security.js';

/** Process facts the UI shows read-only (they are changed in Home Assistant, which restarts the app). */
export interface RuntimeInfo {
  version: string;
  allowLiveOrders: boolean;
  kalshiEnv: KalshiEnv;
  kalshiSubaccount: number;
  /** Absolute path of the SQLite file. */
  dbPath: string;
}

/** The switch states pushed on `/api/live` and returned by `GET /api/status`. */
export interface SwitchStates {
  globalKillSwitch: boolean;
  globalDryRun: boolean;
  allowLiveOrders: boolean;
  kalshiEnv: KalshiEnv;
  kalshiSubaccount: number;
}

/**
 * The mode a new order would get from the global controls alone (SPEC.md §1 effective mode without
 * the per-strategy steps): `live` only when the add-on lock is open and global dry run is off.
 * Switch-change log lines carry it as their `mode`.
 */
export const globalMode = (
  s: Pick<SwitchStates, 'allowLiveOrders' | 'globalDryRun'>,
): Exclude<LogMode, null> => (s.allowLiveOrders && !s.globalDryRun ? 'live' : 'dry_run');

export const HEARTBEAT_MS = 10_000;

/** Fan-out point for everything `/api/live` streams: log lines (from the ring) and switch changes. */
export class LiveHub extends EventEmitter<{ switches: [SwitchStates] }> {
  constructor(
    readonly ring: LogRing,
    readonly runtime: RuntimeInfo,
    private readonly repos: () => Repositories,
  ) {
    super();
    this.setMaxListeners(0);
  }

  /** Current switch states, read from the database (never cached, SPEC.md §4). */
  switches(): SwitchStates {
    const settings = this.repos().settings;
    return {
      globalKillSwitch: settings.get('global_kill_switch'),
      globalDryRun: settings.get('global_dry_run'),
      allowLiveOrders: this.runtime.allowLiveOrders,
      kalshiEnv: this.runtime.kalshiEnv,
      kalshiSubaccount: this.runtime.kalshiSubaccount,
    };
  }

  /** Called after a switch changed, so every open stream sees it immediately. */
  switchesChanged(): void {
    this.emit('switches', this.switches());
  }
}

/** Formats one Server-Sent Event. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * `GET /api/live` (SPEC.md §4 Live status): `retry`, then `switches` and `logs` (the last 50 lines,
 * each with its `mode`), then a `log` event per new line, `switches` on every change and a
 * `heartbeat` (with the switch states) every 10 s. Each heartbeat re-checks the session, so a
 * revoked or expired session stops receiving data within one interval.
 */
export function registerLiveRoutes(
  app: FastifyInstance,
  hub: LiveHub,
  repos: () => Repositories,
  options: { heartbeatMs?: number; now?: () => number } = {},
): void {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  const open = new Set<ServerResponse>();

  app.addHook('preClose', async () => {
    for (const res of open) res.end();
    open.clear();
  });

  app.get('/api/live', async (req, reply) => {
    const { session } = authOf(req);
    const initialSwitches = hub.switches();

    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v;
    res.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Stops proxies (nginx in the Supervisor, Cloudflare) from buffering the stream.
      'x-accel-buffering': 'no',
    });
    open.add(res);

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(sseEvent(event, data));
    };
    const onLine = (line: LogEntry) => send('log', line);
    const onSwitches = (s: SwitchStates) => send('switches', s);

    const sessionActive = (): boolean => {
      try {
        const row = repos().sessions.get({ id_hash: session.id_hash });
        return row !== undefined && Date.parse(row.expires_at) > now();
      } catch {
        return true; // database briefly unavailable: keep the stream, the next beat re-checks
      }
    };

    const cleanup = () => {
      clearInterval(timer);
      hub.ring.off('line', onLine);
      hub.off('switches', onSwitches);
      open.delete(res);
    };

    const timer = setInterval(() => {
      if (!sessionActive()) {
        send('end', { reason: 'session' });
        res.end();
        cleanup();
        return;
      }
      let switches: SwitchStates | null = null;
      try {
        switches = hub.switches();
      } catch {
        // database unavailable: the heartbeat still proves the stream is alive
      }
      send('heartbeat', { at: new Date(now()).toISOString(), switches });
    }, heartbeatMs);
    timer.unref();

    res.write('retry: 2000\n\n');
    send('switches', initialSwitches);
    send('logs', hub.ring.last(LOG_RING_SIZE));
    hub.ring.on('line', onLine);
    hub.on('switches', onSwitches);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
}
