/**
 * `npm run kalshi:smoke` (SPEC.md §14 T06) — read-only checks against the Kalshi **demo** environment:
 * environment, subaccount, balance, exchange status, and the number of open events per enabled series
 * (0 is fine off-season). Without a demo key (`kalshiKeyId` + `kalshiPrivateKeyPath` in
 * `config.local.json`, `kalshiEnv: "demo"`) it prints `SKIPPED (no demo key)` and exits 0.
 */
import { formatMicros } from './kalshi-format.js';
import { demoClient } from './kalshi-lib.js';

const setup = demoClient();
if (!setup) process.exit(0);
const { client, database } = setup;

try {
  console.log(`environment: ${client.env} (${client.baseUrl})`);
  console.log(`subaccount: ${client.subaccount}`);
  const balance = await client.getBalance();
  console.log(
    `balance: ${formatMicros(balance.cash_micros)}` +
      (balance.portfolio_value_micros !== null
        ? ` (portfolio value ${formatMicros(balance.portfolio_value_micros)})`
        : ''),
  );
  const status = await client.getExchangeStatus();
  console.log(`exchange: exchange_active=${status.exchange_active} trading_active=${status.trading_active}`);
  console.log('open events per enabled series:');
  for (const league of database.repositories.leagues.listEnabled()) {
    const events = await client.listAllEvents(league.kalshi_series, 'open', false);
    console.log(`  ${league.id.padEnd(10)} ${league.kalshi_series.padEnd(18)} ${events.length}`);
  }
  console.log('OK');
} catch (err) {
  console.error(`FAIL ${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  database.close();
}
