/**
 * `npm run verify:T09` — runs the T09 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the
 * Vitest files behind each item (pure pricing and guards; executor and settler against the msw Kalshi stand-in
 * with fake timers; the replay through a real app into a trade, its settlement and the Trades API) and the
 * Playwright spec `trades.spec.ts` (Trades page, CSV export, bankroll reset with re-auth).
 */
import { assert, check, finish, run, vitest } from './verify-lib.js';

const PRICING = 'test/unit/pricing.test.ts';
const GUARDS = 'test/unit/core/guards.test.ts';
const EXECUTOR = 'test/unit/core/executor.test.ts';
const SETTLER = 'test/unit/core/settler.test.ts';
const PIPELINE = 'test/unit/trades/pipeline.test.ts';

await check(
  'Pricing: feeMicros (5200, 7900, 1750000, 515200, multiplier 0 → 0, precision 10000 → 10000); limitPriceBp (9400, 9700, $0.005 grid → 9350); contractsFor (2, 0); realized 112100 / −1887900; unrealized 40000',
  () => vitest([PRICING]),
);
await check(
  'Order of operations (msw spy): the trade_attempts insert precedes the market/orderbook requests; an orderbook that throws → attempt error, trade waiting, error logged, nothing thrown',
  () => vitest([EXECUTOR], 'order of operations'),
);
await check(
  'Guards with no bankroll change: market_closed (hard), exchange_paused, stale_feed (20 s vs 15), feed_blocked, price (0.98 vs 0.97), min_price (0.40 vs 0.80), liquidity (5 vs 20), too_small ($1 at 2 %)',
  () => `${vitest([EXECUTOR], 'guards')}; guard table: ${vitest([GUARDS])}`,
);
await check(
  'Retry: 0.98 → waiting (1 attempt), 0.96 → filled at 0.97 (2 attempts, two rows); window ends above maxPrice → skipped/price/window_expired; lead drops to 1 → no attempt',
  () => vitest([EXECUTOR], 'retry'),
);
await check(
  'Happy path: $100, 2 %, ask 0.93 (50 ≤ 0.94) → stake 2000000, limit 9400, 200 cc, cost 1880000, fee 7900, bankroll 98112100, dry_run; maxStakeUsd 1 → 1 contract; 1 offered → 1 contract',
  () => vitest([EXECUTOR], 'happy path'),
);
await check(
  'Settler (fake timers, msw): 1.0 won / 0.0 lost / 0.5 void with payout, P&L, bankroll and one bankroll_snapshots row; open market untouched and re-checked next minute; past the cutoff → /historical/markets',
  () => vitest([SETTLER], 'settler'),
);
await check('Two strategies on one game fill in the same tick: both debits land sequentially', () =>
  vitest([EXECUTOR], 'two strategies'),
);
await check(
  'Restart: pending dry-run attempt 10 min old, window closed → unfilled/restart + trade skipped; window open → trade waiting',
  () => vitest([EXECUTOR], 'restart'),
);
await check(
  'Global kill switch on with filled + waiting trades → zero HTTP from executor and settler, states unchanged; off → settlement catches up',
  () => vitest([SETTLER], 'global kill switch'),
);
await check(
  'End-to-end replay with one dry-run strategy → one trade, signalled → pending → filled → settled_* in audit order (mode dry_run), bankroll updated; Trades API shows snapshot and attempts',
  () => vitest([PIPELINE], 'end-to-end'),
);
await check(
  'Configured live + allow_live_orders=false → dry-run fill labelled LIVE → DRY RUN (add-on lock); allow_live_orders=true, global dry run off, live → hard_skip/live_not_implemented',
  () => vitest([EXECUTOR], 'modes'),
);
await check('(extra) Trades API filters, bankroll reset step-up and fee precision setting', () =>
  vitest([PIPELINE], 'trades API|Settings'),
);
await check(
  'e2e: Trades page row with DRY RUN / LIVE → DRY RUN (add-on lock) badges, snapshot and attempts; CSV header with the mode columns, one line per visible trade; bankroll reset needs re-auth, restores the initial value, audit + reset snapshot',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/trades.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (1280 px + 390 px)`;
  },
);

finish();
