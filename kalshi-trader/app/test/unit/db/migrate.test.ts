import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/db/connection.js';
import { MIGRATIONS_TABLE, migrateDown, migrateUp, migrationStatus } from '../../../src/db/migrate.js';
import { EXPECTED_TABLES, rowCounts, tableNames, tempDb, type TempDb } from '../../helpers/db.js';

describe('migrations', () => {
  let t: TempDb | undefined;
  afterEach(() => {
    t?.cleanup();
    t = undefined;
  });

  it('create exactly the §7 tables plus the Drizzle migration table', () => {
    t = tempDb();
    expect(tableNames(t.db)).toEqual([...EXPECTED_TABLES, MIGRATIONS_TABLE].sort());
  });

  it('create the §7 indexes and constraints', () => {
    t = tempDb();
    const indexes = (
      t.db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_%'")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes.sort()).toEqual(['ix_hist_league_season', 'ix_snapshots_game', 'ix_trades_filter']);
    expect(() =>
      t?.db.sqlite
        .prepare(
          "INSERT INTO strategies (id, name, sport, mode, current_version) VALUES ('s', 'n', 'soccer', 'x', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('seed the six leagues, enabled, preseason excluded', () => {
    t = tempDb();
    const rows = t.db.sqlite.prepare('SELECT * FROM leagues ORDER BY id').all() as Record<string, unknown>[];
    expect(rows.map((r) => [r['id'], r['kalshi_series']])).toEqual([
      ['bundesliga', 'KXBUNDESLIGAGAME'],
      ['epl', 'KXEPLGAME'],
      ['laliga', 'KXLALIGAGAME'],
      ['ligue1', 'KXLIGUE1GAME'],
      ['nhl', 'KXNHLGAME'],
      ['seriea', 'KXSERIEAGAME'],
    ]);
    for (const r of rows) {
      expect(r['enabled']).toBe(1);
      expect(r['include_preseason']).toBe(0);
      expect(() => JSON.parse(String(r['feed_ids']))).not.toThrow();
    }
  });

  it('apply nothing on a second run against the same file', () => {
    t = tempDb();
    t.db.close();
    const again = openDatabase(t.path);
    try {
      expect(migrateUp(again)).toEqual([]);
      expect(migrationStatus(again).every((m) => m.applied)).toBe(true);
      expect(again.sqlite.prepare('SELECT count(*) AS n FROM leagues').get()).toEqual({ n: 6 });
    } finally {
      again.close();
    }
    t.db = openDatabase(t.path);
  });

  it('down then up on a seeded DB leaves row counts unchanged', () => {
    t = tempDb();
    t.db.sqlite.exec(
      "INSERT INTO settings (key, value) VALUES ('global_dry_run', 'false');" +
        "INSERT INTO audit_log (at, actor, action) VALUES ('2026-09-25T00:00:00.000Z', 'system', 'test');",
    );
    const before = rowCounts(t.db);
    expect(migrateDown(t.db)).toEqual(['0001_seed_leagues']);
    expect(t.db.sqlite.prepare('SELECT count(*) AS n FROM leagues').get()).toEqual({ n: 0 });
    expect(migrateUp(t.db)).toEqual(['0001_seed_leagues']);
    expect(rowCounts(t.db)).toEqual(before);
  });

  it('roll back everything and re-apply it', () => {
    t = tempDb();
    expect(migrateDown(t.db, Number.MAX_SAFE_INTEGER)).toEqual(['0001_seed_leagues', '0000_initial_schema']);
    expect(tableNames(t.db)).toEqual([MIGRATIONS_TABLE]);
    expect(migrateUp(t.db)).toEqual(['0000_initial_schema', '0001_seed_leagues']);
    expect(tableNames(t.db)).toEqual([...EXPECTED_TABLES, MIGRATIONS_TABLE].sort());
  });

  it('refuse to remove a seeded league that is still referenced, changing nothing', () => {
    t = tempDb();
    t.db.sqlite.exec("INSERT INTO teams (id, league_id, name) VALUES ('t1', 'epl', 'Wolves')");
    expect(() => migrateDown(t?.db as NonNullable<TempDb['db']>)).toThrow(/FOREIGN KEY/);
    expect(migrationStatus(t.db).every((m) => m.applied)).toBe(true);
    expect(t.db.sqlite.prepare('SELECT count(*) AS n FROM leagues').get()).toEqual({ n: 6 });
  });
});
