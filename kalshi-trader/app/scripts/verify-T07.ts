/// <reference lib="dom" />
/**
 * `npm run verify:T07` — runs the T07 acceptance checks (SPEC.md §14) and prints PASS / FAIL / MANUAL per
 * item: the Vitest files behind each item (fixtures, fake timers, msw), `npm run replay` against a fresh
 * `npm run dev` watched in headless Chromium (plus the Playwright spec `replay.spec.ts` against the
 * production build), `npm run feeds:smoke` (real NHL API; its output format also against the fixture
 * stand-in) and the Playwright spec `feeds.spec.ts`.
 *
 * `feeds:smoke` against the real NHL API needs outbound access to api-web.nhle.com; where the network
 * blocks it, that part is reported as MANUAL (CI runs it on every push).
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
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
} from './verify-lib.js';

const SOCCER = 'test/unit/feeds/soccerMinute.test.ts';
const KALSHI = 'test/unit/feeds/kalshiLive.test.ts';
const NHL = 'test/unit/feeds/nhl.test.ts';
const TRACKER = 'test/unit/core/tracker.test.ts';
const SCHEDULER = 'test/unit/core/scheduler.test.ts';
const ROUTES = 'test/unit/feeds/routes.test.ts';
const STRIP = 'test/unit/web/StatusStrip.test.tsx';

await check(
  "Soccer minute parser table: 78' → 78, 45+2' → 45, 90+4' → 90, HT, FT, 1st Half (no minute), Postponed; unseen → derived + one warn per game",
  () => vitest([SOCCER], 'parser'),
);
await check('Derived minute (fake timers): T+30 min 10 s → 30; S+20 min → 65; capped at 45 / 90', () =>
  vitest([SOCCER], 'derived soccer minute'),
);
await check(
  'Kalshi live fixture (NHL): round 2 "12:34" → live, period 2, 754 s, minute 27; round 1 "00:00" → intermission; finished → regulationOver',
  () => vitest([KALSHI], 'GameState'),
);
await check('NHL adapter: LIVE P3 "05:00" → 55; OFF/FINAL → finished; FUT → scheduled; CRIT → live', () =>
  vitest([NHL]),
);
await check('Batch: 8 live milestones → exactly one live-data request per tick (msw count)', () =>
  vitest([KALSHI], 'batch'),
);
await check(
  'Tracker replay of nhl-sample.jsonl: toMatchSnapshot; scheduled → live → intermission → live → finished; one snapshot per line; hist_games live + goals; timeline_archived=1',
  () => vitest([TRACKER], 'replay'),
);
await check(
  'Disagreement: 2-1 vs 1-1 for 25 s → blocked=1 + warn; agreement → blocked=0; stateUpdated carries blocked',
  () => vitest([TRACKER], 'disagreement'),
);
await check(
  'Scheduler (fake timers): idle 0 calls / 10 min; pre-game every 60 s; live every 5 s; finished → idle; kill switch 0 requests + /healthz 200 paused, resumes; stopped → 503 stale after 2 min',
  () => vitest([SCHEDULER], 'cadence|kill switch|stopped|wake|finished|no games|game in'),
);
await check(
  'A feed throwing on every call does not stop the other feed or the loop; the status strip shows it as error',
  () => {
    const a = vitest([SCHEDULER], 'throwing');
    const b = vitest([STRIP], 'failing feed');
    return `${a}; status strip: ${b}`;
  },
);
await check('(extra) Feeds API (toggle + audit, Test feed), /api/dev/replay access, SSE games frames', () =>
  vitest([ROUTES]),
);

// ---- replay against npm run dev, watched in Chromium ---------------------------------------------

const PORT = 8397;
const BASE = join(APP, '.local/verify-T07');
const GAME = 'KXNHLGAME-26OCT14SEAVGK';
const PASSWORD = 'verify-T07 long password';
rmSync(BASE, { recursive: true, force: true });
const dev = startDev(
  cleanEnv({
    PORT: String(PORT),
    DB_PATH: './.local/verify-T07/trader.db',
    DATA_DIR: './.local/verify-T07/data',
  }),
);
try {
  await waitForHealth(PORT, 20_000);
  await check(
    'npm run replay -- --file test/fixtures/replay/nhl-sample.jsonl --speed 100 against the dev server: card appears, score changes, "Final" within 30 s; SSE games[] with homeScore, awayScore, clock (incl. minuteSource)',
    async () => {
      const setup = await fetch(`http://127.0.0.1:${PORT}/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'pavel', password: PASSWORD }),
      });
      assert(setup.status === 201, `setup ${setup.status}`);
      const browser = await chromium.launch(
        existsSync('/opt/pw-browsers/chromium') && !existsSync(chromium.executablePath())
          ? { executablePath: '/opt/pw-browsers/chromium' }
          : {},
      );
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${PORT}/login`);
        await page.getByLabel('Username').fill('pavel');
        await page.getByLabel('Password').fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { level: 2, name: 'Live games' }).waitFor();
        await page.evaluate(() => {
          const w = window as unknown as { __frames: unknown[] };
          w.__frames = [];
          const es = new EventSource(new URL('api/live', document.baseURI));
          es.addEventListener('games', (e) => w.__frames.push(JSON.parse((e as MessageEvent<string>).data)));
        });
        const started = Date.now();
        const replay = spawn(
          'npm',
          [
            'run',
            'replay',
            '--',
            '--file',
            'test/fixtures/replay/nhl-sample.jsonl',
            '--speed',
            '100',
            '--url',
            `http://127.0.0.1:${PORT}`,
          ],
          { cwd: APP, stdio: 'ignore' },
        );
        const exited = new Promise<number | null>((r) => replay.on('exit', r));
        const card = page.getByTestId(`game-card-${GAME}`);
        await card.waitFor({ timeout: 30_000 });
        const appeared = Date.now() - started;
        await card.getByTestId('away-score').filter({ hasText: '1' }).waitFor({ timeout: 30_000 });
        await card.getByTestId('game-phase').filter({ hasText: 'Final' }).waitFor({ timeout: 30_000 });
        const final = Date.now() - started;
        assert(final < 30_000, `Final after ${final} ms`);
        assert((await exited) === 0, 'replay exited non-zero');
        const frames = (await page.evaluate(
          () => (window as unknown as { __frames: unknown[] }).__frames,
        )) as {
          games: {
            id: string;
            homeScore: number;
            awayScore: number;
            phase: string;
            clock: { minuteSource?: string };
          }[];
        }[];
        const states = frames.flatMap((f) => f.games.filter((g) => g.id === GAME));
        const withMinute = states.find((g) => g.clock.minuteSource === 'feed');
        assert(withMinute !== undefined, 'no SSE frame with clock.minuteSource');
        assert(states.at(-1)?.phase === 'finished', `last phase ${states.at(-1)?.phase}`);
        return `card after ${(appeared / 1000).toFixed(1)} s, "Final" after ${(final / 1000).toFixed(1)} s; ${states.length} SSE games[] frames for the game, e.g. ${JSON.stringify(withMinute)}`;
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await dev.stop();
}
const devErrors = dev
  .stdout()
  .split('\n')
  .filter((l) => l.includes('"level":50') || l.includes('"level":60'));
record(
  '(extra) dev server logged no error lines during the replay',
  devErrors.length === 0 ? 'PASS' : 'FAIL',
  `${devErrors.length} error lines`,
);

// ---- feeds:smoke ------------------------------------------------------------------------------------

const smoke = run('npm', ['run', '--silent', 'feeds:smoke']);
if (smoke.code === 0) {
  record(
    'npm run feeds:smoke prints today\'s NHL games from the real NHL API or "no games today"; exits 0',
    'PASS',
    smoke.stdout.trim().split('\n').join(' | '),
  );
} else if (/could not be reached|answered 403/.test(smoke.out)) {
  record(
    'npm run feeds:smoke against the real NHL API',
    'MANUAL',
    `api-web.nhle.com is not reachable from here (${smoke.out.trim().split('\n').at(-1) ?? ''}); CI runs it — see docs/verification/T07.md`,
  );
} else {
  record('npm run feeds:smoke against the real NHL API', 'FAIL', smoke.out.slice(-500));
}

const stand = spawn('npx', ['tsx', 'test/e2e/fake-kalshi.ts'], {
  cwd: APP,
  env: { ...process.env, E2E_KALSHI_PORT: '8396' },
  detached: true,
  stdio: 'ignore',
});
await sleep(2500);
await check(
  'feeds:smoke output format against the fixture stand-in (3 games: LIVE with score and clock, FUT, OFF); exit 0',
  () => {
    const r = run('npm', ['run', '--silent', 'feeds:smoke'], {
      env: { ...process.env, NHL_SCRIPT_BASE_URL: 'http://127.0.0.1:8396/nhl/v1' },
    });
    assert(r.code === 0, `exit ${r.code}: ${r.out}`);
    for (const needle of [
      '3 NHL game(s) today',
      'UTA @ VGK  LIVE 1-2 P3 05:00',
      'EDM @ SEA  FUT',
      'BOS @ TOR  OFF 3-4',
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

// ---- e2e ---------------------------------------------------------------------------------------------

await check(
  'e2e: Settings → Feeds toggles persist; "Test feed" shows one result line per adapter; replay spec on the production build',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', [
      'playwright',
      'test',
      'test/e2e/feeds.spec.ts',
      'test/e2e/replay.spec.ts',
      '--reporter=line',
    ]);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (desktop + mobile)`;
  },
);

rmSync(BASE, { recursive: true, force: true });
finish();
