/**
 * The season-sized generator behind `npm run seed:season` (T14): one season of finished games with the rows the
 * live path leaves behind — teams, two markets per game, 30 `game_snapshots` per game with raw payloads the size
 * the tracker writes, the archived timelines in `hist_games` — plus 400 trades in both modes (`seed:demo`'s
 * generator). Used for the DB size check (< 200 MB after a checkpoint), the maintenance check (pruning only
 * touches archived games) and the migration down/up check. Deterministic for a given seed; every generated id
 * starts with `season-` (trades: `demo-`), so `clearSeason` removes exactly what it inserted.
 *
 * Default shape: 2 000 games (NHL 800, the five soccer leagues 240 each) spread over the 240 days before `now`;
 * games older than 90 days are archived except every 20th (so pruning has both kinds to tell apart).
 */
import type Database from 'better-sqlite3';
import { clearDemo, seedDemo } from './seed-demo-lib.js';

export interface SeasonOptions {
  games?: number;
  snapshotsPerGame?: number;
  trades?: number;
  /** Clock the season ends at (epoch ms). */
  now?: number;
  seed?: number;
}

export interface SeasonResult {
  games: number;
  archivedGames: number;
  markets: number;
  snapshots: number;
  histGames: number;
  trades: number;
}

const DAY_MS = 86_400_000;
const LEAGUES = [
  { id: 'nhl', sport: 'hockey', share: 0.4, prefix: 'KXNHLGAME' },
  { id: 'epl', sport: 'soccer', share: 0.12, prefix: 'KXEPLGAME' },
  { id: 'laliga', sport: 'soccer', share: 0.12, prefix: 'KXLALIGAGAME' },
  { id: 'bundesliga', sport: 'soccer', share: 0.12, prefix: 'KXBUNDESLIGAGAME' },
  { id: 'seriea', sport: 'soccer', share: 0.12, prefix: 'KXSERIEAGAME' },
  { id: 'ligue1', sport: 'soccer', share: 0.12, prefix: 'KXLIGUE1GAME' },
] as const;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Removes every row the generator inserted (and the demo trades). */
export function clearSeason(db: Database.Database): void {
  db.transaction(() => {
    db.prepare("DELETE FROM game_snapshots WHERE game_id LIKE 'season-%'").run();
    db.prepare("DELETE FROM markets WHERE game_id LIKE 'season-%'").run();
    db.prepare("DELETE FROM hist_games WHERE id LIKE 'season-%'").run();
    db.prepare("DELETE FROM games WHERE id LIKE 'season-%'").run();
    db.prepare("DELETE FROM teams WHERE id LIKE 'season-%'").run();
  })();
  clearDemo(db);
}

