/**
 * Drill (b) `db-lock` (SPEC.md §14 T14): another process holds an exclusive SQLite lock on the app's database for
 * 10 s. Requests that need the database answer `503 {"error":"db_busy"}` (after the 5 s `busy_timeout`), never a
 * 500; `/healthz` stays up; once the lock is released the same requests succeed again.
 *
 *   npx tsx scripts/drills/db-lock.ts
 */
import { spawn } from 'node:child_process';
import { APP } from '../verify-lib.js';
import { DrillClient, done, logLines, sleep, startInstance, step } from './lib.js';

const HOLD_MS = 10_000;
const inst = await startInstance('db-lock', Number(process.env['DRILL_PORT'] ?? 8292));
try {
  const c = new DrillClient(inst.base);
  await c.setup();
  const ok = await c.get('/api/status');
  step(ok.status === 200, 'before: GET /api/status (signed in) 200', `${ok.status}`);
  // The CSRF token is fetched before the lock (fetching it needs the database too).
  const token = (JSON.parse((await c.get('/api/csrf')).body) as { token: string }).token;

  // The lock is taken by a separate Node process (a second connection in another process, as a backup tool or
  // `sqlite3` shell would): BEGIN EXCLUSIVE, hold for 10 s, COMMIT.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.exec('BEGIN EXCLUSIVE');` +
        `console.log('locked');setTimeout(()=>{d.exec('COMMIT');d.close();console.log('released')},${HOLD_MS});`,
      inst.dbPath,
    ],
    { cwd: APP, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let holderOut = '';
  holder.stdout.on('data', (d: Buffer) => (holderOut += d.toString()));
  const released = new Promise<number | null>((r) => holder.on('exit', (code) => r(code)));
  while (!holderOut.includes('locked') && holder.exitCode === null) await sleep(20);
  const lockedAt = Date.now();
  step(holderOut.includes('locked'), 'another process: BEGIN EXCLUSIVE on trader.db', holderOut.trim());

  // better-sqlite3 is synchronous: the 5 s busy_timeout wait blocks the event loop, so requests are served one
  // after another. The first one gets db_busy after 5 s; the lock is gone by the time a second one could.
  const busy = await c.request(
    'POST',
    '/api/settings',
    { order_group_contract_limit: 150 },
    { 'x-csrf-token': token },
  );
  step(
    busy.status === 503 && busy.body === '{"error":"db_busy"}',
    'POST /api/settings while locked → 503 {"error":"db_busy"}',
    `${busy.status} ${busy.body} after ${(busy.ms / 1000).toFixed(1)} s`,
  );
  const health = await fetch(`${inst.base}/healthz`);
  step(health.status === 200, '/healthz while locked stays 200', `${health.status} ${await health.text()}`);

  const code = await released;
  step(
    code === 0,
    `lock released after ${HOLD_MS / 1000} s`,
    `${((Date.now() - lockedAt) / 1000).toFixed(1)} s`,
  );
  const after = await c.request(
    'POST',
    '/api/settings',
    { order_group_contract_limit: 150 },
    { 'x-csrf-token': token },
  );
  step(after.status === 200, 'after: the same POST → 200 (recovered)', `${after.status}`);
  const status = await c.get('/api/status');
  step(status.status === 200, 'after: GET /api/status 200', `${status.status}`);

  const lines = logLines(inst.logs());
  const errors = lines.filter((l) => l['msg'] === 'Unhandled error');
  const warns = lines.filter((l) => l['msg'] === 'Database busy');
  step(
    errors.length === 0 && warns.length >= 1,
    'no 500 / "Unhandled error" logged; "Database busy" warnings',
    `${errors.length} unhandled, ${warns.length} "Database busy"`,
  );
} finally {
  await inst.stop();
}
done('db-lock');
