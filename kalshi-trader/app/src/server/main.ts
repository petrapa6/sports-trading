import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closePrivateKeyFd, ConfigError, missingKalshiCredentials, readPrivateKey } from '../config.js';
import { startMaintenance } from '../core/maintenance.js';
import { DatabaseManager, DatabaseUnavailableError } from '../db/database.js';
import { buildApp } from './app.js';
import { loadConfigOrExit } from './boot.js';
import { publicKeyFingerprint } from './routes/dev.js';
import { createLogger } from './logger.js';
import { LogRing } from './logRing.js';
import { loadOrCreateSecretKey, type LoadedSecret } from './secrets.js';

const { config, configLocalPath } = loadConfigOrExit();
if (config.tz !== undefined) process.env['TZ'] = config.tz;

const logRing = new LogRing();
const log = createLogger(config.logLevel, logRing);

const version = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }
).version;

// `KST_E2E=1` (Playwright only, never in production): loopback counts as the ingress proxy, so the
// e2e suite can drive the ingress channel through a local prefix-stripping proxy, and the /login
// and global rate limits are raised so the suite's many sign-ins and page loads do not trip them.
const e2e = process.env['KST_E2E'] === '1' && process.env['NODE_ENV'] !== 'production';

// The key is read now; the (drained) fd 3 stays open until the server listens, so the database
// and the listening socket are not handed fd 3 by the kernel and nothing holds it after boot.
let privateKey: string | undefined;
try {
  privateKey = readPrivateKey(config, { closeFd: false });
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

// Session/encryption secret (§10): generated on first start; without it the app cannot run safely.
let secret: LoadedSecret;
try {
  secret = loadOrCreateSecretKey(config.dataDir);
} catch (err) {
  log.fatal({ err, dataDir: config.dataDir }, 'Cannot read or create secret.key');
  process.exit(1);
}
if (secret.generated) {
  log.info(
    { path: secret.path },
    'Generated a new secret.key; existing sessions and encrypted settings are invalid',
  );
  // Cookies signed with the old key no longer verify; drop the stale rows too.
  if (database.current) {
    const repos = database.repositories;
    const removed = repos.sessions.deleteAll();
    repos.auditLog.insert({
      at: new Date().toISOString(),
      actor: 'system',
      action: 'secret_key_generated',
      entity: 'secret_key',
      detail: JSON.stringify({ sessionsRemoved: removed }),
    });
  }
}

let privateKeyFingerprint: string | undefined;
if (privateKey !== undefined && process.env['NODE_ENV'] === 'development') {
  try {
    privateKeyFingerprint = publicKeyFingerprint(privateKey);
  } catch (err) {
    log.error({ err: { message: (err as Error).message } }, 'The Kalshi private key cannot be parsed');
  }
}

const maintenance = startMaintenance({ getDb: () => database.current, log });

const app = await buildApp({
  logger: log,
  database,
  secretKey: secret.key,
  trustedProxies: config.trustedProxies,
  nodeEnv: process.env['NODE_ENV'],
  logRing,
  runtime: {
    version,
    allowLiveOrders: config.allowLiveOrders,
    kalshiEnv: config.kalshiEnv,
    kalshiSubaccount: config.kalshiSubaccount,
    dbPath: resolve(config.dbPath),
  },
  privateKeyFingerprint,
  ...(e2e ? { ingressPeer: '127.0.0.1', rateLimits: { global: 10_000, login: 1000 } } : {}),
});

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
closePrivateKeyFd(config);
