/**
 * `npm run verify:T15` — runs the T15 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the Vitest
 * files behind each item (API-Football adapter, quota guard and key storage against an msw stand-in; the tracker
 * with two soccer feeds; Home Assistant notifications against an msw mock of the Supervisor proxy; the rule
 * parameters), `npm run check:addon` on the committed manifest and on two mutated copies, and the Playwright spec
 * behind Settings → Feeds / Notifications.
 *
 *   npm run verify:T15
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { APP, assert, check, finish, ROOT, run, vitest } from './verify-lib.js';

const AF = 'test/unit/feeds/apiFootball.test.ts';
const ROUTES = 'test/unit/feeds/t15Routes.test.ts';
const TRACKER = 'test/unit/core/trackerApiFootball.test.ts';
const NOTIFIER = 'test/unit/core/notifier.test.ts';
const RULES = 'test/unit/core/ruleExtras.test.ts';

await check(
  "Fixture 2H / elapsed 78 / 2-0 → {phase:'live', clock.minute:78, minuteSource:'feed', homeScore:2}; HT → halftime; FT → finished; PST → postponed",
  () => vitest([AF], 'API-Football mapping'),
);
await check(
  'Quota guard: counter at 100 → no call, warn, feed status quota; resets at local midnight (fake timers). Global kill switch → zero calls',
  () => vitest([AF], 'quota guard'),
);
await check('Stored key: DB value ≠ plaintext; decryptSetting returns it; it never appears in logs', () => {
  const unit = vitest([AF], 'API-Football key');
  const api = vitest([ROUTES], 'stores the key encrypted');
  return `adapter: ${unit}; Settings API: ${api}`;
});
await check(
  'Tracker with kalshi-live and api-football: soccer minute from API-Football when present; disagreeing scores > 20 s → blocked as in T07',
  () => vitest([TRACKER]),
);
await check(
  'Notifications: msw mock of http://supervisor/core/api/services/persistent_notification/create gets a Bearer POST with [DRY RUN], strategy name and P&L on a dry-run fill, [LIVE] on a live fill; toggles off → no request; no token → no request and one debug line',
  () => {
    const unit = vitest([NOTIFIER]);
    const api = vitest([ROUTES], 'Settings → Notifications');
    return `notifier: ${unit}; routes: ${api}`;
  },
);
await check(
  'npm run check:addon passes with homeassistant_api: true and fails if hassio_api is added',
  () => {
    const doc = parse(readFileSync(join(ROOT, 'kalshi-trader/config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert(doc['homeassistant_api'] === true, 'config.yaml has no homeassistant_api: true');
    assert(doc['hassio_api'] === undefined, 'config.yaml sets hassio_api');
    const ok = run('npm', ['run', '--silent', 'check:addon']);
    assert(ok.code === 0, ok.out);
    const dir = join(APP, '.local/verify-T15');
    mkdirSync(dir, { recursive: true });
    try {
      const mutated = join(dir, 'config.yaml');
      writeFileSync(mutated, stringify({ ...doc, hassio_api: true }));
      const bad = run('npm', ['run', '--silent', 'check:addon', '--', '--config', mutated]);
      assert(
        bad.code === 1 && /ERROR hassio_api: must not be set/.test(bad.out),
        `hassio_api: exit ${bad.code} ${bad.out}`,
      );
      const without = { ...doc };
      delete without['homeassistant_api'];
      writeFileSync(mutated, stringify(without));
      const missing = run('npm', ['run', '--silent', 'check:addon', '--', '--config', mutated]);
      assert(missing.code === 1 && /ERROR homeassistant_api/.test(missing.out), `missing: ${missing.out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return 'committed config.yaml: exit 0; + hassio_api: true → exit 1 (ERROR hassio_api); without homeassistant_api → exit 1';
  },
);
await check(
  "Rule tests: maxOpponentGoals 0 with 2-1 → no signal, 2-0 → signal; underdogOnly fires only when the leader's kick-off YES ask was below the opponent's",
  () => vitest([RULES]),
);
await check(
  'e2e: Settings → Feeds shows the masked API-Football key field and quota usage; Settings → Notifications toggles persist',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', [
      'playwright',
      'test',
      'test/e2e/t15-settings.spec.ts',
      'test/e2e/feeds.spec.ts',
      '--reporter=line',
    ]);
    assert(r.code === 0, r.out.slice(-2500));
    return `${/(\d+) passed/.exec(r.out)?.[1] ?? '?'} passed (1280 px and 390 px)`;
  },
);

finish();
