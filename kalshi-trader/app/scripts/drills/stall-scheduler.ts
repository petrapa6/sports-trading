/**
 * Drill (a) `stall-scheduler` (SPEC.md §14 T14): a scratch development instance, its trading loop stalled through
 * the development-only `POST /api/dev/drills/stall-scheduler` → `/healthz` must answer 503 within 2 minutes (the
 * Supervisor watchdog then restarts the container); `resume-scheduler` → 200 again.
 *
 *   npx tsx scripts/drills/stall-scheduler.ts      # takes about 2 minutes (real time)
 */
import { done, sleep, startInstance, step } from './lib.js';

const LIMIT_MS = 120_000;
const inst = await startInstance('stall-scheduler', Number(process.env['DRILL_PORT'] ?? 8291));
try {
  const health = async () => {
    const r = await fetch(`${inst.base}/healthz`);
    return { status: r.status, body: await r.text() };
  };
  // The loop ticks once at start; wait for that first tick so the stall starts from a healthy loop.
  let before = await health();
  for (let i = 0; i < 50 && !before.body.includes('"loop":"idle"'); i++) {
    await sleep(200);
    before = await health();
  }
  step(before.status === 200, 'before: /healthz 200', `${before.status} ${before.body}`);

  // Stall a few seconds after that tick, as a hang would (not in the same instant as a tick).
  await sleep(5000);
  const stall = await fetch(`${inst.base}/api/dev/drills/stall-scheduler`, { method: 'POST' });
  const stalledAt = Date.now();
  step(stall.status === 200, 'POST /api/dev/drills/stall-scheduler', `${stall.status}`);

  let after = await health();
  while (after.status === 200 && Date.now() - stalledAt < LIMIT_MS + 5_000) {
    await sleep(1000);
    after = await health();
  }
  const took = Date.now() - stalledAt;
  step(
    after.status === 503 && took <= LIMIT_MS + 1_000,
    '/healthz 503 within 2 min of the stall',
    `${after.status} ${after.body} after ${(took / 1000).toFixed(1)} s`,
  );

  const resume = await fetch(`${inst.base}/api/dev/drills/resume-scheduler`, { method: 'POST' });
  let recovered = await health();
  for (let i = 0; i < 50 && recovered.status !== 200; i++) {
    await sleep(200);
    recovered = await health();
  }
  step(
    resume.status === 200 && recovered.status === 200,
    'resume-scheduler → /healthz 200 again',
    `${recovered.status} ${recovered.body}`,
  );
} finally {
  await inst.stop();
}
done('stall-scheduler');
