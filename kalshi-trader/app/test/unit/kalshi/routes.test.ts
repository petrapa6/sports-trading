import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DiscoveryService } from '../../../src/feeds/kalshi/discovery.js';
import { createTestApp, setupUser, type Client, type TestApp } from '../../helpers/app.js';
import { captureLogger, kalshiMockServer, testClient, must } from '../../helpers/kalshiMsw.js';

const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mock.server.resetHandlers());
afterAll(() => mock.server.close());

let t: TestApp;
afterEach(async () => t.close());

async function app(configured: boolean): Promise<Client> {
  let killSwitch = () => false;
  const log = captureLogger().log;
  const client = configured ? testClient({ log, killSwitch: () => killSwitch() }) : undefined;
  t = await createTestApp({
    kalshi: {
      env: 'demo',
      subaccount: 0,
      client,
      discovery: client
        ? new DiscoveryService({ deps: () => ({ client, repos: t.manager.repositories, log }), log })
        : undefined,
    },
  });
  killSwitch = () => t.manager.repositories.settings.get('global_kill_switch');
  return setupUser(t.app);
}

describe('Settings → Leagues API', () => {
  it('lists six leagues with their series; patches are validated, persisted and audited', async () => {
    const c = await app(false);
    const leagues = (await c.get('/api/leagues')).json() as {
      id: string;
      kalshiSeries: string;
      includePreseason: boolean;
      enabled: boolean;
    }[];
    expect(leagues.map((l) => [l.id, l.kalshiSeries])).toEqual([
      ['bundesliga', 'KXBUNDESLIGAGAME'],
      ['epl', 'KXEPLGAME'],
      ['laliga', 'KXLALIGAGAME'],
      ['ligue1', 'KXLIGUE1GAME'],
      ['nhl', 'KXNHLGAME'],
      ['seriea', 'KXSERIEAGAME'],
    ]);
    expect(leagues.every((l) => l.enabled && !l.includePreseason)).toBe(true);

    const res = await c.postWithCsrf('/api/leagues/nhl', {
      include_preseason: true,
      kalshi_series: 'KXNHLGAME',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'nhl', includePreseason: true });
    expect(must(t.manager.repositories.leagues.get({ id: 'nhl' })).include_preseason).toBe(1);
    const audit = t.manager.repositories.auditLog.list().filter((r) => r.action === 'league_change');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(must(must(audit[0]).detail))).toEqual({ include_preseason: { from: 0, to: 1 } });

    expect((await c.postWithCsrf('/api/leagues/nhl', { kalshi_series: 'bad series' })).statusCode).toBe(400);
    expect((await c.postWithCsrf('/api/leagues/nhl', { other: 1 })).statusCode).toBe(400);
    expect((await c.postWithCsrf('/api/leagues/nope', { enabled: false })).statusCode).toBe(404);
    expect((await c.post('/api/leagues/nhl', { enabled: false })).statusCode).toBe(403); // no CSRF token
  });
});

describe('Kalshi actions', () => {
  it('Discover series lists Sports series ending in GAME', async () => {
    const c = await app(true);
    const res = await c.get('/api/kalshi/series');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { ticker: 'KXBUNDESLIGAGAME', title: 'Bundesliga Game' },
      { ticker: 'KXEPLGAME', title: 'English Premier League Game' },
      { ticker: 'KXLALIGAGAME', title: 'La Liga Game' },
      { ticker: 'KXLIGUE1GAME', title: 'Ligue 1 Game' },
      { ticker: 'KXNHLGAME', title: 'NHL Game' },
      { ticker: 'KXSERIEAGAME', title: 'Serie A Game' },
    ]);
  });

  it('Run discovery now fills games and markets and is audited', async () => {
    const c = await app(true);
    const res = await c.postWithCsrf('/api/kalshi/discovery');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { leagues: unknown[] }).leagues).toHaveLength(6);
    expect(t.manager.repositories.games.count()).toBe(2);
    expect(t.manager.repositories.auditLog.list().map((r) => r.action)).toContain('discovery_run');
  });

  it('Test Kalshi connection: environment, subaccount, balance, exchange status', async () => {
    const c = await app(true);
    const res = await c.postWithCsrf('/api/diagnostics/kalshi');
    expect(res.json()).toEqual({
      env: 'demo',
      subaccount: 0,
      ok: true,
      balance: { cashMicros: 123_450_000, portfolioValueMicros: 1_860_000 },
      exchange: { exchangeActive: true, tradingActive: true },
    });
  });

  it('with the kill switch on: readable errors and no request', async () => {
    const c = await app(true);
    t.manager.repositories.settings.set('global_kill_switch', true);
    mock.requests.length = 0;
    const test = (await c.postWithCsrf('/api/diagnostics/kalshi')).json() as Record<string, unknown>;
    expect(test).toMatchObject({ ok: false, code: 'network_paused', env: 'demo' });
    expect(test['error']).toMatch(/kill switch/);
    const series = await c.get('/api/kalshi/series');
    expect(series.statusCode).toBe(409);
    expect(series.json()).toMatchObject({ error: 'network_paused' });
    expect(mock.requests).toHaveLength(0);
  });

  it('without credentials every Kalshi action answers a readable kalshi_not_configured', async () => {
    const c = await app(false);
    const test = (await c.postWithCsrf('/api/diagnostics/kalshi')).json() as Record<string, unknown>;
    expect(test).toMatchObject({ ok: false, code: 'kalshi_not_configured', env: 'demo', subaccount: 0 });
    expect(test['error']).toMatch(/not configured/);
    const series = await c.get('/api/kalshi/series');
    expect(series.statusCode).toBe(503);
    expect(series.json()).toMatchObject({ error: 'kalshi_not_configured' });
    expect((await c.postWithCsrf('/api/kalshi/discovery')).statusCode).toBe(503);
  });
});
