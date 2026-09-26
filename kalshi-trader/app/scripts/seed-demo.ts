/**
 * `npm run seed:demo -- --trades 500` (T10): fills the configured database (DB_PATH / config.local.json, like
 * the app) with generated demo strategies and trades in both modes for manual checks of the Dashboard and the
 * Trades page. `--clear` removes the demo rows again. Never run it against a production database: every row
 * is fake. Options: `--trades N` (default 500), `--seed N`, `--env demo|prod`, `--clear`.
 */
import { openDatabase } from '../src/db/connection.js';
import { migrateUp } from '../src/db/migrate.js';
import { loadConfigOrExit } from '../src/server/boot.js';
import { clearDemo, seedDemo } from './seed-demo-lib.js';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const trades = Number.parseInt(arg('trades') ?? '500', 10);
const seed = Number.parseInt(arg('seed') ?? '42', 10);
const env = arg('env') ?? 'demo';
if (!Number.isSafeInteger(trades) || trades < 0 || trades > 1_000_000 || !Number.isSafeInteger(seed)) {
  console.error('[seed:demo] --trades must be 0 … 1000000 and --seed an integer');
  process.exit(1);
}
if (env !== 'demo' && env !== 'prod') {
  console.error('[seed:demo] --env must be demo or prod');
  process.exit(1);
}

const { config } = loadConfigOrExit();
const db = openDatabase(config.dbPath);
try {
  migrateUp(db);
  if (args.includes('--clear')) {
    clearDemo(db.sqlite);
    console.log(`[seed:demo] demo rows removed from ${db.path}`);
  } else {
    const r = seedDemo(db.sqlite, { trades, seed, kalshiEnv: env });
    console.log(`[seed:demo] ${db.path}: ${JSON.stringify(r)}`);
  }
} finally {
  db.close();
}
