/**
 * `npm run verify:T12` — runs the T12 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the Vitest
 * files behind each item (simulator, parity, backtests API / worker) and the Playwright spec `backtest.spec.ts`.
 */
import { assert, check, finish, run, vitest } from './verify-lib.js';

const SIM = 'test/unit/backtest/simulator.test.ts';
const PARITY = 'test/unit/backtest/parity.test.ts';
const ROUTES = 'test/unit/backtest/routes.test.ts';

await check('Determinism: the same backtest twice → byte-identical backtest_trades (excluding ids)', () =>
  vitest([ROUTES, SIM], 'determinism|same input twice'),
);
await check(
  'Parity: game-a.json through tracker → engine → executor (dry run) and the simulator (exact) → same minute, limit price, contracts, fee, P&L',
  () => vitest([PARITY], 'game-a'),
);
await check('Exact mode: candle / next_candle / skipped_no_price; ask close, not trade close', () =>
  vitest([SIM], 'candle at 80|ask close'),
);
await check(
  'Retry parity: ask above maxPrice at 80 and below at 82 → entry at 82 in simulator and live replay',
  () => vitest([PARITY, SIM], 'retry'),
);
await check('Modelled mode: price_source=model; priceMode=modelled with minSampleSize', () =>
  vitest([SIM], 'price_source=model|20 observations'),
);
await check('Compounding: second stake is 2 % of the post-first-trade bankroll', () =>
  vitest([SIM], 'bankroll \\$100'),
);
await check('Settlement: soccer 2-1 won; NHL OT win won; OT loss lost; NHL tie void at $0.50', () =>
  vitest([SIM], 'soccer 2-1|through the simulator'),
);
await check('Worker isolation: 5 000 games, /healthz < 100 ms, SSE progress increasing', () => {
  const r = run('npx', ['vitest', 'run', ROUTES, '-t', '5 000-game', '--silent=false']);
  assert(r.code === 0, r.out.slice(-1500));
  return /\[T12 isolation\] ([^\n]+)/.exec(r.out)?.[1] ?? 'passed';
});
await check('Performance: 1 300 games in < 5 s', () => {
  const r = run('npx', ['vitest', 'run', ROUTES, '-t', 'performance', '--silent=false']);
  assert(r.code === 0, r.out.slice(-1500));
  return /\[T12 perf\] ([^\n]+)/.exec(r.out)?.[1] ?? 'passed';
});
await check('Promote: strategy with mode dry_run, kill_switch 1, version 1 = backtest params', () =>
  vitest([ROUTES], 'promote'),
);
await check(
  'e2e: run from the form (tiles, equity/drawdown/monthly charts, trades table), save, second run with another atMinute, comparison with two equity lines, modelled badge only in modelled mode, no Live / Dry run legend',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/backtest.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    return `${/(\d+) passed/.exec(r.out)?.[1] ?? '?'} e2e tests passed (1280 px + 390 px)`;
  },
);

finish();
