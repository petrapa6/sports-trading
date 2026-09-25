/**
 * `npm run db:migrate`              apply every pending migration to DB_PATH
 * `npm run db:migrate:down`         roll back the most recent migration
 * `npm run db:migrate:down -- --steps 2 | --all`
 * `npm run db:migrate -- --status`  list migrations and whether they are applied
 *
 * Uses the same configuration as the app (env, then config.local.json). Prints JSON log lines.
 */
import { openDatabase } from '../src/db/connection.js';
import { migrateDown, migrateUp, migrationStatus } from '../src/db/migrate.js';
import { loadConfigOrExit } from '../src/server/boot.js';
import { createLogger } from '../src/server/logger.js';

const args = process.argv.slice(2);
const direction = args[0] === 'down' ? 'down' : 'up';
const { config } = loadConfigOrExit();
const log = createLogger(config.logLevel);

function stepsArg(): number {
  if (args.includes('--all')) return Number.MAX_SAFE_INTEGER;
  const i = args.indexOf('--steps');
  if (i === -1) return 1;
  const n = Number.parseInt(args[i + 1] ?? '', 10);
  if (!Number.isSafeInteger(n) || n < 1) {
    log.fatal('--steps needs a positive integer');
    process.exit(1);
  }
  return n;
}

let db;
try {
  db = openDatabase(config.dbPath);
} catch (err) {
  log.fatal({ err, dbPath: config.dbPath }, 'Cannot open database');
  process.exit(1);
}

try {
  if (args.includes('--status')) {
    log.info({ dbPath: db.path, migrations: migrationStatus(db) }, 'Migration status');
  } else if (direction === 'up') {
    const applied = migrateUp(db);
    log.info({ dbPath: db.path, applied }, `${applied.length} migration(s) applied`);
  } else {
    const rolledBack = migrateDown(db, stepsArg());
    log.info({ dbPath: db.path, rolledBack }, `${rolledBack.length} migration(s) rolled back`);
  }
} catch (err) {
  log.fatal({ err, dbPath: db.path }, `Migration ${direction} failed`);
  process.exitCode = 1;
} finally {
  db.close();
}
