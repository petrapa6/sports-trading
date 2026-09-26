/**
 * The recorded-fixture stand-in for the Kalshi API, shared by the `msw` unit tests
 * (`kalshiMsw.ts`) and the Playwright stand-in server (`test/e2e/fake-kalshi.ts`).
 *
 * `routeKalshi` maps a request (path relative to `/trade-api/v2`) to a fixture file under
 * `test/fixtures/kalshi/`. Unknown paths answer `404 {"error":{"code":"not_found"}}`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/kalshi');
export const API_PREFIX = '/trade-api/v2';

/** A fixture as parsed JSON (a fresh copy on every call, so tests may modify it). */
export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
}

export interface FixtureResponse {
  status: number;
  body: unknown;
}

/** The fixture, or `404 not_found` when no fixture of that name exists (e.g. an event never recorded). */
const ok = (name: string): FixtureResponse =>
  existsSync(resolve(FIXTURE_DIR, `${name}.json`))
    ? { status: 200, body: fixture(name) }
    : { status: 404, body: { error: { code: 'not_found', message: `no fixture ${name}` } } };

/** Maps one request to its fixture; `path` is the pathname after `/trade-api/v2`. */
export function routeKalshi(method: string, path: string, query: URLSearchParams): FixtureResponse {
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const key = `${method} /${seg.join('/')}`;
  const [a, b, c, d] = seg;
  if (method === 'GET') {
    if (key === 'GET /portfolio/balance') return ok('balance');
    if (key === 'GET /exchange/status') return ok('exchange_status');
    if (key === 'GET /exchange/schedule') return ok('exchange_schedule');
    if (key === 'GET /series')
      return ok(query.get('cursor') === 'cursor-series-2' ? 'series_sports_page2' : 'series_sports_page1');
    if (a === 'series' && seg.length === 2) return ok(`series_${b ?? ''}`);
    if (key === 'GET /events') {
      const series = query.get('series_ticker');
      // Settled events (T11 backfill): `events_settled_<series>`, or none.
      if (query.get('status') === 'settled')
        return existsSync(resolve(FIXTURE_DIR, `events_settled_${series ?? ''}.json`))
          ? ok(`events_settled_${series ?? ''}`)
          : ok('events_empty');
      if (series === 'KXNHLGAME')
        return ok(
          query.get('cursor') === 'cursor-nhl-2' ? 'events_KXNHLGAME_page2' : 'events_KXNHLGAME_page1',
        );
      if (series === 'KXEPLGAME') return ok('events_KXEPLGAME');
      return ok('events_empty');
    }
    if (a === 'events' && seg.length === 2) return ok(`event_${b ?? ''}`);
    if (key === 'GET /milestones') return ok(`milestones_${query.get('related_event_ticker') ?? ''}`);
    if (a === 'markets' && seg.length === 2) return ok('market');
    if (a === 'markets' && c === 'orderbook') return ok('orderbook');
    if (a === 'series' && c === 'markets' && seg[4] === 'candlesticks') return ok('candlesticks');
    if (a === 'historical' && b === 'markets' && seg.length === 3) return ok('market_settled');
    if (a === 'historical' && b === 'markets' && d === 'candlesticks') return ok('candlesticks');
    if (key === 'GET /historical/cutoff') return ok('historical_cutoff');
    if (key === 'GET /live_data/batch') return ok('live_data_batch');
    if (a === 'live_data' && b === 'milestone' && seg.length === 3) return ok('live_data');
    if (a === 'live_data' && b === 'milestone' && d === 'game_stats')
      return existsSync(resolve(FIXTURE_DIR, `game_stats_${c ?? ''}.json`))
        ? ok(`game_stats_${c ?? ''}`)
        : ok('game_stats');
    if (key === 'GET /portfolio/orders' || key === 'GET /historical/orders')
      return ok(query.get('cursor') === 'cursor-orders-2' ? 'orders_page2' : 'orders_page1');
    if (key === 'GET /portfolio/positions') return ok('positions');
    if (key === 'GET /portfolio/settlements') return ok('settlements');
    if (key === 'GET /portfolio/fills') return ok('fills');
    if (a === 'portfolio' && b === 'order_groups' && seg.length === 3) return ok('order_group');
  }
  if (key === 'POST /portfolio/events/orders') return { status: 201, body: fixture('create_order') };
  if (key === 'POST /portfolio/order_groups/create')
    return { status: 201, body: fixture('order_group_create') };
  if (method === 'PUT' && a === 'portfolio' && b === 'order_groups' && d === 'reset') return ok('empty');
  if (key === 'POST /account/api_usage_level/upgrade') return ok('empty');
  return { status: 404, body: { error: { code: 'not_found', message: `no fixture for ${key}` } } };
}
