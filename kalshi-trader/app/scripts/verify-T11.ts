/**
 * `npm run verify:T11` — runs the T11 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the
 * Vitest files behind each item (NHL importer, Kalshi backfill / play-by-play / candles, CSV, price model,
 * jobs), the `npm run import:nhl` network smoke against a scratch database, and the Playwright spec
 * `data.spec.ts` (Settings → Data).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { assert, check, cleanEnv, finish, run, vitest } from './verify-lib.js';

const NHL = 'test/unit/backtest/nhlImporter.test.ts';
const KALSHI = 'test/unit/backtest/kalshi.test.ts';
const ROUTES = 'test/unit/backtest/dataRoutes.test.ts';
const MODEL = 'test/unit/backtest/priceModel.test.ts';

await check(
  'NHL importer (msw: 3 games incl. one preseason) → 2 rows by default, 3 with preseason; goal events with period / minute / second / side; shootout game stores the official final, no shootout attempts; a second run inserts 0 and logs "skipped N existing"',
  () => vitest([NHL]),
);
await check(
  'Network smoke: npm run import:nhl -- --season 20252026 --limit 5 inserts 5 games with goal events (or exits 0 with a clear network error)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'kst-verify-t11-'));
    try {
      const dbPath = join(dir, 'trader.db');
      const r = run('npm', ['run', '-s', 'import:nhl', '--', '--season', '20252026', '--limit', '5'], {
        env: cleanEnv({ DB_PATH: dbPath, DATA_DIR: dir }),
      });
      assert(r.code === 0, `exit ${r.code}: ${r.out.slice(-800)}`);
      const line = r.out.trim().split('\n').pop() ?? '';
      if (/network error/.test(r.out)) return `exit 0 with a network error: ${line}`;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare("SELECT goal_events FROM hist_games WHERE source = 'nhl'").all() as {
          goal_events: string;
        }[];
        assert(rows.length === 5, `expected 5 rows, got ${rows.length}: ${line}`);
        assert(
          rows.every((x) => (JSON.parse(x.goal_events) as unknown[]).length > 0),
          'a game without goal events',
        );
      } finally {
        db.close();
      }
      return line;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
await check(
  'Backfill discovery (msw) over a date range with 2 settled EPL events → 2 historical games with milestones and 3 markets each, not tracked by the scheduler',
  () => vitest([KALSHI], 'Kalshi backfill discovery'),
);
await check(
  'Play-by-play importer on game_stats fixtures (soccer and hockey, shaped like production payloads) → the expected goal timelines; hist_games source kalshi_pbp',
  () => vitest([KALSHI], 'play-by-play'),
);
await check(
  'CSV: 3 valid rows → 3 rows (home:23;away:67;home:90+2 → 23, 67, 90); home_goals_final mismatch → 400 naming the row; 21 MB → 413; without re-auth → 403',
  () => vitest([ROUTES], 'CSV import'),
);
await check(
  'Candles: after the cutoff /series/…/candlesticks, before /historical/markets/…/candlesticks (URLs); ask_close_bp and bid_close_bp; no trade → trade_close_bp NULL; rerun changes nothing',
  () => vitest([KALSHI], 'candle collector'),
);
await check(
  'Price model: 60 observations → hand-computed median and sampleSize 60; a 5-observation cell → seed value, sampleSize 5, seeded; empty DB → full seed table; reads hist_games, not game_snapshots',
  () => vitest([MODEL]),
);
await check(
  'Jobs: DELETE /api/jobs/:id stops the NHL import within one request and keeps inserted rows; kill switch on → paused with zero requests, resumes when off',
  () => vitest([ROUTES], 'jobs'),
);
await check(
  'e2e: Settings → Data: the sample CSV shows "3 rows imported"; "Rebuild price model" shows per-sport sample sizes; DB size updates after vacuum',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/data.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (1280 px + 390 px)`;
  },
);

finish();
