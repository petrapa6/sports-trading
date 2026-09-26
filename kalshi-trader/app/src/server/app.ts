import { randomUUID } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { Logger } from 'pino';
import { JobManager } from '../backtest/jobs.js';
import type { Db } from '../db/connection.js';
import { DatabaseUnavailableError, type DbHealth } from '../db/database.js';
import { createNetworkGate } from '../feeds/network.js';
import type { Repositories } from '../db/repositories.js';
import { AuthService, type Argon2Params } from './auth/service.js';
import { HttpError } from './http.js';
import { LiveHub, registerLiveRoutes, type RuntimeInfo } from './live.js';
import { LogRing } from './logRing.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBacktestRoutes } from './routes/backtests.js';
import { BacktestRunner } from '../backtest/runner.js';
import { registerDataRoutes, type DataServices } from './routes/data.js';
import { OnceSet } from '../feeds/gameState.js';
import { registerDevRoutes, registerReplayRoute } from './routes/dev.js';
import { registerFeedRoutes, type LiveServices } from './routes/feeds.js';
import { registerKalshiRoutes, type KalshiServices } from './routes/kalshi.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerStrategyRoutes } from './routes/strategies.js';
import { registerTradeRoutes } from './routes/trades.js';
import { DEFAULT_RATE_LIMITS, registerSecurity, type RateLimits } from './security.js';
import { registerWeb, WEB_DIR } from './web.js';

const DEFAULT_RUNTIME: RuntimeInfo = {
  version: '0.0.0',
  allowLiveOrders: false,
  kalshiEnv: 'demo',
  kalshiSubaccount: 0,
  dbPath: '',
};

/** SQLite result codes meaning "locked by another connection" (`SQLITE_BUSY`, `SQLITE_LOCKED` and their extended codes). */
export const isDbBusy = (code: string): boolean => /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);

export interface AppOptions {
  logger: FastifyBaseLogger;
  /** The database (`DatabaseManager`): health probe and repositories (throws while unavailable). */
  database: { health(): DbHealth; readonly repositories: Repositories; readonly current?: Db | undefined };
  /** The 32-byte secret from `${DATA_DIR}/secret.key`. */
  secretKey: Buffer;
  /** `TRUSTED_PROXIES`. */
  trustedProxies: readonly string[];
  /** `NODE_ENV`; class `dev` exists only for `development`. */
  nodeEnv?: string | undefined;
  /** Ingress proxy address (tests). */
  ingressPeer?: string;
  /** Clock (tests); defaults to `Date.now()`. */
  now?: () => number;
  /** argon2id cost (tests); defaults to m = 64 MiB, t = 3. */
  argon2?: Argon2Params;
  rateLimits?: RateLimits;
  /** Read-only process facts shown in the UI (version, add-on lock, Kalshi env/subaccount, DB path). */
  runtime?: Partial<RuntimeInfo>;
  /** Ring buffer the logger also writes to (`createLogger(level, ring)`); the SSE log tail reads it. */
  logRing?: LogRing;
  /** The Vite build of the React app; defaults to `dist/web`. */
  webDir?: string;
  /** SSE heartbeat interval (tests); defaults to 10 s. */
  heartbeatMs?: number;
  /** Fingerprint of the loaded Kalshi key, served by the development-only `/api/dev/key-fingerprint`. */
  privateKeyFingerprint?: string | undefined;
  /** Kalshi client and discovery (T06); without them every Kalshi action answers `kalshi_not_configured`. */
  kalshi?: KalshiServices;
  /** Tracker, scheduler, feeds (T07) and engine (T08): `/healthz` loop state, SSE games and signals, Settings → Feeds. */
  live?: LiveServices;
  /**
   * `POST /api/dev/replay` (needs `live`): registered with `NODE_ENV=development`, or when
   * `allowLoopback` is set (the e2e server, `KST_E2E=1`), where it also accepts loopback peers.
   */
  replay?: { allowLoopback: boolean; transaction?: (fn: () => void) => void };
  /** Backtest runner (T12); by default one on the app's database file. */
  backtests?: BacktestRunner;
  /**
   * Settings → Data (T11): the job manager and the network gate default to ones reading the global kill
   * switch from the database; `nhlBaseUrl` / `nhlFetch` point the NHL importer at a stand-in (tests, e2e).
   */
  data?: Partial<DataServices>;
}

