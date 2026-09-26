import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDemoFeeCheck } from '../../../scripts/e2e-demo-lib.js';
import { listTrades } from '../../../src/core/trades.js';
import { createRepositories } from '../../../src/db/repositories.js';
import { tempDb } from '../../helpers/db.js';
import { captureLogger, kalshiMockServer, testClient } from '../../helpers/kalshiMsw.js';

/**
 * `npm run e2e:demo` (T13) against the recorded-fixture stand-in: the order flow, the read-back by
 * client_order_id and the fee comparison. (Against the real demo exchange it needs a key; see T13.md.)
 */
const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());

describe('e2e:demo fee check (fixture stand-in)', () => {
  it('orders 1 contract on the cheapest open market, records a LIVE demo trade, reads it back, compares the fee', async () => {
    const tdb = tempDb();
    try {
      const repos = createRepositories(tdb.db.orm);
      const lines: string[] = [];
      const r = await runDemoFeeCheck({
        client: testClient(),
        repos,
        log: captureLogger().log,
        transaction: (fn) => tdb.db.sqlite.transaction(fn)(),
        print: (l) => lines.push(l),
      });
      // The cheapest priced market of the fixture list is the 0.08 one; its orderbook (fixture) asks 0.93.
      expect(r.ticker).toBe('KXNHLGAME-26OCT10UTAVGK-UTA');
      const order = mock.requests.find(
        (q) => q.method === 'POST' && q.url.pathname.endsWith('/portfolio/events/orders'),
      );
      expect(JSON.parse(order?.body ?? '{}')).toMatchObject({
        ticker: 'KXNHLGAME-26OCT10UTAVGK-UTA',
        count: '1',
        price: '0.9300',
        time_in_force: 'immediate_or_cancel',
        client_order_id: `${r.tradeId}-1`,
        order_group_id: 'grp-1',
      });
      // The fixture response: 2.00 filled at 0.93, fee 0.0046 per contract → 9200 = the formula at $0.0001.
      expect(r).toMatchObject({ orderId: 'ord-7f3a', fillCc: 200, exchangeFeeMicros: 9200, matches: 100 });
      expect(r.modelFeeMicros).toEqual({ 100: 9200, 10000: 10000 });
      expect(lines.join('\n')).toMatch(
        /order id: ord-7f3a[\s\S]*fill_count: 2\.00[\s\S]*matches fee_balance_precision_micros=100[\s\S]*trade row id: /,
      );
      const [trade] = listTrades(repos, { mode: 'live', kalshiEnv: 'demo' });
      expect(trade).toMatchObject({
        id: r.tradeId,
        effectiveMode: 'live',
        kalshiEnv: 'demo',
        status: 'filled',
        fillCc: 200,
      });
      // The read-back queries by ticker and min_ts, never by client_order_id.
      const lookups = mock.requests.filter((q) => q.url.pathname.endsWith('/portfolio/orders'));
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.every((q) => !q.url.searchParams.has('client_order_id'))).toBe(true);
    } finally {
      tdb.cleanup();
    }
  });
});
