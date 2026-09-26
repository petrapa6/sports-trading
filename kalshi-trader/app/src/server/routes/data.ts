import { eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { collectCandles } from '../../backtest/candles.js';
import { CSV_MAX_BYTES, CsvImportError, importCsv } from '../../backtest/csvImporter.js';
import { JobRunning, type JobManager, type JobView } from '../../backtest/jobs.js';
import { runBackfill, validateRange } from '../../backtest/kalshiBackfill.js';
import { importNhlSeason, NhlHistoryClient, seasonLabel } from '../../backtest/nhlImporter.js';
import { buildPriceModel, seedModel, type PriceModel } from '../../backtest/priceModel.js';
import type { Db } from '../../db/connection.js';
import type { Repositories } from '../../db/repositories.js';
import { games as gamesTable, hist_games } from '../../db/schema.js';
import type { NetworkGate } from '../../feeds/network.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import type { LiveHub } from '../live.js';
import { authOf, clientContext } from '../security.js';
import { dbSizeBytes } from './api.js';
import type { KalshiServices } from './kalshi.js';

/**
 * Settings → Data (SPEC.md §8, T11): historical imports, the candle collector, the price model, the
 * database size and vacuum, and the job list.
 *
 * - `GET  /api/data/summary`: DB size, `hist_games` per source, candle rows, backfilled games, model summary.
 * - `POST /api/data/csv` (`text/csv`, ≤ 20 MB, **step-up**): the §3 CSV importer; `400 invalid_csv` names
 *   the row and column; `413` above 20 MB. Audited `hist_csv_import`.
 * - `POST /api/data/nhl` `{season, includePreseason?, limit?}` → `202` job (`nhl_import`).
 * - `POST /api/data/kalshi-backfill` `{from, to, leagueIds?, playByPlay?}` → `202` job (`kalshi_backfill`).
 * - `POST /api/data/candles` `{gameIds?, force?}` → `202` job (`candles`).
 * - `POST /api/data/price-model`: rebuilds `settings.price_model` (synchronous), audited.
 * - `POST /api/data/vacuum`: WAL checkpoint + `VACUUM`, answers the size before and after, audited.
 * - `GET /api/jobs`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id` (cancel; rows already written stay).
 *
 * A second job of a running type answers `409 job_running`. Job starts and cancels are audited
 * (`data_job_start` / `data_job_cancel`); none needs step-up (none can lead to an order), except the CSV
 * upload, as §10 requires.
 */

export interface DataServices {
  jobs: JobManager;
  gate: NetworkGate;
  /** NHL Web API base URL (tests and the e2e stand-in). */
  nhlBaseUrl?: string | undefined;
  nhlFetch?: typeof fetch;
  /** Requests per second to the NHL API (default 4). */
  nhlRequestsPerSecond?: number;
  transaction?: (fn: () => void) => void;
}

const NhlBody = z
  .object({
    season: z.string().regex(/^\d{8}$/, 'must look like 20252026'),
    includePreseason: z.boolean().optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const BackfillBody = z
  .object({
    from: z.string(),
    to: z.string(),
    leagueIds: z.array(z.string().min(1).max(40)).max(20).optional(),
    playByPlay: z.boolean().optional(),
  })
  .strict();

const CandlesBody = z
  .object({
    gameIds: z.array(z.string().min(1).max(100)).max(5000).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** The part of `settings.price_model` the UI shows (per-sport sample sizes and the cells). */
export function modelSummary(model: PriceModel | null) {
  if (!model) return null;
  return { builtAt: model.builtAt, minSamples: model.minSamples, sports: model.sports, cells: model.cells };
}

export function registerDataRoutes(
  app: FastifyInstance,
  database: { readonly repositories: Repositories; readonly current?: Db | undefined },
  hub: LiveHub,
  kalshi: KalshiServices | undefined,
  data: DataServices,
  now: () => number = Date.now,
): void {
  const auth = app.authService;
  const { jobs } = data;
  const repos = () => database.repositories;
  const actorOf = (req: FastifyRequest) => ({
    actor: userActor(authOf(req).user.username),
    ...clientContext(req),
  });
  const transaction =
    data.transaction ??
    ((fn: () => void) => {
      const db = database.current;
      if (db) db.sqlite.transaction(fn)();
      else fn();
    });

  // CSV bodies arrive as text; the route below raises the body limit to 20 MB.
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const dbPath = () => hub.runtime.dbPath || database.current?.path || '';

  const startJob = (
    req: FastifyRequest,
    type: JobView['type'],
    label: string,
    run: Parameters<JobManager['start']>[2],
  ) => {
    let job: JobView;
    try {
      job = jobs.start(type, label, run);
    } catch (err) {
      if (err instanceof JobRunning)
        throw new HttpError(409, 'job_running', {
          message: `A ${err.job.label} job is already running.`,
          job: err.job,
        });
      throw err;
    }
    auth.audit(actorOf(req), {
      action: 'data_job_start',
      entity: 'job',
      entityId: job.id,
      detail: { type, label },
    });
    return job;
  };

  const kalshiClient = () => {
    if (!kalshi?.client)
      throw new HttpError(503, 'kalshi_not_configured', {
        message:
          'Kalshi credentials are not configured: set the key id and the private key in the app configuration.',
      });
    return kalshi.client;
  };

  app.get('/api/data/summary', async () => {
    const r = repos();
    const bySource = Object.fromEntries(r.histGames.countBySource().map((row) => [row.source, row.n]));
    const stored = r.settings.get('price_model') as PriceModel | null;
    return {
      dbPath: dbPath(),
      dbSizeBytes: dbSizeBytes(dbPath()),
      histGames: { total: r.histGames.count(), bySource },
      linkedHistGames: r.histGames.count(isNotNull(hist_games.kalshi_event_ticker)),
      histPrices: r.histPrices.count(),
      backfilledGames: r.games.count(eq(gamesTable.historical, 1)),
      priceModel: modelSummary(stored),
      jobs: jobs.list(),
    };
  });

  app.post(
    '/api/data/csv',
    {
      bodyLimit: CSV_MAX_BYTES,
      // Step-up before the (up to 20 MB) body is read; the session is resolved in `onRequest`.
      preParsing: (req, reply, payload, done) => {
        if (!auth.isRecentAuth(authOf(req).session)) {
          void reply.code(403).send({ error: 'reauth_required' });
          return;
        }
        done(null, payload);
      },
    },
    async (req) => {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (ct !== 'text/csv' || typeof req.body !== 'string')
        throw new HttpError(415, 'unsupported_media_type', { message: 'Send the file as text/csv.' });
      let result;
      try {
        result = importCsv(repos(), req.body, transaction);
      } catch (err) {
        if (err instanceof CsvImportError)
          throw new HttpError(400, 'invalid_csv', { message: err.message, row: err.row, column: err.column });
        throw err;
      }
      auth.audit(actorOf(req), { action: 'hist_csv_import', entity: 'hist_games', detail: { ...result } });
      req.log.info({ ...result }, 'CSV import finished');
      return result;
    },
  );

  app.post('/api/data/nhl', async (req, reply) => {
    const body = parseBody(NhlBody, req.body);
    let label: string;
    try {
      label = seasonLabel(body.season);
    } catch (err) {
      throw new HttpError(400, 'bad_request', { issues: [`season: ${(err as Error).message}`] });
    }
    const client = new NhlHistoryClient({
      gate: data.gate,
      log: req.log,
      ...(data.nhlBaseUrl ? { baseUrl: data.nhlBaseUrl } : {}),
      ...(data.nhlFetch ? { fetch: data.nhlFetch } : {}),
      ...(data.nhlRequestsPerSecond ? { requestsPerSecond: data.nhlRequestsPerSecond } : {}),
    });
    const job = startJob(req, 'nhl_import', `NHL ${label}`, (ctx) =>
      importNhlSeason(
        { client, repos: repos(), log: ctx.log, ctx },
        {
          season: body.season,
          ...(body.includePreseason !== undefined ? { includePreseason: body.includePreseason } : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
        },
      ),
    );
    return reply.code(202).send(job);
  });

  app.post('/api/data/kalshi-backfill', async (req, reply) => {
    const body = parseBody(BackfillBody, req.body);
    try {
      validateRange(body.from, body.to);
    } catch (err) {
      throw new HttpError(400, 'bad_request', { issues: [(err as Error).message] });
    }
    const client = kalshiClient();
    const job = startJob(req, 'kalshi_backfill', `Kalshi backfill ${body.from} – ${body.to}`, (ctx) =>
      runBackfill(
        { client, repos: repos(), log: ctx.log, ctx, transaction, now },
        {
          from: body.from,
          to: body.to,
          ...(body.leagueIds ? { leagueIds: body.leagueIds } : {}),
          ...(body.playByPlay !== undefined ? { playByPlay: body.playByPlay } : {}),
        },
      ),
    );
    return reply.code(202).send(job);
  });

  app.post('/api/data/candles', async (req, reply) => {
    const body = parseBody(CandlesBody, req.body);
    const client = kalshiClient();
    const job = startJob(req, 'candles', 'Collect candles', (ctx) =>
      collectCandles(
        { client, repos: repos(), log: ctx.log, ctx, transaction },
        {
          ...(body.gameIds ? { gameIds: body.gameIds } : {}),
          ...(body.force !== undefined ? { force: body.force } : {}),
        },
      ),
    );
    return reply.code(202).send(job);
  });

  app.post('/api/data/price-model', async (req) => {
    const r = repos();
    const builtAt = new Date(now()).toISOString();
    const model = r.histGames.count() === 0 ? seedModel(builtAt) : buildPriceModel(r, builtAt);
    r.settings.set('price_model', model as never);
    auth.audit(actorOf(req), {
      action: 'price_model_rebuild',
      entity: 'settings',
      entityId: 'price_model',
      detail: { sports: model.sports },
    });
    req.log.info({ sports: model.sports }, 'Price model rebuilt');
    return modelSummary(model);
  });

  app.post('/api/data/vacuum', async (req) => {
    const db = database.current;
    if (!db) throw new HttpError(503, 'unavailable');
    const before = dbSizeBytes(db.path);
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    db.sqlite.exec('VACUUM');
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const after = dbSizeBytes(db.path);
    auth.audit(actorOf(req), { action: 'db_vacuum', entity: 'database', detail: { before, after } });
    req.log.info({ before, after }, 'Database vacuumed');
    return { beforeBytes: before, afterBytes: after, dbSizeBytes: dbSizeBytes(dbPath()) };
  });

  app.get('/api/jobs', async () => ({ jobs: jobs.list() }));

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const job = jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'not_found');
    return job;
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const job = jobs.cancel(req.params.id);
    if (!job) throw new HttpError(404, 'not_found');
    auth.audit(actorOf(req), {
      action: 'data_job_cancel',
      entity: 'job',
      entityId: job.id,
      detail: { type: job.type },
    });
    // The job stops at its next checkpoint; the request in flight is aborted.
    await jobs.wait(job.id);
    return jobs.get(job.id) ?? job;
  });

  jobs.on('job', (view) => hub.jobChanged(view));
}
