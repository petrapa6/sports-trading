import { EventEmitter } from 'node:events';
import { http, HttpResponse } from 'msw';
import { bpToDollars } from '../../src/core/decimal.js';
import { evaluateLeadAtTime, StrategyEngine } from '../../src/core/engine.js';
import { Executor, PENDING_LIVE_MIN_AGE_MS } from '../../src/core/executor.js';
import { OrderGroupManager } from '../../src/core/orderGroup.js';
import { Settler } from '../../src/core/settler.js';
import { StrategyDefinitionSchema, type StrategyDefinitionInput } from '../../src/core/strategy.js';
import { createStrategy } from '../../src/core/strategyStore.js';
import type { GameTracker, TrackedState } from '../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import type { KalshiClient } from '../../src/feeds/kalshi/client.js';
import { tempDb, type TempDb } from './db.js';
import { seedGame } from './feeds.js';
import { captureLogger, TEST_BASE, testClient } from './kalshiMsw.js';

/**
 * Shared set-up for the T09 executor / settler tests: a migrated database with one NHL game (home VGK, away
 * SEA) and its two markets, an engine and an executor attached to a fake tracker, and a Kalshi client pointed
 * at the msw stand-in.
 */

export const GAME = 'KXNHLGAME-26OCT14SEAVGK';
export const HOME_TICKER = `${GAME}-VGK`;
export const AWAY_TICKER = `${GAME}-SEA`;
export const T0 = Date.parse('2026-10-15T03:30:00Z');

/** A mutable clock the executor, settler and engine read. */
export class Clock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** A Kalshi market as `GET /markets/{ticker}` returns it. */
export function marketJson(ticker: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: {
      ticker,
      event_ticker: GAME,
      status: 'active',
      close_time: '2026-10-16T05:00:00Z',
      yes_bid_dollars: '0.9100',
      yes_ask_dollars: '0.9300',
      result: '',
      price_level_structure: 'linear_cent',
      price_ranges: [{ start: '0.0100', end: '0.9900', step: '0.0100' }],
      ...overrides,
    },
  };
}

/**
 * An orderbook whose YES asks are `asks` (`[price, contracts]`, dollars strings), given as the NO bids Kalshi
 * returns (`1 − ask`), plus YES bids.
 */
export function orderbookJson(
  asks: readonly (readonly [string, string])[],
  bids: readonly (readonly [string, string])[] = [['0.9000', '10.00']],
): Record<string, unknown> {
  const toBp = (d: string) => {
    const [w = '0', f = ''] = d.split('.');
    return Number.parseInt(w, 10) * 10_000 + Number.parseInt(f.padEnd(4, '0').slice(0, 4), 10);
  };
  return {
    orderbook_fp: {
      yes_dollars: bids.map(([p, s]) => [p, s]),
      no_dollars: asks.map(([p, s]) => [bpToDollars(10_000 - toBp(p)), s]),
    },
  };
}

/** Per-ticker market / orderbook / exchange answers for the msw stand-in; tests change them between ticks. */
export class KalshiScript {
  market = new Map<string, Record<string, unknown>>();
  book = new Map<string, Record<string, unknown>>();
  tradingActive = true;
  /** Paths requested (method + pathname), in order. */
  readonly log: string[] = [];
  /** Called when a request arrives (before answering). */
  onRequest: ((path: string) => void) | null = null;
  bookError: boolean = false;

  // ---- live (T13) ----
  /** `GET /portfolio/balance` → `balance_dollars`. */
  balanceDollars = '100.0000';
  /** Create Order V2 answer: status and JSON (default: everything filled at the limit, fee 0.0046 / contract). */
  orderAnswer: (body: Record<string, unknown>) => { status: number; json: Record<string, unknown> } = (
    body,
  ) => ({
    status: 201,
    json: {
      order_id: `ord-${this.orderBodies.length}`,
      client_order_id: body['client_order_id'],
      fill_count: `${String(body['count'])}.00`,
      remaining_count: '0.00',
      average_fill_price: body['price'],
      average_fee_paid: '0.0046',
      ts_ms: 1_791_684_065_123,
    },
  });
  /** Create Order V2 fails without an HTTP answer (the order's outcome is unknown to the app). */
  orderNetworkError = false;
  /** Bodies of every Create Order V2 request, in order. */
  readonly orderBodies: Record<string, unknown>[] = [];
  /** `GET /portfolio/orders` and `GET /historical/orders` answers, and the URLs requested. */
  orders: Record<string, unknown>[] = [];
  historicalOrders: Record<string, unknown>[] = [];
  readonly orderQueries: URL[] = [];
  /** `GET /portfolio/settlements` answer. */
  settlements: Record<string, unknown>[] = [];
  /** Answers of the order-group endpoints (status only; 200 by default). */
  orderGroupStatus = 200;

  setAsk(ticker: string, ask: string, contracts = '50.00'): void {
    this.book.set(ticker, orderbookJson([[ask, contracts]]));
  }

