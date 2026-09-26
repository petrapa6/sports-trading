import { describe, expect, it } from 'vitest';
import { KalshiClient } from '../../../src/feeds/kalshi/client.js';
import { testClient } from '../../helpers/kalshiMsw.js';

/**
 * SPEC.md §10 Blast radius (T13): the Kalshi client exposes no deposit, withdrawal or transfer method. Every
 * method on the client is listed here; adding one fails this test until it is reviewed and listed, and a name
 * mentioning money movement fails it whatever the list says.
 */
export const ALLOWED_METHODS = [
  // plumbing (private in TypeScript, still on the prototype)
  'constructor',
  'tokens',
  'cost',
  'subaccountQuery',
  'request',
  'paginate',
  'candleQuery',
  'ordersFrom',
  'getRaw',
  // account and exchange
  'getBalance',
  'getExchangeStatus',
  'getExchangeSchedule',
  'upgradeApiUsageLevel',
  // series, events, milestones, markets, candles
  'listSeries',
  'getSeries',
  'listEvents',
  'listAllEvents',
  'getEvent',
  'listMilestones',
  'getMarket',
  'listMarkets',
  'getHistoricalMarket',
  'getOrderbook',
  'getCandlesticks',
  'getHistoricalCandlesticks',
  'getHistoricalCutoff',
  // live data
  'getLiveData',
  'getLiveDataBatch',
  'getGameStats',
  // orders and portfolio
  'createOrderV2',
  'getOrders',
  'getHistoricalOrders',
  'getPositions',
  'getSettlements',
  'getFills',
  'createOrderGroup',
  'getOrderGroup',
  'resetOrderGroup',
] as const;

const FORBIDDEN = /withdraw|deposit|transfer/i;

/** Every method name the client class (and its prototype chain below Object) defines. */
function clientMethods(): string[] {
  const names = new Set<string>();
  for (
    let p: object | null = KalshiClient.prototype;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const n of Object.getOwnPropertyNames(p)) names.add(n);
  }
  return [...names].sort();
}

describe('Kalshi client allow-list', () => {
  it('the client defines exactly the allowed methods', () => {
    expect(clientMethods()).toEqual([...ALLOWED_METHODS].sort());
  });

  it('no method (and no allowed name) mentions a deposit, withdrawal or transfer', () => {
    expect(clientMethods().filter((n) => FORBIDDEN.test(n))).toEqual([]);
    expect(ALLOWED_METHODS.filter((n) => FORBIDDEN.test(n))).toEqual([]);
  });

  it('no instance property of a constructed client is a function other than the injected fetch and clock', () => {
    const client = testClient() as unknown as Record<string, unknown>;
    const fns = Object.getOwnPropertyNames(client).filter((n) => typeof client[n] === 'function');
    expect(fns.sort()).toEqual(['fetchFn', 'now']);
  });
});
