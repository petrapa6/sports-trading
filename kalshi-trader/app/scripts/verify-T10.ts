/**
 * `npm run verify:T10` — runs the T10 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the Vitest
 * files behind each item (`GET /api/stats` on `stats-seed.sql`, edge cases, the 500- and 10 000-trade checks) and
 * the Playwright spec `dashboard.spec.ts` (Dashboard tiles and charts, Trades page charts).
 */
import { assert, check, finish, run, vitest } from './verify-lib.js';

const STATS = 'test/unit/stats/stats.test.ts';
const PERF = 'test/unit/stats/perf.test.ts';

await check(
  'stats-seed.sql → GET /api/stats equals stats-seed.expected.json (unfiltered, strategies=A, leagues=epl, mode=dry_run, mode=live, range=7d); win rate excludes void / skipped / waiting; ROI over Σ (cost + fee); max drawdown per mode',
  () => vitest([STATS], 'expected.json|omits the mode|win rate excludes'),
);
await check(
  'Mode separation: one live trade changed → only live values change; nothing is a sum over both modes',
  () => vitest([STATS], 'mode separation'),
);
await check('Equity ordered by settled_at; one bankroll / balance point per snapshot row in range', () =>
  vitest([STATS], 'equity points'),
);
await check('Implied vs actual: one point per (strategy, league) within each mode with x, y, n', () =>
  vitest([STATS], 'implied vs actual'),
);
await check('Empty DB → 200 with zeroed tiles and empty arrays; unknown league → 400', () =>
  vitest([STATS], 'empty database|unknown league'),
);
await check('500 seeded trades → response < 200 KB, no per-trade rows', () => vitest([STATS], '500 seeded'));
await check('10 000 trades → /api/stats median < 300 ms over 20 calls', () => {
  const r = run('npx', ['vitest', 'run', PERF, '--silent=false']);
  assert(r.code === 0, r.out.slice(-1500));
  return /\[T10 perf\] ([^\n]+)/.exec(r.out)?.[1] ?? 'passed';
});
await check(
  'e2e: eight charts with Live + Dry run legends and two values per tile (mode = both); no "Dry run" with mode = live; empty states; no overflow at 390 px; dark palette; Trades page histogram / per-trade bars follow the filter, hover shows trade id and mode',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/dashboard.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (1280 px + 390 px)`;
  },
);

finish();
