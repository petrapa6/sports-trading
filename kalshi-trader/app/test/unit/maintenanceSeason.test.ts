import { statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMaintenance, type MaintenanceScheduler } from '../../src/core/maintenance.js';
import { seedSeason } from '../../scripts/seed-season-lib.js';
import { tempDb, type TempDb } from '../helpers/db.js';
import { logLines } from '../helpers/feeds.js';
import { captureLogger } from '../helpers/kalshiMsw.js';

/**
 * T14: nightly maintenance end to end on a season-sized database (`seed:season`: 2 000 games, 60 000 snapshots,
 * 400 trades). Fake time crosses 02:30 → one log line naming `wal_checkpoint` and `pruned N snapshots`, the `-wal`
 * file shrinks below 1 MB, and only snapshots of archived games older than 90 days are gone.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T02:29:00Z');
let t: TempDb;
let scheduler: MaintenanceScheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  t?.cleanup();
  vi.useRealTimers();
});

const count = (sql: string) => (t.db.sqlite.prepare(sql).get() as { n: number }).n;
const walBytes = () => statSync(`${t.path}-wal`).size;

describe('maintenance on the seeded season', () => {
  it('02:30 → "wal_checkpoint" and "pruned N snapshots" logged, -wal < 1 MB, non-archived snapshots survive', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
    t = tempDb();
    const seeded = seedSeason(t.db.sqlite, { now: NOW });
    expect(seeded).toMatchObject({ games: 2000, snapshots: 60_000, trades: 400 });
    const cutoff = new Date(NOW + 60_000 - 90 * DAY).toISOString();
    const prunable = count(
      `SELECT count(*) AS n FROM game_snapshots s JOIN games g ON g.id = s.game_id
       WHERE g.timeline_archived = 1 AND s.observed_at < '${cutoff}'`,
    );
    const notArchived = count(
      `SELECT count(*) AS n FROM game_snapshots s JOIN games g ON g.id = s.game_id WHERE g.timeline_archived = 0`,
    );
    const oldNotArchived = count(
      `SELECT count(*) AS n FROM game_snapshots s JOIN games g ON g.id = s.game_id
       WHERE g.timeline_archived = 0 AND s.observed_at < '${cutoff}'`,
    );
    expect(prunable).toBeGreaterThan(30_000);
    expect(oldNotArchived).toBeGreaterThan(0);
    const walBefore = walBytes();
    expect(walBefore).toBeGreaterThan(1_000_000);

    const { log, text } = captureLogger('info');
    scheduler = startMaintenance({ getDb: () => t.db, log, timeZone: 'UTC' });
    vi.advanceTimersByTime(59_000);
    expect(count('SELECT count(*) AS n FROM game_snapshots')).toBe(60_000);
    vi.advanceTimersByTime(2_000); // crosses 02:30:00

    const done = logLines(text()).filter((l) => l.msg.startsWith('Maintenance done'));
    expect(done).toHaveLength(1);
    expect(done[0]?.msg).toBe(`Maintenance done: wal_checkpoint(TRUNCATE), pruned ${prunable} snapshots`);
    expect(done[0]?.['prunedSnapshots']).toBe(prunable);
    expect(count('SELECT count(*) AS n FROM game_snapshots')).toBe(60_000 - prunable);
    expect(
      count(
        `SELECT count(*) AS n FROM game_snapshots s JOIN games g ON g.id = s.game_id WHERE g.timeline_archived = 0`,
      ),
    ).toBe(notArchived);
    const walAfter = walBytes();
    expect(walAfter).toBeLessThan(1_000_000);
    console.log(
      `seeded ${JSON.stringify(seeded)}; "${done[0]?.msg}"; -wal ${walBefore} → ${walAfter} bytes; ` +
        `${notArchived} snapshots of non-archived games kept (${oldNotArchived} of them older than 90 days)`,
    );
  });
});
