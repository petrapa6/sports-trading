import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { logLines } from '../../helpers/feeds.js';
import { kalshiMockServer } from '../../helpers/kalshiMsw.js';
import {
  GAME,
  hockeyState,
  HOME_TICKER,
  KalshiScript,
  marketJson,
  orderbookJson,
  setupTrading,
  T0,
  type Trading,
} from '../../helpers/trading.js';

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
  mock.server.resetHandlers();
  t?.cleanup();
});

const INITIAL = 100_000_000;

function tradeOf(strategyId: string) {
  const row = t.repos.trades.findByStrategyAndGame(strategyId, GAME);
  if (!row) throw new Error('no trade');
  return row;
}
const bankroll = () => t.repos.settings.get('dry_run_bankroll_micros');
const snapshots = () => t.repos.bankrollSnapshots.list();

describe('order of operations', () => {
  it('the trade_attempts insert precedes the market / orderbook requests', async () => {
    t = setupTrading();
    const id = t.strategy();
    const attemptsWhen: Record<string, { n: number; status: string | undefined }> = {};
    script.onRequest = (path) => {
      const rows = t.repos.tradeAttempts.list();
      attemptsWhen[path] ??= { n: rows.length, status: rows[0]?.status };
    };
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(50, 3, 1));
    expect(attemptsWhen[`GET /markets/${HOME_TICKER}`]).toEqual({ n: 1, status: 'pending' });
    expect(attemptsWhen[`GET /markets/${HOME_TICKER}/orderbook`]).toEqual({ n: 1, status: 'pending' });
    expect(t.repos.tradeAttempts.list()[0]).toMatchObject({
      client_order_id: `${tradeOf(id).id}-1`,
      attempt_no: 1,
      status: 'filled',
    });
  });

  it('an orderbook request that throws → attempt error, trade waiting, error logged, nothing thrown', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.bookError = true;
    await expect(t.tick(hockeyState(50, 3, 1))).resolves.toBeUndefined();
    const trade = tradeOf(id);
    expect(trade).toMatchObject({ status: 'waiting', skip_reason: 'error', attempts: 1 });
    const [attempt] = t.repos.tradeAttempts.listForTrade(trade.id);
    expect(attempt).toMatchObject({ status: 'error', reason: 'error' });
    expect(JSON.parse(attempt?.response ?? '{}')).toMatchObject({ name: 'KalshiNetworkError' });
    const errors = logLines(t.logs.text()).filter((l) => l.level === 50);
    expect(errors.some((l) => l.msg.startsWith('Attempt 1 failed (error)') && l['mode'] === 'dry_run')).toBe(
      true,
    );
    expect(bankroll()).toBe(INITIAL);
  });
});

