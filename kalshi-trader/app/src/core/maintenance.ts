import type { Logger } from 'pino';
import type { Db } from '../db/connection.js';
import { GameSnapshotsRepository } from '../db/repositories.js';

/**
 * Nightly database maintenance (SPEC.md §7 Retention, T02): at 02:30 local time (`TZ`)
 * run `PRAGMA wal_checkpoint(TRUNCATE)` and prune `game_snapshots` older than 90 days for
 * games whose timeline is archived. The schedule uses an injectable clock so it can be
 * tested with fake timers.
 */

export const MAINTENANCE_HOUR = 2;
export const MAINTENANCE_MINUTE = 30;
export const SNAPSHOT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock; resolves the global timer functions at call time (so fake timers apply). */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The process's time zone (from `TZ`, else the system default). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(ms: number, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(ms))
    if (p.type !== 'literal') parts[p.type] = Number.parseInt(p.value, 10);
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

/** UTC offset of `timeZone` at instant `ms`, in milliseconds (local − UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant at which the local wall-clock time `y-m-d h:mi` occurs in `timeZone`. For a time
 * skipped by a DST change the result falls just after the gap (e.g. 03:30 instead of 02:30).
 */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/** The first instant strictly after `nowMs` at which it is `hour:minute` local time in `timeZone`. */
export function nextRunAt(
  nowMs: number,
  timeZone: string,
  hour = MAINTENANCE_HOUR,
  minute = MAINTENANCE_MINUTE,
): number {
  const today = localParts(nowMs, timeZone);
  for (let add = 0; add < 3; add++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const at = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, timeZone);
    if (at > nowMs) return at;
  }
  throw new Error(`could not compute next ${hour}:${minute} in ${timeZone}`);
}

export interface MaintenanceResult {
  prunedSnapshots: number;
  checkpoint: unknown;
}

/** One maintenance pass: WAL checkpoint, then snapshot pruning relative to `nowMs`. */
export function runMaintenance(db: Db, nowMs: number): MaintenanceResult {
  const cutoff = new Date(nowMs - SNAPSHOT_RETENTION_DAYS * DAY_MS).toISOString();
  const prunedSnapshots = new GameSnapshotsRepository(db.orm).pruneArchivedBefore(cutoff);
  const checkpoint = db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  return { prunedSnapshots, checkpoint };
}

export interface MaintenanceOptions {
  /** Returns the open database, or `undefined` while it is unavailable (the run is skipped). */
  getDb: () => Db | undefined;
  log: Logger;
  timeZone?: string;
  clock?: Clock;
}

export interface MaintenanceScheduler {
  /** Epoch ms of the next scheduled run. */
  readonly nextAt: number;
  stop(): void;
}

/** Schedules `runMaintenance` every day at 02:30 local time until `stop()`. */
export function startMaintenance(options: MaintenanceOptions): MaintenanceScheduler {
  const clock = options.clock ?? systemClock;
  const timeZone = options.timeZone ?? localTimeZone();
  const { log } = options;
  let handle: unknown;
  let stopped = false;
  let nextAt = nextRunAt(clock.now(), timeZone);

  const schedule = (): void => {
    if (stopped) return;
    handle = clock.setTimeout(tick, Math.max(0, nextAt - clock.now()));
  };

  function tick(): void {
    const due = nextAt;
    const db = options.getDb();
    if (!db) {
      log.warn('Maintenance skipped: database unavailable');
    } else {
      try {
        const result = runMaintenance(db, clock.now());
        log.info(
          { prunedSnapshots: result.prunedSnapshots, checkpoint: result.checkpoint },
          'Maintenance done',
        );
      } catch (err) {
        log.error({ err }, 'Maintenance failed');
      }
    }
    // Never run twice for the same slot, even if the timer fired a little early.
    nextAt = nextRunAt(Math.max(clock.now(), due), timeZone);
    schedule();
  }

  log.info({ nextAt: new Date(nextAt).toISOString(), timeZone }, 'Maintenance scheduled');
  schedule();

  return {
    get nextAt() {
      return nextAt;
    },
    stop() {
      stopped = true;
      clock.clearTimeout(handle);
    },
  };
}
