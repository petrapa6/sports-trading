/**
 * `npm run verify:T13` — runs the T13 acceptance checks (SPEC.md §14) and prints PASS / FAIL / MANUAL per item:
 * the Vitest files behind each item (executor live path, recovery, reconciliation, balance snapshots and the
 * switch matrix against the msw Kalshi stand-in; the client allow-list; the step-up routes), `npm run e2e:demo`
 * (without a key, and against the fixture stand-in `test/e2e/fake-kalshi.ts`), `npm run replay -- --live-mock`,
 * and the Playwright specs behind the UI parts.
 *
 * `npm run e2e:demo` against the real demo exchange needs a Kalshi demo key in `config.local.json`; when one is
 * configured the script runs it, otherwise that part is reported as MANUAL.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { APP, assert, check, cleanEnv, finish, record, run, sleep, vitest } from './verify-lib.js';

const LIVE = 'test/unit/core/live.test.ts';
const ALLOW = 'test/unit/kalshi/allowlist.test.ts';
const STRATEGY_ROUTES = 'test/unit/strategies/routes.test.ts';
const GROUP_ROUTES = 'test/unit/live/orderGroupRoutes.test.ts';
const DEMO = 'test/unit/live/e2eDemo.test.ts';

await check(
  'Order body: ask 0.93, slippage 0.01, maxPrice 0.97, stake 2 000 000 → count "2", price "0.9400", IOC, taker_at_cross, <trade.id>-1, order group; subaccount 3 → "subaccount":3; pending attempt before the request',
  () => vitest([LIVE], 'order body'),
);
await check(
  'Outcomes: fill 2.00 @ 0.9300 fee 0.0046 → filled 200 cc, 9300, cost 1 860 000, fee 9 200, live; 1.00 → 100 cc; 0.00 → unfilled + waiting, retried; 400/409 → skipped/order_rejected with message; order group → waiting/order_group_limit',
  () => vitest([LIVE], 'order outcomes'),
);
await check('Live sizing: $100 with a $3 pending live attempt → sizing base 97 000 000', () =>
  vitest([LIVE], 'live sizing'),
);
await check(
  'Recovery: executed order by client_order_id → filled with its values; empty + empty historical → unfilled/restart_no_order; before the first scheduler tick; no client_order_id query parameter',
  () => vitest([LIVE], 'start-up recovery'),
);
await check('Reconciliation: revenue 20 000 micros off → reconcile_warning + one warn; equal → none', () =>
  vitest([LIVE], 'reconciliation'),
);
await check(
  'balance_snapshots: +15 min → one row; after a fill → a row within 1 s; global kill switch → no rows, no requests',
  () => vitest([LIVE], 'balance_snapshots'),
);
await check(
  'Switch matrix: add-on lock → no order requests, dry_run/addon_lock; global dry run → dry_run/global_dry_run; strategy kill switch mid-window → skipped/paused; global kill switch → zero requests; maxStakeUsd 1 → count "1"',
  () => `${vitest([LIVE], 'switch matrix')}; ${vitest([LIVE], 'maxStakeUsd 1')}`,
);
await check(
  'Step-up: strategy → live without re-auth → 403, with it → 200 + audit row (API); order-group reset likewise; the e2e confirms the prompt',
  () => {
    const api = `${vitest([STRATEGY_ROUTES], 'step-up')}; ${vitest([GROUP_ROUTES])}`;
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', [
      'playwright',
      'test',
      'test/e2e/strategies.spec.ts',
      'test/e2e/live.spec.ts',
      'test/e2e/shell.spec.ts',
      '--reporter=line',
    ]);
    assert(r.code === 0, r.out.slice(-2500));
    return `${api}; e2e ${/(\d+) passed/.exec(r.out)?.[1] ?? '?'} passed`;
  },
);
await check(
  'Client allow-list test passes (and fails when withdraw / deposit / transfer is added: mutation recorded in T13.md)',
  () => vitest([ALLOW]),
);

await check('e2e:demo without a key prints "SKIPPED (no demo key)" and exits 0', () => {
  const r = run('npm', ['run', '--silent', 'e2e:demo'], { env: cleanEnv({}) });
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
  assert(r.stdout.trim() === 'SKIPPED (no demo key)', r.stdout);
  return r.stdout.trim();
});

const scratch = join(APP, '.local/verify-T13');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
writeFileSync(join(scratch, 'key.pem'), pem, { mode: 0o600 });
writeFileSync(
  join(scratch, 'config.local.json'),
  JSON.stringify({
    kalshiKeyId: 'verify-key',
    kalshiPrivateKeyPath: join(scratch, 'key.pem'),
    dbPath: join(scratch, 'trader.db'),
  }),
);
const stand = spawn('npx', ['tsx', 'test/e2e/fake-kalshi.ts'], {
  cwd: APP,
  env: { ...process.env, E2E_KALSHI_PORT: '8296' },
  detached: true,
  stdio: 'ignore',
});
await sleep(2500);
await check(
  'e2e:demo against the fixture stand-in: order id, fill_count, fee comparison at both precisions, trade row id (plus the unit test)',
  () => {
    const r = run('npm', ['run', '--silent', 'e2e:demo'], {
      env: cleanEnv({
        CONFIG_LOCAL_PATH: join(scratch, 'config.local.json'),
        KALSHI_SCRIPT_BASE_URL: 'http://127.0.0.1:8296/trade-api/v2',
      }),
    });
    assert(r.code === 0, `exit ${r.code}: ${r.out}`);
    for (const needle of [
      'order id: ord-7f3a',
      'fill_count: 2.00',
      'matches fee_balance_precision_micros=100',
      'trade row id: ',
    ])
      assert(r.stdout.includes(needle), `missing "${needle}" in ${r.stdout}`);
    return `${r.stdout.trim().split('\n').join(' | ')}; ${vitest([DEMO])}`;
  },
);
try {
  process.kill(-(stand.pid ?? 0), 'SIGTERM');
} catch {
  // already gone
}

function hasDemoKey(): boolean {
  try {
    const { config } = loadConfig();
    return (
      config.kalshiEnv === 'demo' &&
      config.kalshiKeyId !== undefined &&
      config.kalshiPrivateKeyPath !== undefined
    );
  } catch {
    return false;
  }
}
if (hasDemoKey()) {
  await check(
    'e2e:demo with a demo key: a real IOC order for 1 contract, read back, fee comparison, trade row',
    () => {
      const r = run('npm', ['run', '--silent', 'e2e:demo']);
      assert(r.code === 0, `exit ${r.code}: ${r.out}`);
      return r.stdout.trim().split('\n').join(' | ');
    },
  );
} else {
  record(
    'e2e:demo with a demo key (real order, fee precision, Trades page LIVE / demo)',
    'MANUAL',
    'no demo key in config.local.json; run `npm run e2e:demo` with one and record the output in T13.md',
  );
}

await check(
  'replay --live-mock: one live trade that fills and settles; balance_snapshots grows; /api/stats shows it only under live',
  () => {
    const r = run('npm', ['run', '--silent', 'replay', '--', '--live-mock'], { env: cleanEnv({}) });
    assert(r.code === 0, `exit ${r.code}: ${r.out}`);
    assert(r.stdout.includes('live mock replay: OK'), r.stdout);
    return r.stdout.trim().split('\n').slice(-3).join(' | ');
  },
);

finish();