describe('guards: each names its reason and leaves the bankroll alone', () => {
  const cases: [string, (t: Trading) => void, Record<string, unknown>, string, string][] = [
    [
      'market closed → skipped / market_closed (hard)',
      () => script.market.set(HOME_TICKER, marketJson(HOME_TICKER, { status: 'closed' })),
      {},
      'skipped',
      'market_closed',
    ],
    [
      'trading_active:false → waiting / exchange_paused',
      () => (script.tradingActive = false),
      {},
      'waiting',
      'exchange_paused',
    ],
    [
      'newest observation 20 s old with maxFeedAgeSec 15 → waiting / stale_feed',
      (x) => x.clock.advance(20_000),
      {},
      'waiting',
      'stale_feed',
    ],
    [
      'blocked → waiting / feed_blocked',
      (x) => x.repos.games.update({ id: GAME }, { blocked: 1 }),
      {},
      'waiting',
      'feed_blocked',
    ],
    [
      'ask 0.98 vs maxPrice 0.97 → waiting / price',
      () => script.setAsk(HOME_TICKER, '0.9800'),
      {},
      'waiting',
      'price',
    ],
    [
      'ask 0.40 with minPrice 0.80 → waiting / min_price',
      () => script.setAsk(HOME_TICKER, '0.4000'),
      { execution: { maxPrice: 0.97, minPrice: 0.8 } },
      'waiting',
      'min_price',
    ],
    [
      '5 contracts ≤ limit vs minDepthContracts 20 → waiting / liquidity',
      () => script.setAsk(HOME_TICKER, '0.9300', '5.00'),
      {},
      'waiting',
      'liquidity',
    ],
    [
      'bankroll $1 at 2 % with minStakeUsd 0.01 → skipped / too_small',
      (x) => x.repos.settings.set('dry_run_bankroll_micros', 1_000_000),
      { sizing: { percent: 2, minStakeUsd: 0.01, maxStakeUsd: 50 } },
      'skipped',
      'too_small',
    ],
  ];

  it.each(cases)('%s', async (_name, arrange, def, status, reason) => {
    t = setupTrading();
    const id = t.strategy(def);
    script.setAsk(HOME_TICKER, '0.9300');
    arrange(t);
    const before = bankroll();
    await t.tick(hockeyState(50, 3, 1, { observedAt: T0 }));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({ status, skip_reason: reason, attempts: 1, fill_cc: null });
    const [attempt] = t.repos.tradeAttempts.listForTrade(trade.id);
    expect(attempt).toMatchObject({ status: status === 'skipped' ? 'hard_skip' : 'soft_skip', reason });
    expect(bankroll()).toBe(before);
    expect(snapshots()).toEqual([]);
  });
});

describe('retry within the window', () => {
  it('tick 1 ask 0.98 → waiting (1 attempt); tick 2 ask 0.96 → filled at limit 0.97, 2 attempts', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', skip_reason: 'price', attempts: 1 });

    script.setAsk(HOME_TICKER, '0.9600');
    t.clock.advance(30_000);
    await t.tick(hockeyState(51, 3, 1, { observedAt: t.clock.ms }));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({
      status: 'filled',
      attempts: 2,
      limit_price_bp: 9700,
      avg_fill_price_bp: 9700,
    });
    expect(
      t.repos.tradeAttempts.listForTrade(trade.id).map((a) => [a.attempt_no, a.status, a.reason]),
    ).toEqual([
      [1, 'soft_skip', 'price'],
      [2, 'filled', null],
    ]);
  });

  it('a window that ends with the ask still above maxPrice → skipped, skip_reason price, window_expired 1', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.setAsk(HOME_TICKER, '0.9800');
    for (const minute of [50, 51, 52, 53]) {
      t.clock.advance(60_000);
      await t.tick(hockeyState(minute, 3, 1, { observedAt: t.clock.ms }));
    }
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', attempts: 4 });
    const requests = script.log.length;
    t.clock.advance(60_000);
    await t.tick(hockeyState(54, 3, 1, { observedAt: t.clock.ms }));
    expect(tradeOf(id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'price',
      window_expired: 1,
      attempts: 4,
    });
    expect(script.log.length).toBe(requests);
  });

  it('lead dropping to 1 mid-window → no attempt on those ticks', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    const requests = script.log.length;
    t.clock.advance(30_000);
    await t.tick(hockeyState(51, 3, 2, { observedAt: t.clock.ms }));
    t.clock.advance(30_000);
    await t.tick(hockeyState(52, 3, 2, { observedAt: t.clock.ms }));
    expect(tradeOf(id)).toMatchObject({ status: 'waiting', attempts: 1 });
    expect(script.log.length).toBe(requests);
    // The lead is back while the window is open → the next attempt.
    script.setAsk(HOME_TICKER, '0.9500');
    t.clock.advance(30_000);
    await t.tick(hockeyState(53, 4, 2, { observedAt: t.clock.ms }));
    expect(tradeOf(id)).toMatchObject({ status: 'filled', attempts: 2 });
  });
});

