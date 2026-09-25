/// <reference lib="dom" />
/**
 * `npm run verify:T04` — runs the T04 acceptance checks (SPEC.md §14) and prints PASS / FAIL per
 * item: `npm run build`, one Playwright run of `test/e2e/` (JSON reporter, mapped to the items), the
 * component/unit tests, and live checks against `npm run dev` on :8196 (curl-equivalent `fetch`,
 * a 25 s read of `/api/live`, and a headless-Chromium reconnect check across a dev-server restart).
 *
 * The dev server runs with `KST_E2E=1`, so a loopback request carrying `X-Ingress-Path` counts as
 * coming from the ingress proxy (the "ingress test peer"); requests without it are class `dev`.
 * It uses `./.local/verify-T04/` (removed first), never the developer's own `./.local` data.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  APP,
  assert,
  check,
  cleanEnv,
  finish,
  record,
  run,
  sleep,
  startDev,
  vitest,
  waitForHealth,
  type Dev,
} from './verify-lib.js';

const BASE = join(APP, '.local/verify-T04');
const PORT = 8196;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const INGRESS = '/api/hassio_ingress/abc';
const PASSWORD = 'verify-T04 long password';

// ---- 1. Build ------------------------------------------------------------------------------

const build = run('npm', ['run', 'build']);
await check(
  'npm run build emits dist/web/index.html; / → 200 text/html; hashed assets immutable (part 1: build)',
  () => {
    assert(build.code === 0, build.out.slice(-1500));
    assert(existsSync(join(APP, 'dist/web/index.html')), 'dist/web/index.html missing');
    const assets = readdirSync(join(APP, 'dist/web/assets'));
    return `dist/web/index.html + ${assets.join(', ')}`;
  },
);

// ---- 2. One Playwright run, mapped to the items ------------------------------------------------

interface PwTest {
  projectName: string;
  status: string;
}
interface PwSpec {
  title: string;
  tests: PwTest[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
const pw = run('npx', ['playwright', 'test', '--reporter=json'], { env: { ...process.env, CI: '' } });
const specs: PwSpec[] = [];
try {
  const report = JSON.parse(pw.stdout) as { suites: PwSuite[] };
  const walk = (s: PwSuite) => {
    specs.push(...(s.specs ?? []));
    (s.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
} catch {
  // reported per item below
}

/** Every matching spec passed in both projects (1280 px and 390 px). */
function e2e(titlePart: string): string {
  const matching = specs.filter((s) => s.title.includes(titlePart));
  assert(
    matching.length > 0,
    `no e2e spec matching "${titlePart}" (playwright exit ${pw.code}): ${pw.out.slice(-800)}`,
  );
  const runs = matching.flatMap((s) => s.tests.map((t) => ({ title: s.title, ...t })));
  const bad = runs.filter((t) => t.status !== 'expected');
  assert(bad.length === 0, bad.map((t) => `${t.projectName}: ${t.title} → ${t.status}`).join('; '));
  const projects = [...new Set(runs.map((t) => t.projectName))].sort().join(' + ');
  return `e2e "${titlePart}" passed (${projects})`;
}

// ---- 3. Live checks against npm run dev ---------------------------------------------------------

rmSync(BASE, { recursive: true, force: true });
const env = cleanEnv({
  PORT: String(PORT),
  DB_PATH: './.local/verify-T04/trader.db',
  DATA_DIR: './.local/verify-T04/data',
  KST_E2E: '1',
});
let dev: Dev = startDev(env);

