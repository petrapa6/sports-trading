import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModeTiles, StatsResponse } from '../../../src/core/stats.js';
import { seedDemo } from '../../../scripts/seed-demo-lib.js';
import { createTestApp, setupUser, type Client, type TestApp } from '../../helpers/app.js';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures/db');
const SEED_SQL = readFileSync(resolve(FIXTURES, 'stats-seed.sql'), 'utf8');
const EXPECTED = JSON.parse(readFileSync(resolve(FIXTURES, 'stats-seed.expected.json'), 'utf8')) as {
  now: string;
  kalshiEnv: string;
  cases: Record<string, { query: string; response: StatsResponse }>;
};
const NOW = Date.parse(EXPECTED.now);

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** An app whose clock is the seed's `now`, optionally loaded with `stats-seed.sql`; returns a signed-in client. */
async function statsApp(seed = true): Promise<{ app: TestApp; client: Client; sql: (q: string) => void }> {
  t = await createTestApp({ now: () => NOW });
  const app = t;
  const db = () => {
    const current = app.manager.current;
    if (!current) throw new Error('database closed');
    return current.sqlite;
  };
  if (seed) db().exec(SEED_SQL);
  const client = await setupUser(app.app);
  return { app, client, sql: (q) => db().exec(q) };
}

async function stats(client: Client, query: string): Promise<StatsResponse> {
  const res = await client.get(`/api/stats${query ? `?${query}` : ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as StatsResponse;
}

describe('GET /api/stats on stats-seed.sql', () => {
  for (const [name, c] of Object.entries(EXPECTED.cases)) {
    it(`equals stats-seed.expected.json: ${name}`, async () => {
      const { client } = await statsApp();
      expect(await stats(client, c.query)).toEqual(c.response);
    });
  }

  it('omits the mode that is filtered out', async () => {
    const { client } = await statsApp();
    expect(Object.keys(await stats(client, 'mode=dry_run'))).toEqual(['dry_run']);
    expect(Object.keys(await stats(client, 'mode=live'))).toEqual(['live']);
    expect(Object.keys(await stats(client, ''))).toEqual(['live', 'dry_run']);
  });

  it('win rate excludes void, skipped and waiting trades; ROI divides by Σ (cost + fee) of settled trades', async () => {
    const { client } = await statsApp();
    const r = await stats(client, '');
    const dry = r.dry_run?.tiles;
    // Dry run: 8 won, 2 lost, 1 void (excluded), skipped / waiting / open not counted.
    expect(dry).toMatchObject({ trades: 11, won: 8, lost: 2, void: 1, winRate: 0.8 });
    expect(dry).toMatchObject({ netPnlMicros: -3_000_100, investedMicros: 16_000_100, roi: -0.1875 });
    expect(dry?.maxDrawdownMicros).toBe(3_421_000);
    expect(r.live?.tiles).toMatchObject({
      trades: 8,
      won: 6,
      lost: 2,
      winRate: 0.75,
      maxDrawdownMicros: 1_646_200,
    });
  });

  it('mode separation: changing one live trade changes only values under live; nothing is a sum over both modes', async () => {
    const { client, sql } = await statsApp();
    const before = await stats(client, '');
    // Per-mode recomputation: the combined response equals the single-mode responses, mode by mode.
    expect(before.live).toEqual((await stats(client, 'mode=live')).live);
    expect(before.dry_run).toEqual((await stats(client, 'mode=dry_run')).dry_run);

    // Trade #16 (live, won) becomes a loss.
    sql(
      `UPDATE trades SET status = 'settled_lost', settlement_value_bp = 0, payout_micros = 0,
         realized_pnl_micros = -1907000 WHERE id = 'stats-t16'`,
    );
    const after = await stats(client, '');
    expect(after.dry_run).toEqual(before.dry_run);
    expect(after.live).not.toEqual(before.live);
    expect(after.live?.tiles).toMatchObject({ won: 5, lost: 3, netPnlMicros: -1_298_100 - 2_000_000 });

    // No numeric tile under one mode equals the sum of both single-mode values (where both are non-zero).
    const live = must((await stats(client, 'mode=live')).live);
    const dry = must((await stats(client, 'mode=dry_run')).dry_run);
    for (const mode of ['live', 'dry_run'] as const) {
      const tiles = must(after[mode]).tiles;
      for (const key of Object.keys(tiles) as (keyof ModeTiles)[]) {
        const a = live.tiles[key];
        const b = dry.tiles[key];
        if (typeof a !== 'number' || typeof b !== 'number' || a === 0 || b === 0) continue;
        expect(tiles[key], `${mode}.${key}`).not.toBe(a + b);
      }
    }
    expect(Object.keys(after).sort()).toEqual(['dry_run', 'live']);
  });

  it('equity points are ordered by settled_at; bankroll and balance lines have one point per snapshot row in range', async () => {
    const { client, app } = await statsApp();
    const count = (q: string, ...p: string[]) =>
      (
        must(app.manager.current)
          .sqlite.prepare(q)
          .get(...p) as { n: number }
      ).n;
    for (const [query, since] of [
      ['', '0000'],
      ['range=7d', '2026-09-13T12:00:00.000Z'],
    ] as const) {
      const r = await stats(client, query);
      for (const mode of ['live', 'dry_run'] as const) {
        const m = must(r[mode]);
        const times = m.series.equity.total.map((p) => p.t);
        expect(times).toEqual([...times].sort());
        for (const s of m.series.equity.byStrategy) {
          expect(s.points.map((p) => p.t)).toEqual(s.points.map((p) => p.t).sort());
        }
      }
      expect(must(r.dry_run).series.bankroll).toHaveLength(
        count('SELECT count(*) AS n FROM bankroll_snapshots WHERE at >= ?', since),
      );
      expect(must(r.live).series.balance).toHaveLength(
        count("SELECT count(*) AS n FROM balance_snapshots WHERE kalshi_env = 'demo' AND at >= ?", since),
      );
      expect(must(r.dry_run).series.balance).toBeUndefined();
      expect(must(r.live).series.bankroll).toBeUndefined();
    }
  });

  it('implied vs actual: one point per (strategy, league) within each mode, with x, y and n', async () => {
    const { client } = await statsApp();
    const r = await stats(client, '');
    for (const mode of ['live', 'dry_run'] as const) {
      const points = must(r[mode]).series.impliedVsActual;
      const keys = points.map((p) => `${p.strategyId}/${p.leagueId}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.sort()).toEqual(['A/epl', 'A/laliga', 'B/epl', 'B/laliga']);
      for (const p of points) {
        expect(typeof p.x).toBe('number');
        expect(typeof p.y).toBe('number');
        expect(p.n).toBeGreaterThan(0);
      }
    }
  });
});

