import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { goalTimeline } from '../../../src/backtest/apiFootballImporter.js';
import type { JobView } from '../../../src/backtest/jobs.js';
import { FixtureSchema, GoalEventSchema, type Fixture } from '../../../src/feeds/apiFootball/feed.js';
import { decryptSetting } from '../../../src/server/secrets.js';
import { createTestApp, setupUser, TEST_SECRET, type Client, type TestApp } from '../../helpers/app.js';

/** T15 HTTP surface: Settings → Feeds (API-Football key, quota), Settings → Notifications, the import job. */

// Built at runtime so no key-like literal is committed (gitleaks generic-api-key).
const KEY = 'z'.repeat(28);

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function debugLogger() {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { logger: pino({ level: 'debug' }, sink), text: () => out };
}

async function app(extra: Parameters<typeof createTestApp>[0] = {}): Promise<{ t: TestApp; c: Client }> {
  const test = await createTestApp(extra);
  t = test;
  return { t: test, c: await setupUser(test.app) };
}

describe('Settings → Feeds → API-Football', () => {
  it('stores the key encrypted, answers it masked only, audits without it, never logs it', async () => {
    const log = debugLogger();
    const { t, c } = await app({ logger: log.logger });
    const before = (await c.get('/api/settings/api-football')).json();
    expect(before).toMatchObject({ configured: false, maskedKey: null, quota: { used: 0, limit: 100 } });

    expect((await c.post('/api/settings/api-football', { key: KEY })).statusCode).toBe(403); // CSRF
    const saved = await c.postWithCsrf('/api/settings/api-football', { key: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(KEY);
    expect(saved.json()).toMatchObject({ configured: true, maskedKey: '••••••••••••' });

    const repos = t.manager.repositories;
    const stored = repos.settings.get('api_football_key_enc');
    expect(stored).not.toBe(KEY);
    expect(stored).not.toContain(KEY);
    expect(decryptSetting(stored ?? '', TEST_SECRET)).toBe(KEY);
    expect((await c.get('/api/settings')).body).not.toContain('api_football');

    const audit = repos.auditLog.listFor('api_football_key_set', 'settings', 'api_football_key_enc');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(KEY);

    // Replace, then limit, then remove.
    await c.postWithCsrf('/api/settings/api-football', { key: `${KEY}-2` });
    expect(decryptSetting(repos.settings.get('api_football_key_enc') ?? '', TEST_SECRET)).toBe(`${KEY}-2`);
    const limit = await c.postWithCsrf('/api/settings/api-football', { dailyLimit: 7500 });
    expect(limit.json()).toMatchObject({ quota: { limit: 7500 } });
    expect((await c.postWithCsrf('/api/settings/api-football', { dailyLimit: 0 })).statusCode).toBe(400);
    expect((await c.postWithCsrf('/api/settings/api-football', { key: 'has spaces in it' })).statusCode).toBe(
      400,
    );
    const removed = await c.postWithCsrf('/api/settings/api-football', { key: null });
    expect(removed.json()).toMatchObject({ configured: false, maskedKey: null });
    expect(
      repos.auditLog.listFor('api_football_key_removed', 'settings', 'api_football_key_enc'),
    ).toHaveLength(1);

    expect(log.text()).toContain('API-Football key stored');
    expect(log.text()).not.toContain(KEY);
  });

  it('shows the quota of the local day', async () => {
    const { t, c } = await app();
    const repos = t.manager.repositories;
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    repos.settings.set('api_football_quota', { day, used: 42 });
    expect((await c.get('/api/settings/api-football')).json()).toMatchObject({
      quota: { day, used: 42, limit: 100 },
    });
    repos.settings.set('api_football_quota', { day: '2020-01-01', used: 99 });
    expect((await c.get('/api/settings/api-football')).json()).toMatchObject({ quota: { day, used: 0 } });
  });
});

describe('Settings → Notifications', () => {
  it('toggles persist and are audited; unavailable without a notifier token', async () => {
    const { t, c } = await app();
    const view = (await c.get('/api/settings/notifications')).json();
    expect(view).toEqual({
      available: false,
      events: {
        trade_filled: true,
        trade_settled: true,
        kill_switch_changed: true,
        global_dry_run_changed: true,
        feed_disagreement: true,
      },
      modes: { live: true, dry_run: true },
    });
    const res = await c.postWithCsrf('/api/settings/notifications', {
      events: { trade_settled: false },
      modes: { dry_run: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      events: { trade_settled: false, trade_filled: true },
      modes: { dry_run: false, live: true },
    });
    expect((await c.get('/api/settings/notifications')).json()).toMatchObject({
      events: { trade_settled: false },
      modes: { dry_run: false },
    });
    const audit = t.manager.repositories.auditLog.listFor('settings_change', 'settings', 'notifications');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({
      'events.trade_settled': { from: true, to: false },
      'modes.dry_run': { from: true, to: false },
    });
    expect((await c.postWithCsrf('/api/settings/notifications', { events: { nope: true } })).statusCode).toBe(
      400,
    );
  });

  it('switch changes through the API reach the notifier with the resulting global mode', async () => {
    const calls: unknown[][] = [];
    const { c } = await app({
      notifier: { available: true, switchChanged: (...args: unknown[]) => void calls.push(args) },
    });
    expect((await c.get('/api/settings/notifications')).json()).toMatchObject({ available: true });
    await c.postWithCsrf('/api/settings', { global_kill_switch: true });
    await c.postWithCsrf('/api/settings', { global_kill_switch: false });
    expect(calls).toEqual([
      ['global_kill_switch', true, 'dry_run'],
      ['global_kill_switch', false, 'dry_run'],
    ]);
  });
});

describe('Settings → Data → API-Football import', () => {
  const fx = (id: number, home: number, away: number): Fixture =>
    FixtureSchema.parse({
      fixture: { id, date: '2025-08-16T14:00:00+00:00', status: { short: 'FT', elapsed: 90 } },
      league: { id: 39, season: 2025 },
      teams: { home: { id: 42, name: 'Arsenal' }, away: { id: 49, name: 'Chelsea' } },
      goals: { home, away },
    });
  const goal = (team: number, elapsed: number, detail = 'Normal Goal', extra: number | null = null) =>
    GoalEventSchema.parse({ time: { elapsed, extra }, team: { id: team }, type: 'Goal', detail });

  it('goal timelines: stoppage counts as 45 / 90, missed penalties ignored, own goals made to add up', () => {
    expect(
      goalTimeline(
        [
          goal(42, 23),
          goal(49, 45, 'Normal Goal', 2),
          goal(42, 90, 'Penalty', 4),
          goal(49, 70, 'Missed Penalty'),
        ],
        42,
        49,
        {
          home: 2,
          away: 1,
        },
      ),
    ).toEqual([
      { side: 'home', period: 1, minute: 23, second: 0 },
      { side: 'away', period: 1, minute: 45, second: 0 },
      { side: 'home', period: 2, minute: 90, second: 0 },
    ]);
    // An own goal listed under the scorer's team: flipped so the timeline adds up to 1-0.
    expect(goalTimeline([goal(49, 30, 'Own Goal')], 42, 49, { home: 1, away: 0 })).toEqual([
      { side: 'home', period: 1, minute: 30, second: 0 },
    ]);
    expect(goalTimeline([goal(42, 30)], 42, 49, { home: 0, away: 2 })).toBeNull();
  });

  it('409 without a key; with a paid key the job imports hist_games rows (source api_football)', async () => {
    const plan = { value: 'Free' };
    const client = {
      configured: () => true,
      status: async () => ({ subscription: { plan: plan.value } }),
      fixtures: async () => [fx(1001, 2, 1), fx(1002, 0, 0)],
      goalEvents: async (id: number) => (id === 1001 ? [goal(42, 10), goal(49, 50), goal(42, 88)] : []),
    };
    const off = await app({ data: { apiFootball: { ...client, configured: () => false } } });
    expect(
      (await off.c.postWithCsrf('/api/data/api-football', { leagueId: 'epl', season: 2025 })).statusCode,
    ).toBe(409);
    await off.t.close();
    t = undefined;

    const { t: test, c } = await app({ data: { apiFootball: client } });
    expect(
      (await c.postWithCsrf('/api/data/api-football', { leagueId: 'nhl', season: 2025 })).statusCode,
    ).toBe(400);
    const wait = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const j = (await c.get(`/api/jobs/${id}`)).json() as JobView;
        if (j.status !== 'running') return j;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('job did not finish');
    };
    const free = await c.postWithCsrf('/api/data/api-football', { leagueId: 'epl', season: 2025 });
    expect(free.statusCode).toBe(202);
    const failed = await wait((free.json() as JobView).id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/paid API-Football plan/),
    });

    plan.value = 'Pro';
    const started = await c.postWithCsrf('/api/data/api-football', { leagueId: 'epl', season: 2025 });
    const done = await wait((started.json() as JobView).id);
    expect(done).toMatchObject({
      status: 'done',
      type: 'api_football_import',
      result: { imported: 2, skipped: 0, failed: 0 },
    });
    const row = test.manager.repositories.histGames.get({ id: 'api_football:1001' });
    expect(row).toMatchObject({
      source: 'api_football',
      league_id: 'epl',
      season: '2025-26',
      final_home: 2,
      final_away: 1,
    });
    expect(JSON.parse(row?.goal_events ?? '[]')).toHaveLength(3);
    // Resumable: a second run skips what is stored.
    const again = await wait(
      ((await c.postWithCsrf('/api/data/api-football', { leagueId: 'epl', season: 2025 })).json() as JobView)
        .id,
    );
    expect(again.result).toMatchObject({ imported: 0, skipped: 2 });
  });
});
