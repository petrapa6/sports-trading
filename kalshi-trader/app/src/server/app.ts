import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DbHealth } from '../db/database.js';

export interface AppOptions {
  logger: FastifyBaseLogger;
  /** The database health probe (`DatabaseManager`): opens the DB if needed and runs `SELECT 1`. */
  database: { health(): DbHealth };
}

/** Builds the Fastify application. Routes are registered here; listening is done by `main.ts`. */
export function buildApp({ logger, database }: AppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
  });

  app.get('/healthz', async (_req, reply) => {
    const health = database.health();
    if (!health.ok) return reply.code(503).send(health);
    return { ok: true };
  });

  return app;
}
