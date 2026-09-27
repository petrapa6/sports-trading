import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameTracker, type BlockedChange, type TrackedState } from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import type { GameClock, GameState } from '../../../src/feeds/gameState.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { logLines, seedGame } from '../../helpers/feeds.js';

/** A soccer game tracked by `kalshi-live` and `api-football`. */

const ID = 'KXEPLGAME-26OCT17ARSCHE';
const T0 = Date.parse('2026-10-17T15:30:00Z');

let db: TempDb;
let repos: Repositories;
let logs: ReturnType<typeof captureLogger>;
let tracker: GameTracker;
let updates: TrackedState[];
let blocked: BlockedChange[];

beforeEach(() => {
  db = tempDb();
  repos = createRepositories(db.db.orm);
  logs = captureLogger('debug');
  tracker = new GameTracker({ repos: () => repos, log: logs.log, now: () => T0 });
  updates = [];
  blocked = [];
  tracker.on('stateUpdated', (s) => updates.push(s));
  tracker.on('blockedChanged', (c) => blocked.push(c));
  seedGame(repos, {
    id: ID,
    leagueId: 'epl',
    scheduledAt: '2026-10-17T14:00:00.000Z',
    home: 'ARS',
    away: 'CHE',
    phase: 'live',
  });
  repos.games.update(
    { id: ID },
    { kickoff_observed_at: '2026-10-17T14:01:00.000Z', second_half_observed_at: '2026-10-17T15:03:00.000Z' },
  );
});
afterEach(() => db.cleanup());

const state = (feed: string, home: number, away: number, at: number, clock: GameClock): GameState => ({
  gameId: ID,
  leagueId: 'epl',
  homeTeam: 'Team ARS',
  awayTeam: 'Team CHE',
  homeScore: home,
  awayScore: away,
  phase: 'live',
  clock,
  source: feed,
  observedAt: new Date(at),
});
const kalshi = (home: number, away: number, at: number, minute?: number) =>
  state('kalshi-live', home, away, at, {
    ...(minute !== undefined
      ? { minute, minuteSource: 'feed' as const }
      : { minuteSource: 'derived' as const }),
    period: 2,
    regulationOver: false,
  });
const af = (home: number, away: number, at: number, minute: number) =>
  state('api-football', home, away, at, { minute, minuteSource: 'feed', period: 2, regulationOver: false });

describe('tracker with kalshi-live and api-football', () => {
  it('the soccer minute comes from API-Football when present', () => {
    // Kalshi alone: its derived minute (27 min after the observed second-half start → 72).
    tracker.ingest('kalshi-live', [{ state: kalshi(2, 0, T0), raw: {} }]);
    expect(updates.at(-1)?.clock).toMatchObject({ minute: 72, minuteSource: 'derived' });

    // API-Football arrives: its feed minute wins, also on later Kalshi observations.
    tracker.ingest('api-football', [{ state: af(2, 0, T0 + 1_000, 78), raw: {} }]);
    expect(updates.at(-1)).toMatchObject({
      clock: { minute: 78, minuteSource: 'feed' },
      homeScore: 2,
      awayScore: 0,
      source: 'kalshi-live+api-football',
    });
    tracker.ingest('kalshi-live', [{ state: kalshi(2, 0, T0 + 5_000, 76), raw: {} }]);
    expect(updates.at(-1)?.clock).toMatchObject({ minute: 78, minuteSource: 'feed' });
    expect(repos.games.get({ id: ID })).toMatchObject({ clock_minute: 78, minute_source: 'feed' });

    // API-Football goes stale (> 60 s without an observation): Kalshi's minute again.
    tracker.ingest('kalshi-live', [{ state: kalshi(2, 0, T0 + 70_000, 79), raw: {} }]);
    expect(updates.at(-1)?.clock).toMatchObject({ minute: 79 });
    expect(updates.at(-1)?.source).toBe('kalshi-live');
  });

  it('disagreeing scores for more than 20 s → blocked, as with any two sources; agreement unblocks', () => {
    for (const dt of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      tracker.ingest('kalshi-live', [{ state: kalshi(2, 0, T0 + dt, 78), raw: {} }]);
      tracker.ingest('api-football', [{ state: af(2, 1, T0 + dt, 78), raw: {} }]);
      expect(repos.games.get({ id: ID })?.blocked).toBe(dt > 20_000 ? 1 : 0);
    }
    expect(updates.at(-1)).toMatchObject({ blocked: true, homeScore: 2, awayScore: 0 });
    const warns = logLines(logs.text()).filter((l) => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ gameId: ID, scores: { 'kalshi-live': '2-0', 'api-football': '2-1' } });
    expect(blocked).toEqual([
      {
        gameId: ID,
        leagueId: 'epl',
        blocked: true,
        scores: { 'kalshi-live': '2-0', 'api-football': '2-1' },
        at: new Date(T0 + 25_000),
      },
    ]);

    tracker.ingest('kalshi-live', [{ state: kalshi(2, 1, T0 + 30_000, 79), raw: {} }]);
    expect(repos.games.get({ id: ID })).toMatchObject({ blocked: 0, home_score: 2, away_score: 1 });
    expect(blocked.at(-1)).toMatchObject({ blocked: false });
  });

  it('carries the kick-off asks (games.pregame_*_bp) on the merged state', () => {
    repos.games.update({ id: ID }, { pregame_home_bp: 4100, pregame_away_bp: 3300 });
    tracker.ingest('api-football', [{ state: af(1, 0, T0, 60), raw: {} }]);
    expect(updates.at(-1)?.pregame).toEqual({ homeBp: 4100, awayBp: 3300 });
  });
});