async function http(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(URL_BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    redirect: 'manual',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

try {
  await waitForHealth(PORT, 20_000);

  await check(
    'npm run build emits dist/web/index.html; curl -I / → 200 text/html; hashed assets → 200 immutable',
    async () => {
      const head = await http('/', { method: 'HEAD' });
      assert(head.status === 200, `HEAD / ${head.status}`);
      const type = head.headers.get('content-type') ?? '';
      assert(type.startsWith('text/html'), `content-type ${type}`);
      const html = await (await http('/login')).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? '');
      assert(assets.length >= 2, `asset URLs in the shell: ${assets.join(', ')}`);
      for (const a of assets) {
        const res = await http(a);
        const cc = res.headers.get('cache-control');
        assert(
          res.status === 200 && cc === 'public, max-age=31536000, immutable',
          `${a}: ${res.status} ${cc}`,
        );
      }
      return `HEAD / → 200 ${type}; ${assets.join(', ')} → 200 public, max-age=31536000, immutable; ${vitest(['test/unit/web-shell.test.ts'])}`;
    },
  );

  await check(
    'e2e at 1280 px and 390 px: setup → login → Dashboard → every nav heading → logout; scrollWidth ≤ 390',
    () => e2e('setup → login → Dashboard'),
  );

  await check('Zero console messages matching "Content Security Policy" during the whole e2e run', () => {
    assert(pw.code === 0, `playwright exit ${pw.code}`);
    const runs = specs.flatMap((s) => s.tests);
    assert(
      runs.every((t) => t.status === 'expected'),
      'some e2e test failed',
    );
    return `${runs.length} e2e tests passed; each asserts zero CSP console messages (afterEach watcher in every context)`;
  });

  await check(
    'Filter bar: epl + live + 30d → ?leagues=epl&mode=live&range=30d; reload; back; default both',
    () => `${e2e('filter bar state lives in the URL')}; ${vitest(['test/unit/web/filters.test.ts'])}`,
  );

  // Setup (class dev) for the SSE and reconnect checks.
  const setup = await http('/setup', { method: 'POST', body: { username: 'pavel', password: PASSWORD } });
  assert(setup.status === 201, `setup ${setup.status}`);
  const cookie = setup.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  await check(
    '/api/live: heartbeat at least every 15 s; initial logs ≤ 50 entries each with a mode key',
    async () => {
      const res = await fetch(`${URL_BASE}/api/live`, { headers: { cookie } });
      assert(res.status === 200 && res.body, `GET /api/live ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const start = Date.now();
      const beats: number[] = [];
      let seen = 0;
      let pending = reader.read();
      while (Date.now() - start < 25_000) {
        // Keep one read in flight: a read abandoned by the race would lose its chunk.
        const chunk = await Promise.race([pending, sleep(1000).then(() => null)]);
        if (chunk) {
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          pending = reader.read();
        }
        const count = (text.match(/^event: heartbeat$/gm) ?? []).length;
        for (; seen < count; seen++) beats.push(Date.now() - start);
      }
      await reader.cancel();
      const logsBlock = /^event: logs\ndata: (.*)$/m.exec(text)?.[1];
      assert(logsBlock, 'no initial logs event');
      const logs = JSON.parse(logsBlock) as Record<string, unknown>[];
      assert(logs.length > 0 && logs.length <= 50, `${logs.length} log entries`);
      assert(
        logs.every((l) => 'mode' in l),
        'a log entry without mode',
      );
      assert(beats.length >= 2, `heartbeats at ${beats.join(', ')} ms`);
      const gaps = [beats[0] ?? 0, ...beats.slice(1).map((b, i) => b - (beats[i] ?? 0))];
      assert(Math.max(...gaps) <= 15_000, `heartbeat gaps ${gaps.join(', ')} ms`);
      return `initial logs: ${logs.length} entries, all with "mode"; heartbeats at ${beats.map((b) => (b / 1000).toFixed(1)).join(', ')} s; ${vitest(['test/unit/live.test.ts'])}`;
    },
  );

  await check(
    'Killing and restarting the dev server shows "reconnected" within 10 s without reload',
    async () => {
      const browser = await chromium.launch(
        existsSync('/opt/pw-browsers/chromium') && !existsSync(chromium.executablePath())
          ? { executablePath: '/opt/pw-browsers/chromium' }
          : {},
      );
      try {
        const page = await browser.newPage();
        await page.goto(`${URL_BASE}/login`);
        await page.getByLabel('Username').fill('pavel');
        await page.getByLabel('Password').fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page
          .getByTestId('live-status')
          .filter({ hasText: 'Live: connected' })
          .waitFor({ timeout: 10_000 });
        await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
        await dev.stop();
        await page
          .getByTestId('live-status')
          .filter({ hasText: 'reconnecting' })
          .waitFor({ timeout: 10_000 });
        dev = startDev(env);
        await waitForHealth(PORT, 20_000);
        const up = Date.now();
        await page
          .getByTestId('live-status')
          .filter({ hasText: 'Live: reconnected' })
          .waitFor({ timeout: 10_000 });
        const ms = Date.now() - up;
        const same = await page.evaluate(
          () => (window as unknown as { __noReload?: boolean }).__noReload === true,
        );
        assert(same, 'the page was reloaded');
        return `"Live: reconnected" ${(ms / 1000).toFixed(1)} s after the restarted server answered /healthz; same document (no reload)`;
      } finally {
        await browser.close();
      }
    },
  );

  await check(
    'Switches: kill switch on (no prompt, persists, audited); off / dry run off need step-up; allow_live_orders locked',
    () => `${e2e('switches: on needs no prompt')}; ${vitest(['test/security/switches.test.ts'])}`,
  );

  await check(
    'Account: wrong current password inline; change works, old fails; TOTP QR enrol; revoke second session',
    () => e2e('account: change password'),
  );

  await check(
    'Ingress: X-Ingress-Path from the ingress peer → <base href> and asset URLs start with the prefix; e2e without 404s',
    async () => {
      const res = await http('/login', { headers: { 'x-ingress-path': INGRESS } });
      const html = await res.text();
      assert(res.status === 200, `GET /login ${res.status}`);
      assert(html.includes(`<base href="${INGRESS}/">`), 'base href');
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1] ?? '')
        .filter((u) => !u.startsWith('data:'));
      assert(urls.length >= 3 && urls.every((u) => u.startsWith(`${INGRESS}/`)), urls.join(', '));
      return `live: ${urls.join(', ')}; ${e2e('ingress: prefixed <base href>')}`;
    },
  );

  await check(
    'Diagnostics: version, DB path, DB size in MB, live log lines; mode filter dry_run hides other lines',
    () => e2e('diagnostics: version, DB path'),
  );

  await check('ModeBadge renders the four variants (component test with snapshots)', () =>
    vitest(['test/unit/web/ModeBadge.test.tsx']),
  );
} finally {
  await dev.stop();
}

const errors = dev
  .stdout()
  .split('\n')
  .filter((l) => l.includes('"level":50') || l.includes('"level":60'));
record(
  '(extra) dev server logged no error lines',
  errors.length === 0 ? 'PASS' : 'FAIL',
  `${errors.length} error lines`,
);
record('Branch pushed; GitHub Actions run green', 'MANUAL', 'see docs/verification/T04.md for the run URL');
rmSync(BASE, { recursive: true, force: true });
finish();