  handlers() {
    const seen = (req: Request) => {
      const p = `${req.method} ${new URL(req.url).pathname.replace('/trade-api/v2', '')}`;
      this.log.push(p);
      this.onRequest?.(p);
    };
    return [
      http.get(`${TEST_BASE}/markets/:ticker/orderbook`, ({ request, params }) => {
        seen(request);
        if (this.bookError) return HttpResponse.error();
        return HttpResponse.json(this.book.get(String(params['ticker'])) ?? orderbookJson([]));
      }),
      http.get(`${TEST_BASE}/markets/:ticker`, ({ request, params }) => {
        seen(request);
        const t = String(params['ticker']);
        return HttpResponse.json(this.market.get(t) ?? marketJson(t));
      }),
      http.get(`${TEST_BASE}/historical/markets/:ticker`, ({ request, params }) => {
        seen(request);
        const t = String(params['ticker']);
        return HttpResponse.json(this.market.get(t) ?? marketJson(t));
      }),
      http.get(`${TEST_BASE}/exchange/status`, ({ request }) => {
        seen(request);
        return HttpResponse.json({ exchange_active: true, trading_active: this.tradingActive });
      }),
      http.get(`${TEST_BASE}/events/:ticker`, ({ request, params }) => {
        seen(request);
        return HttpResponse.json({
          event: { event_ticker: String(params['ticker']), series_ticker: 'KXNHLGAME', fee_multiplier: null },
          markets: [],
        });
      }),
      http.get(`${TEST_BASE}/series/:ticker`, ({ request, params }) => {
        seen(request);
        return HttpResponse.json({ series: { ticker: String(params['ticker']), fee_multiplier: 1 } });
      }),
      http.get(`${TEST_BASE}/historical/cutoff`, ({ request }) => {
        seen(request);
        return HttpResponse.json({ market_settled_ts: '2026-06-25T00:00:00Z' });
      }),
      http.get(`${TEST_BASE}/portfolio/balance`, ({ request }) => {
        seen(request);
        return HttpResponse.json({ balance_dollars: this.balanceDollars, portfolio_value_dollars: '0.0000' });
      }),
      http.post(`${TEST_BASE}/portfolio/events/orders`, async ({ request }) => {
        seen(request);
        const body = (await request.json()) as Record<string, unknown>;
        this.orderBodies.push(body);
        if (this.orderNetworkError) return HttpResponse.error();
        const a = this.orderAnswer(body);
        return HttpResponse.json(a.json, { status: a.status });
      }),
      http.get(`${TEST_BASE}/portfolio/orders`, ({ request }) => {
        seen(request);
        this.orderQueries.push(new URL(request.url));
        return HttpResponse.json({ orders: this.orders, cursor: '' });
      }),
      http.get(`${TEST_BASE}/historical/orders`, ({ request }) => {
        seen(request);
        this.orderQueries.push(new URL(request.url));
        return HttpResponse.json({ orders: this.historicalOrders, cursor: '' });
      }),
      http.get(`${TEST_BASE}/portfolio/settlements`, ({ request }) => {
        seen(request);
        const ticker = new URL(request.url).searchParams.get('ticker');
        return HttpResponse.json({
          settlements: this.settlements.filter((x) => ticker === null || x['ticker'] === ticker),
          cursor: '',
        });
      }),
      http.post(`${TEST_BASE}/portfolio/order_groups/create`, ({ request }) => {
        seen(request);
        return HttpResponse.json({ order_group_id: 'grp-new' }, { status: 201 });
      }),
      http.get(`${TEST_BASE}/portfolio/order_groups/:id`, ({ request }) => {
        seen(request);
        return this.orderGroupStatus === 200
          ? HttpResponse.json({ is_auto_cancel_enabled: false, orders: [] })
          : HttpResponse.json(
              { error: { code: 'not_found', message: 'order group not found' } },
              { status: this.orderGroupStatus },
            );
      }),
      http.put(`${TEST_BASE}/portfolio/order_groups/:id/reset`, ({ request }) => {
        seen(request);
        return this.orderGroupStatus === 200
          ? HttpResponse.json({})
          : HttpResponse.json(
              { error: { code: 'not_found', message: 'order group not found' } },
              { status: this.orderGroupStatus },
            );
      }),
    ];
  }
}

/** Fires `stateUpdated` like the GameTracker. */
export class FakeTracker extends EventEmitter<{ stateUpdated: [TrackedState]; gameReset: [string] }> {}

