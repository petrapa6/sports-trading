import { ConfigError, missingKalshiCredentials, readPrivateKey } from '../config.js';
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

const app = buildApp({ logger: log });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutting down');
  try {
    await app.close();
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
