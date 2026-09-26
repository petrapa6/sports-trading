import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPriceModel,
  matchMinute,
  medianBp,
  priceModelLookup,
  seedAskBp,
  seedModel,
  type PriceModel,
} from '../../../src/backtest/priceModel.js';
import { openDatabase, type Db } from '../../../src/db/connection.js';
import { migrateUp } from '../../../src/db/migrate.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';

let db: Db | undefined;
let dir: string | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
function fresh(): Repositories {
  dir = mkdtempSync(join(tmpdir(), 'kst-model-'));
  db = openDatabase(join(dir, 'trader.db'));
  migrateUp(db);
  return createRepositories(db.orm);
}

const MIN = 60_000;
const cell = (m: PriceModel, sport: 'soccer' | 'hockey', lead: 1 | 2 | 3, from: number) =>
  m.cells.find((c) => c.sport === sport && c.lead === lead && c.remainingFrom === from);

/**
 * 12 EPL games, each with home goals at 20' and 50' (lead 2 from minute 50). Each game has five home-market
 * candles at wall minutes 93–97 after the start = match minutes 76–80 (10–14 minutes left) → 60
 * observations in (soccer, lead 2, 10–15). Asks are 9300 + 10 × i for i = 0 … 59, so the hand-computed
 * median is (9590 + 9600) / 2 = 9595. Game 0 also has five candles at match minutes 31–35 (lead 1, 55–59
 * minutes left): a 5-observation cell. Candles that must not count: the away (trailing) market, half-time,
 * and the 0-0 start.
 */
function seed(repos: Repositories): void {
  for (let g = 0; g < 12; g++) {
    const id = `KXEPLGAME-TEST${String(g).padStart(2, '0')}`;
    const start = Date.parse('2026-09-01T14:00:00Z') + g * 86_400_000;
    repos.games.insert({
      id,
      league_id: 'epl',
      scheduled_at: new Date(start).toISOString(),
      phase: 'finished',
      historical: 1,
      updated_at: '2026-09-26T00:00:00.000Z',
    });
    for (const outcome of ['home', 'away', 'tie'] as const)
      repos.markets.insert({ ticker: `${id}-${outcome.toUpperCase()}`, game_id: id, outcome });
    repos.histGames.insert({
      id: `kalshi_pbp:${id}`,
      league_id: 'epl',
      season: '2026-27',
      played_at: new Date(start).toISOString(),
      home: 'H',
      away: 'A',
      final_home: 2,
      final_away: 0,
      goal_events: JSON.stringify([
        { side: 'home', period: 1, minute: 20, second: 0 },
        { side: 'home', period: 2, minute: 50, second: 0 },
      ]),
      source: 'kalshi_pbp',
      kalshi_event_ticker: id,
    });
    // A CSV duplicate of the same event with a different timeline must lose against kalshi_pbp.
    if (g === 0)
      repos.histGames.insert({
        id: `csv:${id}`,
        league_id: 'epl',
        season: '2026-27',
        played_at: new Date(start).toISOString(),
        home: 'H',
        away: 'A',
        final_home: 0,
        final_away: 3,
        goal_events: JSON.stringify([
          { side: 'away', period: 1, minute: 1, second: 0 },
          { side: 'away', period: 1, minute: 2, second: 0 },
          { side: 'away', period: 1, minute: 3, second: 0 },
        ]),
        source: 'csv',
        kalshi_event_ticker: id,
      });
    const candle = (market: string, wallMinute: number, ask: number) =>
      repos.histPrices.insert({
        market_ticker: `${id}-${market}`,
        minute_ts: new Date(start + wallMinute * MIN).toISOString(),
        ask_close_bp: ask,
        bid_close_bp: ask - 100,
        trade_close_bp: null,
        volume_cc: 0,
      });
    for (let k = 0; k < 5; k++) candle('HOME', 93 + k, 9300 + 10 * (g * 5 + k));
    for (let k = 0; k < 5; k++) candle('AWAY', 93 + k, 400); // trailing side: never an observation
    candle('HOME', 50, 7000); // half-time
    candle('HOME', 5, 5000); // 0-0
    if (g === 0) for (let k = 0; k < 5; k++) candle('HOME', 31 + k, 7700 + k);
  }
}

