import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BalanceRecorder } from '../../../src/core/balances.js';
import { snapshotBalanceOnLiveChanges, startTrading } from '../../../src/core/startup.js';
import { logLines } from '../../helpers/feeds.js';
import { kalshiMockServer, must } from '../../helpers/kalshiMsw.js';
import {
  GAME,
  hockeyState,
  HOME_TICKER,
  KalshiScript,
  marketJson,
  setupTrading,
  T0,
  type Trading,
} from '../../helpers/trading.js';

/**
 * T13: the live path of the executor (Create Order V2, sizing from the Kalshi balance, outcomes), start-up
 * recovery of pending live attempts, reconciliation with `/portfolio/settlements`, `balance_snapshots`, and the
 * switch matrix — Kalshi answered by the msw stand-in.
 */

const mock = kalshiMockServer();
let script: KalshiScript;
let t: Trading;

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
beforeEach(() => {
  script = new KalshiScript();
  mock.use(...script.handlers());
});
afterEach(() => {
  vi.useRealTimers();
  mock.server.resetHandlers();
  t?.cleanup();
});

const ORDER_PATH = 'POST /portfolio/events/orders';

function tradeOf(strategyId: string) {
  return must(t.repos.trades.findByStrategyAndGame(strategyId, GAME), 'trade');
}

/** Lock open, global dry run off, one live strategy on NHL; ask 0.93 with 50 contracts. */
function liveSetup(opts: { subaccount?: number; def?: Parameters<Trading['strategy']>[0] } = {}) {
  t = setupTrading({ allowLiveOrders: true, ...(opts.subaccount ? { subaccount: opts.subaccount } : {}) });
  t.repos.settings.set('global_dry_run', false);
  const id = t.strategy(opts.def ?? {}, { mode: 'live' });
  script.setAsk(HOME_TICKER, '0.9300');
  return id;
}

const warns = () => logLines(t.logs.text()).filter((l) => l.level === 40);

describe('order body', () => {
  it('ask 0.93, maxSlippage 0.01, maxPrice 0.97, stake 2 000 000 → the exact Create Order V2 body; the pending attempt exists before the request', async () => {
    const id = liveSetup();
    let atRequest: { attempt: unknown; trade: unknown } | undefined;
    script.onRequest = (path) => {
      if (path !== ORDER_PATH) return;
      const trade = tradeOf(id);
      atRequest = {
        trade: {
          status: trade.status,
          stake_micros: trade.stake_micros,
          limit_price_bp: trade.limit_price_bp,
        },
        attempt: t.repos.tradeAttempts
          .listForTrade(trade.id)
          .map((a) => ({ status: a.status, requested_cc: a.requested_cc, limit_price_bp: a.limit_price_bp })),
      };
    };
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(script.orderBodies).toEqual([
      {
        ticker: HOME_TICKER,
        side: 'bid',
        count: '2',
        price: '0.9400',
        time_in_force: 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross',
        client_order_id: `${trade.id}-1`,
        order_group_id: 'grp-1',
      },
    ]);
    expect(atRequest).toEqual({
      trade: { status: 'pending', stake_micros: 2_000_000, limit_price_bp: 9400 },
      attempt: [{ status: 'pending', requested_cc: 200, limit_price_bp: 9400 }],
    });
  });

  it('with KALSHI_SUBACCOUNT=3 the body also carries "subaccount": 3', async () => {
    liveSetup({ subaccount: 3 });
    await t.tick(hockeyState(50, 3, 1));
    expect(script.orderBodies).toHaveLength(1);
    expect(script.orderBodies[0]).toMatchObject({ count: '2', price: '0.9400', subaccount: 3 });
  });

  it('maxStakeUsd 1 with ask 0.93 → count "1"', async () => {
    liveSetup({ def: { sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 1 } } });
    await t.tick(hockeyState(50, 3, 1));
    expect(script.orderBodies.map((b) => b['count'])).toEqual(['1']);
  });
});

