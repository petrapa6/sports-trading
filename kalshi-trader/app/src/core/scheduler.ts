import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import {
  FEED_IDS,
  FEED_NAMES,
  IN_PROGRESS,
  type FeedId,
  type ScoreFeed,
  type TrackedGame,
} from '../feeds/gameState.js';
import { NetworkPaused } from '../feeds/network.js';
import { systemClock, type Clock } from './maintenance.js';
import type { GameTracker } from './tracker.js';

/**
 * Poll cadence (SPEC.md §3 Polling plan, §4, T07), a `setTimeout` chain:
 *
 * - **paused** while the global kill switch is on: no feed call at all; the switch is re-read every 5 s
 *   (and at once on `wake()`, which the API calls after a switch change);
 * - **5 s** while any tracked game is in progress; **60 s** within the hour before a scheduled game;
 * - **idle** otherwise: no feed call, the database is re-checked every 60 s.
 *
 * Feeds are polled concurrently with `Promise.allSettled`, so a failing feed never stops the others or
 * the loop. Every tick (also idle and paused ones) refreshes the health tick: `/healthz` reports
 * `503 {"ok":false,"loop":"stale"}` once no tick happened for 2 minutes.
 */

export const LIVE_INTERVAL_MS = 5_000;
export const PREGAME_INTERVAL_MS = 60_000;
export const IDLE_CHECK_MS = 60_000;
export const PAUSED_CHECK_MS = 5_000;
export const STALE_MS = 120_000;
export const BALANCE_REFRESH_MS = 5 * 60_000;

export type LoopState = 'starting' | 'running' | 'idle' | 'paused' | 'stopped';
export type FeedHealth = 'ok' | 'error' | 'idle' | 'disabled' | 'paused' | 'unavailable';

export interface FeedStatus {
  id: FeedId;
  name: string;
  enabled: boolean;
  /** `false` when the adapter cannot run (Kalshi credentials missing). */
  available: boolean;
  status: FeedHealth;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface LoopStatus {
  state: LoopState | 'stale';
  lastTickAt: string | null;
  lastPollAt: string | null;
  cadenceMs: number | null;
  trackedGames: number;
  feeds: FeedStatus[];
  balance: { cashMicros: number | null; at: string | null; error: string | null };
}

export type LoopHealth = { ok: true; loop: LoopState } | { ok: false; loop: 'stale' };

export interface SchedulerOptions {
  tracker: Pick<GameTracker, 'pollTargets' | 'ingest'>;
  /** The adapters that can run (the Kalshi one only with credentials). */
  feeds: readonly ScoreFeed[];
  /** Settings → Feeds, read on every tick. */
  isFeedEnabled: (id: FeedId) => boolean;
  /** The global kill switch, read from the database on every tick (errors count as "on"). */
  isPaused: () => boolean;
  log: Logger;
  clock?: Clock;
  /** Reads the Kalshi cash balance for the status strip (every 5 min while not paused). */
  balance?: () => Promise<number>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 5 s with a game in progress, 60 s with one about to start, `null` (idle) otherwise. */
export function cadenceFor(games: readonly TrackedGame[]): number | null {
  if (games.length === 0) return null;
  return games.some((g) => IN_PROGRESS.has(g.phase)) ? LIVE_INTERVAL_MS : PREGAME_INTERVAL_MS;
}

interface FeedRecord {
  status: FeedHealth;
  lastPollAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
}

export class Scheduler extends EventEmitter<{ status: [LoopStatus] }> {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly records = new Map<FeedId, FeedRecord>();
  private handle: unknown;
  private state: LoopState = 'starting';
  private startedAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastPollAt: number | null = null;
  private cadenceMs: number | null = null;
  private trackedGames = 0;
  private ticking = false;
  private wakeRequested = false;
  private balanceMicros: number | null = null;
  private balanceAt: number | null = null;
  private balanceError: string | null = null;
  private balanceInFlight = false;

  constructor(private readonly options: SchedulerOptions) {
    super();
    this.setMaxListeners(0);
    this.clock = options.clock ?? systemClock;
    this.log = options.log.child({ component: 'scheduler' });
    for (const id of FEED_IDS)
      this.records.set(id, { status: 'idle', lastPollAt: null, lastOkAt: null, lastError: null });
  }

  /** Starts the loop (first tick at once). */
  start(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.clock.now();
    this.schedule(0);
  }

  /** Stops the loop; `/healthz` turns stale 2 minutes after the last tick. */
  stop(): void {
    this.state = 'stopped';
    this.clock.clearTimeout(this.handle);
    this.handle = undefined;
  }

  /**
   * Restarts a stopped loop (the development-only stall drill, T14): the next tick runs at once, so
   * `/healthz` recovers as soon as it has ticked.
   */
  resume(): void {
    if (this.state !== 'stopped' || this.startedAt === null) return;
    this.state = 'starting';
    this.schedule(0);
  }

  /** Re-evaluates at once (after a switch change), e.g. to leave `paused` without waiting. */
  wake(): void {
    if (this.state === 'stopped' || this.startedAt === null) return;
    if (this.ticking) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.state === 'stopped') return;
    this.clock.clearTimeout(this.handle);
    this.handle = this.clock.setTimeout(() => void this.tick(), ms);
  }

  health(now = this.clock.now()): LoopHealth {
    const last = this.lastTickAt ?? this.startedAt;
    if (last !== null && now - last > STALE_MS) return { ok: false, loop: 'stale' };
    return { ok: true, loop: this.state };
  }

