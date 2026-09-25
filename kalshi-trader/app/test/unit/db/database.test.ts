import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager, DatabaseUnavailableError } from '../../../src/db/database.js';
import { buildApp } from '../../../src/server/app.js';

const log = pino({ level: 'silent' });
const isRoot = process.getuid?.() === 0;

describe('DatabaseManager and /healthz', () => {
  let dir: string;
  let manager: DatabaseManager | undefined;
  afterEach(() => {
    manager?.close();
    manager = undefined;
    if (existsSync(dir)) {
      chmodSync(dir, 0o755);
      for (const sub of ['ro']) if (existsSync(join(dir, sub))) chmodSync(join(dir, sub), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens, migrates and answers /healthz with {"ok":true}', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kst-mgr-'));
    manager = new DatabaseManager(join(dir, 'data', 'db', 'trader.db'), log);
    manager.open();
    expect(manager.repositories.leagues.count()).toBe(6);
    const app = buildApp({ logger: log, database: manager });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    await app.close();
  });

  it.skipIf(isRoot)(
    'returns 503 {"ok":false,"db":…} when DB_PATH is in an unwritable directory',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'kst-mgr-'));
      const ro = join(dir, 'ro');
      mkdirSync(ro);
      chmodSync(ro, 0o555);
      manager = new DatabaseManager(join(ro, 'trader.db'), log);
      expect(() => manager?.open()).toThrow(DatabaseUnavailableError);
      const app = buildApp({ logger: log, database: manager });
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, db: 'SQLITE_CANTOPEN' });
      await app.close();
    },
  );

  it('returns 503 when the database directory cannot be created, and recovers once it can', async () => {
    // A regular file where the directory should be: unwritable for every user, including root.
    dir = mkdtempSync(join(tmpdir(), 'kst-mgr-'));
    const blocker = join(dir, 'db');
    writeFileSync(blocker, '');
    manager = new DatabaseManager(join(blocker, 'trader.db'), log);
    const app = buildApp({ logger: log, database: manager });
    let res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) });

    rmSync(blocker);
    res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(manager.current).toBeDefined();
    await app.close();
  });
});