describe('order outcomes', () => {
  const answer =
    (json: Record<string, unknown>, status = 201) =>
    () => ({ status, json });

  it('fill_count "2.00", average_fill_price "0.9300", average_fee_paid "0.0046" → filled 200 cc at 9300, cost 1 860 000, fee 9 200, live', async () => {
    const id = liveSetup();
    script.orderAnswer = answer({
      order_id: 'ord-7f3a',
      fill_count: '2.00',
      remaining_count: '0.00',
      average_fill_price: '0.9300',
      average_fee_paid: '0.0046',
    });
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({
      status: 'filled',
      fill_cc: 200,
      avg_fill_price_bp: 9300,
      cost_micros: 1_860_000,
      fee_micros: 9200,
      effective_mode: 'live',
      mode_reason: null,
      kalshi_order_id: 'ord-7f3a',
      requested_cc: 200,
      limit_price_bp: 9400,
    });
    expect(t.repos.tradeAttempts.listForTrade(trade.id)).toMatchObject([
      {
        status: 'filled',
        fill_cc: 200,
        avg_fill_price_bp: 9300,
        fee_micros: 9200,
        kalshi_order_id: 'ord-7f3a',
      },
    ]);
    const actions = t.repos.auditLog
      .listForEntity('trade', trade.id)
      .filter((a) => a.action.startsWith('trade_'))
      .map((a) => [a.action, a.mode]);
    expect(actions).toEqual([
      ['trade_signalled', 'live'],
      ['trade_pending', 'live'],
      ['trade_filled', 'live'],
    ]);
    // Live fills never touch the dry-run bankroll.
    expect(t.repos.settings.get('dry_run_bankroll_micros')).toBe(100_000_000);
    expect(t.repos.bankrollSnapshots.list()).toEqual([]);
  });

  it('fill_count "1.00" (partial) → filled with 100 cc', async () => {
    const id = liveSetup();
    script.orderAnswer = answer({
      order_id: 'ord-1',
      fill_count: '1.00',
      remaining_count: '1.00',
      average_fill_price: '0.9300',
      average_fee_paid: '0.0046',
    });
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      fill_cc: 100,
      cost_micros: 930_000,
      fee_micros: 4600,
    });
  });

  it('fill_count "0.00" → attempt unfilled, trade waiting, retried on the next tick', async () => {
    const id = liveSetup();
    script.orderAnswer = answer({ order_id: 'ord-0', fill_count: '0.00', remaining_count: '2.00' });
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({ status: 'waiting', skip_reason: 'unfilled', attempts: 1, fill_cc: null });
    expect(t.repos.tradeAttempts.listForTrade(trade.id)).toMatchObject([
      { status: 'unfilled', reason: 'unfilled', kalshi_order_id: 'ord-0' },
    ]);

    script.orderAnswer = answer({
      order_id: 'ord-2',
      fill_count: '2.00',
      average_fill_price: '0.9300',
      average_fee_paid: '0.0046',
    });
    t.clock.advance(5_000);
    await t.tick(hockeyState(50, 3, 1, { observedAt: t.clock.ms }));
    expect(tradeOf(id)).toMatchObject({ status: 'filled', attempts: 2, fill_cc: 200 });
    expect(script.orderBodies.map((b) => b['client_order_id'])).toEqual([`${trade.id}-1`, `${trade.id}-2`]);
  });

  it.each([400, 409])('HTTP %i → skipped / order_rejected with the error message stored', async (status) => {
    const id = liveSetup();
    script.orderAnswer = answer({ error: { code: 'invalid_order', message: 'price out of range' } }, status);
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({ status: 'skipped', skip_reason: 'order_rejected', fill_cc: null });
    const [attempt] = t.repos.tradeAttempts.listForTrade(trade.id);
    expect(attempt).toMatchObject({ status: 'hard_skip', reason: 'order_rejected' });
    const response = JSON.parse(must(attempt?.response, 'response')) as Record<string, unknown>;
    expect(response).toMatchObject({ status, code: 'invalid_order' });
    expect(String(response['error'])).toContain('price out of range');
    // No retry after a hard rejection.
    await t.tick(hockeyState(51, 3, 1));
    expect(script.orderBodies).toHaveLength(1);
  });

  it('an order-group rejection → waiting / order_group_limit, one warn, the group marked in Settings', async () => {
    const id = liveSetup();
    script.orderAnswer = answer(
      { error: { code: 'order_group_limit_exceeded', message: 'order group contracts limit reached' } },
      409,
    );
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', skip_reason: 'order_group_limit' });
    expect(warns().filter((l) => /order group limit/.test(l.msg))).toHaveLength(1);
    expect(t.orderGroups.status()).toMatchObject({ state: 'limit_hit', id: 'grp-1' });
    // Settings → Trading "Reset" resets the group on the exchange and clears the mark.
    const reset = await t.orderGroups.reset();
    expect(reset).toMatchObject({ state: 'active', limitHitAt: null });
    expect(script.log).toContain('PUT /portfolio/order_groups/grp-1/reset');
  });

  it('an unknown outcome (no HTTP answer) → looked up by client_order_id and applied', async () => {
    const id = liveSetup();
    script.orderNetworkError = true;
    script.onRequest = (path) => {
      if (path !== ORDER_PATH) return;
      const trade = tradeOf(id);
      script.orders = [
        {
          order_id: 'ord-late',
          client_order_id: `${trade.id}-1`,
          ticker: HOME_TICKER,
          status: 'executed',
          fill_count_fp: '2.00',
          taker_fill_cost_dollars: '1.860000',
          taker_fees_dollars: '0.009200',
        },
      ];
    };
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      fill_cc: 200,
      cost_micros: 1_860_000,
      fee_micros: 9200,
    });
  });

  it('an unknown outcome and no such order at Kalshi → attempt error, trade waiting (retried)', async () => {
    const id = liveSetup();
    script.orderNetworkError = true;
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({ status: 'waiting', skip_reason: 'error' });
    expect(t.repos.tradeAttempts.listForTrade(trade.id)).toMatchObject([
      { status: 'error', reason: 'error' },
    ]);
    expect(script.log.filter((p) => p.endsWith('/orders'))).toEqual([
      ORDER_PATH,
      'GET /portfolio/orders',
      'GET /historical/orders',
    ]);
  });
});

