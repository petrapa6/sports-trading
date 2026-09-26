import { generateKeyPairSync, verify } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { feeMicros } from '../../../src/core/pricing.js';
import { KalshiApiError, type KalshiClient } from '../../../src/feeds/kalshi/client.js';
import { PSS_OPTIONS, loadSigningKey, signRequest, signedString } from '../../../src/feeds/kalshi/signing.js';
import { NetworkPaused } from '../../../src/feeds/network.js';
import {
  captureLogger,
  fixtureKey,
  kalshiMockServer,
  testClient,
  TEST_BASE,
  TEST_KEY_ID,
  must,
} from '../../helpers/kalshiMsw.js';
import { fixture } from '../../helpers/kalshiFixtures.js';

const mock = kalshiMockServer();
/** One logger for every client in this file: the log check at the end covers the whole run. */
const logs = captureLogger('debug');
const client = (opts: Parameters<typeof testClient>[0] = {}) => testClient({ log: logs.log, ...opts });

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  mock.server.resetHandlers();
  mock.requests.length = 0;
  mock.seen.length = 0;
});
afterAll(() => mock.server.close());

const last = () => must(mock.requests.at(-1));

describe('signing (SPEC.md §2)', () => {
  it('signs timestamp + METHOD + path with RSA-PSS/SHA-256; verifies with the same PSS parameters', () => {
    const msg = signedString(1700000000000, 'GET', '/trade-api/v2/portfolio/balance');
    expect(msg).toBe('1700000000000GET/trade-api/v2/portfolio/balance');
    const sig = signRequest(
      loadSigningKey(fixtureKey.pem),
      1700000000000,
      'GET',
      '/trade-api/v2/portfolio/balance',
    );
    expect(
      verify(
        'sha256',
        Buffer.from(msg),
        { key: fixtureKey.publicKey, ...PSS_OPTIONS },
        Buffer.from(sig, 'base64'),
      ),
    ).toBe(true);
  });

  it('signs a path with a query string without the query', () => {
    expect(signedString(1700000000000, 'get', '/trade-api/v2/portfolio/orders?limit=5')).toBe(
      '1700000000000GET/trade-api/v2/portfolio/orders',
    );
    const sig = signRequest(
      loadSigningKey(fixtureKey.pem),
      1700000000000,
      'GET',
      '/trade-api/v2/portfolio/orders?limit=5',
    );
    expect(
      verify(
        'sha256',
        Buffer.from('1700000000000GET/trade-api/v2/portfolio/orders'),
        { key: fixtureKey.publicKey, ...PSS_OPTIONS },
        Buffer.from(sig, 'base64'),
      ),
    ).toBe(true);
  });

  it('sends the three headers on every request, signed over the path without the query', async () => {
    await client().getOrders({ ticker: 'X' });
    const r = must(mock.requests[0]);
    expect(r.headers.get('kalshi-access-key')).toBe(TEST_KEY_ID);
    const ts = must(r.headers.get('kalshi-access-timestamp'));
    expect(ts).toMatch(/^\d{13}$/);
    expect(r.url.search).not.toBe('');
    const ok = verify(
      'sha256',
      Buffer.from(`${ts}GET${r.url.pathname}`),
      { key: fixtureKey.publicKey, ...PSS_OPTIONS },
      Buffer.from(must(r.headers.get('kalshi-access-signature')), 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('rejects a non-RSA key', () => {
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => loadSigningKey(ed)).toThrow(/RSA/);
  });
});

describe('every method against a fixture returns typed integers', () => {
  let c: KalshiClient;
  beforeAll(() => {
    c = client();
  });

  it('getBalance', async () => {
    expect(await c.getBalance()).toEqual({ cash_micros: 123_450_000, portfolio_value_micros: 1_860_000 });
    expect(last().url.pathname).toBe('/trade-api/v2/portfolio/balance');
    expect(last().url.searchParams.has('subaccount')).toBe(false);
  });

  it('getBalance with a subaccount sends it', async () => {
    await client({ subaccount: 3 }).getBalance();
    expect(last().url.searchParams.get('subaccount')).toBe('3');
  });

  it('getExchangeStatus / getExchangeSchedule', async () => {
    expect(await c.getExchangeStatus()).toMatchObject({ exchange_active: true, trading_active: true });
    const s = await c.getExchangeSchedule();
    expect(s.schedule.maintenance_windows?.[0]?.start_datetime).toBe('2026-10-15T07:00:00Z');
  });

  it('listSeries paginates; getSeries', async () => {
    const series = await c.listSeries({ category: 'Sports' });
    expect(series.map((s) => s.ticker)).toContain('KXLIGUE1GAME');
    expect(series).toHaveLength(8);
    expect(mock.requests.filter((r) => r.url.pathname.endsWith('/series'))).toHaveLength(2);
    expect(must(mock.requests[0]).url.searchParams.get('category')).toBe('Sports');
    expect((await c.getSeries('KXNHLGAME')).fee_multiplier).toBe(1);
  });

  it('listEvents (one page, cursor) / listAllEvents / getEvent', async () => {
    const page = await c.listEvents('KXNHLGAME', 'open', true);
    expect(page.cursor).toBe('cursor-nhl-2');
    expect(page.items[0]?.markets[0]).toMatchObject({ yes_bid_bp: 4100, yes_ask_bp: 4300 });
    expect(last().url.searchParams.get('with_nested_markets')).toBe('true');
    expect(last().url.searchParams.get('status')).toBe('open');
    const all = await c.listAllEvents('KXNHLGAME', 'open', true);
    expect(all.map((e) => e.competition)).toEqual(['Pro Hockey', 'Pro Hockey Preseason']);
    const ev = await c.getEvent('KXEPLGAME-26FEB07WOLCFC');
    expect(ev.markets).toHaveLength(3);
    expect(ev.fee_multiplier).toBe(1);
  });

  it('listMilestones', async () => {
    const ms = await c.listMilestones({ relatedEventTicker: 'KXEPLGAME-26FEB07WOLCFC' });
    expect(ms[0]).toMatchObject({
      id: 'b3f0c1d2-0002-4000-8000-000000000003',
      start_date: '2027-02-07T15:00:00Z',
    });
    expect(last().url.searchParams.get('related_event_ticker')).toBe('KXEPLGAME-26FEB07WOLCFC');
  });

  it('getMarket / getHistoricalMarket (settlement value in bp; sub-cent price ranges kept as strings)', async () => {
    const m = await c.getMarket('KXNHLGAME-26OCT10UTAVGK-VGK');
    expect(m).toMatchObject({
      ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
      yes_bid_bp: 5700,
      yes_ask_bp: 5900,
      settlement_value_bp: null,
    });
    expect(m.price_ranges).toEqual([{ start: '0.0100', end: '0.9900', step: '0.0100' }]);
    const h = await c.getHistoricalMarket('KXNHLGAME-26SEP24UTAVGK-VGK');
    expect(h).toMatchObject({ status: 'finalized', result: 'yes', settlement_value_bp: 10_000 });
    expect(last().url.pathname).toBe('/trade-api/v2/historical/markets/KXNHLGAME-26SEP24UTAVGK-VGK');
  });

  it('getOrderbook: a NO bid "0.0700" × "50.00" becomes a YES ask {9300, 5000}', async () => {
    const ob = await c.getOrderbook('KXNHLGAME-26OCT10UTAVGK-VGK');
    expect(ob.yes_asks[0]).toEqual({ price_bp: 9300, size_cc: 5000 });
    expect(ob.yes_asks).toEqual([
      { price_bp: 9300, size_cc: 5000 },
      { price_bp: 9400, size_cc: 1250 },
    ]);
    expect(ob.yes_bids[0]).toEqual({ price_bp: 9200, size_cc: 1000 });
  });

  it('getOrderbook accepts the legacy integer format', async () => {
    mock.use(
      http.get(`${TEST_BASE}/markets/:t/orderbook`, () =>
        HttpResponse.json({ orderbook: { yes: [[92, 10]], no: [[7, 50]] } }),
      ),
    );
    expect((await c.getOrderbook('X')).yes_asks).toEqual([{ price_bp: 9300, size_cc: 5000 }]);
  });

  it('getCandlesticks: URL and parsed candle (ask_close_bp, bid_close_bp, nullable trade_close_bp)', async () => {
    const candles = await c.getCandlesticks('KXNHLGAME', 'KXNHLGAME-26OCT10UTAVGK-VGK', {
      startMs: 1791684000_000,
      endMs: 1791684120_000,
    });
    const r = last();
    expect(r.url.pathname).toBe(
      '/trade-api/v2/series/KXNHLGAME/markets/KXNHLGAME-26OCT10UTAVGK-VGK/candlesticks',
    );
    expect(r.url.search).toBe('?start_ts=1791684000&end_ts=1791684120&period_interval=1');
    expect(candles[0]).toEqual({
      end_period_ms: 1791684060_000,
      ask_open_bp: 5800,
      ask_high_bp: 5900,
      ask_low_bp: 5800,
      ask_close_bp: 5900,
      bid_close_bp: 5700,
      trade_close_bp: 5800,
      volume_cc: 12000,
    });
    expect(candles[1]).toMatchObject({
      ask_close_bp: 5900,
      bid_close_bp: 5700,
      trade_close_bp: null,
      volume_cc: 0,
    });
  });

  it('getHistoricalCandlesticks / getHistoricalCutoff', async () => {
    const candles = await c.getHistoricalCandlesticks('KXNHLGAME-26SEP24UTAVGK-VGK', {
      startMs: 0,
      endMs: 60_000,
    });
    expect(last().url.pathname).toBe(
      '/trade-api/v2/historical/markets/KXNHLGAME-26SEP24UTAVGK-VGK/candlesticks',
    );
    expect(candles).toHaveLength(2);
    expect((await c.getHistoricalCutoff()).market_settled_ms).toBe(Date.parse('2026-06-25T00:00:00Z'));
  });

  it('getLiveData / getLiveDataBatch / getGameStats', async () => {
    expect((await c.getLiveData('b3f0c1d2-0001-4000-8000-000000000001')).details['home_points']).toBe(2);
    const batch = await c.getLiveDataBatch(['m1', 'm2']);
    expect(batch).toHaveLength(2);
    expect(last().url.searchParams.get('milestone_ids')).toBe('m1,m2');
    expect(await c.getLiveDataBatch([])).toEqual([]);
    const gs = await c.getGameStats('m1');
    expect(gs.pbp?.periods[0]?.events).toHaveLength(1);
    expect(last().url.pathname).toBe('/trade-api/v2/live_data/milestone/m1/game_stats');
  });

  it('createOrderV2: body, endpoint and parsed fill/fee', async () => {
    const r = await c.createOrderV2({
      ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
      contracts: 2,
      priceBp: 9400,
      clientOrderId: 'trade-1-1',
      orderGroupId: 'grp-1',
    });
    const req = last();
    expect(req.method).toBe('POST');
    expect(req.url.pathname).toBe('/trade-api/v2/portfolio/events/orders');
    expect(JSON.parse(req.body)).toEqual({
      ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
      side: 'bid',
      count: '2',
      price: '0.9400',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: 'trade-1-1',
      order_group_id: 'grp-1',
    });
    expect(r).toMatchObject({ fill_cc: 200, avg_fill_price_bp: 9300, fee_micros: 9200, remaining_cc: 0 });
    expect(r.fee_micros).toBe(feeMicros({ cc: 200, bp: 9300 }));
  });

  it('createOrderV2 adds subaccount when > 0', async () => {
    await client({ subaccount: 2 }).createOrderV2({
      ticker: 'T',
      contracts: 1,
      priceBp: 9000,
      clientOrderId: 'x-1',
      orderGroupId: 'g',
    });
    expect(JSON.parse(last().body)).toMatchObject({ subaccount: 2 });
  });

  it('getOrders sends ticker and min_ts (never client_order_id) and paginates; getHistoricalOrders', async () => {
    const orders = await c.getOrders({ ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK', minTs: 1791684000_500 });
    expect(orders.map((o) => o.client_order_id)).toEqual(['trade-1-1', 'trade-2-1']);
    expect(orders[0]).toMatchObject({
      fill_cc: 200,
      yes_price_bp: 9400,
      taker_fill_cost_micros: 1_860_000,
      taker_fees_micros: 9200,
    });
    expect(mock.requests).toHaveLength(2);
    for (const r of mock.requests) {
      expect(r.url.searchParams.get('ticker')).toBe('KXNHLGAME-26OCT10UTAVGK-VGK');
      expect(r.url.searchParams.get('min_ts')).toBe('1791684000');
      expect(r.url.searchParams.has('client_order_id')).toBe(false);
    }
    expect(must(mock.requests[1]).url.searchParams.get('cursor')).toBe('cursor-orders-2');
    expect(await c.getHistoricalOrders({ ticker: 'T' })).toHaveLength(2);
    expect(last().url.pathname).toBe('/trade-api/v2/historical/orders');
  });

  it('getPositions / getSettlements / getFills', async () => {
    expect(await c.getPositions()).toEqual([
      {
        ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
        position_cc: 200,
        market_exposure_micros: 1_860_000,
        realized_pnl_micros: 0,
        fees_paid_micros: 9200,
      },
    ]);
    expect((await c.getSettlements())[0]).toMatchObject({
      revenue_micros: 2_000_000,
      yes_count_cc: 200,
      settlement_value_bp: 10_000,
    });
    expect((await c.getFills())[0]).toMatchObject({
      count_cc: 200,
      yes_price_bp: 9300,
      fee_micros: 9200,
      client_order_id: 'trade-1-1',
    });
  });

  it('order groups and upgradeApiUsageLevel', async () => {
    expect(await c.createOrderGroup(200)).toBe('grp-1');
    expect(JSON.parse(last().body)).toEqual({ contracts_limit: 200 });
    expect(await c.getOrderGroup('grp-1')).toMatchObject({ is_auto_cancel_enabled: false });
    await c.resetOrderGroup('grp-1');
    expect(last()).toMatchObject({ method: 'PUT' });
    expect(last().url.pathname).toBe('/trade-api/v2/portfolio/order_groups/grp-1/reset');
    await c.upgradeApiUsageLevel();
    expect(last().method).toBe('POST');
  });

  it('an extra unknown field passes; a fixture missing ticker fails with a ZodError naming ticker', async () => {
    const m = await c.getMarket('X');
    expect((m.raw as Record<string, unknown>)['some_future_field']).toEqual({ nested: true });
    mock.use(http.get(`${TEST_BASE}/markets/:t`, () => HttpResponse.json(fixture('market_missing_ticker'))));
    const err = await c.getMarket('X').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues.map((i) => i.path.join('.'))).toContain('market.ticker');
    expect((err as ZodError).message).toContain('ticker');
  });

  it('a 4xx throws KalshiApiError with the status and code', async () => {
    mock.use(
      http.get(`${TEST_BASE}/portfolio/balance`, () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'bad signature' } }, { status: 401 }),
      ),
    );
    const err = await c.getBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KalshiApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
  });
});

describe('network gate', () => {
  it('with global_kill_switch=true every method rejects with NetworkPaused and no request is made', async () => {
    const c = client({ killSwitch: () => true });
    const calls: [string, () => Promise<unknown>][] = [
      ['getBalance', () => c.getBalance()],
      ['getExchangeStatus', () => c.getExchangeStatus()],
      ['getExchangeSchedule', () => c.getExchangeSchedule()],
      ['listSeries', () => c.listSeries()],
      ['getSeries', () => c.getSeries('KXNHLGAME')],
      ['listEvents', () => c.listEvents('KXNHLGAME', 'open', true)],
      ['listAllEvents', () => c.listAllEvents('KXNHLGAME')],
      ['getEvent', () => c.getEvent('E')],
      ['listMilestones', () => c.listMilestones({ relatedEventTicker: 'E' })],
      ['getMarket', () => c.getMarket('T')],
      ['getHistoricalMarket', () => c.getHistoricalMarket('T')],
      ['getOrderbook', () => c.getOrderbook('T')],
      ['getCandlesticks', () => c.getCandlesticks('S', 'T', { startMs: 0, endMs: 1 })],
      ['getHistoricalCandlesticks', () => c.getHistoricalCandlesticks('T', { startMs: 0, endMs: 1 })],
      ['getHistoricalCutoff', () => c.getHistoricalCutoff()],
      ['getLiveData', () => c.getLiveData('m')],
      ['getLiveDataBatch', () => c.getLiveDataBatch(['m'])],
      ['getGameStats', () => c.getGameStats('m')],
      [
        'createOrderV2',
        () =>
          c.createOrderV2({
            ticker: 'T',
            contracts: 1,
            priceBp: 9000,
            clientOrderId: 'a',
            orderGroupId: 'g',
          }),
      ],
      ['getOrders', () => c.getOrders({ ticker: 'T' })],
      ['getHistoricalOrders', () => c.getHistoricalOrders()],
      ['getPositions', () => c.getPositions()],
      ['getSettlements', () => c.getSettlements()],
      ['getFills', () => c.getFills()],
      ['createOrderGroup', () => c.createOrderGroup(10)],
      ['getOrderGroup', () => c.getOrderGroup('g')],
      ['resetOrderGroup', () => c.resetOrderGroup('g')],
      ['upgradeApiUsageLevel', () => c.upgradeApiUsageLevel()],
      ['getRaw', () => c.getRaw('/exchange/status')],
    ];
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter(
      (n) =>
        n !== 'constructor' &&
        !['request', 'paginate', 'cost', 'subaccountQuery', 'candleQuery', 'ordersFrom', 'tokens'].includes(
          n,
        ),
    );
    expect(calls.map(([n]) => n).sort()).toEqual(methods.sort());
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toBeInstanceOf(NetworkPaused);
    }
    expect(mock.seen).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });

  it('reads the switch on every call (never cached)', async () => {
    let on = true;
    const c = client({ killSwitch: () => on });
    await expect(c.getExchangeStatus()).rejects.toBeInstanceOf(NetworkPaused);
    on = false;
    await expect(c.getExchangeStatus()).resolves.toMatchObject({ trading_active: true });
  });
});

describe('logging', () => {
  it('logs from the whole client run never contain the key id or any /portfolio response body', () => {
    const text = logs.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('"path":"/trade-api/v2/portfolio/balance"');
    expect(text).not.toContain(TEST_KEY_ID);
    for (const needle of [
      '123.4500',
      'ord-7f3a',
      'trade-1-1',
      '1.860000',
      'fill-1',
      'bad signature',
      'KALSHI-ACCESS',
    ]) {
      expect(text, needle).not.toContain(needle);
    }
    // Only method + path: no query strings.
    expect(text).not.toMatch(/"path":"[^"]*\?/);
  });
});
