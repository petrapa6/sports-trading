import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';

describe('buildApp', () => {
  it('GET /healthz returns exactly {"ok":true}', async () => {
    const app = buildApp({ logger: pino({ level: 'silent' }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    await app.close();
  });

  it('unknown routes return 404', async () => {
    const app = buildApp({ logger: pino({ level: 'silent' }) });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
