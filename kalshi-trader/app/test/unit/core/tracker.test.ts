import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyReplayLine, parseReplayFile } from '../../../src/core/replay.js';
import {
  GameTracker,
  goalEventsFromSnapshots,
  seasonOf,
  type PhaseChange,
  type TrackedState,
} from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { OnceSet, type GameState } from '../../../src/feeds/gameState.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { logLines, seedGame } from '../../helpers/feeds.js';

const SAMPLE = resolve(import.meta.dirname, '../../fixtures/replay/nhl-sample.jsonl');

let db: TempDb;
let repos: Repositories;
let logs: ReturnType<typeof captureLogger>;
let clock: number;
let tracker: GameTracker;
let updates: TrackedState[];
let phases: PhaseChange[];

beforeEach(() => {
  db = tempDb();
  repos = createRepositories(db.db.orm);
  logs = captureLogger('debug');
  clock = Date.parse('2026-10-15T02:00:00Z');
  tracker = new GameTracker({
    repos: () => repos,
    log: logs.log,
    now: () => clock,
    transaction: (fn) => db.db.sqlite.transaction(fn)(),
  });
  updates = [];
  phases = [];
  tracker.on('stateUpdated', (s) => updates.push(s));
  tracker.on('phaseChanged', (p) => phases.push(p));
});
afterEach(() => db.cleanup());

describe('tracker replay of test/fixtures/replay/nhl-sample.jsonl', () => {
  it('produces the expected snapshot sequence, one game_snapshots row per line, and the archived timeline', () => {
    const lines = parseReplayFile(readFileSync(SAMPLE, 'utf8'));
    const ctx = { repos, tracker, log: logs.log, unknownText: new OnceSet() };
    lines.forEach((line, i) => {
      clock = Date.parse(line.at);
      applyReplayLine(ctx, line, { observedAt: clock, reset: i === 0 });
    });

    expect(
      updates.map((u) => ({
        observedAt: u.observedAt.toISOString(),
        phase: u.phase,
        score: `${u.homeScore}-${u.awayScore}`,
        clock: u.clock,
        blocked: u.blocked,
        source: u.source,
      })),
    ).toMatchSnapshot();

    const distinct = updates.map((u) => u.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    expect(distinct).toEqual(['scheduled', 'live', 'intermission', 'live', 'finished']);
    expect(phases.map((p) => `${p.from}→${p.to}`)).toEqual([
      'scheduled→live',
      'live→intermission',
      'intermission→live',
      'live→finished',
    ]);

    const id = 'KXNHLGAME-26OCT14SEAVGK';
    const snapshots = repos.gameSnapshots.listByGame(id);
    expect(snapshots).toHaveLength(lines.length);
    expect(snapshots.every((s) => s.feed === 'kalshi-live' && s.minute_source !== undefined)).toBe(true);

    const game = repos.games.get({ id });
    expect(game).toMatchObject({
      phase: 'finished',
      final_home: 2,
      final_away: 1,
      timeline_archived: 1,
      kickoff_observed_at: '2026-10-15T02:01:30.000Z',
      finished_at: '2026-10-15T02:15:00.000Z',
    });
    const hist = repos.histGames.get({ id: `live:${id}` });
    expect(hist).toMatchObject({
      source: 'live',
      league_id: 'nhl',
      season: '2026-27',
      home: 'Vegas Golden Knights',
      away: 'Seattle Kraken',
      final_home: 2,
      final_away: 1,
      kalshi_event_ticker: id,
    });
    expect(JSON.parse(hist?.goal_events ?? '[]')).toEqual([
      { side: 'home', period: 1, minute: 11, second: 45 },
      { side: 'away', period: 2, minute: 27, second: 26 },
      { side: 'home', period: 3, minute: 55, second: 0 },
    ]);
    // Archived games ignore further observations.
    const extra = lines.at(-1);
    if (extra) applyReplayLine(ctx, extra, { observedAt: clock + 5000 });
    expect(repos.gameSnapshots.listByGame(id)).toHaveLength(lines.length);
  });
});

const NHL_ID = 'KXNHLGAME-26OCT10UTAVGK';
const state = (feed: string, home: number, away: number, at: number): GameState => ({
  gameId: NHL_ID,
  leagueId: 'nhl',
  homeTeam: 'Team VGK',
  awayTeam: 'Team UTA',
  homeScore: home,
  awayScore: away,
  phase: 'live',
  clock: { period: 3, secondsLeftInPeriod: 600, minute: 50, minuteSource: 'feed', regulationOver: false },
  source: feed,
  observedAt: new Date(at),
});

describe('feed disagreement', () => {
  beforeEach(() => {
    seedGame(repos, {
      id: NHL_ID,
      leagueId: 'nhl',
      scheduledAt: '2026-10-15T01:00:00.000Z',
      home: 'VGK',
      away: 'UTA',
      phase: 'live',
    });
  });

  it('2-1 vs 1-1 for 25 s → blocked=1 and a warn; agreement → blocked=0; stateUpdated carries blocked', () => {
    const t0 = clock;
    for (const dt of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      tracker.ingest('kalshi-live', [{ state: state('kalshi-live', 2, 1, t0 + dt), raw: {} }]);
      tracker.ingest('nhl-official', [{ state: state('nhl-official', 1, 1, t0 + dt), raw: {} }]);
      expect(repos.games.get({ id: NHL_ID })?.blocked).toBe(dt > 20_000 ? 1 : 0);
    }
    const warns = logLines(logs.text()).filter((l) => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      gameId: NHL_ID,
      scores: { 'kalshi-live': '2-1', 'nhl-official': '1-1' },
    });
    expect(updates.at(-1)?.blocked).toBe(true);
    expect(updates.slice(0, 2).every((u) => u.blocked === false)).toBe(true);

    tracker.ingest('kalshi-live', [{ state: state('kalshi-live', 2, 1, t0 + 30_000), raw: {} }]);
    expect(repos.games.get({ id: NHL_ID })?.blocked).toBe(1); // still disagreeing with the last NHL value
    tracker.ingest('nhl-official', [{ state: state('nhl-official', 2, 1, t0 + 30_000), raw: {} }]);
    expect(repos.games.get({ id: NHL_ID })).toMatchObject({ blocked: 0, home_score: 2, away_score: 1 });
    expect(updates.at(-1)).toMatchObject({ blocked: false, homeScore: 2, awayScore: 1 });
    expect(logLines(logs.text()).some((l) => l.level === 30 && /agree again/.test(l.msg))).toBe(true);
  });

  it('a short disagreement (≤ 20 s) never blocks; the agreed score is kept meanwhile', () => {
    const t0 = clock;
    tracker.ingest('kalshi-live', [{ state: state('kalshi-live', 1, 1, t0), raw: {} }]);
    tracker.ingest('nhl-official', [{ state: state('nhl-official', 1, 1, t0), raw: {} }]);
    tracker.ingest('kalshi-live', [{ state: state('kalshi-live', 2, 1, t0 + 5_000), raw: {} }]);
    expect(updates.at(-1)).toMatchObject({ homeScore: 1, awayScore: 1, blocked: false });
    tracker.ingest('nhl-official', [{ state: state('nhl-official', 2, 1, t0 + 15_000), raw: {} }]);
    expect(updates.at(-1)).toMatchObject({ homeScore: 2, awayScore: 1, blocked: false });
    expect(repos.games.get({ id: NHL_ID })?.blocked).toBe(0);
  });
});