  status(now = this.clock.now()): LoopStatus {
    const health = this.health(now);
    const available = new Set(this.options.feeds.map((f) => f.id));
    return {
      state: health.ok ? this.state : 'stale',
      lastTickAt: iso(this.lastTickAt),
      lastPollAt: iso(this.lastPollAt),
      cadenceMs: this.cadenceMs,
      trackedGames: this.trackedGames,
      feeds: FEED_IDS.map((id) => {
        const r = this.records.get(id) as FeedRecord;
        const on = this.feedEnabled(id);
        const isAvailable = available.has(id);
        return {
          id,
          name: FEED_NAMES[id],
          enabled: on,
          available: isAvailable,
          status: !isAvailable ? 'unavailable' : !on ? 'disabled' : r.status,
          lastPollAt: iso(r.lastPollAt),
          lastOkAt: iso(r.lastOkAt),
          lastError: r.lastError,
        };
      }),
      balance: { cashMicros: this.balanceMicros, at: iso(this.balanceAt), error: this.balanceError },
    };
  }

  private feedEnabled(id: FeedId): boolean {
    try {
      return this.options.isFeedEnabled(id);
    } catch {
      return true; // database briefly unavailable: keep the last behaviour (feeds default to on)
    }
  }

  private setAll(status: FeedHealth): void {
    for (const r of this.records.values()) if (r.status !== 'error' || status === 'paused') r.status = status;
  }

  private publish(): void {
    this.emit('status', this.status());
  }

  private async tick(): Promise<void> {
    if (this.state === 'stopped' || this.ticking) return;
    this.ticking = true;
    let next = IDLE_CHECK_MS;
    try {
      next = await this.runTick();
    } catch (err) {
      this.log.error({ err: { message: message(err) } }, 'Scheduler tick failed');
    } finally {
      this.ticking = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        next = 0;
      }
      this.schedule(next);
      this.publish();
    }
  }

  private async runTick(): Promise<number> {
    const now = this.clock.now();
    this.lastTickAt = now;

    let paused: boolean;
    try {
      paused = this.options.isPaused();
    } catch {
      paused = true; // fail closed: no outgoing request while the switch cannot be read
    }
    if (paused) {
      if (this.state !== 'paused') this.log.info('Polling paused: the global kill switch is on');
      this.state = 'paused';
      this.cadenceMs = null;
      this.setAll('paused');
      return PAUSED_CHECK_MS;
    }
    if (this.state === 'paused') this.log.info('Polling resumed: the global kill switch is off');

    let targets = this.options.tracker.pollTargets(now);
    this.trackedGames = targets.length;
    let cadence = cadenceFor(targets);
    this.refreshBalance();
    if (cadence === null) {
      this.state = 'idle';
      this.cadenceMs = null;
      this.setAll('idle');
      return IDLE_CHECK_MS;
    }
    this.state = 'running';

    const jobs: { feed: ScoreFeed; games: TrackedGame[] }[] = [];
    for (const feed of this.options.feeds) {
      const record = this.records.get(feed.id) as FeedRecord;
      const on = this.feedEnabled(feed.id);
      const games = targets.filter((g) => feed.sports.includes(g.sport));
      if (!on || games.length === 0) {
        if (record.status !== 'error' || !on) record.status = on ? 'idle' : 'disabled';
        continue;
      }
      jobs.push({ feed, games });
    }

    const results = await Promise.allSettled(jobs.map((j) => j.feed.poll(j.games)));
    const polledAt = this.clock.now();
    results.forEach((result, i) => {
      const { feed } = jobs[i] as (typeof jobs)[number];
      const record = this.records.get(feed.id) as FeedRecord;
      record.lastPollAt = polledAt;
      if (result.status === 'fulfilled') {
        if (record.status === 'error') this.log.info({ feed: feed.id }, `Feed ${feed.id} recovered`);
        record.status = 'ok';
        record.lastOkAt = polledAt;
        record.lastError = null;
        try {
          this.options.tracker.ingest(feed.id, result.value);
        } catch (err) {
          this.log.error(
            { feed: feed.id, err: { message: message(err) } },
            'Could not apply feed observations',
          );
        }
      } else if (result.reason instanceof NetworkPaused) {
        record.status = 'paused';
      } else {
        const text = message(result.reason);
        if (record.status !== 'error' || record.lastError !== text)
          this.log.warn({ feed: feed.id, err: { message: text } }, `Feed ${feed.id} failed`);
        record.status = 'error';
        record.lastError = text;
      }
    });
    this.lastPollAt = polledAt;

    // Phases may have changed (a game finished): the next interval follows the new state.
    targets = this.options.tracker.pollTargets(this.clock.now());
    this.trackedGames = targets.length;
    cadence = cadenceFor(targets);
    this.cadenceMs = cadence;
    if (cadence === null) {
      this.state = 'idle';
      return IDLE_CHECK_MS;
    }
    return cadence;
  }

  private refreshBalance(): void {
    const read = this.options.balance;
    if (!read || this.balanceInFlight) return;
    const now = this.clock.now();
    if (this.balanceAt !== null && now - this.balanceAt < BALANCE_REFRESH_MS) return;
    this.balanceInFlight = true;
    read()
      .then((cash) => {
        this.balanceMicros = cash;
        this.balanceError = null;
      })
      .catch((err: unknown) => {
        if (!(err instanceof NetworkPaused)) this.balanceError = message(err);
      })
      .finally(() => {
        this.balanceAt = this.clock.now();
        this.balanceInFlight = false;
        this.publish();
      });
  }
}