/** A hockey state at elapsed `minute` (period and seconds left derived), home − away score. */
export function hockeyState(
  minute: number,
  home: number,
  away: number,
  opts: { observedAt?: number; phase?: TrackedState['phase']; blocked?: boolean } = {},
): TrackedState {
  const period = Math.min(3, Math.floor(minute / 20) + 1);
  const secondsLeft = 1200 - (minute - (period - 1) * 20) * 60;
  return {
    gameId: GAME,
    leagueId: 'nhl',
    homeTeam: 'Vegas Golden Knights',
    awayTeam: 'Seattle Kraken',
    homeScore: home,
    awayScore: away,
    phase: opts.phase ?? 'live',
    clock: { minute, minuteSource: 'feed', period, secondsLeftInPeriod: secondsLeft, regulationOver: false },
    source: 'kalshi-live',
    observedAt: new Date(opts.observedAt ?? T0),
    blocked: opts.blocked ?? false,
  };
}

export interface Trading {
  tdb: TempDb;
  repos: Repositories;
  clock: Clock;
  tracker: FakeTracker;
  engine: StrategyEngine;
  executor: Executor;
  settler: Settler;
  orderGroups: OrderGroupManager;
  client: KalshiClient;
  logs: ReturnType<typeof captureLogger>;
  /** Creates a hockey strategy on NHL (kill switch off), returns its id. */
  strategy(def?: Partial<StrategyDefinitionInput>, opts?: { mode?: 'live' | 'dry_run' }): string;
  /** Emits a state and waits until every queued attempt finished. */
  tick(state: TrackedState): Promise<void>;
  cleanup(): void;
}

export const HOCKEY_RULE = { type: 'lead_at_time', minLead: 2, atMinute: 50, windowMinutes: 3 } as const;

export function setupTrading(
  opts: { allowLiveOrders?: boolean; killSwitch?: () => boolean; subaccount?: number } = {},
): Trading {
  const tdb = tempDb();
  const clock = new Clock();
  const repos = createRepositories(tdb.db.orm, clock.now);
  seedGame(repos, {
    id: GAME,
    leagueId: 'nhl',
    scheduledAt: '2026-10-15T02:00:00Z',
    home: 'VGK',
    away: 'SEA',
    phase: 'live',
  });
  repos.markets.insert({
    ticker: HOME_TICKER,
    game_id: GAME,
    outcome: 'home',
    status: 'open',
    close_time: '2026-10-16T05:00:00Z',
    updated_at: clock.iso(),
  });
  repos.markets.insert({
    ticker: AWAY_TICKER,
    game_id: GAME,
    outcome: 'away',
    status: 'open',
    close_time: '2026-10-16T05:00:00Z',
    updated_at: clock.iso(),
  });
  const logs = captureLogger('debug');
  const tracker = new FakeTracker();
  const allowLiveOrders = opts.allowLiveOrders ?? false;
  const engine = new StrategyEngine({
    repos: () => repos,
    log: logs.log,
    allowLiveOrders,
    now: clock.now,
    evaluate: evaluateLeadAtTime,
  }).attach(tracker as unknown as GameTracker);
  const client = testClient({
    killSwitch: opts.killSwitch ?? (() => repos.settings.get('global_kill_switch')),
    subaccount: opts.subaccount ?? 0,
  });
  // Live orders carry the stored order group (T13); `OrderGroupManager` reuses it without a request.
  repos.settings.set('kalshi_order_group_id', 'grp-1');
  const orderGroups = new OrderGroupManager({
    repos: () => repos,
    log: logs.log,
    kalshi: () => client,
    allowLiveOrders,
    now: clock.now,
  });
  const transaction = (fn: () => void) => tdb.db.sqlite.transaction(fn)();
  const executor = new Executor({
    repos: () => repos,
    log: logs.log,
    kalshi: () => client,
    allowLiveOrders,
    kalshiEnv: 'demo',
    transaction,
    orderGroups,
    now: clock.now,
  }).attach(engine, tracker as unknown as GameTracker);
  const settler = new Settler({
    repos: () => repos,
    log: logs.log,
    kalshi: () => client,
    transaction,
    now: clock.now,
    beforeRun: async () => {
      executor.sweep();
      await executor.resolvePendingLive('order_not_found', PENDING_LIVE_MIN_AGE_MS);
    },
  });
  return {
    tdb,
    repos,
    clock,
    tracker,
    engine,
    executor,
    settler,
    orderGroups,
    client,
    logs,
    strategy(def = {}, o = {}) {
      const parsed = StrategyDefinitionSchema.parse({
        name: 'NHL 2-goal lead at 50',
        sport: 'hockey',
        leagueIds: ['nhl'],
        rule: HOCKEY_RULE,
        sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
        execution: { maxPrice: 0.97, maxSlippage: 0.01, minDepthContracts: 20, maxFeedAgeSec: 15 },
        ...def,
      });
      const s = createStrategy(repos, parsed, clock.iso());
      repos.strategies.update({ id: s.id }, { kill_switch: 0, mode: o.mode ?? 'dry_run' });
      return s.id;
    },
    async tick(state) {
      tracker.emit('stateUpdated', state);
      await executor.idle();
    },
    cleanup: () => tdb.cleanup(),
  };
}
