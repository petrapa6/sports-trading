import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StrategyEngine } from '../../../src/core/engine.js';
import { Executor } from '../../../src/core/executor.js';
import { parseReplayFile } from '../../../src/core/replay.js';
import { Scheduler } from '../../../src/core/scheduler.js';
import { Settler } from '../../../src/core/settler.js';
import { GameTracker } from '../../../src/core/tracker.js';
import type { TradeDetail, TradeView } from '../../../src/core/trades.js';
import { Client, createTestApp, PASSWORD, setupUser, type TestApp } from '../../helpers/app.js';
import { captureLogger, kalshiMockServer, must, testClient } from '../../helpers/kalshiMsw.js';
import { KalshiScript, marketJson, orderbookJson } from '../../helpers/trading.js';

const SAMPLE = resolve(import.meta.dirname, '../../fixtures/replay/nhl-sample.jsonl');
const GAME = 'KXNHLGAME-26OCT14SEAVGK';
const TICKER = `${GAME}-VGK`;
const DEV = { remoteAddress: '127.0.0.1', headers: {} };

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

/** An app with the real tracker, engine, executor and settler, Kalshi answered by the msw script. */
async function tradingApp() {
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const transaction = (fn: () => void) => {
    const db = must(box.app, 'app').manager.current;
    if (db) db.sqlite.transaction(fn)();
    else fn();
  };
  const logs = captureLogger('info');
  const client = testClient({ killSwitch: () => repos().settings.get('global_kill_switch') });
  const tracker = new GameTracker({ repos, log: logs.log, transaction });
  const engine = new StrategyEngine({ repos, log: logs.log, allowLiveOrders: false }).attach(tracker);
  const executor = new Executor({
    repos,
    log: logs.log,
    kalshi: () => client,
    allowLiveOrders: false,
    kalshiEnv: 'demo',
    transaction,
  }).attach(engine, tracker);
  const settler = new Settler({ repos, log: logs.log, kalshi: () => client, transaction });
  const scheduler = new Scheduler({
    tracker,
    feeds: [],
    isFeedEnabled: () => true,
    isPaused: () => repos().settings.get('global_kill_switch'),
    log: logs.log,
  });
  box.app = await createTestApp({
    nodeEnv: 'development',
    live: { tracker, scheduler, feeds: [], engine, executor, settler },
    replay: { allowLoopback: false, transaction },
  });
  return { app: box.app, executor, settler, logs };
}

const NHL_55 = {
  name: 'NHL lead at 55',
  sport: 'hockey',
  leagueIds: ['nhl'],
  rule: { type: 'lead_at_time', minLead: 1, atMinute: 55, windowMinutes: 5 },
  sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
  execution: { maxPrice: 0.97 },
};

async function replay(app: TestApp, executor: Executor): Promise<void> {
  const dev = new Client(app.app, DEV);
  for (const [i, line] of parseReplayFile(readFileSync(SAMPLE, 'utf8')).entries()) {
    const r = await dev.post('/api/dev/replay', { line, reset: i === 0 });
    expect(r.statusCode, r.body).toBe(200);
    await executor.idle();
  }
}