describe('happy path (dry run)', () => {
  it('$100, 2 %, ask 0.93 with 50 contracts ≤ 0.94 → 200 cc at 9400, cost 1 880 000, fee 7 900, bankroll 98 112 100', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.book.set(
      HOME_TICKER,
      orderbookJson([
        ['0.9300', '30.00'],
        ['0.9400', '20.00'],
        ['0.9600', '100.00'],
      ]),
    );
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({
      status: 'filled',
      effective_mode: 'dry_run',
      configured_mode: 'dry_run',
      mode_reason: 'addon_lock',
      kalshi_env: 'demo',
      balance_micros: INITIAL,
      stake_micros: 2_000_000,
      limit_price_bp: 9400,
      requested_cc: 200,
      fill_cc: 200,
      avg_fill_price_bp: 9400,
      cost_micros: 1_880_000,
      fee_micros: 7900,
      market_ticker: HOME_TICKER,
    });
    expect(bankroll()).toBe(98_112_100);
    expect(snapshots()).toMatchObject([{ reason: 'fill', trade_id: trade.id, bankroll_micros: 98_112_100 }]);
    const snap = JSON.parse(trade.trigger_snapshot) as Record<string, unknown>;
    expect(snap).toMatchObject({
      homeScore: 3,
      awayScore: 1,
      side: 'home',
      minute: 50,
      clock: { minute: 50, minuteSource: 'feed' },
      orderbook: { bestAskBp: 9300, bestBidBp: 9000 },
    });
    // Every state change is audited with entity 'trade' and the mode.
    const audit = t.repos.auditLog.listForEntity('trade', trade.id);
    expect(audit.map((a) => a.action)).toEqual([
      'trade_signalled',
      'attempt_pending',
      'trade_pending',
      'attempt_filled',
      'trade_filled',
    ]);
    expect(audit.every((a) => a.mode === 'dry_run' && a.entity === 'trade')).toBe(true);
    // The fill log line carries its mode.
    expect(logLines(t.logs.text()).find((l) => l.msg.startsWith('Dry-run fill'))?.['mode']).toBe('dry_run');
  });

  it('maxStakeUsd 1 → 1 contract', async () => {
    t = setupTrading();
    const id = t.strategy({ sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 1 } });
    script.book.set(
      HOME_TICKER,
      orderbookJson([
        ['0.9300', '30.00'],
        ['0.9400', '20.00'],
      ]),
    );
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      stake_micros: 1_000_000,
      requested_cc: 100,
      fill_cc: 100,
    });
    // 1 contract at $0.94: fee $0.0040.
    expect(bankroll()).toBe(INITIAL - 940_000 - 4000);
  });

  it('only 1 contract offered ≤ limit → 1 contract', async () => {
    t = setupTrading();
    const id = t.strategy({ execution: { maxPrice: 0.97, minDepthContracts: 1 } });
    script.book.set(
      HOME_TICKER,
      orderbookJson([
        ['0.9300', '1.00'],
        ['0.9800', '100.00'],
      ]),
    );
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      requested_cc: 200,
      fill_cc: 100,
      cost_micros: 940_000,
    });
  });

  it('two strategies on one game fill in the same tick: both debits land, one after the other', async () => {
    t = setupTrading();
    const a = t.strategy({ name: 'A' });
    const b = t.strategy({ name: 'B' });
    script.book.set(
      HOME_TICKER,
      orderbookJson([
        ['0.9300', '30.00'],
        ['0.9400', '20.00'],
      ]),
    );
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(a).status).toBe('filled');
    expect(tradeOf(b).status).toBe('filled');
    // The second stake is 2 % of the already debited bankroll: $1.96 → 2 contracts all the same.
    expect(bankroll()).toBe(INITIAL - 2 * 1_887_900);
    expect(snapshots().map((s) => s.bankroll_micros)).toEqual([98_112_100, 96_224_200]);
    expect(
      [tradeOf(a).balance_micros, tradeOf(b).balance_micros].sort((x, y) => (x ?? 0) - (y ?? 0)),
    ).toEqual([98_112_100, INITIAL]);
  });
});

