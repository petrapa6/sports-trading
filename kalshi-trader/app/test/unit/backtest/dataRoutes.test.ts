import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobView } from '../../../src/backtest/jobs.js';
import { createTestApp, PASSWORD, setupUser, type Client, type TestApp } from '../../helpers/app.js';
import { routeNhl } from '../../helpers/nhlFixtures.js';

const BASE = 'https://nhl.test/v1';
const seen: string[] = [];
/** When set, play-by-play requests for these games wait until the promise resolves. */
let hold: { ids: Set<string>; release: Promise<void>; reached: () => void } | undefined;

const server = setupServer(
  http.get(`${BASE}/*`, async ({ request }) => {
    const path = new URL(request.url).pathname.slice('/v1'.length);
    seen.push(path);
    const id = /gamecenter\/(\d+)\//.exec(path)?.[1];
    if (hold && id && hold.ids.has(id)) {
      hold.reached();
      await hold.release;
    }
    const r = routeNhl(path);
    return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(async () => {
  hold = undefined;
  seen.length = 0;
  server.resetHandlers();
  await t?.close();
  t = undefined;
});
afterAll(() => server.close());

let t: TestApp | undefined;
async function app(): Promise<{ t: TestApp; c: Client }> {
  const test = await createTestApp({ data: { nhlBaseUrl: BASE, nhlRequestsPerSecond: 1000 } });
  t = test;
  return { t: test, c: await setupUser(test.app) };
}

function ageAuth(test: TestApp): void {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  test.manager.current?.sqlite.prepare('UPDATE sessions SET last_auth_at = ?').run(old);
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const holdGames = (...ids: string[]) => {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reachedP = new Promise<void>((r) => (reached = r));
  hold = { ids: new Set(ids), release: released, reached };
  return { release, reached: reachedP };
};

const job = async (c: Client, id: string) => (await c.get(`/api/jobs/${id}`)).json() as JobView;

describe('jobs', () => {
  it('DELETE /api/jobs/:id stops the NHL import within one request and keeps the inserted rows', async () => {
    const { t, c } = await app();
    const gate = holdGames('2025020074');
    const started = await c.postWithCsrf('/api/data/nhl', { season: '20252026' });
    expect(started.statusCode).toBe(202);
    const { id } = started.json() as JobView;
    await gate.reached; // the second play-by-play is in flight; the first game is stored
    expect(t.manager.repositories.histGames.list().map((h) => h.id)).toEqual(['nhl:2025020039']);
    const before = seen.length;

    const token = await c.csrf();
    const res = await c.request('DELETE', `/api/jobs/${id}`, { headers: { 'x-csrf-token': token } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as JobView).status).toBe('cancelled');
    gate.release();
    await new Promise((r) => setTimeout(r, 100));
    // At most the request that was in flight; nothing after the cancel.
    expect(seen.length - before).toBeLessThanOrEqual(1);
    expect(seen.filter((p) => p.startsWith('/schedule/2025-09-29'))).toHaveLength(0);
    expect(t.manager.repositories.histGames.list().map((h) => h.id)).toEqual(['nhl:2025020039']);
    expect((await job(c, id)).status).toBe('cancelled');
    expect(t.manager.repositories.auditLog.list().map((r) => r.action)).toEqual(
      expect.arrayContaining(['data_job_start', 'data_job_cancel']),
    );
  });

  it('global kill switch on → the job pauses with zero requests and resumes when switched off', async () => {
    const { t, c } = await app();
    const gate = holdGames('2025020039');
    const { id } = (await c.postWithCsrf('/api/data/nhl', { season: '20252026' })).json() as JobView;
    await gate.reached;
    // Kill switch on while a request is in flight: that request may finish, nothing else goes out.
    expect((await c.postWithCsrf('/api/settings', { global_kill_switch: true })).statusCode).toBe(200);
    gate.release();
    await until(() => t.manager.repositories.histGames.count() === 1);
    await new Promise((r) => setTimeout(r, 50));
    const paused = seen.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen.length).toBe(paused);
    expect((await job(c, id)).status).toBe('paused');

    expect((await c.postWithCsrf('/api/settings', { global_kill_switch: false })).statusCode).toBe(200);
    await until(() => seen.includes('/schedule/2025-09-29'));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.manager.repositories.histGames.count()).toBe(2);
    const done = await job(c, id);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ inserted: 2 });
  });

  it('a job that starts while the kill switch is on makes no request until it is turned off', async () => {
    const { t, c } = await app();
    t.manager.repositories.settings.set('global_kill_switch', true);
    const { id } = (await c.postWithCsrf('/api/data/nhl', { season: '20252026' })).json() as JobView;
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(0);
    expect((await job(c, id)).status).toBe('paused');
    expect((await c.postWithCsrf('/api/settings', { global_kill_switch: false })).statusCode).toBe(200);
    await until(() => seen.includes('/schedule/2025-09-29'));
    await until(() => t.manager.repositories.histGames.count() === 2);
  });

  it('a second job of the same type → 409 job_running; unknown job → 404; bad season → 400', async () => {
    const { c } = await app();
    const gate = holdGames('2025020039');
    expect((await c.postWithCsrf('/api/data/nhl', { season: '20252026' })).statusCode).toBe(202);
    await gate.reached;
    const second = await c.postWithCsrf('/api/data/nhl', { season: '20252026' });
    expect([second.statusCode, (second.json() as { error: string }).error]).toEqual([409, 'job_running']);
    gate.release();
    expect((await c.get('/api/jobs/nope')).statusCode).toBe(404);
    expect((await c.postWithCsrf('/api/data/nhl', { season: '2025' })).statusCode).toBe(400);
    const list = (await c.get('/api/jobs')).json() as { jobs: JobView[] };
    expect(list.jobs).toHaveLength(1);
  });

  it('Kalshi jobs without credentials answer kalshi_not_configured', async () => {
    const { c } = await app();
    const res = await c.postWithCsrf('/api/data/candles', {});
    expect([res.statusCode, (res.json() as { error: string }).error]).toEqual([503, 'kalshi_not_configured']);
    const bad = await c.postWithCsrf('/api/data/kalshi-backfill', { from: '2026-09-30', to: '2026-09-01' });
    expect(bad.statusCode).toBe(400);
  });
});

