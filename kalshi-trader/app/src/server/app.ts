import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger: FastifyBaseLogger;
}

/** Builds the Fastify application. Routes are registered here; listening is done by `main.ts`. */
export function buildApp({ logger }: AppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
  });

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
