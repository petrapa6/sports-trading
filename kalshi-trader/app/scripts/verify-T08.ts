/**
 * `npm run verify:T08` — runs the T08 acceptance checks (SPEC.md §14) and prints PASS / FAIL per item: the
 * Vitest files behind each item (table tests, engine with fixtures-shaped states, API through `app.inject`,
 * replay into a listening app with an SSE reader), `npm run replay` against a fresh `npm run dev` with a
 * matching strategy (counting SSE `signal` events), and the Playwright spec `strategies.spec.ts`.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP,
  assert,
  check,
  cleanEnv,
  finish,
  record,
  run,
  startDev,
  vitest,
  waitForHealth,
} from './verify-lib.js';

const MODES = 'test/unit/core/modes.test.ts';
const ENGINE = 'test/unit/core/engine.test.ts';
const ROUTES = 'test/unit/strategies/routes.test.ts';
const PIPELINE = 'test/unit/strategies/pipeline.test.ts';

await check(
  'modes.ts table test over all 32 combinations of the five switches (global kill → paused; strategy kill → paused; add-on lock; global dry run; strategy; live)',
  () => vitest([MODES]),
);
await check(
  'Soccer {minLead:2, atMinute:80, windowMinutes:5, any}: 2-0@80 home; 79 none; first seen 84 signal; 86 none; 1-0 none; 0-2 away; leaderSide home + 0-2 none; halftime / regulationOver / blocked (debug line) none; 90+3 = 90 only with a window covering 90',
  () => vitest([ENGINE], 'soccer'),
);
await check(
  'Hockey {minLead:2, atMinute:50}: P3 10:00 3-1 → signal; 10:01 none; P2 none; intermission none; OT none',
  () => vitest([ENGINE], 'hockey'),
);
await check(
  'Once per game: a trades row for (strategy, game) → re-evaluation emits nothing; another strategy on the same game still signals',
  () => vitest([ENGINE], 'once per game'),
);
await check(
  'Paused strategies are not evaluated (spy): strategy kill switch on → zero evaluations; global kill switch on → the engine receives no states at all',
  () => {
    const a = vitest([ENGINE], 'paused strategies');
    const b = vitest([PIPELINE], 'global kill switch');
    return `${a}; scheduler + engine: ${b}`;
  },
);
await check(
  'Signal labelling: allowLiveOrders=false + strategy live → configuredMode live, effectiveMode dry_run, modeReason addon_lock; log line "mode":"dry_run"',
  () => vitest([ENGINE], 'signal labelling'),
);
await check(
  "Validation: percent 150 → 400 naming sizing.percent; soccer atMinute 95; minLead 0; minPrice ≥ maxPrice; leagueIds ['nba']; hockey + EPL → 400",
  () => vitest([ROUTES], 'validation'),
);
await check(
  'API: create → kill_switch=1, dry_run, current_version=1, one version; edit minLead → v2 with v1 unchanged; trades on v1 join to its rule; toggles create no version; delete hidden unless ?includeDeleted=1',
  () => vitest([ROUTES], 'strategy API'),
);
await check(
  'Step-up: kill switch off / mode → live without recent re-auth → 403 reauth_required; with it → 200 + audit row; kill switch on / mode → dry run need none',
  () => vitest([ROUTES], 'step-up'),
);
await check(
  'Replay (nhl-sample.jsonl) through the app with a matching strategy (kill switch off) → exactly one SSE signal with snapshot.homeScore, snapshot.clock.minute, marketTicker, effectiveMode',
  () => vitest([PIPELINE], 'replay'),
);

// ---- npm run replay against npm run dev, counting SSE signal events -------------------------------------

const PORT = 8398;
const BASE = join(APP, '.local/verify-T08');
const GAME = 'KXNHLGAME-26OCT14SEAVGK';
rmSync(BASE, { recursive: true, force: true });
const dev = startDev(
  cleanEnv({
    PORT: String(PORT),
    DB_PATH: './.local/verify-T08/trader.db',
    DATA_DIR: './.local/verify-T08/data',
  }),
);
try {
  await waitForHealth(PORT, 20_000);
  await check(
    'npm run replay -- --file test/fixtures/replay/nhl-sample.jsonl --speed 100 against npm run dev with a matching strategy (kill switch off) → exactly one SSE signal event for the game',
    async () => {
      const base = `http://127.0.0.1:${PORT}`;
      const jar = new Map<string, string>();
      const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const call = async (method: string, path: string, body?: unknown, csrf?: string) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            cookie: cookie(),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        for (const c of res.headers.getSetCookie()) {
          const [pair = ''] = c.split(';');
          const i = pair.indexOf('=');
          jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      };
      const setup = await call('POST', '/setup', { username: 'pavel', password: 'verify-T08 long password' });
      assert(setup.status === 201, `setup ${setup.status}`);
      const csrf = String((await call('GET', '/api/csrf')).json['token']);
      const created = await call(
        'POST',
        '/api/strategies',
        {
          name: 'NHL lead at 55',
          sport: 'hockey',
          leagueIds: ['nhl'],
          rule: { type: 'lead_at_time', minLead: 1, atMinute: 55, windowMinutes: 5 },
          sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
          execution: { maxPrice: 0.97 },
        },
        csrf,
      );
      assert(created.status === 201, `create ${created.status} ${JSON.stringify(created.json)}`);
      const id = String(created.json['id']);
      const off = await call('POST', `/api/strategies/${id}/kill-switch`, { killSwitch: false }, csrf);
      assert(off.status === 200, `kill switch off ${off.status}`);

      const stream = await fetch(`${base}/api/live`, { headers: { cookie: cookie() } });
      assert(stream.status === 200 && stream.body, `SSE ${stream.status}`);
      const signals: Record<string, unknown>[] = [];
      let finished = false;
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const reading = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!event || data === undefined) continue;
            if (event === 'signal') signals.push(JSON.parse(data) as Record<string, unknown>);
            if (event === 'games' && data.includes(`"id":"${GAME}"`) && data.includes('"phase":"finished"'))
              finished = true;
          }
        }
      })().catch(() => undefined);

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
          base,
        ],
        { cwd: APP, stdio: 'ignore' },
      );
      const code = await new Promise<number | null>((r) => replay.on('exit', r));
      assert(code === 0, `replay exited ${code}`);
      const start = Date.now();
      while (!finished && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 100));
      await reader.cancel().catch(() => undefined);
      await reading;
      assert(finished, 'no games frame with the finished game');
      const forGame = signals.filter((s) => s['gameId'] === GAME);
      assert(forGame.length === 1, `${forGame.length} signal events for the game`);
      const s = forGame[0] as {
        marketTicker: string;
        effectiveMode: string;
        modeReason: string;
        snapshot: { homeScore: number; awayScore: number; clock: { minute: number } };
      };
      assert(s.marketTicker === `${GAME}-VGK`, `marketTicker ${s.marketTicker}`);
      assert(s.snapshot.homeScore === 2 && s.snapshot.clock.minute === 55, JSON.stringify(s.snapshot));
      assert(s.effectiveMode === 'dry_run', `effectiveMode ${s.effectiveMode}`);
      return `1 signal: ${JSON.stringify({
        strategyId: id,
        marketTicker: s.marketTicker,
        effectiveMode: s.effectiveMode,
        modeReason: s.modeReason,
        homeScore: s.snapshot.homeScore,
        awayScore: s.snapshot.awayScore,
        minute: s.snapshot.clock.minute,
      })}`;
    },
  );
} finally {
  await dev.stop();
}
const signalLines = dev
  .stdout()
  .split('\n')
  .filter((l) => l.includes('"msg":"Signal:'));
record(
  '(extra) dev server logged the signal with its mode',
  signalLines.length === 1 && signalLines[0]?.includes('"mode":"dry_run"') ? 'PASS' : 'FAIL',
  signalLines[0]?.slice(0, 400) ?? 'no signal line',
);
const devErrors = dev
  .stdout()
  .split('\n')
  .filter((l) => l.includes('"level":50') || l.includes('"level":60'));
record(
  '(extra) dev server logged no error lines',
  devErrors.length === 0 ? 'PASS' : 'FAIL',
  `${devErrors.length} error lines`,
);

// ---- e2e ---------------------------------------------------------------------------------------------

await check(
  'e2e: create (invalid percent → inline error first), kill switch off (password prompt), edit → two versions; mode → live opens the re-auth prompt and the badge reads LIVE → DRY RUN (add-on lock)',
  () => {
    const build = run('npx', ['vite', 'build']);
    assert(build.code === 0, build.out.slice(-1500));
    const r = run('npx', ['playwright', 'test', 'test/e2e/strategies.spec.ts', '--reporter=line']);
    assert(r.code === 0, r.out.slice(-2500));
    const passed = /(\d+) passed/.exec(r.out);
    return `${passed?.[1] ?? '?'} e2e tests passed (1280 px + 390 px)`;
  },
);

rmSync(BASE, { recursive: true, force: true });
finish();