describe('live sizing', () => {
  it('balance $100 with one pending live attempt costing $3 → sizing base 97 000 000 micros', async () => {
    const id = liveSetup();
    // Another trade of the app with a live attempt still pending: 300 cc at $1.0000 = $3.
    const other = t.repos.trades.insert({
      id: 'other-trade',
      strategy_id: 'other',
      strategy_version: 1,
      game_id: GAME,
      market_ticker: HOME_TICKER,
      league_id: 'nhl',
      kalshi_env: 'demo',
      configured_mode: 'live',
      effective_mode: 'live',
      status: 'pending',
      trigger_snapshot: '{}',
      triggered_at: new Date(T0).toISOString(),
      window_ends_at: new Date(T0 + 600_000).toISOString(),
    });
    t.repos.tradeAttempts.insert({
      trade_id: other.id,
      attempt_no: 1,
      at: new Date(T0).toISOString(),
      effective_mode: 'live',
      client_order_id: `${other.id}-1`,
      status: 'pending',
      limit_price_bp: 7500,
      requested_cc: 400,
    });
    expect(t.executor.pendingLiveCostMicros(t.repos)).toBe(3_000_000);
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ balance_micros: 97_000_000, stake_micros: 1_940_000 });
  });
});

describe('start-up recovery of pending live attempts', () => {
  /** A crash right after the order request: trade `pending`, attempt `pending` with limit and count. */
  async function crashedAttempt(windowOpen = true) {
    const id = liveSetup();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1)); // waiting / price: the trade row exists
    const trade = tradeOf(id);
    const at = new Date(t.clock.ms - 2 * 60_000).toISOString();
    t.repos.tradeAttempts.insert({
      trade_id: trade.id,
      attempt_no: 2,
      at,
      effective_mode: 'live',
      client_order_id: `${trade.id}-2`,
      status: 'pending',
      limit_price_bp: 9400,
      requested_cc: 200,
    });
    t.repos.trades.update(
      { id: trade.id },
      {
        status: 'pending',
        attempts: 2,
        window_ends_at: new Date(t.clock.ms + (windowOpen ? 5 : -5) * 60_000).toISOString(),
      },
    );
    return { trade, at };
  }

  it('getOrders returns the executed order with our client_order_id → trade filled with its values; no client_order_id in the query', async () => {
    const { trade, at } = await crashedAttempt();
    script.orders = [
      { order_id: 'someone-else', client_order_id: 'x-1', ticker: HOME_TICKER, fill_count_fp: '5.00' },
      {
        order_id: 'ord-9',
        client_order_id: `${trade.id}-2`,
        ticker: HOME_TICKER,
        status: 'executed',
        fill_count_fp: '2.00',
        remaining_count_fp: '0.00',
        yes_price_dollars: '0.9400',
        taker_fill_cost_dollars: '1.8600',
        taker_fees_dollars: '0.0092',
      },
    ];
    const out = await t.executor.recoverOnStart();
    expect(out.live).toEqual({ filled: 1, unfilled: 0, unresolved: 0 });
    expect(t.repos.trades.get({ id: trade.id })).toMatchObject({
      status: 'filled',
      fill_cc: 200,
      cost_micros: 1_860_000,
      fee_micros: 9200,
      avg_fill_price_bp: 9300,
      kalshi_order_id: 'ord-9',
      effective_mode: 'live',
    });
    expect(t.repos.tradeAttempts.findByClientOrderId(`${trade.id}-2`)).toMatchObject({
      status: 'filled',
      fill_cc: 200,
    });
    expect(script.orderQueries).toHaveLength(1);
    const q = must(script.orderQueries[0], 'query');
    expect(q.pathname).toMatch(/\/portfolio\/orders$/);
    expect(q.searchParams.get('ticker')).toBe(HOME_TICKER);
    expect(Number(q.searchParams.get('min_ts'))).toBe(Math.floor((Date.parse(at) - 60_000) / 1000));
    expect(q.searchParams.has('client_order_id')).toBe(false);
    expect(q.search).not.toContain(trade.id);
  });

  it('an empty list and an empty historical list → attempt unfilled / restart_no_order; trade waiting (window open) or skipped (closed)', async () => {
    const { trade } = await crashedAttempt(true);
    await t.executor.recoverOnStart();
    expect(t.repos.tradeAttempts.findByClientOrderId(`${trade.id}-2`)).toMatchObject({
      status: 'unfilled',
      reason: 'restart_no_order',
    });
    expect(t.repos.trades.get({ id: trade.id })).toMatchObject({
      status: 'waiting',
      skip_reason: 'restart_no_order',
    });
    expect(script.orderQueries.map((u) => u.pathname.replace('/trade-api/v2', ''))).toEqual([
      '/portfolio/orders',
      '/historical/orders',
    ]);
    expect(script.orderQueries.every((u) => !u.searchParams.has('client_order_id'))).toBe(true);
  });

  it('window closed → trade skipped with window_expired', async () => {
    const { trade } = await crashedAttempt(false);
    await t.executor.recoverOnStart();
    expect(t.repos.trades.get({ id: trade.id })).toMatchObject({
      status: 'skipped',
      skip_reason: 'restart_no_order',
      window_expired: 1,
    });
  });

  it('found in /historical/orders when the order is past the cutoff', async () => {
    const { trade } = await crashedAttempt();
    script.historicalOrders = [
      {
        order_id: 'ord-h',
        client_order_id: `${trade.id}-2`,
        ticker: HOME_TICKER,
        fill_count_fp: '1.00',
        taker_fill_cost_dollars: '0.9300',
        taker_fees_dollars: '0.0046',
      },
    ];
    await t.executor.recoverOnStart();
    expect(t.repos.trades.get({ id: trade.id })).toMatchObject({
      status: 'filled',
      fill_cc: 100,
      fee_micros: 4600,
    });
  });

  it('recovery completes before the first scheduler tick', async () => {
    const { trade } = await crashedAttempt();
    const events: string[] = [];
    script.onRequest = (path) => events.push(path);
    await startTrading({
      log: t.logs.log,
      recover: () => t.executor.recoverOnStart(),
      loops: [
        {
          start: () => {
            events.push(
              `scheduler.start (attempt ${t.repos.tradeAttempts.findByClientOrderId(`${trade.id}-2`)?.status})`,
            );
          },
        },
      ],
    });
    expect(events).toEqual([
      'GET /portfolio/orders',
      'GET /historical/orders',
      'scheduler.start (attempt unfilled)',
    ]);
  });

  it('a lookup that fails leaves the attempt pending; the settler loop resolves it later', async () => {
    const { trade } = await crashedAttempt();
    t.repos.settings.set('global_kill_switch', true);
    const out = await t.executor.recoverOnStart();
    expect(out.live).toEqual({ filled: 0, unfilled: 0, unresolved: 1 });
    expect(t.repos.trades.get({ id: trade.id })?.status).toBe('pending');
    t.repos.settings.set('global_kill_switch', false);
    await t.settler.runOnce();
    expect(t.repos.tradeAttempts.findByClientOrderId(`${trade.id}-2`)).toMatchObject({
      status: 'unfilled',
      reason: 'order_not_found',
    });
  });
});

