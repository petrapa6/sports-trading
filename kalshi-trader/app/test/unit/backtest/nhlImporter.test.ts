import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  importNhlSeason,
  NhlHistoryClient,
  NhlPlayByPlaySchema,
  seasonLabel,
  timelineFromPlayByPlay,
} from '../../../src/backtest/nhlImporter.js';
import { openDatabase, type Db } from '../../../src/db/connection.js';
import { migrateUp } from '../../../src/db/migrate.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { createNetworkGate, NetworkPaused } from '../../../src/feeds/network.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { nhlFixture, routeNhl } from '../../helpers/nhlFixtures.js';

const BASE = 'https://nhl.test/v1';
const seen: { path: string; at: number }[] = [];
const server = setupServer(
  http.get(`${BASE}/*`, ({ request }) => {
    const path = new URL(request.url).pathname.slice('/v1'.length);
    seen.push({ path, at: Date.now() });
    const r = routeNhl(path);
    return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
afterAll(() => server.close());

let db: Db | undefined;
let dir: string | undefined;
function fresh(): Repositories {
  dir = mkdtempSync(join(tmpdir(), 'kst-nhl-'));
  db = openDatabase(join(dir, 'trader.db'));
  migrateUp(db);
  return createRepositories(db.orm);
}

function importer(repos: Repositories, opts: { killSwitch?: () => boolean; rate?: number } = {}) {
  const logs = captureLogger('info');
  const client = new NhlHistoryClient({
    gate: createNetworkGate(opts.killSwitch ?? (() => false)),
    log: logs.log,
    baseUrl: BASE,
    requestsPerSecond: opts.rate ?? 100,
  });
  return {
    client,
    logs,
    run: (o: Parameters<typeof importNhlSeason>[1]) => importNhlSeason({ client, repos, log: logs.log }, o),
  };
}

const events = (repos: Repositories, id: string) =>
  JSON.parse(repos.histGames.get({ id })?.goal_events ?? 'null') as unknown;

describe('NHL importer (msw: one week with 3 games incl. one preseason + play-by-play files)', () => {
  it('imports 2 regular-season games by default and 3 with preseason requested', async () => {
    const repos = fresh();
    const r = await importer(repos).run({ season: '20252026' });
    expect(r).toMatchObject({
      season: '2025-26',
      inserted: 2,
      skippedPreseason: 1,
      skippedExisting: 0,
      failed: 0,
    });
    expect(repos.histGames.list().map((h) => h.id)).toEqual(['nhl:2025020039', 'nhl:2025020074']);
    expect(seen.map((s) => s.path)).toEqual([
      '/schedule/2025-09-01',
      '/gamecenter/2025020039/play-by-play',
      '/gamecenter/2025020074/play-by-play',
      '/schedule/2025-09-29',
    ]);

    const withPre = await importer(repos).run({ season: '20252026', includePreseason: true });
    expect(withPre.inserted).toBe(1);
    expect(repos.histGames.count()).toBe(3);
    expect(repos.histGames.get({ id: 'nhl:2025010001' })).toMatchObject({
      league_id: 'nhl',
      season: '2025-26',
      competition: 'Pro Hockey Preseason',
      home: 'MTL',
      away: 'TOR',
      final_home: 2,
      final_away: 1,
      source: 'nhl',
    });
  });

  it('goal events carry period, minute, second and the side from the scoring team id', async () => {
    const repos = fresh();
    await importer(repos).run({ season: '20252026' });
    expect(repos.histGames.get({ id: 'nhl:2025020039' })).toMatchObject({
      home: 'BUF',
      away: 'COL',
      played_at: '2025-09-24T16:30:00.000Z',
      final_home: 1,
      final_away: 3,
      competition: 'Pro Hockey',
      kalshi_event_ticker: null,
    });
    expect(events(repos, 'nhl:2025020039')).toEqual([
      { side: 'away', period: 1, minute: 3, second: 14 },
      { side: 'home', period: 1, minute: 16, second: 32 },
      { side: 'away', period: 2, minute: 24, second: 32 },
      { side: 'away', period: 2, minute: 31, second: 59 },
    ]);
  });

  it('a shootout game stores the official final (3-2) and its goal events exclude the shootout attempts', async () => {
    const repos = fresh();
    await importer(repos).run({ season: '20252026' });
    const so = repos.histGames.get({ id: 'nhl:2025020074' });
    expect([so?.away, so?.final_away, so?.home, so?.final_home]).toEqual(['VAN', 3, 'CHI', 2]);
    expect(events(repos, 'nhl:2025020074')).toEqual([
      { side: 'home', period: 1, minute: 7, second: 41 },
      { side: 'away', period: 2, minute: 29, second: 3 },
      { side: 'away', period: 3, minute: 42, second: 27 },
      { side: 'home', period: 3, minute: 57, second: 50 },
    ]);
    // The fixture has three shootout goals (periodType SO); none is a goal event.
    const pbp = nhlFixture<{ plays: { typeDescKey: string; periodDescriptor: { periodType: string } }[] }>(
      'pbp_2025020074',
    );
    expect(
      pbp.plays.filter((p) => p.typeDescKey === 'goal' && p.periodDescriptor.periodType === 'SO'),
    ).toHaveLength(3);
  });

  it('a second run inserts 0 rows and logs "skipped N existing"', async () => {
    const repos = fresh();
    await importer(repos).run({ season: '20252026' });
    seen.length = 0;
    const again = importer(repos);
    const r = await again.run({ season: '20252026' });
    expect(r).toMatchObject({ inserted: 0, skippedExisting: 2 });
    expect(again.logs.text()).toContain('skipped 2 existing');
    // Existing games are not fetched again.
    expect(seen.some((s) => s.path.includes('play-by-play'))).toBe(false);
  });

  it('--limit stops after that many inserted games', async () => {
    const repos = fresh();
    const r = await importer(repos).run({ season: '20252026', limit: 1 });
    expect(r.inserted).toBe(1);
    expect(repos.histGames.count()).toBe(1);
  });

  it('makes at most 4 requests per second', async () => {
    const repos = fresh();
    await importer(repos, { rate: 4 }).run({ season: '20252026' });
    expect(seen).toHaveLength(4);
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i]?.at ?? 0) - (seen[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(245);
    }
  });

  it('makes no request while the global kill switch is on', async () => {
    const repos = fresh();
    await expect(
      importer(repos, { killSwitch: () => true }).run({ season: '20252026' }),
    ).rejects.toBeInstanceOf(NetworkPaused);
    expect(seen).toHaveLength(0);
  });

  it('rejects a play-by-play whose goals do not add up to the final', () => {
    const pbp = NhlPlayByPlaySchema.parse(nhlFixture('pbp_2025020039'));
    expect(timelineFromPlayByPlay(pbp).goals).toHaveLength(4);
    pbp.homeTeam.score = 3;
    expect(() => timelineFromPlayByPlay(pbp)).toThrow(/do not match the final/);
  });

  it('season labels', () => {
    expect(seasonLabel('20252026')).toBe('2025-26');
    expect(seasonLabel(20992100)).toBe('2099-00');
    expect(() => seasonLabel('2025')).toThrow();
    expect(() => seasonLabel('20252027')).toThrow();
  });
});
