/**
 * `npm run seed:season` (T14): fills the configured database (DB_PATH / config.local.json, like the app) with one
 * generated season — 2 000 games, 60 000 snapshots, 400 trades (`scripts/seed-season-lib.ts`) — then runs
 * `PRAGMA wal_checkpoint(TRUNCATE)` and prints the row counts and the size of `trader.db` and its `-wal`.
 * `--clear` removes the generated rows again. Never run it against a production database: every row is fake.
 * Options: `--games N` (default 2000), `--snapshots-per-game N` (30), `--trades N` (400), `--seed N`, `--clear`.
 */
import { existsSync, statSync } from 'node:fs';
import { openDatabase } from '../src/db/connection.js';
import { migrateUp } from '../src/db/migrate.js';
import { loadConfigOrExit } from '../src/server/boot.js';
import { clearSeason, seedSeason } from './seed-season-lib.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  const n = i === -1 ? fallback : Number.parseInt(args[i + 1] ?? '', 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000) {
    console.error(`[seed:season] --${name} must be an integer 0 … 10000000`);
    process.exit(1);
  }
  return n;
};
const games = num('games', 2000);
const snapshotsPerGame = num('snapshots-per-game', 30);
const trades = num('trades', 400);
const seed = num('seed', 7);

const { config } = loadConfigOrExit();
const db = openDatabase(config.dbPath);
const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
const mb = (b: number) => `${(b / 1_000_000).toFixed(1)} MB`;
try {
  migrateUp(db);
  if (args.includes('--clear')) {
    clearSeason(db.sqlite);
    console.log(`[seed:season] generated rows removed from ${db.path}`);
  } else {
    const started = Date.now();
    const r = seedSeason(db.sqlite, { games, snapshotsPerGame, trades, seed });
    console.log(
      `[seed:season] ${db.path}: ${JSON.stringify(r)} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  const before = size(`${db.path}-wal`);
  const checkpoint = db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const counts = Object.fromEntries(
    ['games', 'game_snapshots', 'markets', 'hist_games', 'trades', 'trade_attempts'].map((t) => [
      t,
      (db.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );
  console.log(`[seed:season] row counts: ${JSON.stringify(counts)}`);
  console.log(
    `[seed:season] after wal_checkpoint(TRUNCATE) ${JSON.stringify(checkpoint)}: trader.db ${mb(size(db.path))} (${size(db.path)} bytes), -wal ${mb(size(`${db.path}-wal`))} (was ${mb(before)})`,
  );
} finally {
  db.close();
}