describe('reconciliation with /portfolio/settlements', () => {
  async function filledLive() {
    const id = liveSetup();
    script.orderAnswer = () => ({
      status: 201,
      json: {
        order_id: 'ord-1',
        fill_count: '2.00',
        average_fill_price: '0.9300',
        average_fee_paid: '0.0046',
      },
    });
    await t.tick(hockeyState(50, 3, 1));
    script.market.set(
      HOME_TICKER,
      marketJson(HOME_TICKER, { status: 'finalized', result: 'yes', settlement_value_dollars: '1.0000' }),
    );
    return tradeOf(id);
  }

  it('revenue equal to the payout → settled_won, no reconcile_warning, no warn', async () => {
    const trade = await filledLive();
    script.settlements = [{ ticker: HOME_TICKER, revenue_dollars: '2.000000', value_dollars: '1.0000' }];
    expect(await t.settler.runOnce()).toMatchObject({ settled: 1 });
    expect(t.repos.trades.get({ id: trade.id })).toMatchObject({
      status: 'settled_won',
      payout_micros: 2_000_000,
      realized_pnl_micros: 2_000_000 - 1_860_000 - 9200,
      reconcile_warning: null,
    });
    expect(warns().filter((l) => /Reconciliation/.test(l.msg))).toEqual([]);
    expect(t.repos.settings.get('dry_run_bankroll_micros')).toBe(100_000_000);
  });

  it('revenue 20 000 micros different → reconcile_warning set and one warn', async () => {
    const trade = await filledLive();
    script.settlements = [{ ticker: HOME_TICKER, revenue_dollars: '1.980000', value_dollars: '1.0000' }];
    await t.settler.runOnce();
    const row = t.repos.trades.get({ id: trade.id });
    expect(row?.status).toBe('settled_won');
    expect(row?.reconcile_warning).toMatch(
      /revenue \$1\.9800 .* computed \$2\.0000 \(difference -\$0\.0200\)/,
    );
    const w = warns().filter((l) => /Reconciliation/.test(l.msg));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ mode: 'live', revenueMicros: 1_980_000, payoutMicros: 2_000_000 });
  });

  it('no settlement listed yet → the live trade waits (the market is re-checked on the next run)', async () => {
    const trade = await filledLive();
    await t.settler.runOnce();
    expect(t.repos.trades.get({ id: trade.id })?.status).toBe('filled');
    script.settlements = [{ ticker: HOME_TICKER, revenue_dollars: '2.000000' }];
    t.clock.advance(60_000);
    await t.settler.runOnce();
    expect(t.repos.trades.get({ id: trade.id })?.status).toBe('settled_won');
  });
});

