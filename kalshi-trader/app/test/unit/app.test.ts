import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { DbHealth } from '../../src/db/database.js';
import { buildApp } from '../../src/server/app.js';

const healthy = { health: (): DbHealth => ({ ok: true }) };

describe('buildApp', () => {
  it('GET /healthz returns exactly {"ok":true} when the database answers', async () => {
    const app = buildApp({ logger: pino({ level: 'silent' }), database: healthy });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    await app.close();
  });

  it('GET /healthz returns 503 with the database error when the database is unavailable', async () => {
    const app = buildApp({
      logger: pino({ level: 'silent' }),
      database: { health: (): DbHealth => ({ ok: false, db: 'SQLITE_CANTOPEN' }) },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: 'SQLITE_CANTOPEN' });
    await app.close();
  });

  it('unknown routes return 404', async () => {
    const app = buildApp({ logger: pino({ level: 'silent' }), database: healthy });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
