import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { collectCandles } from '../../../src/backtest/candles.js';
import { importPlayByPlay, runBackfill } from '../../../src/backtest/kalshiBackfill.js';
import { PbpUnusable, timelineFromGameStats } from '../../../src/backtest/kalshiPbp.js';
import { GameTracker } from '../../../src/core/tracker.js';
import { openDatabase, type Db } from '../../../src/db/connection.js';
import { migrateUp } from '../../../src/db/migrate.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { GameStatsResponseSchema } from '../../../src/feeds/kalshi/schemas.js';
import { fixture } from '../../helpers/kalshiFixtures.js';
import { captureLogger, kalshiMockServer, testClient } from '../../helpers/kalshiMsw.js';

const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  mock.server.resetHandlers();
  mock.requests.length = 0;
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
afterAll(() => mock.server.close());

let db: Db | undefined;
let dir: string | undefined;
function fresh(): Repositories {
  dir = mkdtempSync(join(tmpdir(), 'kst-kalshi-hist-'));
  db = openDatabase(join(dir, 'trader.db'));
  migrateUp(db);
  return createRepositories(db.orm);
}

const FULMUN = 'KXEPLGAME-26SEP20FULMUN';
const MCISUN = 'KXEPLGAME-26SEP20MCISUN';
const paths = () => mock.requests.map((r) => `${r.url.pathname.replace('/trade-api/v2', '')}${r.url.search}`);

function deps(repos: Repositories) {
  const logs = captureLogger('info');
  return {
    logs,
    d: {
      client: testClient(),
      repos,
      log: logs.log,
      transaction: (fn: () => void) => db?.sqlite.transaction(fn)(),
      now: () => Date.parse('2026-09-26T08:00:00Z'),
    },
  };
}

