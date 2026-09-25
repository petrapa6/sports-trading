import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { DbHealth } from '../../src/db/database.js';
import type { Repositories } from '../../src/db/repositories.js';
import { buildApp } from '../../src/server/app.js';
import { TEST_APP_OPTIONS } from '../helpers/app.js';

const fakeDb = (health: DbHealth) => ({
  health: () => health,
  get repositories(): Repositories {
    throw new Error('no database in this test');
  },
});
const healthy = fakeDb({ ok: true });
const logger = pino({ level: 'silent' });

describe('buildApp', () => {
  it('GET /healthz returns exactly {"ok":true} when the database answers', async () => {
    const app = await buildApp({ logger, database: healthy, ...TEST_APP_OPTIONS });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    await app.close();
  });

  it('GET /healthz returns 503 with the database error when the database is unavailable', async () => {
    const app = await buildApp({
      logger,
      database: fakeDb({ ok: false, db: 'SQLITE_CANTOPEN' }),
      ...TEST_APP_OPTIONS,
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: 'SQLITE_CANTOPEN' });
    await app.close();
  });

  it('unknown routes require a session first (401), so they reveal nothing', async () => {
    const app = await buildApp({ logger, database: healthy, ...TEST_APP_OPTIONS });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });
});
