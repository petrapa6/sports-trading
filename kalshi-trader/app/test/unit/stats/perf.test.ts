import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StatsResponse } from '../../../src/core/stats.js';
import { seedDemo } from '../../../scripts/seed-demo-lib.js';
import { createTestApp, setupUser, type Client, type TestApp } from '../../helpers/app.js';

/** T10: `/api/stats` over 10 000 generated trades (both modes), median of 20 calls under 300 ms. */
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
let t: TestApp;
let client: Client;

beforeAll(async () => {
  t = await createTestApp({ now: () => NOW });
  const db = t.manager.current;
  if (!db) throw new Error('database closed');
  seedDemo(db.sqlite, { trades: 10_000, now: NOW });
  client = await setupUser(t.app);
}, 60_000);
afterAll(async () => {
  await t.close();
});

it('10 000 trades: /api/stats median < 300 ms over 20 calls', async () => {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const res = await client.get('/api/stats');
    times.push(performance.now() - start);
    expect(res.statusCode).toBe(200);
    bytes = Buffer.byteLength(res.body);
    const body = res.json() as StatsResponse;
    expect(body.live?.tiles.trades ?? 0).toBeGreaterThan(0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = ((sorted[9] ?? 0) + (sorted[10] ?? 0)) / 2;
  console.log(
    `[T10 perf] 10000 trades, 20 calls: median ${median.toFixed(1)} ms, min ${(sorted[0] ?? 0).toFixed(1)} ms, max ${(sorted[19] ?? 0).toFixed(1)} ms, response ${bytes} bytes`,
  );
  expect(median).toBeLessThan(300);
}, 120_000);
