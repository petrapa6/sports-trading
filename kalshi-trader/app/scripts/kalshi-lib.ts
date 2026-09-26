/**
 * Shared set-up for the Kalshi command-line scripts (`kalshi:smoke`, `fixtures:record:kalshi`): loads the
 * configuration, and builds a client for the **demo** environment when a key is configured.
 */
import { destination, pino } from 'pino';
import { ConfigError, loadConfig, readPrivateKey, type Config } from '../src/config.js';
import { DatabaseManager } from '../src/db/database.js';
import { KalshiClient } from '../src/feeds/kalshi/client.js';
import { createNetworkGate } from '../src/feeds/network.js';

export interface ScriptKalshi {
  config: Config;
  client: KalshiClient;
  database: DatabaseManager;
}

/**
 * The client, or `undefined` after printing `SKIPPED (no demo key)` when no key id / private key is
 * configured or the configured environment is not `demo`. Logs go to stderr (warn and above), so
 * stdout carries only the script's own output. The network gate honours the global kill switch in the
 * local database.
 */
export function demoClient(): ScriptKalshi | undefined {
  let config: Config;
  let pem: string | undefined;
  try {
    config = loadConfig().config;
    pem = readPrivateKey(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (config.kalshiKeyId === undefined || pem === undefined) {
    console.log('SKIPPED (no demo key)');
    return undefined;
  }
  if (config.kalshiEnv !== 'demo') {
    console.log(
      `SKIPPED (no demo key: kalshiEnv is ${config.kalshiEnv}; this script runs against demo only)`,
    );
    return undefined;
  }
  const log = pino({ level: 'warn' }, destination(2));
  const database = new DatabaseManager(config.dbPath, log);
  database.open();
  // `KALSHI_SCRIPT_BASE_URL`: point the script at a stand-in (verify:T06 uses test/e2e/fake-kalshi.ts).
  const baseUrl = process.env['KALSHI_SCRIPT_BASE_URL'];
  const client = new KalshiClient({
    env: 'demo',
    keyId: config.kalshiKeyId,
    privateKey: pem,
    subaccount: config.kalshiSubaccount,
    gate: createNetworkGate(() => database.repositories.settings.get('global_kill_switch')),
    log,
    ...(baseUrl ? { baseUrl } : {}),
  });
  return { config, client, database };
}
