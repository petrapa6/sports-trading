import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import { DatabaseUnavailableError, type DbHealth } from '../db/database.js';
import type { Repositories } from '../db/repositories.js';
import { AuthService, type Argon2Params } from './auth/service.js';
import { HttpError } from './http.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './routes/auth.js';
import { DEFAULT_RATE_LIMITS, registerSecurity, type RateLimits } from './security.js';

/** Static assets served under `/assets/` (outside `src/`, so `src/server` and `dist/server` resolve it alike). */
export const PUBLIC_DIR = resolve(import.meta.dirname, '../../public');

export interface AppOptions {
  logger: FastifyBaseLogger;
  /** The database (`DatabaseManager`): health probe and repositories (throws while unavailable). */
  database: { health(): DbHealth; readonly repositories: Repositories };
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

  app.get('/healthz', { config: { public: true } }, async (_req, reply) => {
    const health = database.health();
    if (!health.ok) return reply.code(503).send(health);
    return { ok: true };
  });

  await app.register(fastifyStatic, {
    root: resolve(PUBLIC_DIR, 'assets'),
    prefix: '/assets/',
    index: false,
    list: false,
    dotfiles: 'deny',
    decorateReply: false,
  });

  registerAuthRoutes(app, rateLimits);
  registerApiRoutes(app, database);

  // Everything else: a session is required first (so unknown paths reveal nothing), then 404.
  app.all('/*', async () => {
    throw new HttpError(404, 'not_found');
  });
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  return app;
}
