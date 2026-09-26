import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { KalshiEnv } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { Signal } from '../core/engine.js';
import type { LoopStatus } from '../core/scheduler.js';
import {
  armedStrategies,
  loadStrategies,
  readGlobalSwitches,
  strategyViews,
  type StrategyView,
} from '../core/strategyStore.js';
import type { GameView } from '../core/tracker.js';
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

/** Where the tracked games, the loop status and the recent signals come from (tracker, scheduler, engine). */
export interface LiveSource {
  games(): GameView[];
  loop(): LoopStatus | null;
  signals?(): Signal[];
}

const NO_SOURCE: LiveSource = { games: () => [], loop: () => null };

/**
 * Fan-out point for everything `/api/live` streams: log lines (from the ring), switch changes, the
 * tracked games (after every tracker update, coalesced per event-loop turn) with the strategies armed on
 * them, the loop status, the strategies with their effective mode, and signals (T08).
 */
export class LiveHub extends EventEmitter<{
  switches: [SwitchStates];
  games: [GameView[]];
  loop: [LoopStatus];
  strategies: [StrategyView[]];
  signal: [Signal];
}> {
  private source: LiveSource = NO_SOURCE;
  private gamesPending = false;

  constructor(
    readonly ring: LogRing,
    readonly runtime: RuntimeInfo,
    private readonly repos: () => Repositories,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.setMaxListeners(0);
  }

  setSource(source: LiveSource): void {
    this.source = source;
  }

  /**
   * Tracked games for the dashboard cards, each with the strategies armed on it (effective mode not
   * `paused`, league and sport match); empty while the database is unavailable.
   */
  games(): GameView[] {
    try {
      const games = this.source.games();
      if (games.length === 0) return games;
      const repos = this.repos();
      const switches = readGlobalSwitches(repos, this.runtime.allowLiveOrders);
      const strategies = loadStrategies(repos);
      return games.map((g) => ({
        ...g,
        strategies: armedStrategies(strategies, switches, g.leagueId, g.sport),
      }));
    } catch {
      return [];
    }
  }

  /** Strategies with their effective mode (empty while the database is unavailable). */
  strategies(): StrategyView[] {
    try {
      const repos = this.repos();
      return strategyViews(repos, readGlobalSwitches(repos, this.runtime.allowLiveOrders), this.now());
    } catch {
      return [];
    }
  }

  /** The most recent signals (newest last). */
  signals(): Signal[] {
    return this.source.signals?.() ?? [];
  }

  /** Called after a strategy was created, edited, toggled or deleted. */
  strategiesChanged(): void {
    this.emit('strategies', this.strategies());
    this.gamesChanged();
  }

  signalEmitted(signal: Signal): void {
    this.emit('signal', signal);
  }

  loop(): LoopStatus | null {
    return this.source.loop();
  }

  /** Called after a tracker update; many updates in one tick produce one `games` event. */
  gamesChanged(): void {
    if (this.gamesPending) return;
    this.gamesPending = true;
    setImmediate(() => {
      this.gamesPending = false;
      this.emit('games', this.games());
    });
  }

  loopChanged(status: LoopStatus): void {
    this.emit('loop', status);
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

  /** Called after a switch changed, so every open stream sees it immediately (and the new effective modes). */
  switchesChanged(): void {
    this.emit('switches', this.switches());
    this.strategiesChanged();
  }
}

/** Formats one Server-Sent Event. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * `GET /api/live` (SPEC.md §4 Live status): `retry`, then `switches`, `logs` (the last 50 lines,
 * each with its `mode`), `games` (`{games: GameView[]}`, the tracked games with score, clock and armed
 * strategies), `loop` (loop state, last poll, feed status, Kalshi balance), `strategies`
 * (`{strategies: StrategyView[]}` with effective modes) and `signals` (`{signals: Signal[]}`, the recent
 * ones); then a `log` event per new line, `switches` / `games` / `loop` / `strategies` on every change, a
 * `signal` event per new signal and a `heartbeat` (with the switch states) every 10 s.
 * Each heartbeat re-checks the session, so a revoked or expired session stops receiving data within
 * one interval.
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
    const onGames = (games: GameView[]) => send('games', { games });
    const onLoop = (loop: LoopStatus) => send('loop', loop);
    const onStrategies = (strategies: StrategyView[]) => send('strategies', { strategies });
    const onSignal = (signal: Signal) => send('signal', signal);

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
      hub.off('games', onGames);
      hub.off('loop', onLoop);
      hub.off('strategies', onStrategies);
      hub.off('signal', onSignal);
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
    send('games', { games: hub.games() });
    const loop = hub.loop();
    if (loop) send('loop', loop);
    send('strategies', { strategies: hub.strategies() });
    send('signals', { signals: hub.signals() });
    hub.ring.on('line', onLine);
    hub.on('switches', onSwitches);
    hub.on('games', onGames);
    hub.on('loop', onLoop);
    hub.on('strategies', onStrategies);
    hub.on('signal', onSignal);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
}
