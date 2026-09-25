import { ConfigError, missingKalshiCredentials, readPrivateKey } from '../config.js';
import { startMaintenance } from '../core/maintenance.js';
import { DatabaseManager, DatabaseUnavailableError } from '../db/database.js';
import { buildApp } from './app.js';
import { loadConfigOrExit } from './boot.js';
import { createLogger } from './logger.js';

const { config, configLocalPath } = loadConfigOrExit();
if (config.tz !== undefined) process.env['TZ'] = config.tz;

const log = createLogger(config.logLevel);

let privateKey: string | undefined;
try {
  privateKey = readPrivateKey(config);
} catch (err) {
  if (err instanceof ConfigError) {
    log.fatal({ keys: err.keys }, err.message);
    process.exit(1);
  }
  throw err;
}

const missing = missingKalshiCredentials(config);
if (missing.length > 0 || privateKey === undefined) {
  log.warn(
    { missing: missing.length > 0 ? missing : ['private key (source is empty)'] },
    'Kalshi credentials are not configured; Kalshi access stays disabled',
  );
}

log.info(
  {
    kalshiEnv: config.kalshiEnv,
    kalshiSubaccount: config.kalshiSubaccount,
    allowLiveOrders: config.allowLiveOrders,
    port: config.port,
    dbPath: config.dbPath,
    configLocal: configLocalPath ?? null,
  },
  'Starting kalshi-trader',
);

// Migrations run before the server listens; a failed migration exits 1 so the app never serves a
// half-migrated database. A database that cannot be opened at all (unwritable directory) does not
// stop the server: /healthz reports 503 and retries the open on every probe.
const database = new DatabaseManager(config.dbPath, log);
try {
  database.open();
} catch (err) {
  if (err instanceof DatabaseUnavailableError) {
    log.error(
      { err, dbPath: config.dbPath },
      'Database unavailable; /healthz reports 503 until it can be opened',
    );
  } else {
    log.fatal({ err, dbPath: config.dbPath }, 'Database migration failed');
    process.exit(1);
  }
}

const maintenance = startMaintenance({ getDb: () => database.current, log });

const app = buildApp({ logger: log, database });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutting down');
  try {
    maintenance.stop();
    await app.close();
    database.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  log.fatal({ err }, 'Failed to start HTTP server');
  process.exit(1);
}