describe('balance_snapshots', () => {
  function recorder() {
    return new BalanceRecorder({
      repos: () => t.repos,
      log: t.logs.log,
      kalshi: () => t.client,
      kalshiEnv: 'demo',
      subaccount: 0,
      now: t.clock.now,
    });
  }

  it('+15 min (fake timers) → one row', async () => {
    liveSetup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = recorder();
    r.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
    expect(t.repos.balanceSnapshots.list()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    r.stop();
    expect(t.repos.balanceSnapshots.list()).toMatchObject([
      { kalshi_env: 'demo', subaccount: 0, cash_micros: 100_000_000, portfolio_value_micros: 0 },
    ]);
  });

  it('after a live fill → an extra row within 1 s; after the live settlement → another', async () => {
    liveSetup();
    const r = recorder();
    snapshotBalanceOnLiveChanges(r, t.executor, t.settler);
    await t.tick(hockeyState(50, 3, 1));
    expect(t.repos.trades.list()[0]?.status).toBe('filled');
    await vi.waitFor(() => expect(t.repos.balanceSnapshots.list()).toHaveLength(1), { timeout: 1000 });
    script.market.set(
      HOME_TICKER,
      marketJson(HOME_TICKER, { status: 'finalized', result: 'yes', settlement_value_dollars: '1.0000' }),
    );
    script.settlements = [{ ticker: HOME_TICKER, revenue_dollars: '2.000000' }];
    await t.settler.runOnce();
    await vi.waitFor(() => expect(t.repos.balanceSnapshots.list()).toHaveLength(2), { timeout: 1000 });
  });

  it('global kill switch on → no rows and no requests', async () => {
    liveSetup();
    t.repos.settings.set('global_kill_switch', true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen = mock.seen.length;
    const r = recorder();
    r.start();
    r.recordSoon('fill');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    r.stop();
    expect(t.repos.balanceSnapshots.list()).toEqual([]);
    expect(mock.seen.length).toBe(seen);
  });
});

describe('switch matrix with a live-configured strategy', () => {
  it('allow_live_orders=false → zero order requests, trade dry_run / addon_lock', async () => {
    t = setupTrading({ allowLiveOrders: false });
    t.repos.settings.set('global_dry_run', false);
    const id = t.strategy({}, { mode: 'live' });
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(50, 3, 1));
    expect(script.log.filter((p) => p === ORDER_PATH)).toEqual([]);
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      effective_mode: 'dry_run',
      mode_reason: 'addon_lock',
    });
  });

  it('global dry run on → zero order requests, trade dry_run / global_dry_run', async () => {
    t = setupTrading({ allowLiveOrders: true });
    const id = t.strategy({}, { mode: 'live' });
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(50, 3, 1));
    expect(script.log.filter((p) => p === ORDER_PATH)).toEqual([]);
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      effective_mode: 'dry_run',
      mode_reason: 'global_dry_run',
    });
  });

  it('strategy kill switch turned on mid-window → skipped / paused, no order', async () => {
    const id = liveSetup();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', skip_reason: 'price' });
    t.repos.strategies.update({ id }, { kill_switch: 1 });
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(51, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'skipped', skip_reason: 'paused' });
    expect(script.orderBodies).toEqual([]);
  });

  it('strategy kill switch turned on between the reads and the order → paused, no order', async () => {
    const id = liveSetup();
    script.onRequest = (path) => {
      if (path === 'GET /portfolio/balance') t.repos.strategies.update({ id }, { kill_switch: 1 });
    };
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'skipped', skip_reason: 'paused' });
    expect(script.orderBodies).toEqual([]);
  });

  it('global kill switch on → zero requests of any kind', async () => {
    const id = liveSetup();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id).status).toBe('waiting');
    t.repos.settings.set('global_kill_switch', true);
    const seen = mock.seen.length;
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(51, 3, 1));
    await t.settler.runOnce();
    expect(mock.seen.length).toBe(seen);
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', attempts: 1 });
  });
});

describe('order group', () => {
  it('start-up reuses the stored group while Kalshi knows it, else creates one with order_group_contract_limit', async () => {
    liveSetup();
    expect(await t.orderGroups.ensure()).toBe('grp-1');
    expect(script.log).toEqual(['GET /portfolio/order_groups/grp-1']);
    script.orderGroupStatus = 404;
    t.repos.settings.set('order_group_contract_limit', 150);
    expect(await t.orderGroups.ensure()).toBe('grp-new');
    expect(t.repos.settings.get('kalshi_order_group_id')).toBe('grp-new');
    const created = t.repos.auditLog.list().filter((a) => a.action === 'order_group_created');
    expect(created).toMatchObject([
      { mode: 'live', detail: JSON.stringify({ orderGroupId: 'grp-new', contractsLimit: 150 }) },
    ]);
  });

  it('allow_live_orders=false → no order group requests, state disabled', async () => {
    t = setupTrading({ allowLiveOrders: false });
    expect(await t.orderGroups.ensure()).toBeNull();
    expect(t.orderGroups.status().state).toBe('disabled');
    expect(script.log).toEqual([]);
  });
});
