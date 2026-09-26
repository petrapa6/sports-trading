/**
 * `npm run e2e:demo` (SPEC.md §14 T13) — places **one real IOC order for 1 contract** on the cheapest open
 * market of the Kalshi **demo** environment (paper money), records it as a live trade of the app in the local
 * database (the Trades page shows it with a `LIVE` badge and environment `demo`), reads it back via
 * `getOrders` + `client_order_id`, and prints the order id, `fill_count`, the fee comparison against the §2
 * formula at both balance precisions, and the trade row id.
 *
 * Without a demo key (`kalshiKeyId` + `kalshiPrivateKeyPath` in `config.local.json`, `kalshiEnv: "demo"`) it
 * prints `SKIPPED (no demo key)` and exits 0. It never runs against prod.
 */
import { destination, pino } from 'pino';
import { runDemoFeeCheck } from './e2e-demo-lib.js';
import { demoClient } from './kalshi-lib.js';

const setup = demoClient();
if (!setup) process.exit(0);
const { client, database } = setup;

try {
  const db = database.current;
  await runDemoFeeCheck({
    client,
    repos: database.repositories,
    log: pino({ level: 'warn' }, destination(2)),
    transaction: (fn) => (db ? db.sqlite.transaction(fn)() : fn()),
    print: (line) => console.log(line),
  });
  console.log('OK');
} catch (err) {
  console.error(`FAIL ${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  database.close();
}