describe('price model', () => {
  it('60 observations at (soccer, lead 2, 10–15 min left) → the hand-computed median 9595, sampleSize 60', () => {
    const repos = fresh();
    seed(repos);
    const model = buildPriceModel(repos, '2026-09-26T08:00:00.000Z');
    expect(cell(model, 'soccer', 2, 10)).toEqual({
      sport: 'soccer',
      lead: 2,
      remainingFrom: 10,
      remainingTo: 15,
      askBp: 9595,
      sampleSize: 60,
      seeded: false,
    });
    expect(model.sports.soccer).toEqual({ games: 12, observations: 65, modelledCells: 1 });
    expect(model.sports.hockey).toEqual({ games: 0, observations: 0, modelledCells: 0 });
  });

  it('a 5-observation cell reports the seed value with sampleSize 5 and seeded = true', () => {
    const repos = fresh();
    seed(repos);
    const model = buildPriceModel(repos, '2026-09-26T08:00:00.000Z');
    expect(cell(model, 'soccer', 1, 55)).toMatchObject({
      askBp: seedAskBp('soccer', 1, 55),
      sampleSize: 5,
      seeded: true,
    });
  });

  it('empty DB → the full seed table (the §9 anchors included)', () => {
    const repos = fresh();
    const model = buildPriceModel(repos, '2026-09-26T08:00:00.000Z');
    expect(model).toEqual(seedModel('2026-09-26T08:00:00.000Z'));
    expect(model.cells).toHaveLength((19 + 13) * 3);
    expect(model.cells.every((c) => c.seeded && c.sampleSize === 0)).toBe(true);
    expect(cell(model, 'soccer', 2, 10)?.askBp).toBe(9600);
    expect(cell(model, 'soccer', 1, 10)?.askBp).toBe(8500);
    expect(cell(model, 'hockey', 2, 5)?.askBp).toBe(9700);
    for (const c of model.cells) {
      expect(Number.isSafeInteger(c.askBp)).toBe(true);
      expect(c.askBp).toBeGreaterThanOrEqual(5000);
      expect(c.askBp).toBeLessThanOrEqual(9900);
    }
  });

  it('reads hist_games, not game_snapshots: deleting every snapshot changes nothing', () => {
    const repos = fresh();
    seed(repos);
    // Snapshots that contradict the timelines (0-0 all game long).
    for (let i = 0; i < 30; i++)
      repos.gameSnapshots.insert({
        game_id: 'KXEPLGAME-TEST00',
        observed_at: new Date(Date.parse('2026-09-01T14:00:00Z') + i * 3 * MIN).toISOString(),
        feed: 'kalshi-live',
        home_score: 0,
        away_score: 0,
        phase: 'live',
      });
    const withSnapshots = buildPriceModel(repos, 'x');
    db?.sqlite.exec('DELETE FROM game_snapshots');
    expect(repos.gameSnapshots.count()).toBe(0);
    const without = buildPriceModel(repos, 'x');
    expect(without).toEqual(withSnapshots);
    expect(cell(without, 'soccer', 2, 10)?.sampleSize).toBe(60);
  });

  it('clock model, median and lookup', () => {
    expect([0, 10, 45, 46, 47, 61, 62, 72, 107, 114, 115].map((e) => matchMinute('soccer', e))).toEqual([
      0,
      10,
      45,
      45,
      null,
      null,
      45,
      55,
      90,
      90,
      null,
    ]);
    expect([0, 18, 35, 36, 53, 54, 137, 161, 162].map((e) => matchMinute('hockey', e))).toEqual([
      0,
      10,
      19,
      null,
      null,
      20,
      56,
      null,
      null,
    ]);
    expect(matchMinute('soccer', -1)).toBeNull();
    expect(medianBp([3, 1, 2])).toBe(2);
    expect(medianBp([9590, 9600])).toBe(9595);
    expect(medianBp([9591, 9600])).toBe(9596);
    const model = seedModel('x');
    expect(priceModelLookup(model, 'soccer', 5, 12)).toMatchObject({ lead: 3, remainingFrom: 10 });
    expect(priceModelLookup(model, 'hockey', 2, 60)).toMatchObject({ remainingFrom: 60, remainingTo: 65 });
  });
});