describe('GET /api/stats edge cases', () => {
  it('empty database → 200 with zeroed tiles and empty arrays for both modes', async () => {
    const { client } = await statsApp(false);
    const r = await stats(client, '');
    const zeroTiles = {
      trades: 0,
      won: 0,
      lost: 0,
      void: 0,
      winRate: 0,
      netPnlMicros: 0,
      investedMicros: 0,
      roi: 0,
      maxDrawdownMicros: 0,
      filled: 0,
      avgPriceBp: 0,
      avgFeeMicros: 0,
      impliedVsActual: { impliedBp: 0, actualWinRate: 0, n: 0 },
    };
    const emptySeries = {
      equity: { total: [], byStrategy: [] },
      dailyPnl: [],
      drawdown: [],
      impliedVsActual: [],
      priceHistogram: { minBp: 8200, maxBp: 9700, below: 0, above: 0, bins: [] },
      tradesPerMinute: [],
      skipReasons: { final: [], perAttempt: [] },
    };
    expect(r).toEqual({
      live: { tiles: zeroTiles, series: { ...emptySeries, balance: [] } },
      dry_run: {
        tiles: { ...zeroTiles, forcedDryRun: { forced: 0, total: 0, share: 0 } },
        series: { ...emptySeries, bankroll: [] },
      },
    } satisfies StatsResponse);
  });

  it('unknown league id → 400; malformed parameters → 400', async () => {
    const { client } = await statsApp(false);
    const unknown = await client.get('/api/stats?leagues=epl,atlantis');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'unknown_league', leagues: ['atlantis'] });
    expect((await client.get('/api/stats?mode=all')).statusCode).toBe(400);
    expect((await client.get('/api/stats?range=1y')).statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const { app } = await statsApp(false);
    const res = await app.app.inject({ method: 'GET', url: '/api/stats', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(401);
  });

  it('500 seeded trades → response < 200 KB with no per-trade rows', async () => {
    const { client, app } = await statsApp(false);
    const result = seedDemo(must(app.manager.current).sqlite, { trades: 500, now: NOW });
    expect(result.trades).toBe(500);
    const res = await client.get('/api/stats');
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(Buffer.byteLength(res.body)).toBeLessThan(200 * 1024);
    expect(JSON.stringify(body).includes('trigger_snapshot')).toBe(false);
    expect(JSON.stringify(body).includes('demo-000')).toBe(false); // no trade ids
    expect(must(body.live).tiles.trades).toBeGreaterThan(0);
    expect(must(body.dry_run).tiles.trades).toBeGreaterThan(0);
  });
});

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('missing value');
  return v;
}