const CSV = [
  'league_code,season,date,home,away,home_goals_final,away_goals_final,goal_events',
  'epl,2015-16,2015-08-08,Manchester United,Tottenham,1,0,home:22',
  'epl,2015-16,2015-08-08,Bournemouth,Aston Villa,0,1,away:72',
  'epl,2015-16,2015-08-09,Arsenal,West Ham,1,2,home:23;away:67;away:90+2',
].join('\n');

const upload = (c: Client, token: string, payload: string | Buffer) =>
  c.request('POST', '/api/data/csv', {
    headers: { 'x-csrf-token': token },
    raw: { contentType: 'text/csv', payload },
  });

describe('CSV import', () => {
  it('3 valid rows → 3 rows; home:23;away:67;home:90+2 → minutes 23, 67, 90', async () => {
    const { t, c } = await app();
    const res = await upload(
      c,
      await c.csrf(),
      `${CSV}\nepl,2016-17,2016-08-13,Hull,Leicester,2,1,home:23;away:67;home:90+2\n`.replace(
        /\nepl,2015-16,2015-08-09[^\n]*/,
        '',
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rows: 3, inserted: 3, updated: 0 });
    const repos = t.manager.repositories;
    expect(repos.histGames.count()).toBe(3);
    const hull = repos.histGames.get({ id: 'csv:epl:2016-08-13:Hull:Leicester' });
    expect(hull).toMatchObject({
      source: 'csv',
      league_id: 'epl',
      season: '2016-17',
      final_home: 2,
      final_away: 1,
    });
    expect(JSON.parse(hull?.goal_events ?? '[]')).toEqual([
      { side: 'home', period: 1, minute: 23, second: 0 },
      { side: 'away', period: 2, minute: 67, second: 0 },
      { side: 'home', period: 2, minute: 90, second: 0 },
    ]);
    expect(repos.auditLog.list().some((r) => r.action === 'hist_csv_import')).toBe(true);
    // Importing the same file again changes nothing.
    const again = await upload(
      c,
      await c.csrf(),
      `${CSV}\nepl,2016-17,2016-08-13,Hull,Leicester,2,1,home:23;away:67;home:90+2\n`.replace(
        /\nepl,2015-16,2015-08-09[^\n]*/,
        '',
      ),
    );
    expect(again.json()).toEqual({ rows: 3, inserted: 0, updated: 3 });
    expect(repos.histGames.count()).toBe(3);
  });

  it('home_goals_final not matching the home goal events → 400 naming the row (nothing written)', async () => {
    const { t, c } = await app();
    const bad = CSV.replace('Bournemouth,Aston Villa,0,1', 'Bournemouth,Aston Villa,2,1');
    const res = await upload(c, await c.csrf(), bad);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; row: number; column: string; message: string };
    expect(body).toMatchObject({ error: 'invalid_csv', row: 2, column: 'home_goals_final' });
    expect(body.message).toMatch(/^row 2, column home_goals_final: /);
    expect(t.manager.repositories.histGames.count()).toBe(0);

    const badEvents = await upload(c, await c.csrf(), CSV.replace('home:22', 'home:twenty'));
    expect(badEvents.json()).toMatchObject({ row: 1, column: 'goal_events' });
    const badLeague = await upload(
      c,
      await c.csrf(),
      CSV.replace('\nepl,2015-16,2015-08-09', '\nxyz,2015-16,2015-08-09'),
    );
    expect(badLeague.json()).toMatchObject({ row: 3, column: 'league_code' });
    const noHeader = await upload(c, await c.csrf(), 'a,b\n1,2');
    expect(noHeader.statusCode).toBe(400);
  });

  it('21 MB → 413', async () => {
    const { c } = await app();
    const big = Buffer.alloc(21 * 1024 * 1024, 'a');
    const res = await upload(c, await c.csrf(), big);
    expect(res.statusCode).toBe(413);
  });

  it('without re-auth → 403 reauth_required (before the body is read); with re-auth → 200', async () => {
    const { t, c } = await app();
    ageAuth(t);
    const res = await upload(c, await c.csrf(), CSV);
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'reauth_required' }]);
    expect(t.manager.repositories.histGames.count()).toBe(0);
    expect((await c.postWithCsrf('/auth/reauth', { password: PASSWORD })).statusCode).toBe(200);
    expect((await upload(c, await c.csrf(), CSV)).statusCode).toBe(200);
  });

  it('needs a CSRF token and a text/csv body', async () => {
    const { c } = await app();
    expect((await upload(c, 'wrong', CSV)).statusCode).toBe(403);
    const json = await c.postWithCsrf('/api/data/csv', { csv: CSV });
    expect(json.statusCode).toBe(415);
  });
});

