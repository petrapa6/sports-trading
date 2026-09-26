import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReplayFile } from '../../../src/core/replay.js';
import { Scheduler } from '../../../src/core/scheduler.js';
import { GameTracker } from '../../../src/core/tracker.js';
import type { ScoreFeed } from '../../../src/feeds/gameState.js';
import { isFeedEnabled, type LiveServices } from '../../../src/server/routes/feeds.js';
import {
  Client,
  createTestApp,
  ingress,
  PASSWORD,
  setupUser,
  USER,
  type TestApp,
} from '../../helpers/app.js';
import { captureLogger, must } from '../../helpers/kalshiMsw.js';
import { sseReader } from '../../helpers/sse.js';

const SAMPLE = resolve(import.meta.dirname, '../../fixtures/replay/nhl-sample.jsonl');
const DEV = { remoteAddress: '127.0.0.1', headers: {} };

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function okFeed(id: 'kalshi-live' | 'nhl-official', message: string | Error): ScoreFeed {
  return {
    id,
    sports: id === 'kalshi-live' ? ['soccer', 'hockey'] : ['hockey'],
    poll: async () => [],
    listLive: async () => [],
    get: async () => {
      throw new Error('unused');
    },
    test: async () => {
      if (message instanceof Error) throw message;
      return message;
    },
  };
}

/** An app with a real tracker and scheduler (not started) over the given feeds. */
async function liveApp(feeds: ScoreFeed[], extra: Parameters<typeof createTestApp>[0] = {}) {
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const log = captureLogger().log;
  const tracker = new GameTracker({ repos, log });
  const scheduler = new Scheduler({
    tracker,
    feeds,
    isFeedEnabled: (id) => isFeedEnabled(repos().settings.get('feeds'), id),
    isPaused: () => repos().settings.get('global_kill_switch'),
    log,
  });
  const live: LiveServices = { tracker, scheduler, feeds };
  box.app = await createTestApp({ live, ...extra });
  return { app: box.app, tracker, scheduler };
}

async function signedIn(app: TestApp): Promise<Client> {
  await setupUser(app.app);
  const c = new Client(app.app, ingress());
  expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
  return c;
}

describe('Settings → Feeds API', () => {
  it('lists both adapters; toggles persist (settings + audit), need a session and CSRF', async () => {
    const setup = await liveApp([okFeed('kalshi-live', 'x'), okFeed('nhl-official', 'y')]);
    t = setup.app;
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/feeds', remoteAddress: '10.0.0.1' })).statusCode,
    ).toBe(401);
    const c = await signedIn(t);
    const list = (await c.get('/api/feeds')).json() as { id: string; enabled: boolean; available: boolean }[];
    expect(list.map((f) => [f.id, f.enabled, f.available])).toEqual([
      ['kalshi-live', true, true],
      ['nhl-official', true, true],
    ]);

    expect((await c.post('/api/feeds/nhl-official', { enabled: false })).statusCode).toBe(403); // no CSRF token
    const off = await c.postWithCsrf('/api/feeds/nhl-official', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(
      (off.json() as { id: string; enabled: boolean }[]).find((f) => f.id === 'nhl-official')?.enabled,
    ).toBe(false);
    expect(t.manager.repositories.settings.get('feeds')).toEqual({ 'nhl-official': false });
    const audit = t.manager.repositories.auditLog.listFor('feed_change', 'feed', 'nhl-official');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({ enabled: { from: true, to: false } });

    // Unchanged value → no second audit row; unknown adapter → 404; bad body → 400.
    await c.postWithCsrf('/api/feeds/nhl-official', { enabled: false });
    expect(t.manager.repositories.auditLog.listFor('feed_change', 'feed', 'nhl-official')).toHaveLength(1);
    expect((await c.postWithCsrf('/api/feeds/espn', { enabled: false })).statusCode).toBe(404);
    expect((await c.postWithCsrf('/api/feeds/nhl-official', { enabled: 'no' })).statusCode).toBe(400);
  });

  it('"Test feed" answers one line per adapter (unavailable Kalshi, failures and the kill switch readable)', async () => {
    const setup = await liveApp([
      okFeed('nhl-official', new Error('NHL API answered 502 for GET /score/now')),
    ]);
    t = setup.app;
    const c = await signedIn(t);
    const res = await c.postWithCsrf('/api/feeds/test', {});
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: { id: string; ok: boolean; message: string }[] };
    expect(results.map((r) => r.id)).toEqual(['kalshi-live', 'nhl-official']);
    expect(results[0]).toMatchObject({
      ok: false,
      message: expect.stringMatching(/credentials are not configured/),
    });
    expect(results[1]).toMatchObject({ ok: false, message: 'NHL API answered 502 for GET /score/now' });
    await t.close();

    const second = await liveApp([
      okFeed('kalshi-live', 'reachable'),
      okFeed('nhl-official', '3 NHL game(s) today'),
    ]);
    t = second.app;
    const c2 = await signedIn(t);
    const ok = (await c2.postWithCsrf('/api/feeds/test', {})).json() as {
      results: { ok: boolean; message: string }[];
    };
    expect(ok.results.map((r) => [r.ok, r.message])).toEqual([
      [true, 'reachable'],
      [true, '3 NHL game(s) today'],
    ]);
  });
});