describe('soccer kick-off / second half and derived minute', () => {
  it('records kick-off and second-half start on first sight and derives the minute from them', () => {
    const id = 'KXEPLGAME-26OCT17ARSCHE';
    seedGame(repos, {
      id,
      leagueId: 'epl',
      scheduledAt: '2026-10-17T14:00:00.000Z',
      home: 'ARS',
      away: 'CHE',
    });
    const soccer = (phase: GameState['phase'], at: number, clk: GameState['clock']): GameState => ({
      ...state('kalshi-live', 0, 0, at),
      gameId: id,
      leagueId: 'epl',
      phase,
      clock: clk,
    });
    const k = Date.parse('2026-10-17T14:01:00Z');
    tracker.ingest('kalshi-live', [
      { state: soccer('live', k, { minuteSource: 'derived', regulationOver: false }), raw: {} },
    ]);
    tracker.ingest('kalshi-live', [
      {
        state: soccer('live', k + 30 * 60_000 + 10_000, {
          minuteSource: 'derived',
          period: 1,
          regulationOver: false,
        }),
        raw: {},
      },
    ]);
    expect(updates.at(-1)?.clock.minute).toBe(30);
    tracker.ingest('kalshi-live', [
      {
        state: soccer('halftime', k + 47 * 60_000, {
          minute: 45,
          minuteSource: 'feed',
          regulationOver: false,
        }),
        raw: {},
      },
    ]);
    const s = k + 62 * 60_000;
    tracker.ingest('kalshi-live', [
      { state: soccer('live', s, { minuteSource: 'derived', regulationOver: false }), raw: {} },
    ]);
    tracker.ingest('kalshi-live', [
      { state: soccer('live', s + 20 * 60_000, { minuteSource: 'derived', regulationOver: false }), raw: {} },
    ]);
    expect(updates.at(-1)?.clock).toMatchObject({ minute: 65, minuteSource: 'derived', period: 2 });
    const row = repos.games.get({ id });
    expect(row).toMatchObject({
      kickoff_observed_at: new Date(k).toISOString(),
      second_half_observed_at: new Date(s).toISOString(),
      clock_minute: 65,
      minute_source: 'derived',
    });
    expect(repos.gameSnapshots.listByGame(id).map((r) => r.minute_source)).toEqual([
      'derived',
      'derived',
      'feed',
      'derived',
      'derived',
    ]);
  });
});

describe('helpers', () => {
  it('goal events: rises add goals at the snapshot clock, a fall removes the side’s last goal', () => {
    const snap = (h: number, a: number, minute: number, period: number) => ({
      id: 0,
      game_id: 'g',
      observed_at: '',
      feed_updated_at: null,
      feed: 'kalshi-live',
      home_score: h,
      away_score: a,
      phase: 'live',
      clock_minute: minute,
      minute_source: 'feed',
      raw: JSON.stringify({ clock: { period } }),
    });
    expect(
      goalEventsFromSnapshots(
        [snap(0, 0, 1, 1), snap(1, 0, 23, 1), snap(1, 1, 67, 2), snap(1, 0, 68, 2), snap(2, 0, 90, 2)],
        'soccer',
      ),
    ).toEqual([
      { side: 'home', period: 1, minute: 23, second: 0 },
      { side: 'home', period: 2, minute: 90, second: 0 },
    ]);
    expect(seasonOf(Date.parse('2027-02-07T15:00:00Z'))).toBe('2026-27');
    expect(seasonOf(Date.parse('2026-10-15T02:00:00Z'))).toBe('2026-27');
  });
});