describe('Kalshi backfill discovery (msw: 3 settled EPL events, 2 in the range)', () => {
  it('stores 2 historical games with milestones and 3 markets each, not tracked by the scheduler', async () => {
    const repos = fresh();
    for (const l of repos.leagues.list())
      if (l.id !== 'epl') repos.leagues.update({ id: l.id }, { enabled: 0 });
    const { d } = deps(repos);
    const r = await runBackfill(d, { from: '2026-09-15', to: '2026-09-25', playByPlay: false });
    expect(r.leagues).toEqual([
      {
        leagueId: 'epl',
        series: 'KXEPLGAME',
        settledEvents: 3,
        inRange: 2,
        skippedPreseason: 0,
        skippedNoMilestone: 0,
        games: 2,
        markets: 6,
      },
    ]);
    expect(paths()[0]).toContain('/events?series_ticker=KXEPLGAME&status=settled&with_nested_markets=true');
    const games = repos.games.list();
    expect(games.map((g) => g.id)).toEqual([FULMUN, MCISUN]);
    for (const g of games) {
      expect(g).toMatchObject({ league_id: 'epl', phase: 'finished', historical: 1, competition: 'EPL' });
      expect(g.milestone_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(g.home_team_id).not.toBeNull();
      expect(g.away_team_id).not.toBeNull();
      const markets = repos.markets.listByGame(g.id);
      expect(markets.map((m) => m.outcome).sort()).toEqual(['away', 'home', 'tie']);
      expect(markets.every((m) => m.status === 'finalized' && m.settlement_value_bp !== null)).toBe(true);
    }
    expect(repos.games.get({ id: FULMUN })).toMatchObject({
      scheduled_at: '2026-09-20T15:30:00.000Z',
      finished_at: '2026-09-20T17:28:06.000Z',
    });
    expect(repos.markets.get({ ticker: `${FULMUN}-TIE` })).toMatchObject({
      result: 'yes',
      settlement_value_bp: 10000,
    });

    // Not tracked: the tracker's poll targets and the dashboard cards leave historical games out, even
    // right after their scheduled start.
    const tracker = new GameTracker({ repos: () => repos, log: captureLogger().log });
    const kickoff = Date.parse('2026-09-20T15:40:00Z');
    repos.games.update({ id: FULMUN }, { phase: 'live' });
    expect(tracker.pollTargets(kickoff)).toEqual([]);
    expect(tracker.displayGames(kickoff)).toEqual([]);
    repos.games.update({ id: FULMUN }, { phase: 'finished' });

    // A second run changes nothing but updated_at.
    const again = await runBackfill(d, { from: '2026-09-15', to: '2026-09-25', playByPlay: false });
    expect(again.leagues[0]?.games).toBe(2);
    expect(repos.games.count()).toBe(2);
    expect(repos.markets.count()).toBe(6);
  });

  it('keeps a game the app tracked live as it is (only its markets are refreshed)', async () => {
    const repos = fresh();
    repos.games.insert({
      id: FULMUN,
      league_id: 'epl',
      scheduled_at: '2026-09-20T15:30:00.000Z',
      phase: 'finished',
      timeline_archived: 1,
      updated_at: '2026-09-20T17:30:00.000Z',
    });
    const { d } = deps(repos);
    await runBackfill(d, { from: '2026-09-20', to: '2026-09-20', leagueIds: ['epl'], playByPlay: false });
    expect(repos.games.get({ id: FULMUN })).toMatchObject({ historical: 0, timeline_archived: 1 });
    expect(repos.markets.listByGame(FULMUN)).toHaveLength(3);
  });
});

describe('Kalshi play-by-play importer (game_stats payloads shaped like production, 2026-09-26)', () => {
  it('soccer: FUL 1-1 MUN → an own goal at 63 for home, the equaliser at 89; a disallowed possible_goal does not count', () => {
    const stats = GameStatsResponseSchema.parse(fixture('game_stats_70de1a3b-9f5d-4a74-adc7-b803ce6b0ae2'));
    expect(timelineFromGameStats(stats, 'soccer')).toEqual({
      goals: [
        { side: 'home', period: 2, minute: 63, second: 25 },
        { side: 'away', period: 2, minute: 89, second: 38 },
      ],
      finalHome: 1,
      finalAway: 1,
    });
  });

  it('soccer: MCI 5-3 SUN, 8 goals in time order across both halves', () => {
    const stats = GameStatsResponseSchema.parse(fixture('game_stats_f4ab8b9c-50de-4922-a1fe-c54324d4e8d3'));
    const t = timelineFromGameStats(stats, 'soccer');
    expect([t.finalHome, t.finalAway]).toEqual([5, 3]);
    expect(t.goals.map((g) => `${g.side}:${g.minute}`)).toEqual([
      'home:9',
      'away:12',
      'home:29',
      'away:33',
      'home:43',
      'home:57',
      'away:59',
      'home:81',
    ]);
    expect(t.goals.map((g) => g.period)).toEqual([1, 1, 1, 1, 1, 2, 2, 2]);
  });

  it('hockey: running points with the clock as time remaining → elapsed minute and second', () => {
    const stats = GameStatsResponseSchema.parse(fixture('game_stats_ba515294-df3d-46f9-b96d-16177d4e1004'));
    expect(timelineFromGameStats(stats, 'hockey')).toEqual({
      goals: [
        { side: 'home', period: 1, minute: 5, second: 58 },
        { side: 'away', period: 1, minute: 13, second: 15 },
        { side: 'home', period: 2, minute: 28, second: 40 },
        { side: 'away', period: 3, minute: 44, second: 50 },
        { side: 'home', period: 3, minute: 51, second: 55 },
        { side: 'home', period: 3, minute: 59, second: 38 },
      ],
      finalHome: 4,
      finalAway: 2,
    });
  });

  it('an unusable payload is rejected with the reason', () => {
    expect(() =>
      timelineFromGameStats(GameStatsResponseSchema.parse(fixture('game_stats')), 'soccer'),
    ).toThrow(PbpUnusable);
    expect(() =>
      timelineFromGameStats(GameStatsResponseSchema.parse({ pbp: { periods: [] } }), 'hockey'),
    ).toThrow(/no play-by-play periods/);
  });

  it('backfill + play-by-play: hist_games (source kalshi_pbp) with the expected goal timeline; timeline_archived = 1', async () => {
    const repos = fresh();
    const { d, logs } = deps(repos);
    const r = await runBackfill(d, { from: '2026-09-15', to: '2026-09-25', leagueIds: ['epl'] });
    expect(r.playByPlay).toEqual({ imported: 2, skippedLive: 0, unusable: 0, failed: 0 });
    const ful = repos.histGames.get({ id: `kalshi_pbp:${FULMUN}` });
    expect(ful).toMatchObject({
      league_id: 'epl',
      season: '2026-27',
      source: 'kalshi_pbp',
      kalshi_event_ticker: FULMUN,
      home: 'Fulham',
      away: 'Manchester United',
      final_home: 1,
      final_away: 1,
    });
    expect(JSON.parse(ful?.goal_events ?? '[]')).toHaveLength(2);
    expect(repos.games.get({ id: FULMUN })).toMatchObject({
      timeline_archived: 1,
      final_home: 1,
      final_away: 1,
    });
    expect(paths().filter((p) => p.endsWith('/game_stats'))).toHaveLength(2);

    // Nothing left to import; a game with a live timeline is skipped.
    mock.requests.length = 0;
    expect(await importPlayByPlay(d)).toEqual({ imported: 0, skippedLive: 0, unusable: 0, failed: 0 });
    expect(mock.requests).toHaveLength(0);
    expect(logs.text()).toContain('Play-by-play import finished');
  });
});

describe('candle collector', () => {
  function seedGames(repos: Repositories) {
    const game = (id: string, close: string) => {
      repos.games.insert({
        id,
        league_id: 'nhl',
        scheduled_at: '2026-01-10T00:00:00.000Z',
        milestone_id: `m-${id}`,
        phase: 'finished',
        historical: 1,
        updated_at: close,
      });
      for (const outcome of ['home', 'away'] as const)
        repos.markets.insert({
          ticker: `${id}-${outcome === 'home' ? 'VGK' : 'UTA'}`,
          game_id: id,
          outcome,
          status: 'finalized',
          close_time: close,
        });
    };
    // The fixture cutoff (market_settled_ts) is 2026-06-25.
    game('KXNHLGAME-26OCT10UTAVGK', '2026-10-11T04:40:00Z'); // after the cutoff
    game('KXNHLGAME-26MAY10UTAVGK', '2026-05-11T04:40:00Z'); // before the cutoff
  }

  it('uses /series/…/candlesticks after the cutoff and /historical/markets/…/candlesticks before; rows carry ask and bid close; no trade → NULL', async () => {
    const repos = fresh();
    seedGames(repos);
    const { d } = deps(repos);
    const r = await collectCandles(d);
    expect(r).toMatchObject({ games: 2, markets: 4, historicalMarkets: 2, candles: 8, failed: 0 });
    const urls = paths();
    expect(urls[0]).toBe('/historical/cutoff');
    expect(
      urls.filter((u) => u.startsWith('/series/KXNHLGAME/markets/KXNHLGAME-26OCT10UTAVGK-')),
    ).toHaveLength(2);
    expect(urls.filter((u) => u.startsWith('/historical/markets/KXNHLGAME-26MAY10UTAVGK-'))).toHaveLength(2);
    expect(urls.some((u) => u.includes('26MAY10') && u.startsWith('/series/'))).toBe(false);
    expect(urls.find((u) => u.includes('26OCT10UTAVGK-VGK'))).toContain('period_interval=1');

    const rows = repos.histPrices.list();
    expect(rows).toHaveLength(8);
    const first = repos.histPrices.get({
      market_ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
      minute_ts: new Date(1791684060 * 1000).toISOString(),
    });
    expect(first).toMatchObject({
      ask_close_bp: 5900,
      bid_close_bp: 5700,
      trade_close_bp: 5800,
      volume_cc: 12000,
    });
    const quiet = repos.histPrices.get({
      market_ticker: 'KXNHLGAME-26OCT10UTAVGK-VGK',
      minute_ts: new Date(1791684120 * 1000).toISOString(),
    });
    expect(quiet).toMatchObject({ ask_close_bp: 5900, bid_close_bp: 5700, trade_close_bp: null });
  });

  it('rerunning changes nothing (skipped, or rewritten with identical values when forced)', async () => {
    const repos = fresh();
    seedGames(repos);
    const { d } = deps(repos);
    await collectCandles(d);
    const before = JSON.stringify(repos.histPrices.list());
    mock.requests.length = 0;
    const skip = await collectCandles(d);
    expect(skip).toMatchObject({ skippedExisting: 4, candles: 0 });
    expect(paths()).toEqual(['/historical/cutoff']);
    const forced = await collectCandles(d, { force: true });
    expect(forced.candles).toBe(8);
    expect(JSON.stringify(repos.histPrices.list())).toBe(before);
  });

  it('sets hist_games.kalshi_event_ticker on the matching NHL timeline', async () => {
    const repos = fresh();
    seedGames(repos);
    repos.teams.insert({
      id: 'nhl:vgk',
      league_id: 'nhl',
      name: 'Vegas',
      abbreviation: 'VGK',
      aliases: '["VGK"]',
    });
    repos.teams.insert({
      id: 'nhl:uta',
      league_id: 'nhl',
      name: 'Utah',
      abbreviation: 'UTA',
      aliases: '["UTA"]',
    });
    repos.games.update(
      { id: 'KXNHLGAME-26OCT10UTAVGK' },
      { home_team_id: 'nhl:vgk', away_team_id: 'nhl:uta' },
    );
    const hist = (id: string, home: string, playedAt: string) =>
      repos.histGames.insert({
        id,
        league_id: 'nhl',
        season: '2025-26',
        played_at: playedAt,
        home,
        away: 'UTA',
        final_home: 0,
        final_away: 0,
        goal_events: '[]',
        source: 'nhl',
      });
    hist('nhl:1', 'VGK', '2026-01-10T00:00:00.000Z');
    hist('nhl:2', 'SEA', '2026-01-10T00:00:00.000Z');
    hist('nhl:3', 'VGK', '2026-01-14T00:00:00.000Z');
    repos.games.update({ id: 'KXNHLGAME-26OCT10UTAVGK' }, { scheduled_at: '2026-01-10T01:00:00.000Z' });
    const { d } = deps(repos);
    const r = await collectCandles(d);
    expect(r.linked).toBe(1);
    expect(repos.histGames.get({ id: 'nhl:1' })?.kalshi_event_ticker).toBe('KXNHLGAME-26OCT10UTAVGK');
    expect(repos.histGames.get({ id: 'nhl:2' })?.kalshi_event_ticker).toBeNull();
    expect(repos.histGames.get({ id: 'nhl:3' })?.kalshi_event_ticker).toBeNull();
  });
});
