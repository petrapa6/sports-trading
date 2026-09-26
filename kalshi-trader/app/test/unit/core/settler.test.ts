import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let t: Trading | undefined;

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
beforeEach(() => {
  script = new KalshiScript();
  mock.use(...script.handlers());
});
afterEach(() => {
  t?.settler.stop();
  vi.useRealTimers();
  mock.server.resetHandlers();
  t?.cleanup();
  t = undefined;
});

function must(x: Trading | undefined): Trading {
  if (!x) throw new Error('no trading set-up');
  return x;
}

/** The happy-path fill: 200 cc at 9400, cost 1 880 000, fee 7 900, bankroll 98 112 100. */
async function filledTrade(): Promise<{ x: Trading; tradeId: string }> {
  const x = setupTrading();
  t = x;
  const id = x.strategy();
  script.book.set(
    HOME_TICKER,
    orderbookJson([
      ['0.9300', '30.00'],
      ['0.9400', '20.00'],
    ]),
  );
  await x.tick(hockeyState(50, 3, 1));
  const trade = x.repos.trades.findByStrategyAndGame(id, GAME);
  if (trade?.status !== 'filled') throw new Error(`not filled: ${trade?.status}`);
  expect(x.repos.settings.get('dry_run_bankroll_micros')).toBe(98_112_100);
  return { x, tradeId: trade.id };
}

const settledMarket = (value: string) =>
  marketJson(HOME_TICKER, {
    status: 'settled',
    result: value === '1.0000' ? 'yes' : value === '0.0000' ? 'no' : '',
    settlement_value_dollars: value,
  });

/** Advances fake time to the next settler run and lets its requests finish. */
async function nextMinute(x: Trading): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(async () => {
    await x.settler.runOnce();
  });
}

describe('settler (fake timers, msw)', () => {
  it.each([
    ['1.0000', 'settled_won', 2_000_000, 112_100, 100_112_100],
    ['0.0000', 'settled_lost', 0, -1_887_900, 98_112_100],
    ['0.5000', 'settled_void', 1_000_000, -887_900, 99_112_100],
  ])(
    'settlement value %s → %s, payout %i, P&L %i, bankroll %i, one bankroll_snapshots row',
    async (value, status, payout, pnl, bankroll) => {
      const { x, tradeId } = await filledTrade();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 + 60_000 });
      x.clock.ms = T0 + 60_000;
      script.market.set(HOME_TICKER, settledMarket(value));
      x.settler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(x.repos.trades.get({ id: tradeId })?.status).toBe(status));
      expect(x.repos.trades.get({ id: tradeId })).toMatchObject({
        settlement_value_bp: Number(value.replace('.', '')),
        payout_micros: payout,
        realized_pnl_micros: pnl,
      });
      expect(x.repos.settings.get('dry_run_bankroll_micros')).toBe(bankroll);
      const rows = x.repos.bankrollSnapshots.list().filter((r) => r.reason === 'settlement');
      expect(rows).toMatchObject([{ trade_id: tradeId, bankroll_micros: bankroll }]);
      const actions = x.repos.auditLog.listForEntity('trade', tradeId).map((a) => a.action);
      expect(actions.at(-1)).toBe(`trade_${status}`);
    },
  );

  it('a market still open → untouched and re-checked next minute', async () => {
    const { x, tradeId } = await filledTrade();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 + 60_000 });
    x.clock.ms = T0 + 60_000;
    script.market.set(HOME_TICKER, marketJson(HOME_TICKER, { status: 'active' }));
    const reads = () => script.log.filter((p) => p === `GET /markets/${HOME_TICKER}`).length;
    const before = reads();
    x.settler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('filled');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(reads()).toBe(before + 2));
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('filled');
    expect(x.repos.settings.get('dry_run_bankroll_micros')).toBe(98_112_100);

    script.market.set(HOME_TICKER, settledMarket('1.0000'));
    await nextMinute(x);
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('settled_won');
  });

  it('a market past the historical cutoff → read from /historical/markets/{ticker}', async () => {
    const { x, tradeId } = await filledTrade();
    // Closed before the cutoff (2026-06-25): only the historical endpoint has it.
    x.repos.markets.update({ ticker: HOME_TICKER }, { close_time: '2026-06-01T00:00:00Z' });
    script.market.set(HOME_TICKER, settledMarket('1.0000'));
    const before = script.log.length;
    const r = await x.settler.runOnce();
    expect(r).toMatchObject({ checked: 1, settled: 1 });
    const paths = script.log.slice(before);
    expect(paths).toContain(`GET /historical/markets/${HOME_TICKER}`);
    expect(paths).not.toContain(`GET /markets/${HOME_TICKER}`);
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('settled_won');
  });

  it('a 404 from /markets/{ticker} falls back to the historical endpoint', async () => {
    const { x, tradeId } = await filledTrade();
    const { http, HttpResponse } = await import('msw');
    const { TEST_BASE } = await import('../../helpers/kalshiMsw.js');
    mock.use(
      http.get(`${TEST_BASE}/markets/:ticker`, () =>
        HttpResponse.json({ error: { code: 'not_found' } }, { status: 404 }),
      ),
    );
    script.market.set(HOME_TICKER, settledMarket('0.0000'));
    await x.settler.runOnce();
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('settled_lost');
  });
});

describe('global kill switch', () => {
  it('on with filled and waiting trades → zero HTTP from executor and settler, states unchanged; off → settlement catches up', async () => {
    const { x, tradeId } = await filledTrade();
    // A second strategy with a waiting trade on the same game.
    const waitingId = x.strategy({ name: 'second' });
    script.setAsk(HOME_TICKER, '0.9800');
    await x.tick(hockeyState(51, 3, 1));
    const waiting = x.repos.trades.findByStrategyAndGame(waitingId, GAME);
    expect(waiting?.status).toBe('waiting');
    script.market.set(HOME_TICKER, settledMarket('1.0000'));

    x.repos.settings.set('global_kill_switch', true);
    const before = mock.seen.length;
    const scriptBefore = script.log.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 + 60_000 });
    x.settler.start();
    for (let i = 0; i < 5; i++) {
      // Ticks reach the executor (in production the scheduler is paused and sends none at all).
      await x.tick(hockeyState(52, 3, 1, { observedAt: Date.now() }));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(await x.settler.runOnce()).toMatchObject({ skipped: 'paused', checked: 0 });
    expect(mock.seen.length).toBe(before);
    expect(script.log.length).toBe(scriptBefore);
    expect(x.repos.trades.get({ id: tradeId })?.status).toBe('filled');
    expect(x.repos.trades.get({ id: waiting?.id ?? '' })).toMatchObject({ status: 'waiting', attempts: 1 });

    x.repos.settings.set('global_kill_switch', false);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(x.repos.trades.get({ id: tradeId })?.status).toBe('settled_won'));
    expect(must(t).repos.settings.get('dry_run_bankroll_micros')).toBe(100_112_100);
  });
});
