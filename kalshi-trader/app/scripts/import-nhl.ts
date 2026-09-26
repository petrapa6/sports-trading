/**
 * `npm run import:nhl -- --season 20252026 [--limit 5] [--preseason]` (SPEC.md §14 T11): imports an NHL
 * season's goal timelines from the NHL Web API into `hist_games` of the configured database (DB_PATH /
 * config.local.json, like the app). Resumable: games already imported are skipped. Respects the global
 * kill switch (exits at once while it is on). When the NHL API cannot be reached it prints the network
 * error and exits 0 (nothing was written); any other failure exits 1. `NHL_SCRIPT_BASE_URL` points it at
 * a stand-in.
 */
import { pino } from 'pino';
import {
  importNhlSeason,
  NhlHistoryClient,
  NhlHistoryError,
  seasonLabel,
} from '../src/backtest/nhlImporter.js';
import { openDatabase } from '../src/db/connection.js';
import { migrateUp } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { createNetworkGate, NetworkPaused } from '../src/feeds/network.js';
import { loadConfigOrExit } from '../src/server/boot.js';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const season = arg('season') ?? '';
const limitArg = arg('limit');
const limit = limitArg !== undefined ? Number.parseInt(limitArg, 10) : undefined;
try {
  seasonLabel(season);
} catch (err) {
  console.error(`[import:nhl] ${(err as Error).message} (use --season 20252026)`);
  process.exit(1);
}
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
  console.error('[import:nhl] --limit must be a positive integer');
  process.exit(1);
}

const { config } = loadConfigOrExit();
const db = openDatabase(config.dbPath);
let exitCode = 0;
try {
  migrateUp(db);
  const repos = createRepositories(db.orm);
  const log = pino({ level: process.env['LOG_LEVEL'] ?? 'warn' });
  const baseUrl = process.env['NHL_SCRIPT_BASE_URL'];
  const client = new NhlHistoryClient({
    gate: createNetworkGate(() => repos.settings.get('global_kill_switch')),
    log,
    ...(baseUrl ? { baseUrl } : {}),
  });
  let last = 0;
  const result = await importNhlSeason(
    {
      client,
      repos,
      log,
      ctx: {
        request: (fn) => fn(new AbortController().signal),
        checkpoint: async () => undefined,
        progress: (done, _total, message) => {
          if (done !== last && message) console.log(`[import:nhl] ${done} imported — ${message}`);
          last = done;
        },
      },
    },
    { season, ...(limit !== undefined ? { limit } : {}), includePreseason: args.includes('--preseason') },
  );
  console.log(
    `[import:nhl] season ${result.season}: inserted ${result.inserted}, skipped ${result.skippedExisting} existing, ` +
      `${result.skippedPreseason} preseason, ${result.skippedUnfinished} unfinished, ${result.failed} failed ` +
      `(${result.requests} requests) → ${db.path}`,
  );
} catch (err) {
  if (err instanceof NetworkPaused) {
    console.error('[import:nhl] the global kill switch is on; nothing was imported');
  } else if (err instanceof NhlHistoryError && /could not be reached|answered \d+/.test(err.message)) {
    console.error(`[import:nhl] network error, nothing imported: ${err.message}`);
  } else {
    console.error(`[import:nhl] FAIL ${(err as Error).message}`);
    exitCode = 1;
  }
} finally {
  db.close();
}
process.exit(exitCode);
