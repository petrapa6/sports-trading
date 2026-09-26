import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../../src/core/scheduler.js';
import { GameTracker } from '../../src/core/tracker.js';
import { isDbBusy } from '../../src/server/app.js';
import { Client, createTestApp, PASSWORD, setupUser, tunnel, USER, type TestApp } from '../helpers/app.js';
import { captureLogger, must } from '../helpers/kalshiMsw.js';

/**
 * T14: the failure-drill endpoints exist only with NODE_ENV=development and answer only class `dev`; a database
 * locked by another process answers `503 {"error":"db_busy"}`, never a 500.
 */

const DEV = { remoteAddress: '127.0.0.1', headers: {} };
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function appWithLoop(nodeEnv: string) {
  const { log } = captureLogger('info');
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const tracker = new GameTracker({ repos, log });
  const scheduler = new Scheduler({
    tracker,
    feeds: [],
    isFeedEnabled: () => true,
    isPaused: () => false,
    log,
  });
  const app = await createTestApp({ nodeEnv, live: { tracker, scheduler, feeds: [] } });
  box.app = app;
  return { app, scheduler };
}

describe('drill endpoints', () => {
  it.each(['production', 'test', undefined])(
    'NODE_ENV=%s → not registered: 404 when signed in, 401 without a session',
    async (env) => {
      const { app } = await appWithLoop(env as string);
      t = app;
      const signedIn = await setupUser(app.app);
      for (const path of ['/api/dev/drills/stall-scheduler', '/api/dev/drills/resume-scheduler']) {
        const res = await signedIn.postWithCsrf(path, {});
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
        expect((await new Client(app.app, DEV).post(path)).statusCode).toBe(401);
      }
    },
  );

  it('NODE_ENV=development: class dev stalls and resumes the loop; tunnel gets 404', async () => {
    const { app, scheduler } = await appWithLoop('development');
    t = app;
    scheduler.start();
    const outside = await new Client(app.app, tunnel()).post('/api/dev/drills/stall-scheduler');
    expect(outside.statusCode).toBe(404);
    const dev = new Client(app.app, DEV);
    expect((await dev.post('/api/dev/drills/stall-scheduler')).statusCode).toBe(200);
    expect(scheduler.status().state).toBe('stopped');
    expect((await dev.post('/api/dev/drills/resume-scheduler')).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduler.status().state).not.toBe('stopped');
    scheduler.stop();
  });
});

describe('database locked by another process', () => {
  it('isDbBusy matches SQLITE_BUSY / SQLITE_LOCKED and their extended codes only', () => {
    for (const c of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'])
      expect(isDbBusy(c)).toBe(true);
    for (const c of ['SQLITE_BUSYX', 'SQLITE_CONSTRAINT', 'FST_ERR', '']) expect(isDbBusy(c)).toBe(false);
  });

  it('a signed-in request while another connection holds BEGIN EXCLUSIVE → 503 {"error":"db_busy"}, then 200', async () => {
    t = await createTestApp();
    await setupUser(t.app);
    const c = new Client(t.app, tunnel());
    expect((await c.login(USER, PASSWORD)).statusCode).toBe(200);
    const db = must(t.manager.current, 'db');
    db.sqlite.pragma('busy_timeout = 50'); // the drill waits the real 5 s; the unit test does not need to
    const other = new Database(db.path);
    other.exec('BEGIN EXCLUSIVE');
    try {
      const res = await c.get('/api/status');
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe('{"error":"db_busy"}');
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      other.exec('COMMIT');
      other.close();
    }
    expect((await c.get('/api/status')).statusCode).toBe(200);
    expect(t.logs().some((l) => l['msg'] === 'Unhandled error')).toBe(false);
    expect(t.logs().some((l) => l['msg'] === 'Database busy')).toBe(true);
  });
});
