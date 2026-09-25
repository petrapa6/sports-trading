import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextRunAt, startMaintenance, type MaintenanceScheduler } from '../../src/core/maintenance.js';
import { createRepositories } from '../../src/db/repositories.js';
import { tempDb, type TempDb } from '../helpers/db.js';

const DAY = 24 * 60 * 60 * 1000;
const log = pino({ level: 'silent' });

describe('nextRunAt', () => {
  it('returns today 02:30 local when before it, else tomorrow', () => {
    // Prague is UTC+2 in September: 02:30 local = 00:30Z.
    expect(new Date(nextRunAt(Date.parse('2026-09-25T00:00:00Z'), 'Europe/Prague')).toISOString()).toBe(
      '2026-09-25T00:30:00.000Z',
    );
    expect(new Date(nextRunAt(Date.parse('2026-09-25T00:30:00Z'), 'Europe/Prague')).toISOString()).toBe(
      '2026-09-26T00:30:00.000Z',
    );
    expect(new Date(nextRunAt(Date.parse('2026-09-25T12:00:00Z'), 'UTC')).toISOString()).toBe(
      '2026-09-26T02:30:00.000Z',
    );
    expect(new Date(nextRunAt(Date.parse('2026-09-25T12:00:00Z'), 'America/New_York')).toISOString()).toBe(
      '2026-09-26T06:30:00.000Z',
    );
  });

  it('handles DST changes', () => {
    // Europe: back to winter time on 2026-10-25, when 02:30 occurs twice; it runs once, at the
    // second occurrence (02:30 CET = 01:30Z), then daily at 01:30Z.
    const fallBack = nextRunAt(Date.parse('2026-10-24T12:00:00Z'), 'Europe/Prague');
    expect(new Date(fallBack).toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(new Date(nextRunAt(fallBack, 'Europe/Prague')).toISOString()).toBe('2026-10-26T01:30:00.000Z');
    // 2027-03-28 02:30 does not exist in Prague (02:00 → 03:00); it runs once, just after the gap.
    const at = nextRunAt(Date.parse('2027-03-27T12:00:00Z'), 'Europe/Prague');
    expect(at).toBeGreaterThan(Date.parse('2027-03-28T00:59:59Z'));
    expect(at).toBeLessThanOrEqual(Date.parse('2027-03-28T01:30:00Z'));
    expect(new Date(nextRunAt(at, 'Europe/Prague')).toISOString()).toBe('2027-03-29T00:30:00.000Z');
  });
});

describe('startMaintenance', () => {
  let t: TempDb;
  let scheduler: MaintenanceScheduler | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    t = tempDb();
  });
  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    t.cleanup();
    vi.useRealTimers();
  });

  function seed(): void {
    const r = createRepositories(t.db.orm);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    r.games.insert({
      id: 'archived',
      league_id: 'epl',
      scheduled_at: iso(now),
      updated_at: iso(now),
      timeline_archived: 1,
    });
    r.games.insert({ id: 'open', league_id: 'epl', scheduled_at: iso(now), updated_at: iso(now) });
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => ({
        game_id: 'archived',
        observed_at: iso(now - 91 * DAY - i * 1000),
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        game_id: 'open',
        observed_at: iso(now - 91 * DAY - i * 1000),
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        game_id: 'archived',
        observed_at: iso(now - 89 * DAY - i * 1000),
      })),
    ];
    r.gameSnapshots.insertMany(rows);
  }

  it('prunes only archived snapshots older than 90 days at the 02:30 tick', () => {
    seed();
    const pragma = vi.spyOn(t.db.sqlite, 'pragma');
    const count = () =>
      (t.db.sqlite.prepare('SELECT count(*) AS n FROM game_snapshots').get() as { n: number }).n;
    scheduler = startMaintenance({ getDb: () => t.db, log, timeZone: 'Europe/Prague' });
    expect(new Date(scheduler.nextAt).toISOString()).toBe('2026-09-26T00:30:00.000Z');

    vi.advanceTimersByTime(Date.parse('2026-09-26T00:29:59Z') - Date.now());
    expect(count()).toBe(160);
    expect(pragma).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(count()).toBe(60);
    const remaining = t.db.sqlite
      .prepare('SELECT game_id, count(*) AS n FROM game_snapshots GROUP BY game_id ORDER BY game_id')
      .all();
    expect(remaining).toEqual([
      { game_id: 'archived', n: 10 },
      { game_id: 'open', n: 50 },
    ]);
    expect(pragma).toHaveBeenCalledTimes(1);
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
  });

  it('checkpoints the WAL exactly once per day', () => {
    const pragma = vi.spyOn(t.db.sqlite, 'pragma');
    scheduler = startMaintenance({ getDb: () => t.db, log, timeZone: 'Europe/Prague' });
    const checkpoints = () => pragma.mock.calls.filter((c) => c[0] === 'wal_checkpoint(TRUNCATE)').length;
    vi.advanceTimersByTime(DAY);
    expect(checkpoints()).toBe(1);
    vi.advanceTimersByTime(DAY);
    expect(checkpoints()).toBe(2);
    vi.advanceTimersByTime(5 * DAY);
    expect(checkpoints()).toBe(7);
    expect(new Date(scheduler.nextAt).toISOString()).toBe('2026-10-03T00:30:00.000Z');
  });

  it('uses an injected clock', () => {
    let now = Date.parse('2026-09-25T10:00:00Z');
    const timers: { fn: () => void; at: number }[] = [];
    const pragma = vi.spyOn(t.db.sqlite, 'pragma');
    scheduler = startMaintenance({
      getDb: () => t.db,
      log,
      timeZone: 'UTC',
      clock: {
        now: () => now,
        setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }),
        clearTimeout: () => undefined,
      },
    });
    expect(timers).toHaveLength(1);
    expect(new Date(timers[0]?.at ?? 0).toISOString()).toBe('2026-09-26T02:30:00.000Z');
    now = timers[0]?.at ?? 0;
    timers[0]?.fn();
    expect(pragma).toHaveBeenCalledTimes(1);
    expect(new Date(timers[1]?.at ?? 0).toISOString()).toBe('2026-09-27T02:30:00.000Z');
  });

  it('skips the run while the database is unavailable and stops cleanly', () => {
    const pragma = vi.spyOn(t.db.sqlite, 'pragma');
    scheduler = startMaintenance({ getDb: () => undefined, log, timeZone: 'UTC' });
    vi.advanceTimersByTime(DAY);
    expect(pragma).not.toHaveBeenCalled();
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
