import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createTestApp, PASSWORD, setupUser, tunnel, USER, type TestApp } from '../helpers/app.js';

let t: TestApp;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const actions = () => t.manager.repositories.auditLog.list().map((r) => r.action);

async function signedIn(): Promise<Client> {
  await setupUser(t.app);
  const c = new Client(t.app, tunnel());
  expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
  return c;
}

describe('global switches (Settings → Trading)', () => {
  it('kill switch on needs no step-up and is audited; off needs a recent step-up', async () => {
    const c = await signedIn();
    advance(5 * 60_000 + 1000); // the login no longer counts as a recent authentication

    const on = await c.postWithCsrf('/api/settings', { global_kill_switch: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ global_kill_switch: true });
    expect(t.manager.repositories.settings.get('global_kill_switch')).toBe(true);
    const row = t.manager.repositories.auditLog.list().find((r) => r.action === 'global_kill_switch_on');
    expect(row).toMatchObject({
      actor: `user:${USER}`,
      channel: 'tunnel',
      ip: '198.51.100.7',
      mode: 'dry_run',
    });

    const off = await c.postWithCsrf('/api/settings', { global_kill_switch: false });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toEqual({ error: 'reauth_required' });
    expect(t.manager.repositories.settings.get('global_kill_switch')).toBe(true);
    expect(actions()).not.toContain('global_kill_switch_off');

    expect((await c.postWithCsrf('/auth/reauth', { password: PASSWORD })).statusCode).toBe(200);
    const off2 = await c.postWithCsrf('/api/settings', { global_kill_switch: false });
    expect(off2.statusCode).toBe(200);
    expect(t.manager.repositories.settings.get('global_kill_switch')).toBe(false);
    expect(actions()).toContain('global_kill_switch_off');
  });

  it('global dry run off needs step-up; on does not; a rejected request changes nothing', async () => {
    const c = await signedIn();
    advance(5 * 60_000 + 1000);
    const off = await c.postWithCsrf('/api/settings', {
      global_dry_run: false,
      order_group_contract_limit: 50,
    });
    expect(off.statusCode).toBe(403);
    expect(t.manager.repositories.settings.get('global_dry_run')).toBe(true);
    expect(t.manager.repositories.settings.get('order_group_contract_limit')).toBe(200);

    await c.postWithCsrf('/auth/reauth', { password: PASSWORD });
    expect((await c.postWithCsrf('/api/settings', { global_dry_run: false })).statusCode).toBe(200);
    expect(actions()).toContain('global_dry_run_off');
    advance(10 * 60_000);
    const on = await c.postWithCsrf('/api/settings', { global_dry_run: true });
    expect(on.statusCode).toBe(200);
    expect(actions()).toContain('global_dry_run_on');
    // Setting a switch to its current value is a no-op (no audit row, no step-up).
    const before = actions().length;
    expect((await c.postWithCsrf('/api/settings', { global_dry_run: true })).statusCode).toBe(200);
    expect(actions().length).toBe(before);
  });

  it('a switch change is logged with its mode; /api/status reports the switches and the add-on lock', async () => {
    const c = await signedIn();
    await c.postWithCsrf('/api/settings', { global_kill_switch: true });
    const line = t.logs().find((l) => l['msg'] === 'Global kill switch turned on');
    expect(line).toMatchObject({ mode: 'dry_run', setting: 'global_kill_switch', value: true });
    const status = (await c.get('/api/status')).json();
    expect(status).toMatchObject({
      globalKillSwitch: true,
      globalDryRun: true,
      allowLiveOrders: false,
      kalshiEnv: 'demo',
      kalshiSubaccount: 0,
    });
    expect(typeof status.version).toBe('string');
  });

  it('the add-on lock cannot be changed through the API', async () => {
    const c = await signedIn();
    const res = await c.postWithCsrf('/api/settings', { allow_live_orders: true });
    expect(res.statusCode).toBe(400);
  });
});

describe('other signed-in endpoints', () => {
  it('diagnostics, leagues and strategies', async () => {
    const t2 = await createTestApp({ runtime: { version: '9.9.9', dbPath: '/nonexistent/trader.db' } });
    try {
      await setupUser(t2.app);
      const c = new Client(t2.app, tunnel());
      await c.login(USER, PASSWORD);
      expect((await c.get('/api/diagnostics')).json()).toEqual({
        version: '9.9.9',
        dbPath: '/nonexistent/trader.db',
        dbSizeBytes: 0,
      });
      const leagues = (await c.get('/api/leagues')).json() as { id: string }[];
      expect(leagues.map((l) => l.id).sort()).toEqual([
        'bundesliga',
        'epl',
        'laliga',
        'ligue1',
        'nhl',
        'seriea',
      ]);
      expect((await c.get('/api/strategies')).json()).toEqual([]);
      expect((await new Client(t2.app, tunnel()).get('/api/diagnostics')).statusCode).toBe(401);
    } finally {
      await t2.close();
    }
  });
});