describe('restart recovery', () => {
  async function pendingAttempt(windowOpen: boolean) {
    t = setupTrading();
    const id = t.strategy();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    // A crash mid-attempt 10 minutes ago: a pending attempt row, the trade still waiting.
    const tenMinAgo = new Date(t.clock.ms - 10 * 60_000).toISOString();
    t.repos.tradeAttempts.insert({
      trade_id: trade.id,
      attempt_no: 2,
      at: tenMinAgo,
      effective_mode: 'dry_run',
      mode_reason: 'addon_lock',
      client_order_id: `${trade.id}-2`,
      status: 'pending',
    });
    t.repos.trades.update(
      { id: trade.id },
      {
        attempts: 2,
        window_ends_at: new Date(t.clock.ms + (windowOpen ? 5 : -5) * 60_000).toISOString(),
      },
    );
    return trade.id;
  }

  it('window closed → attempt unfilled / restart, trade skipped', async () => {
    const id = await pendingAttempt(false);
    t.executor.recoverOnStart();
    expect(t.repos.tradeAttempts.findByClientOrderId(`${id}-2`)).toMatchObject({
      status: 'unfilled',
      reason: 'restart',
    });
    expect(t.repos.trades.get({ id })).toMatchObject({
      status: 'skipped',
      window_expired: 1,
      skip_reason: 'price',
    });
  });

  it('window still open → trade waiting', async () => {
    const id = await pendingAttempt(true);
    t.executor.recoverOnStart();
    expect(t.repos.tradeAttempts.findByClientOrderId(`${id}-2`)).toMatchObject({
      status: 'unfilled',
      reason: 'restart',
    });
    expect(t.repos.trades.get({ id })).toMatchObject({ status: 'waiting', window_expired: 0 });
  });
});

describe('modes', () => {
  it('configured live with allow_live_orders=false → fills as dry run (LIVE → DRY RUN (add-on lock))', async () => {
    t = setupTrading({ allowLiveOrders: false });
    const id = t.strategy({}, { mode: 'live' });
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({
      status: 'filled',
      configured_mode: 'live',
      effective_mode: 'dry_run',
      mode_reason: 'addon_lock',
    });
    expect(bankroll()).toBeLessThan(INITIAL);
  });

  it('allow_live_orders=true, global dry run off, mode live → hard_skip / live_not_implemented, nothing crashes', async () => {
    t = setupTrading({ allowLiveOrders: true });
    t.repos.settings.set('global_dry_run', false);
    const id = t.strategy({}, { mode: 'live' });
    script.setAsk(HOME_TICKER, '0.9300');
    await t.tick(hockeyState(50, 3, 1));
    const trade = tradeOf(id);
    expect(trade).toMatchObject({
      status: 'skipped',
      skip_reason: 'live_not_implemented',
      configured_mode: 'live',
      effective_mode: 'live',
      mode_reason: null,
    });
    expect(t.repos.tradeAttempts.listForTrade(trade.id)).toMatchObject([
      { status: 'hard_skip', reason: 'live_not_implemented', effective_mode: 'live' },
    ]);
    expect(script.log).toEqual([]);
    expect(bankroll()).toBe(INITIAL);
  });

  it('a strategy kill switch turned on mid-window → the next attempt is hard_skip / paused', async () => {
    t = setupTrading();
    const id = t.strategy();
    script.setAsk(HOME_TICKER, '0.9800');
    await t.tick(hockeyState(50, 3, 1));
    t.repos.strategies.update({ id }, { kill_switch: 1 });
    await t.tick(hockeyState(51, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'skipped', skip_reason: 'paused', attempts: 2 });
  });

  it('a signal without a market → trade skipped / no_market, no attempt', async () => {
    t = setupTrading();
    const id = t.strategy();
    t.repos.markets.delete({ ticker: HOME_TICKER });
    await t.tick(hockeyState(50, 3, 1));
    expect(tradeOf(id)).toMatchObject({ status: 'skipped', skip_reason: 'no_market', attempts: 0 });
    expect(script.log).toEqual([]);
  });
});
