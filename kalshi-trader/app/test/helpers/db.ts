import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../src/db/connection.js';
import { migrateUp } from '../../src/db/migrate.js';

export const EXPECTED_TABLES = [
  'leagues',
  'teams',
  'games',
  'markets',
  'game_snapshots',
  'strategies',
  'strategy_versions',
  'trades',
  'trade_attempts',
  'balance_snapshots',
  'bankroll_snapshots',
  'audit_log',
  'users',
  'sessions',
  'login_attempts',
  'settings',
  'hist_games',
  'hist_prices',
  'backtests',
  'backtest_trades',
];

export interface TempDb {
  dir: string;
  path: string;
  db: Db;
  cleanup(): void;
}

/** A migrated database in a fresh temporary directory. */
export function tempDb(migrate = true): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'kst-db-'));
  const path = join(dir, 'db', 'trader.db');
  const db = openDatabase(path);
  if (migrate) migrateUp(db);
  return {
    dir,
    path,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tableNames(db: Db): string[] {
  return (
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

export function rowCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of EXPECTED_TABLES) {
    out[t] = (db.sqlite.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  }
  return out;
}