describe('summary, price model and vacuum', () => {
  it('summary counts, rebuilding on an empty DB stores the seed table, vacuum reports sizes', async () => {
    const { t, c } = await app();
    await upload(c, await c.csrf(), CSV);
    const summary = (await c.get('/api/data/summary')).json() as {
      histGames: { total: number; bySource: Record<string, number> };
      priceModel: unknown;
    };
    expect(summary.histGames).toEqual({ total: 3, bySource: { csv: 3 } });
    expect(summary.priceModel).toBeNull();

    const model = await c.postWithCsrf('/api/data/price-model', {});
    expect(model.statusCode).toBe(200);
    const body = model.json() as {
      sports: Record<string, { observations: number }>;
      cells: { seeded: boolean }[];
    };
    expect(body.sports['soccer']?.observations).toBe(0);
    expect(body.cells.every((x) => x.seeded)).toBe(true);
    expect(t.manager.repositories.settings.get('price_model')).not.toBeNull();

    const vacuum = await c.postWithCsrf('/api/data/vacuum', {});
    expect(vacuum.statusCode).toBe(200);
    const v = vacuum.json() as { beforeBytes: number; afterBytes: number };
    expect(v.beforeBytes).toBeGreaterThan(0);
    expect(v.afterBytes).toBeGreaterThan(0);
    const actions = t.manager.repositories.auditLog.list().map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['price_model_rebuild', 'db_vacuum']));
  });
});
