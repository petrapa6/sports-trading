/**
 * `npm run verify:T06` — runs the T06 acceptance checks (SPEC.md §14) and prints PASS / FAIL / MANUAL per
 * item: the Vitest files behind each item (msw against the fixtures in `test/fixtures/kalshi/`), the
 * `kalshi:smoke` script (without a key, and against the fixture stand-in `test/e2e/fake-kalshi.ts`), and
 * the Playwright spec `test/e2e/leagues.spec.ts` (after `vite build`).
 *
 * The smoke item "with a demo key" needs a real Kalshi demo key in `config.local.json`; when one is
 * configured the script runs it against demo, otherwise that part is reported as MANUAL.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { APP, assert, check, cleanEnv, finish, record, run, sleep, vitest } from './verify-lib.js';

const CLIENT = 'test/unit/kalshi/client.test.ts';
const LIMITER = 'test/unit/kalshi/rateLimiter.test.ts';
const DISCOVERY = 'test/unit/kalshi/discovery.test.ts';
const ROUTES = 'test/unit/kalshi/routes.test.ts';

await check(
  'Signing: fixed timestamp/GET/path signs "1700000000000GET/trade-api/v2/portfolio/balance", verifies; query excluded',
  () => vitest([CLIENT], 'signing'),
);
await check(
  'Every method has an msw test returning typed integers; NO bid 0.0700×50.00 → ask {9300, 5000}; unknown field passes; missing ticker → ZodError',
  () => vitest([CLIENT], 'every method'),
);
await check(
  'Candlesticks URL /series/KXNHLGAME/markets/<ticker>/candlesticks?…&period_interval=1; ask_close_bp, bid_close_bp, nullable trade_close_bp',
  () => vitest([CLIENT], 'getCandlesticks'),
);
await check(
  'Network gate: global_kill_switch=true → every method rejects NetworkPaused, msw records zero requests',
  () => vitest([CLIENT, ROUTES], 'kill switch|network gate'),
);
await check(
  'Rate limiter (fake timers): 600 tokens after 3 s; 40 + 40 → 60 at once then 20/s; 429,429,200 after 0.5 s + 1 s; six 503 → KalshiUnavailable after 5',
  () => vitest([LIMITER]),
);
await check('Logs from the whole client run never contain the key id or any /portfolio/* response body', () =>
  vitest([CLIENT]),
);
await check(
  'Discovery: 2 games (preseason skipped, info), 2 + 3 markets with price_ranges; second run only updated_at; include_preseason adds it',
  () => vitest([DISCOVERY], 'discovery against fixtures'),
);
await check(
  'Team mapping: -CFC via custom_strike to the matching team; TIE → tie; unknown target → unknown + one warn, continues',
  () => vitest([DISCOVERY], 'team mapping'),
);
await check(
  'createOrderV2 body to POST /portfolio/events/orders; fill "2.00" → 200 cc, "0.9300" → 9300, fee "0.0046"×2 → 9200 = feeMicros',
  () => vitest([CLIENT, 'test/unit/pricing.test.ts'], 'createOrderV2|fees'),
);
await check('getOrders sends ticker and min_ts (never client_order_id) and paginates', () =>
  vitest([CLIENT], 'getOrders'),
);
await check('(extra) Leagues / discovery / connection-test API and the daily 05:00 schedule', () =>
  vitest([ROUTES, DISCOVERY], 'Kalshi actions|Leagues API|schedule'),
);

// ---- kalshi:smoke ----------------------------------------------------------------------------

await check('kalshi:smoke without a key prints "SKIPPED (no demo key)" and exits 0', () => {
  const r = run('npm', ['run', 'kalshi:smoke'], { env: cleanEnv({}) });
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
  assert(r.stdout.trim() === 'SKIPPED (no demo key)', r.stdout);
  return r.stdout.trim();
});

const scratch = join(APP, '.local/verify-T06');
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
  env: { ...process.env, E2E_KALSHI_PORT: '8295' },
  detached: true,
  stdio: 'ignore',
});
await sleep(2500);
await check(
  'kalshi:smoke output format against the fixture stand-in: environment, balance, exchange status, events per enabled series',
  () => {
    const r = run('npm', ['run', 'kalshi:smoke'], {
      env: cleanEnv({
        CONFIG_LOCAL_PATH: join(scratch, 'config.local.json'),
        KALSHI_SCRIPT_BASE_URL: 'http://127.0.0.1:8295/trade-api/v2',
      }),
    });
    assert(r.code === 0, `exit ${r.code}: ${r.out}`);
    for (const needle of [
      'environment: demo',
      'balance: $123.450000',
      'exchange: exchange_active=true trading_active=true',
      'nhl',
      'KXNHLGAME',
    ])
      assert(r.stdout.includes(needle), `missing "${needle}" in ${r.stdout}`);
    return r.stdout.trim().split('\n').join(' | ');
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
const demoConfigured = hasDemoKey();
if (demoConfigured) {
  await check(
    'kalshi:smoke with a demo key: environment, balance, exchange status, open events per enabled series',
    () => {
      const r = run('npm', ['run', 'kalshi:smoke']);
      assert(r.code === 0, `exit ${r.code}: ${r.out}`);
      return r.stdout.trim().split('\n').join(' | ');
    },
  );
} else {
  record(
    'kalshi:smoke with a demo key',
    'MANUAL',
    'no demo key in config.local.json — see docs/verification/T06.md',
  );
}

// ---- e2e ---------------------------------------------------------------------------------------

await check(
  'e2e: Settings → Leagues six leagues + series; Discover series (mocked); include-preseason persists; Test Kalshi connection shows demo + balance',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/leagues.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (desktop + mobile)`;
  },
);

rmSync(scratch, { recursive: true, force: true });
finish();
