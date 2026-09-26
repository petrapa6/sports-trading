import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderGroupManager } from '../../../src/core/orderGroup.js';
import { Scheduler } from '../../../src/core/scheduler.js';
import { GameTracker } from '../../../src/core/tracker.js';
import { createTestApp, PASSWORD, setupUser, type TestApp } from '../../helpers/app.js';
import { captureLogger, kalshiMockServer, must, testClient } from '../../helpers/kalshiMsw.js';
import { KalshiScript } from '../../helpers/trading.js';

/** Settings → Trading, order group (T13): status, and the reset that needs step-up and is audited. */
const mock = kalshiMockServer();
let script: KalshiScript;
let t: TestApp | undefined;

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
beforeEach(() => {
  script = new KalshiScript();
  mock.use(...script.handlers());
});
afterEach(async () => {
  mock.server.resetHandlers();
  await t?.close();
  t = undefined;
});

async function app(allowLiveOrders: boolean) {
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const log = captureLogger().log;
  const client = testClient({ killSwitch: () => repos().settings.get('global_kill_switch') });
  const orderGroups = new OrderGroupManager({ repos, log, kalshi: () => client, allowLiveOrders });
  const tracker = new GameTracker({ repos, log, transaction: (fn) => fn() });
  const scheduler = new Scheduler({
    tracker,
    feeds: [],
    isFeedEnabled: () => true,
    isPaused: () => false,
    log,
  });
  box.app = await createTestApp({ live: { tracker, scheduler, feeds: [], orderGroups } });
  return { app: box.app, orderGroups };
}

const ageAuth = (test: TestApp) =>
  test.manager.current?.sqlite
    .prepare('UPDATE sessions SET last_auth_at = ?')
    .run(new Date(Date.now() - 10 * 60_000).toISOString());

describe('order group API', () => {
  it('GET shows the group; reset without recent re-auth → 403, with it → 200, the exchange reset and an audit row', async () => {
    const s = await app(true);
    t = s.app;
    const c = await setupUser(t.app);
    await s.orderGroups.ensure(); // creates grp-new (none stored)
    s.orderGroups.markLimitHit();
    expect((await c.get('/api/settings/order-group')).json()).toMatchObject({
      enabled: true,
      id: 'grp-new',
      contractsLimit: 200,
      state: 'limit_hit',
    });
    ageAuth(t);
    const denied = await c.postWithCsrf('/api/settings/order-group/reset');
    expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'reauth_required' }]);
    expect(script.log.filter((p) => p.includes('/reset'))).toEqual([]);

    expect((await c.postWithCsrf('/auth/reauth', { password: PASSWORD })).statusCode).toBe(200);
    const ok = await c.postWithCsrf('/api/settings/order-group/reset');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'grp-new', state: 'active', limitHitAt: null });
    expect(script.log).toContain('PUT /portfolio/order_groups/grp-new/reset');
    const audit = t.manager.repositories.auditLog.list().filter((r) => r.action === 'order_group_reset');
    expect(audit).toMatchObject([{ actor: 'user:alice', mode: 'live', entity: 'settings' }]);
  });

  it('with allow_live_orders=false the group is disabled and reset answers 409 without any request', async () => {
    const s = await app(false);
    t = s.app;
    const c = await setupUser(t.app);
    expect((await c.get('/api/settings/order-group')).json()).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
    const r = await c.postWithCsrf('/api/settings/order-group/reset');
    expect([r.statusCode, (r.json() as { error: string }).error]).toEqual([409, 'live_orders_disabled']);
    expect(script.log).toEqual([]);
  });
});