describe('end-to-end replay (dry run)', () => {
  it('one dry-run strategy → exactly one trade, signalled → pending → filled → settled_won in audit order (mode dry_run), bankroll updated', async () => {
    const setup = await tradingApp();
    t = setup.app;
    const c = await setupUser(t.app);
    const created = await c.postWithCsrf('/api/strategies', NHL_55);
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(
      (await c.postWithCsrf(`/api/strategies/${id}/kill-switch`, { killSwitch: false })).statusCode,
    ).toBe(200);

    script.market.set(TICKER, marketJson(TICKER, { close_time: '2099-01-01T00:00:00Z' }));
    script.book.set(
      TICKER,
      orderbookJson([
        ['0.9300', '30.00'],
        ['0.9400', '20.00'],
      ]),
    );
    await replay(t, setup.executor);

    const repos = t.manager.repositories;
    const trades = repos.trades.list().filter((x) => x.game_id === GAME);
    expect(trades).toHaveLength(1);
    const trade = must(trades[0], 'trade');
    expect(trade).toMatchObject({
      status: 'filled',
      effective_mode: 'dry_run',
      configured_mode: 'dry_run',
      mode_reason: 'addon_lock',
      fill_cc: 200,
      avg_fill_price_bp: 9400,
      cost_micros: 1_880_000,
      fee_micros: 7900,
    });
    expect(repos.settings.get('dry_run_bankroll_micros')).toBe(98_112_100);

    script.market.set(
      TICKER,
      marketJson(TICKER, { status: 'finalized', result: 'yes', settlement_value_dollars: '1.0000' }),
    );
    expect(await setup.settler.runOnce()).toMatchObject({ settled: 1 });
    expect(repos.settings.get('dry_run_bankroll_micros')).toBe(100_112_100);

    const audit = repos.auditLog.listForEntity('trade', trade.id);
    expect(audit.filter((a) => a.action.startsWith('trade_')).map((a) => a.action)).toEqual([
      'trade_signalled',
      'trade_pending',
      'trade_filled',
      'trade_settled_won',
    ]);
    expect(audit.every((a) => a.mode === 'dry_run')).toBe(true);
    expect(repos.bankrollSnapshots.list().map((r) => [r.reason, r.bankroll_micros])).toEqual([
      ['fill', 98_112_100],
      ['settlement', 100_112_100],
    ]);

    // The Trades API shows it with its snapshot, attempts and audit trail.
    const list = (await c.get('/api/trades')).json() as { trades: TradeView[] };
    expect(list.trades).toHaveLength(1);
    expect(list.trades[0]).toMatchObject({
      id: trade.id,
      strategyName: 'NHL lead at 55',
      effectiveMode: 'dry_run',
      configuredMode: 'dry_run',
      modeReason: 'addon_lock',
      kalshiEnv: 'demo',
      status: 'settled_won',
      score: '2-1',
      minute: 55,
      askAtTriggerBp: 9300,
      realizedPnlMicros: 112_100,
    });
    const detail = (await c.get(`/api/trades/${trade.id}`)).json() as TradeDetail;
    expect(detail.snapshot).toMatchObject({
      homeScore: 2,
      awayScore: 1,
      clock: { minute: 55, minuteSource: 'feed' },
    });
    expect(detail.snapshot?.observedAt).toEqual(expect.any(String));
    expect(detail.attemptsList).toMatchObject([
      { attemptNo: 1, status: 'filled', bestAskBp: 9300, limitPriceBp: 9400 },
    ]);
    expect(detail.audit.map((a) => a.action)).toContain('trade_settled_won');
  });
});