/** Builds the Fastify application with every §10 control. Listening is done by `main.ts`. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { logger, database } = options;
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    return503OnClosing: true,
  });

  // HTML forms (login, setup, logout) post urlencoded bodies; parsed without an extra dependency.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Errors never carry stack traces: 4xx get a stable code, 5xx a correlation id that is also logged.
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.code === 'rate_limited' && err.extra['retryAfterSeconds'] !== undefined) {
        reply.header('retry-after', String(err.extra['retryAfterSeconds']));
      }
      return reply.code(err.statusCode).send({ error: err.code, ...err.extra });
    }
    if (err instanceof DatabaseUnavailableError) {
      req.log.error({ err }, 'Database unavailable');
      return reply.code(503).send({ error: 'unavailable' });
    }
    const code = typeof err.code === 'string' ? err.code : '';
    // Another process holds the SQLite lock past `busy_timeout` (T14 drill): a retryable 503, not a 500.
    if (isDbBusy(code)) {
      req.log.warn({ code }, 'Database busy');
      return reply.code(503).header('retry-after', '1').send({ error: 'db_busy' });
    }
    if (code.startsWith('FST_CSRF')) return reply.code(403).send({ error: 'csrf' });
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const error =
        status === 413
          ? 'payload_too_large'
          : status === 415
            ? 'unsupported_media_type'
            : status === 404
              ? 'not_found'
              : 'bad_request';
      return reply.code(status).send({ error });
    }
    const correlationId = req.id;
    req.log.error({ err, correlationId }, 'Unhandled error');
    return reply.code(500).send({ error: 'internal', correlationId });
  });

  const authService = new AuthService({
    repos: () => database.repositories,
    secretKey: options.secretKey,
    ...(options.now ? { now: options.now } : {}),
    ...(options.argon2 ? { argon2: options.argon2 } : {}),
  });
  const rateLimits = options.rateLimits ?? DEFAULT_RATE_LIMITS;

  await registerSecurity(app, {
    secretKey: options.secretKey,
    authService,
    rateLimits,
    trustedProxies: options.trustedProxies,
    nodeEnv: options.nodeEnv,
    ...(options.ingressPeer ? { ingressPeer: options.ingressPeer } : {}),
  });

  // Database first, then the trading loop (T07): `loop` is `running` / `idle` / `paused` / `starting`,
  // and a loop without a tick for 2 minutes answers `503 {"ok":false,"loop":"stale"}`.
  app.get('/healthz', { config: { public: true } }, async (_req, reply) => {
    const health = database.health();
    if (!health.ok) return reply.code(503).send(health);
    const scheduler = options.live?.scheduler;
    if (!scheduler) return { ok: true };
    const loop = scheduler.health(options.now?.());
    if (!loop.ok) return reply.code(503).send(loop);
    return loop;
  });

  const repos = () => database.repositories;
  const hub = new LiveHub(
    options.logRing ?? new LogRing(),
    { ...DEFAULT_RUNTIME, ...options.runtime },
    repos,
    options.now ?? Date.now,
  );

  const live = options.live;
  if (live) {
    const engine = live.engine;
    hub.setSource({
      games: () => live.tracker.displayGames(),
      loop: () => live.scheduler.status(),
      signals: () => engine?.recent() ?? [],
    });
    engine?.on('signal', (signal) => hub.signalEmitted(signal));
    live.executor?.on('trade', (t) => hub.tradeChanged(t));
    live.settler?.on('trade', (t) => hub.tradeChanged(t));
    live.tracker.on('stateUpdated', () => hub.gamesChanged());
    live.scheduler.on('status', (status) => {
      hub.loopChanged(status);
      hub.gamesChanged();
    });
    // Leaving `paused` (kill switch off) must not wait for the next 5 s check.
    hub.on('switches', () => live.scheduler.wake());
  }

  const backtests =
    options.backtests ??
    new BacktestRunner({
      repos,
      dbPath: () => {
        const path = database.current?.path;
        if (!path) throw new DatabaseUnavailableError('closed', { cause: undefined });
        return path;
      },
      log: logger,
      ...(options.now ? { now: options.now } : {}),
    });
  backtests.on('progress', (p) => hub.backtestProgress(p));
  app.addHook('onClose', async () => backtests.close());
  // Data jobs (T11) pause while the global kill switch is on and resume as soon as it is turned off.
  const killSwitchOn = () => database.repositories.settings.get('global_kill_switch');
  const jobs =
    options.data?.jobs ??
    new JobManager({
      isPaused: killSwitchOn,
      log: logger as unknown as Logger,
      ...(options.now ? { now: options.now } : {}),
    });
  hub.on('switches', () => jobs.wake());
  app.addHook('onClose', async () => {
    jobs.cancelAll();
    await jobs.idle();
  });

  await registerWeb(app, options.webDir ?? WEB_DIR, rateLimits);
  registerAuthRoutes(app, rateLimits);
  registerApiRoutes(app, database, hub, options.now, options.live?.orderGroups);
  registerStrategyRoutes(app, database, hub, options.now);
  registerTradeRoutes(app, database, hub, options.now);
  registerStatsRoutes(app, database, hub, options.now);
  registerBacktestRoutes(app, database, hub, backtests, options.now);
  registerKalshiRoutes(
    app,
    database,
    options.kalshi ?? { env: hub.runtime.kalshiEnv, subaccount: hub.runtime.kalshiSubaccount },
  );
  registerFeedRoutes(app, database, hub, live);
  registerDataRoutes(
    app,
    database,
    hub,
    options.kalshi,
    { ...options.data, jobs, gate: options.data?.gate ?? createNetworkGate(killSwitchOn) },
    options.now,
  );
  if (options.nodeEnv === 'development') {
    registerDevRoutes(app, {
      privateKeyFingerprint: options.privateKeyFingerprint,
      ...(live ? { scheduler: live.scheduler } : {}),
    });
  }
  if (live && (options.nodeEnv === 'development' || options.replay?.allowLoopback)) {
    registerReplayRoute(app, {
      context: {
        get repos() {
          return database.repositories;
        },
        tracker: live.tracker,
        log: logger,
        unknownText: new OnceSet(),
        ...(options.replay?.transaction ? { transaction: options.replay.transaction } : {}),
      },
      allowLoopback: options.replay?.allowLoopback ?? false,
      ...(options.now ? { now: options.now } : {}),
    });
  }
  registerLiveRoutes(app, hub, repos, {
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  // Everything else: a session is required first (so unknown paths reveal nothing), then 404.
  app.all('/*', async () => {
    throw new HttpError(404, 'not_found');
  });
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  return app;
}
