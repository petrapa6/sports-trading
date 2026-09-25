/**
 * `npm run verify:T02` — runs the T02 acceptance checks (SPEC.md §14) and prints
 * PASS / FAIL / MANUAL per item. Manual steps are documented in docs/verification/T02.md.
 *
 * The dev-server checks use `./.local/verify-T02/data/db/trader.db` (removed first), so a
 * developer's own `./.local` database is never touched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  APP,
  assert,
  check,
  cleanEnv,
  finish,
  jsonLines,
  record,
  run,
  sleep,
  startDev,
  vitest,
  waitForHealth,
} from './verify-lib.js';

const BASE = join(APP, '.local/verify-T02');
const DB_REL = './.local/verify-T02/data/db/trader.db';
const DB = join(APP, DB_REL);
const PORT = 8196;

const EXPECTED_TABLES =
  'leagues teams games markets game_snapshots strategies strategy_versions trades trade_attempts balance_snapshots bankroll_snapshots audit_log users sessions login_attempts settings hist_games hist_prices backtests backtest_trades'.split(
    ' ',
  );

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function counts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables(db))
    out[t] = (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  return out;
}

// 1. Fresh .local: directory, file and WAL created; journal_mode wal; foreign_keys=1 in the app connection.
let firstRunFiles = { dir: false, db: false, wal: false };
await check(
  'rm -rf .local && DB_PATH=…/data/db/trader.db npm run dev creates dir, trader.db, trader.db-wal; journal_mode wal; foreign_keys 1',
  async () => {
    rmSync(BASE, { recursive: true, force: true });
    const dev = startDev(cleanEnv({ PORT: String(PORT), DB_PATH: DB_REL }));
    try {
      const { status, body } = await waitForHealth(PORT, 10_000);
      assert(status === 200 && body === '{"ok":true}', `/healthz answered ${status} ${body}`);
      firstRunFiles = { dir: existsSync(join(DB, '..')), db: existsSync(DB), wal: existsSync(`${DB}-wal`) };
    } finally {
      await dev.stop();
    }
    assert(
      firstRunFiles.dir && firstRunFiles.db && firstRunFiles.wal,
      `files: ${JSON.stringify(firstRunFiles)}`,
    );
    const mode = withDb((db) => db.pragma('journal_mode', { simple: true }));
    assert(mode === 'wal', `journal_mode is ${String(mode)}`);
    const fk = vitest(['test/unit/db/connection.test.ts']);
    return `dir + trader.db + trader.db-wal present while running; journal_mode=wal; connection tests: ${fk}`;
  },
);

// 2. Exactly the §7 tables plus Drizzle's migration table.
await check('.tables lists exactly the §7 tables plus the Drizzle migration table', () => {
  const found = withDb(tables).sort();
  const expected = [...EXPECTED_TABLES, '__drizzle_migrations'].sort();
  assert(JSON.stringify(found) === JSON.stringify(expected), `tables: ${found.join(' ')}`);
  return `${found.length} tables: ${found.join(' ')}`;
});

// 3. Restart: no migration applied, no error logged; six seeded leagues.
await check(
  'Restart applies no migration and logs no error; 6 leagues, kalshi_series set, enabled=1',
  async () => {
    const dev = startDev(cleanEnv({ PORT: String(PORT), DB_PATH: DB_REL }));
    try {
      const { status } = await waitForHealth(PORT, 10_000);
      assert(status === 200, `/healthz answered ${status}`);
      await sleep(300);
    } finally {
      await dev.stop();
    }
    const lines = jsonLines(dev.stdout());
    const errors = lines.filter((l) => Number(l['level']) >= 50);
    assert(errors.length === 0, `error lines: ${JSON.stringify(errors)}`);
    const ready = lines.find((l) => Array.isArray(l['applied']));
    assert(ready, 'no "Database ready" line');
    assert(
      (ready['applied'] as unknown[]).length === 0,
      `applied on restart: ${JSON.stringify(ready['applied'])}`,
    );
    const leagues = withDb(
      (db) => db.prepare('SELECT id, kalshi_series, enabled FROM leagues').all() as Record<string, unknown>[],
    );
    assert(leagues.length === 6, `${leagues.length} leagues`);
    assert(
      leagues.every(
        (l) => typeof l['kalshi_series'] === 'string' && l['kalshi_series'] !== '' && l['enabled'] === 1,
      ),
      JSON.stringify(leagues),
    );
    return `applied=[], 0 error lines, leagues: ${leagues.map((l) => `${String(l['id'])}=${String(l['kalshi_series'])}`).join(', ')}`;
  },
);

// 4. Repository tests.
await check(
  'Repository tests: UNIQUE errors, settings defaults and JSON round trip, CRUD for every repository',
  () => vitest(['test/unit/db/repositories.test.ts']),
);

// 5. Validation.
await check('stake_micros: 12.5 or fill_cc: "200" fails validation', () =>
  vitest(['test/unit/db/repositories.test.ts'], 'validation'),
);

// 6. Maintenance with fake timers.
await check(
  'Maintenance (fake timers): 160 snapshots → 60 after the 02:30 tick; wal_checkpoint once per day',
  () => vitest(['test/unit/maintenance.test.ts']),
);

// 7. Down then up on the seeded DB.
await check('db:migrate:down then db:migrate on a seeded DB succeeds with unchanged row counts', () => {
  const env = cleanEnv({ DB_PATH: DB_REL });
  const before = withDb(counts);
  const down = run('npm', ['run', 'db:migrate:down'], { env });
  assert(down.code === 0, `db:migrate:down exited ${down.code}: ${down.out.slice(-800)}`);
  const middle = withDb((db) => (db.prepare('SELECT count(*) AS n FROM leagues').get() as { n: number }).n);
  const up = run('npm', ['run', 'db:migrate'], { env });
  assert(up.code === 0, `db:migrate exited ${up.code}: ${up.out.slice(-800)}`);
  const after = withDb(counts);
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
  );
  const rolledBack = jsonLines(down.stdout).find((l) => Array.isArray(l['rolledBack']))?.['rolledBack'];
  return `rolled back ${JSON.stringify(rolledBack)} (leagues ${before['leagues']} → ${middle}), re-applied; counts unchanged`;
});

// 8. /healthz 503 with an unwritable DB directory.
await check(
  '/healthz returns 503 {"ok":false,"db":"…"} when DB_PATH points to an unwritable directory',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kst-ro-'));
    const isRoot = process.getuid?.() === 0;
    let dbPath: string;
    let how: string;
    if (!isRoot) {
      mkdirSync(join(dir, 'ro'));
      chmodSync(join(dir, 'ro'), 0o555);
      dbPath = join(dir, 'ro', 'db', 'trader.db');
      how = 'chmod 555 directory';
    } else {
      // Root ignores directory permissions; a regular file in place of the directory is unwritable for anyone.
      writeFileSync(join(dir, 'ro'), '');
      dbPath = join(dir, 'ro', 'db', 'trader.db');
      how = 'running as root: a regular file in place of the directory';
    }
    try {
      const dev = startDev(cleanEnv({ PORT: String(PORT), DB_PATH: dbPath }));
      let res: { status: number; body: string };
      try {
        res = await waitForHealth(PORT, 10_000);
      } finally {
        await dev.stop();
      }
      assert(res.status === 503, `status ${res.status}`);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      assert(body['ok'] === false && typeof body['db'] === 'string' && body['db'] !== '', `body ${res.body}`);
      return `${how}: 503 ${res.body}`;
    } finally {
      if (existsSync(join(dir, 'ro'))) chmodSync(join(dir, 'ro'), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Extra: the committed migrations match src/db/schema.ts.
await check('(extra) drizzle-kit generate finds no schema changes (migrations match schema.ts)', () => {
  const r = run('npx', ['drizzle-kit', 'generate']);
  assert(r.code === 0 && /No schema changes/.test(r.out), r.out.slice(-800));
  return 'no schema changes';
});

record('Branch pushed; GitHub Actions run green', 'MANUAL', 'see docs/verification/T02.md for the run URL');
rmSync(BASE, { recursive: true, force: true });
finish();