describe('trades API', () => {
  it('filters by mode, env, status, reason and strategy; 404 for an unknown id; 400 for a bad filter', async () => {
    const setup = await tradingApp();
    t = setup.app;
    const c = await setupUser(t.app);
    const repos = t.manager.repositories;
    const base = {
      strategy_version: 1,
      game_id: GAME,
      league_id: 'nhl',
      configured_mode: 'dry_run',
      trigger_snapshot: '{}',
      window_ends_at: '2026-10-15T04:00:00Z',
    };
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    repos.trades.insert({
      ...base,
      id: 't1',
      strategy_id: 's1',
      kalshi_env: 'demo',
      effective_mode: 'dry_run',
      status: 'filled',
      triggered_at: at(1),
    });
    repos.trades.insert({
      ...base,
      id: 't2',
      strategy_id: 's2',
      kalshi_env: 'demo',
      effective_mode: 'live',
      status: 'skipped',
      skip_reason: 'price',
      triggered_at: at(10),
    });
    repos.trades.insert({
      ...base,
      id: 't3',
      strategy_id: 's3',
      kalshi_env: 'prod',
      effective_mode: 'dry_run',
      status: 'waiting',
      skip_reason: 'liquidity',
      triggered_at: at(2),
    });
    repos.trades.insert({
      ...base,
      id: 't4',
      strategy_id: 's4',
      kalshi_env: 'demo',
      effective_mode: 'dry_run',
      status: 'settled_lost',
      triggered_at: at(40),
    });

    const ids = async (q: string) =>
      ((await c.get(`/api/trades${q}`)).json() as { trades: TradeView[] }).trades.map((x) => x.id);
    expect(await ids('')).toEqual(['t1', 't2', 't4']); // current env (demo), newest first
    expect(await ids('?env=prod')).toEqual(['t3']);
    expect(await ids('?mode=live')).toEqual(['t2']);
    expect(await ids('?mode=dry_run')).toEqual(['t1', 't4']);
    expect(await ids('?status=skipped&reason=price')).toEqual(['t2']);
    expect(await ids('?status=skipped&reason=liquidity')).toEqual([]);
    expect(await ids('?status=settled')).toEqual(['t4']);
    expect(await ids('?range=7d')).toEqual(['t1']);
    expect(await ids('?range=30d')).toEqual(['t1', 't2']);
    expect(await ids('?strategies=s2,s4')).toEqual(['t2', 't4']);
    expect(await ids('?sport=soccer')).toEqual([]);
    expect(await ids('?leagues=nhl&sport=hockey')).toEqual(['t1', 't2', 't4']);
    expect((await c.get('/api/trades?mode=all')).statusCode).toBe(400);
    expect((await c.get('/api/trades/nope')).statusCode).toBe(404);
    expect((await c.get('/api/trades/t2')).json()).toMatchObject({
      id: 't2',
      effectiveMode: 'live',
      attemptsList: [],
    });
    // Without a session: 401.
    expect((await new Client(t.app, DEV).get('/api/trades')).statusCode).toBe(401);
  });
});

describe('Settings → Trading: dry-run bankroll', () => {
  it('reset needs step-up; restores the initial value, writes an audit row and a bankroll_snapshots row (reset)', async () => {
    const setup = await tradingApp();
    t = setup.app;
    const c = await setupUser(t.app);
    const repos = t.manager.repositories;
    repos.settings.set('dry_run_bankroll_micros', 98_112_100);
    expect(
      (await c.postWithCsrf('/api/settings', { dry_run_initial_bankroll_micros: 250_000_000 })).json(),
    ).toMatchObject({ dry_run_initial_bankroll_micros: 250_000_000, dry_run_bankroll_micros: 98_112_100 });

    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    t.manager.current?.sqlite.prepare('UPDATE sessions SET last_auth_at = ?').run(old);
    const denied = await c.postWithCsrf('/api/settings/bankroll/reset');
    expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'reauth_required' }]);
    expect(repos.settings.get('dry_run_bankroll_micros')).toBe(98_112_100);

    expect((await c.postWithCsrf('/auth/reauth', { password: PASSWORD })).statusCode).toBe(200);
    const ok = await c.postWithCsrf('/api/settings/bankroll/reset');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ dry_run_bankroll_micros: 250_000_000 });
    expect(repos.bankrollSnapshots.list()).toMatchObject([
      { reason: 'reset', bankroll_micros: 250_000_000, trade_id: null },
    ]);
    const audit = repos.auditLog.listFor('dry_run_bankroll_reset', 'settings', 'dry_run_bankroll_micros');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ mode: 'dry_run', actor: 'user:alice' });
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({ fromMicros: 98_112_100, toMicros: 250_000_000 });
  });

  it('fee precision is a setting: 100 by default, 10000 accepted, 300 rejected (must divide $1)', async () => {
    const setup = await tradingApp();
    t = setup.app;
    const c = await setupUser(t.app);
    expect((await c.get('/api/settings')).json()).toMatchObject({ fee_balance_precision_micros: 100 });
    expect(
      (await c.postWithCsrf('/api/settings', { fee_balance_precision_micros: 10_000 })).json(),
    ).toMatchObject({ fee_balance_precision_micros: 10_000 });
    expect((await c.postWithCsrf('/api/settings', { fee_balance_precision_micros: 300 })).statusCode).toBe(
      400,
    );
    expect(
      (await c.postWithCsrf('/api/settings', { dry_run_initial_bankroll_micros: 12.5 })).statusCode,
    ).toBe(400);
  });
});