describe('POST /api/dev/replay', () => {
  const line = () => must(parseReplayFile(readFileSync(SAMPLE, 'utf8'))[1], 'line');

  it('development: class dev only; plays a line through the tracker', async () => {
    const setup = await liveApp([], { nodeEnv: 'development' });
    t = setup.app;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: DEV.remoteAddress,
      payload: { line: line(), reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      state: { phase: 'live', homeScore: 0, clock: { period: 1 } },
    });
    const game = t.manager.repositories.games.get({ id: 'KXNHLGAME-26OCT14SEAVGK' });
    expect(JSON.parse(game?.feed_game_ids ?? '{}')).toEqual({ replay: true });
    const viaIngress = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: '172.30.32.2',
      headers: { 'x-ingress-path': '/api/hassio_ingress/abc' },
      payload: { line: line() },
    });
    expect(viaIngress.statusCode).toBe(404);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: '127.0.0.1',
      payload: { line: {} },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('production: not registered (no session → 401); e2e (allowLoopback): loopback only', async () => {
    const prod = await liveApp([]);
    t = prod.app;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: '127.0.0.1',
      payload: { line: line() },
    });
    expect(res.statusCode).toBe(401);
    await t.close();

    const e2e = await liveApp([], { replay: { allowLoopback: true } });
    t = e2e.app;
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: '127.0.0.1',
      payload: { line: line(), reset: true },
    });
    expect(ok.statusCode).toBe(200);
    const remote = await t.app.inject({
      method: 'POST',
      url: '/api/dev/replay',
      remoteAddress: '10.0.0.8',
      payload: { line: line() },
    });
    expect(remote.statusCode).toBe(404);
  });
});

describe('SSE games', () => {
  it('frames include games[] with homeScore, awayScore and clock (incl. minuteSource); /api/games and /api/loop', async () => {
    const setup = await liveApp([], { nodeEnv: 'development' });
    t = setup.app;
    await setupUser(t.app);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    // fetch() connects from loopback: with NODE_ENV=development that is class dev.
    const dev = new Client(t.app, DEV);
    await dev.login(USER, PASSWORD);
    const devCookie = [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const stream = await fetch(`${address}/api/live`, { headers: { cookie: devCookie } });
    expect(stream.status).toBe(200);
    const sse = sseReader(must(stream.body, 'body'));
    const initial = await sse.waitFor((e) => e.event === 'games');
    expect(initial.data).toEqual({ games: [] });
    expect(sse.events.some((e) => e.event === 'loop')).toBe(true);

    const lines = parseReplayFile(readFileSync(SAMPLE, 'utf8'));
    for (const [i, l] of lines.slice(0, 7).entries()) {
      const r = await fetch(`${address}/api/dev/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line: l, reset: i === 0 }),
      });
      expect(r.status).toBe(200);
    }
    type Frame = {
      games: {
        id: string;
        homeScore: number;
        awayScore: number;
        phase: string;
        clock: Record<string, unknown>;
      }[];
    };
    const frame = await sse.waitFor(
      (e) => e.event === 'games' && (e.data as Frame).games.some((g) => g.awayScore === 1),
    );
    const game = (frame.data as Frame).games[0];
    expect(game).toMatchObject({
      id: 'KXNHLGAME-26OCT14SEAVGK',
      homeScore: 1,
      awayScore: 1,
      phase: 'live',
      clock: { minute: 27, minuteSource: 'feed', period: 2, secondsLeftInPeriod: 754 },
    });
    expect(((await dev.get('/api/games')).json() as Frame).games[0]?.awayScore).toBe(1);
    expect((await dev.get('/api/loop')).json()).toMatchObject({
      state: 'starting',
      feeds: [{ id: 'kalshi-live' }, { id: 'nhl-official' }],
    });
    await sse.cancel();
  });
});
