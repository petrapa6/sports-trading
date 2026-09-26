import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/server/logger.js';
import { LogRing } from '../../src/server/logRing.js';
import { Client, createTestApp, PASSWORD, setupUser, USER, type TestApp } from '../helpers/app.js';
import { sseReader } from '../helpers/sse.js';

describe('LogRing', () => {
  it('keeps the last 50 lines with their mode (null when absent) and skips request lines', () => {
    const ring = new LogRing();
    const log = createLogger('info', ring, { write: () => true });
    for (let i = 0; i < 60; i++) log.info({ mode: i % 2 ? 'dry_run' : undefined }, `line ${i}`);
    log.info({ req: { method: 'GET' } }, 'incoming request');
    log.info({ mode: 'live' }, 'live line');
    log.debug('below the level');
    const lines = ring.last();
    expect(lines).toHaveLength(50);
    expect(lines.at(-1)).toMatchObject({ msg: 'live line', mode: 'live', level: 'info' });
    expect(lines.at(-2)).toMatchObject({ msg: 'line 59', mode: 'dry_run' });
    expect(lines.at(-3)).toMatchObject({ msg: 'line 58', mode: null });
    expect(lines.every((l) => 'mode' in l)).toBe(true);
    expect(lines.some((l) => l.msg === 'incoming request')).toBe(false);
    expect(ring.last(3).map((l) => l.msg)).toEqual(['line 58', 'line 59', 'live line']);
  });

  it('ignores a line that is not JSON and invalid modes', () => {
    const ring = new LogRing();
    ring.write('not json\n');
    ring.write(
      `${JSON.stringify({ level: 40, msg: 'x', mode: 'bogus', time: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    expect(ring.last()).toEqual([
      { seq: 1, level: 'warn', msg: 'x', mode: null, time: '2026-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('GET /api/live', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  it('requires a session', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/live', remoteAddress: '10.0.0.9' });
    expect(res.statusCode).toBe(401);
  });

  it('streams switches, the last 50 logs (each with mode), new lines, switch changes and heartbeats', async () => {
    const ring = new LogRing();
    for (let i = 0; i < 70; i++)
      ring.push({ time: new Date().toISOString(), level: 'info', msg: `old ${i}`, mode: null });
    t = await createTestApp({ logRing: ring, heartbeatMs: 150 });
    await setupUser(t.app);
    const c = new Client(t.app, { remoteAddress: '10.0.0.9', headers: {} });
    expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/live`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    if (!res.body) throw new Error('no body');
    const sse = sseReader(res.body);

    const switches = await sse.waitFor((e) => e.event === 'switches');
    expect(switches.data).toMatchObject({
      globalKillSwitch: false,
      globalDryRun: true,
      allowLiveOrders: false,
    });
    const logs = (await sse.waitFor((e) => e.event === 'logs')).data as { msg: string; mode: unknown }[];
    expect(logs).toHaveLength(50);
    expect(logs.every((l) => 'mode' in l)).toBe(true);
    expect(logs.at(-1)?.msg).toBe('old 69');

    ring.push({ time: new Date().toISOString(), level: 'info', msg: 'fresh', mode: 'dry_run' });
    expect((await sse.waitFor((e) => e.event === 'log')).data).toMatchObject({
      msg: 'fresh',
      mode: 'dry_run',
    });

    await c.postWithCsrf('/api/settings', { global_kill_switch: true });
    await sse.waitFor(
      (e) => e.event === 'switches' && (e.data as { globalKillSwitch: boolean }).globalKillSwitch,
    );

    const beats = async () => sse.events.filter((e) => e.event === 'heartbeat');
    await sse.waitFor((e) => e.event === 'heartbeat');
    await new Promise((r) => setTimeout(r, 400));
    const hb = await beats();
    expect(hb.length).toBeGreaterThanOrEqual(2);
    expect(hb[0]?.data).toMatchObject({ switches: { globalKillSwitch: true } });

    // A revoked session stops receiving data at the next heartbeat.
    t.manager.repositories.sessions.deleteAll();
    await sse.waitFor((e) => e.event === 'end');
    await sse.done;
  });

  it('closing the app ends open streams', async () => {
    t = await createTestApp();
    await setupUser(t.app);
    const c = new Client(t.app, { remoteAddress: '10.0.0.9', headers: {} });
    await c.login(USER, PASSWORD);
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/live`, { headers: { cookie } });
    if (!res.body) throw new Error('no body');
    const sse = sseReader(res.body);
    await sse.waitFor((e) => e.event === 'logs');
    await t.app.close();
    await sse.done;
  });
});