export function seedSeason(db: Database.Database, opts: SeasonOptions = {}): SeasonResult {
  const total = opts.games ?? 2000;
  const perGame = opts.snapshotsPerGame ?? 30;
  const now = opts.now ?? Date.now();
  const rnd = prng(opts.seed ?? 7);
  const iso = (ms: number) => new Date(ms).toISOString();
  const result: SeasonResult = {
    games: 0,
    archivedGames: 0,
    markets: 0,
    snapshots: 0,
    histGames: 0,
    trades: 0,
  };
  clearSeason(db);

  const insTeam = db.prepare(
    'INSERT INTO teams (id, league_id, name, abbreviation, aliases) VALUES (?, ?, ?, ?, ?)',
  );
  const insGame = db.prepare(
    `INSERT INTO games (id, league_id, competition, home_team_id, away_team_id, scheduled_at, milestone_id,
       feed_game_ids, phase, home_score, away_score, clock_minute, minute_source, kickoff_observed_at,
       second_half_observed_at, final_home, final_away, finished_at, timeline_archived, pregame_home_bp,
       pregame_away_bp, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insMarket = db.prepare(
    `INSERT INTO markets (ticker, game_id, outcome, status, result, settlement_value_bp, close_time, price_ranges,
       yes_bid_bp, yes_ask_bp, updated_at)
     VALUES (?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insSnapshot = db.prepare(
    `INSERT INTO game_snapshots (game_id, observed_at, feed_updated_at, feed, home_score, away_score, phase,
       clock_minute, minute_source, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insHist = db.prepare(
    `INSERT INTO hist_games (id, league_id, season, competition, played_at, home, away, final_home, final_away,
       goal_events, source, kalshi_event_ticker)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
  );
  const priceRanges = JSON.stringify([{ start: '0.0100', end: '0.9900', step: '0.0100' }]);

  db.transaction(() => {
    let n = 0;
    for (const [li, league] of LEAGUES.entries()) {
      const count = li === LEAGUES.length - 1 ? total - n : Math.round(total * league.share);
      const teams = league.sport === 'hockey' ? 32 : 20;
      for (let k = 0; k < teams; k++) {
        const abbr = `${league.id.slice(0, 2).toUpperCase()}${String.fromCharCode(65 + k)}`;
        insTeam.run(
          `season-${league.id}:${abbr}`,
          league.id,
          `Season ${league.id} team ${k + 1}`,
          abbr,
          `["${abbr}"]`,
        );
      }
      for (let g = 0; g < count; g++, n++) {
        const home = Math.floor(rnd() * teams);
        const away = (home + 1 + Math.floor(rnd() * (teams - 1))) % teams;
        const abbr = (k: number) => `${league.id.slice(0, 2).toUpperCase()}${String.fromCharCode(65 + k)}`;
        const scheduled =
          now - Math.floor(((n + 0.5) / total) * 240 * DAY_MS) - Math.floor(rnd() * 3_600_000);
        const id = `season-${league.prefix}-${String(n).padStart(5, '0')}`;
        const archived = now - scheduled > 90 * DAY_MS && n % 20 !== 0;
        const length = league.sport === 'hockey' ? 60 : 90;
        const goals: { minute: number; side: 'home' | 'away' }[] = [];
        const goalCount = Math.floor(rnd() * (league.sport === 'hockey' ? 8 : 5));
        for (let q = 0; q < goalCount; q++)
          goals.push({ minute: 1 + Math.floor(rnd() * (length - 1)), side: rnd() < 0.55 ? 'home' : 'away' });
        goals.sort((a, b) => a.minute - b.minute);
        const finalHome = goals.filter((x) => x.side === 'home').length;
        const finalAway = goals.length - finalHome;
        const finished = scheduled + (league.sport === 'hockey' ? 150 : 115) * 60_000;
        const pregameHome = 3000 + Math.floor(rnd() * 40) * 100;
        insGame.run(
          id,
          league.id,
          league.sport === 'hockey' ? 'regular' : null,
          `season-${league.id}:${abbr(home)}`,
          `season-${league.id}:${abbr(away)}`,
          iso(scheduled),
          `ms-${id}`,
          JSON.stringify(league.sport === 'hockey' ? { 'nhl-official': 2026020000 + n } : {}),
          finalHome,
          finalAway,
          length,
          'feed',
          iso(scheduled + 5 * 60_000),
          league.sport === 'soccer' ? iso(scheduled + 65 * 60_000) : null,
          finalHome,
          finalAway,
          iso(finished),
          archived ? 1 : 0,
          pregameHome,
          10_000 - pregameHome - 200,
          iso(finished),
        );
        result.games += 1;
        if (archived) result.archivedGames += 1;
        const winner = finalHome > finalAway ? 'home' : finalHome < finalAway ? 'away' : null;
        for (const [outcome, team] of [
          ['home', abbr(home)],
          ['away', abbr(away)],
        ] as const) {
          const value = winner === null ? 5000 : winner === outcome ? 10_000 : 0;
          insMarket.run(
            `${id}-${team}`,
            id,
            outcome,
            value === 10_000 ? 'yes' : 'no',
            value,
            iso(finished + 3_600_000),
            priceRanges,
            value === 10_000 ? 9900 : 100,
            value === 10_000 ? 9901 : 101,
            iso(finished + 3_600_000),
          );
          result.markets += 1;
        }
        // Snapshots every few minutes of game time, the raw payload as the tracker stores it.
        for (let s = 0; s < perGame; s++) {
          const minute = Math.floor((s * length) / perGame);
          const observed =
            scheduled + 5 * 60_000 + Math.floor((s * (finished - scheduled - 5 * 60_000)) / perGame);
          const h = goals.filter((x) => x.side === 'home' && x.minute <= minute).length;
          const a = goals.filter((x) => x.side === 'away' && x.minute <= minute).length;
          const phase = s === perGame - 1 ? 'finished' : 'live';
          const period =
            league.sport === 'hockey' ? Math.min(3, Math.floor(minute / 20) + 1) : minute < 45 ? 1 : 2;
          const clock =
            league.sport === 'hockey'
              ? {
                  minute,
                  minuteSource: 'feed',
                  period,
                  secondsLeftInPeriod: 1200 - (minute % 20) * 60,
                  regulationOver: false,
                }
              : { minute, minuteSource: 'derived', period, regulationOver: false };
          const payload = {
            milestone_id: `ms-${id}`,
            type: league.sport === 'hockey' ? 'hockey_game' : 'soccer_tournament_multi_leg',
            details: {
              home_points: h,
              away_points: a,
              status: phase === 'finished' ? 'closed' : 'live',
              period_number: period,
              time_remaining_in_period: league.sport === 'hockey' ? `${19 - (minute % 20)}:00` : undefined,
              last_play: { description: `Play ${s + 1}`, team: rnd() < 0.5 ? abbr(home) : abbr(away) },
              competitors: [
                {
                  id: `season-${league.id}:${abbr(home)}`,
                  name: `Season ${league.id} team ${home + 1}`,
                  side: 'home',
                },
                {
                  id: `season-${league.id}:${abbr(away)}`,
                  name: `Season ${league.id} team ${away + 1}`,
                  side: 'away',
                },
              ],
            },
          };
          insSnapshot.run(
            id,
            iso(observed),
            iso(observed - 1500),
            s % 2 === 0 || league.sport === 'soccer' ? 'kalshi-live' : 'nhl-official',
            h,
            a,
            phase,
            minute,
            clock.minuteSource,
            JSON.stringify({ clock, payload }),
          );
          result.snapshots += 1;
        }
        if (archived) {
          insHist.run(
            id,
            league.id,
            `${new Date(scheduled).getUTCFullYear()}`,
            league.sport === 'hockey' ? 'regular' : null,
            iso(scheduled),
            abbr(home),
            abbr(away),
            finalHome,
            finalAway,
            JSON.stringify(goals),
            id.slice('season-'.length),
          );
          result.histGames += 1;
        }
      }
    }
  })();

  result.trades = seedDemo(db, { trades: opts.trades ?? 400, now, seed: opts.seed ?? 7 }).trades;
  return result;
}
