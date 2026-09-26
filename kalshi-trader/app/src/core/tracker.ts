import { EventEmitter } from 'node:events';
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { ArmedStrategy } from './strategyStore.js';
import { games as gamesTable, type Game, type GameSnapshot, type Team } from '../db/schema.js';
import {
  derivedSoccerMinute,
  IN_PROGRESS,
  type FeedObservation,
  type GameClock,
  type GameState,
  type MinuteSource,
  type Phase,
  type Sport,
  type TeamRef,
  type TrackedGame,
} from '../feeds/gameState.js';

/**
 * GameTracker (SPEC.md §3 Polling plan, §4, T07): turns feed observations into the one `GameState` per
 * game that the rest of the app sees.
 *
 * - Every observation is written to `game_snapshots` (one row per observation, with `minute_source`).
 * - Kick-off and second-half start are recorded on first sight (`games.kickoff_observed_at`,
 *   `second_half_observed_at`); a derived soccer minute is recomputed from them.
 * - Feed merge: the score is the value the fresh feeds agree on; a disagreement lasting more than 20 s
 *   sets `games.blocked = 1` (logged at `warn`) until the feeds agree again. For hockey the NHL feed is
 *   the authoritative clock; a game is finished as soon as any fresh feed says so.
 * - `games` is updated, `stateUpdated` (with `blocked`) is emitted for every observation and
 *   `phaseChanged` for every phase change.
 * - On `finished`: goal events are derived from the snapshot score changes and written to `hist_games`
 *   (`source = 'live'`), and `timeline_archived = 1`.
 */

export const DISAGREEMENT_MS = 20_000;
/** A feed's last observation counts for the merge while it is at most this old. */
export const FRESH_MS = 60_000;
/** Games still `live` this long after their scheduled start are no longer polled (stuck state). */
export const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Polling starts this long before the scheduled start (SPEC.md §3: 60 s cadence in the hour before). */
export const PREGAME_MS = 60 * 60 * 1000;
/** A game that has not started this long after its scheduled start is no longer polled. */
export const LATE_START_MS = 6 * 60 * 60 * 1000;
/** Finished games stay on the dashboard this long. */
export const FINISHED_VISIBLE_MS = 3 * 60 * 60 * 1000;

export interface TrackedState extends GameState {
  blocked: boolean;
}

export interface PhaseChange {
  gameId: string;
  leagueId: string;
  from: Phase;
  to: Phase;
  at: Date;
}

export interface GoalEvent {
  side: 'home' | 'away';
  period: number;
  minute: number;
  second: number;
}

/** A game as the dashboard shows it (SSE `games` event, `GET /api/games`). */
export interface GameView {
  id: string;
  leagueId: string;
  sport: Sport;
  competition: string | null;
  homeTeam: string;
  awayTeam: string;
  homeAbbr: string | null;
  awayAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  phase: Phase;
  clock: GameClock;
  blocked: boolean;
  scheduledAt: string;
  observedAt: string | null;
  source: string | null;
  /** Strategies armed on the game with their configured / effective mode (filled by the app, T08). */
  strategies: ArmedStrategy[];
}

export interface TrackerOptions {
  repos: () => Repositories;
  log: Logger;
  now?: () => number;
  /** Runs `fn` in one database transaction; defaults to running it directly. */
  transaction?: (fn: () => void) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isNaN(v) ? null : v;
};

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function teamRef(team: Team | undefined): TeamRef | null {
  if (!team) return null;
  const aliases = parseJson<unknown[]>(team.aliases, []).filter((a): a is string => typeof a === 'string');
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    aliases: [...new Set([...(team.abbreviation ? [team.abbreviation] : []), ...aliases])].map((a) =>
      a.toUpperCase(),
    ),
  };
}

/** NHL / European football season label of a start time: `2026-27` from July on, else `2025-26`. */
export function seasonOf(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

interface SnapshotClock {
  period?: number;
  secondsLeftInPeriod?: number;
}

/**
 * Goal events from a game's snapshot score changes (in observation order). A score rise adds one
 * event per goal at that snapshot's clock; a fall (a goal taken back) removes the side's last event.
 */
export function goalEventsFromSnapshots(snapshots: readonly GameSnapshot[], sport: Sport): GoalEvent[] {
  const events: GoalEvent[] = [];
  let home = 0;
  let away = 0;
  for (const s of snapshots) {
    if (s.home_score === null || s.away_score === null) continue;
    const clock = parseJson<{ clock?: SnapshotClock }>(s.raw, {}).clock ?? {};
    const at = (): Omit<GoalEvent, 'side'> => {
      if (sport === 'hockey') {
        const period = clock.period ?? 1;
        if (period >= 4) return { period, minute: 60, second: 0 };
        const left = clock.secondsLeftInPeriod;
        if (left === undefined) return { period, minute: s.clock_minute ?? 0, second: 0 };
        const elapsed = (period - 1) * 1200 + (1200 - left);
        return { period, minute: Math.floor(elapsed / 60), second: elapsed % 60 };
      }
      const minute = s.clock_minute ?? 0;
      return { period: clock.period ?? (minute > 45 ? 2 : 1), minute, second: 0 };
    };
    for (const [side, now, before] of [
      ['home', s.home_score, home],
      ['away', s.away_score, away],
    ] as const) {
      for (let i = before; i < now; i++) events.push({ side, ...at() });
      for (let i = now; i < before; i++) {
        const last = events.map((e) => e.side).lastIndexOf(side);
        if (last !== -1) events.splice(last, 1);
      }
    }
    home = s.home_score;
    away = s.away_score;
  }
  return events;
}

export class GameTracker extends EventEmitter<{
  stateUpdated: [TrackedState];
  phaseChanged: [PhaseChange];
  /** A game was started over (replay reset); listeners drop what they remember about it. */
  gameReset: [string];
}> {
  private readonly latest = new Map<string, Map<string, GameState>>();
  private readonly merged = new Map<string, TrackedState>();
  private readonly disagreeSince = new Map<string, number>();
  private readonly lastAgreed = new Map<string, { home: number; away: number }>();
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly options: TrackerOptions) {
    super();
    this.setMaxListeners(0);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log.child({ component: 'tracker' });
  }

  private get repos(): Repositories {
    return this.options.repos();
  }

  private tx(fn: () => void): void {
    (this.options.transaction ?? ((f) => f()))(fn);
  }

  /** Forgets everything held in memory for a game (replay reset). */
  forget(gameId: string): void {
    this.latest.delete(gameId);
    this.merged.delete(gameId);
    this.disagreeSince.delete(gameId);
    this.lastAgreed.delete(gameId);
    this.emit('gameReset', gameId);
  }

  private toTracked(row: Game, sports: Map<string, Sport>, teams: Map<string, Team>): TrackedGame {
    return {
      id: row.id,
      leagueId: row.league_id ?? '',
      sport: sports.get(row.league_id ?? '') ?? 'soccer',
      milestoneId: row.milestone_id,
      scheduledAt: ms(row.scheduled_at) ?? 0,
      phase: row.phase as Phase,
      home: teamRef(row.home_team_id ? teams.get(row.home_team_id) : undefined),
      away: teamRef(row.away_team_id ? teams.get(row.away_team_id) : undefined),
      feedGameIds: parseJson<Record<string, unknown>>(row.feed_game_ids, {}),
      kickoffObservedAt: ms(row.kickoff_observed_at),
      secondHalfObservedAt: ms(row.second_half_observed_at),
    };
  }

  private lookups(): { sports: Map<string, Sport>; enabled: Set<string>; teams: Map<string, Team> } {
    const leagues = this.repos.leagues.list();
    return {
      sports: new Map(leagues.map((l) => [l.id, l.sport as Sport])),
      enabled: new Set(leagues.filter((l) => l.enabled === 1).map((l) => l.id)),
      teams: new Map(this.repos.teams.list().map((t) => [t.id, t])),
    };
  }

  /** One game as the adapters see it. */
  trackedGame(gameId: string): TrackedGame | undefined {
    const row = this.repos.games.get({ id: gameId });
    if (!row) return undefined;
    const { sports, teams } = this.lookups();
    return this.toTracked(row, sports, teams);
  }

  /**
   * The games to poll now: in progress (started less than 12 h ago), or scheduled from 60 min before
   * to 6 h after their start, in enabled leagues. Replayed games are never polled.
   */
  pollTargets(now = this.now()): TrackedGame[] {
    const rows = this.repos.games.list(
      or(
        and(
          inArray(gamesTable.phase, [...IN_PROGRESS]),
          gte(gamesTable.scheduled_at, iso(now - LIVE_WINDOW_MS)),
        ),
        and(
          eq(gamesTable.phase, 'scheduled'),
          gte(gamesTable.scheduled_at, iso(now - LATE_START_MS)),
          lte(gamesTable.scheduled_at, iso(now + PREGAME_MS)),
        ),
      ),
    );
    const { sports, enabled, teams } = this.lookups();
    return rows
      .filter((r) => r.league_id !== null && enabled.has(r.league_id))
      .map((r) => this.toTracked(r, sports, teams))
      .filter((g) => g.feedGameIds['replay'] !== true);
  }

  /** The dashboard's live game cards: games in progress, about to start, or finished in the last 3 h. */
  displayGames(now = this.now()): GameView[] {
    const rows = this.repos.games.list(
      or(
        and(
          inArray(gamesTable.phase, [...IN_PROGRESS]),
          gte(gamesTable.scheduled_at, iso(now - LIVE_WINDOW_MS)),
        ),
        and(
          eq(gamesTable.phase, 'scheduled'),
          gte(gamesTable.scheduled_at, iso(now - LATE_START_MS)),
          lte(gamesTable.scheduled_at, iso(now + PREGAME_MS)),
        ),
        and(eq(gamesTable.phase, 'finished'), gte(gamesTable.finished_at, iso(now - FINISHED_VISIBLE_MS))),
      ),
    );
    const { sports, teams } = this.lookups();
    const order = (p: string) => (IN_PROGRESS.has(p as Phase) ? 0 : p === 'scheduled' ? 1 : 2);
    return rows
      .sort((a, b) => order(a.phase) - order(b.phase) || a.scheduled_at.localeCompare(b.scheduled_at))
      .map((row) => {
        const home = row.home_team_id ? teams.get(row.home_team_id) : undefined;
        const away = row.away_team_id ? teams.get(row.away_team_id) : undefined;
        const m = this.merged.get(row.id);
        const clock: GameClock = m?.clock ?? {
          regulationOver: row.phase === 'finished',
          ...(row.clock_minute !== null ? { minute: row.clock_minute } : {}),
          ...(row.minute_source ? { minuteSource: row.minute_source as MinuteSource } : {}),
        };
        return {
          id: row.id,
          leagueId: row.league_id ?? '',
          sport: sports.get(row.league_id ?? '') ?? 'soccer',
          competition: row.competition,
          homeTeam: home?.name ?? 'Home',
          awayTeam: away?.name ?? 'Away',
          homeAbbr: home?.abbreviation ?? null,
          awayAbbr: away?.abbreviation ?? null,
          homeScore: row.home_score,
          awayScore: row.away_score,
          phase: row.phase as Phase,
          clock,
          blocked: row.blocked === 1,
          scheduledAt: row.scheduled_at,
          observedAt: m ? m.observedAt.toISOString() : null,
          source: m?.source ?? null,
          strategies: [],
        };
      });
  }

  /** The last merged state of a game (in memory since start-up). */
  state(gameId: string): TrackedState | undefined {
    return this.merged.get(gameId);
  }

  /** Applies one feed's observations of one tick; returns the merged states. */
  ingest(feedId: string, observations: readonly FeedObservation[]): TrackedState[] {
    const out: TrackedState[] = [];
    for (const obs of observations) {
      const result = this.ingestOne(feedId, obs);
      if (result) out.push(result);
    }
    return out;
  }

  private ingestOne(feedId: string, obs: FeedObservation): TrackedState | undefined {
    const repos = this.repos;
    const row = repos.games.get({ id: obs.state.gameId });
    if (!row || row.timeline_archived === 1) return undefined;
    const sport = (repos.leagues.get({ id: row.league_id ?? '' })?.sport ?? 'soccer') as Sport;
    const at = obs.state.observedAt.getTime();
    const state: GameState = { ...obs.state, clock: { ...obs.state.clock }, source: feedId };

    // Kick-off: the first transition to live. Second half: the first live after halftime (or a
    // feed-reported second half).
    const patch: Partial<Game> = {};
    const kickoff = ms(row.kickoff_observed_at) ?? (state.phase === 'live' ? at : null);
    if (kickoff !== null && row.kickoff_observed_at === null) patch.kickoff_observed_at = iso(kickoff);
    let secondHalf = ms(row.second_half_observed_at);
    if (
      sport === 'soccer' &&
      secondHalf === null &&
      state.phase === 'live' &&
      (row.phase === 'halftime' || state.clock.period === 2)
    ) {
      secondHalf = at;
      patch.second_half_observed_at = iso(at);
    }
    if (sport === 'soccer' && state.clock.minuteSource === 'derived' && state.phase === 'live') {
      const minute = derivedSoccerMinute(kickoff, state.clock.period === 1 ? null : secondHalf, at);
      if (minute !== undefined) state.clock.minute = minute;
      if (state.clock.period === undefined) state.clock.period = secondHalf !== null ? 2 : 1;
    }

    const feeds = this.latest.get(row.id) ?? new Map<string, GameState>();
    feeds.set(feedId, state);
    this.latest.set(row.id, feeds);
    const merged = this.merge(row, sport, feeds, at);

    const updated: Partial<Game> = {
      ...patch,
      phase: merged.phase,
      home_score: merged.homeScore,
      away_score: merged.awayScore,
      clock_minute: merged.clock.minute ?? null,
      minute_source: merged.clock.minuteSource ?? null,
      blocked: merged.blocked ? 1 : 0,
      updated_at: iso(this.now()),
    };
    if (obs.feedGameId) {
      const ids = parseJson<Record<string, unknown>>(row.feed_game_ids, {});
      if (ids[obs.feedGameId.key] !== obs.feedGameId.value) {
        updated.feed_game_ids = JSON.stringify({ ...ids, [obs.feedGameId.key]: obs.feedGameId.value });
      }
    }
    if (merged.phase === 'finished') {
      updated.final_home = merged.homeScore;
      updated.final_away = merged.awayScore;
      if (row.finished_at === null) updated.finished_at = iso(at);
    }

    this.tx(() => {
      repos.gameSnapshots.insert({
        game_id: row.id,
        observed_at: iso(at),
        feed_updated_at: state.feedUpdatedAt ? state.feedUpdatedAt.toISOString() : null,
        feed: feedId,
        home_score: state.homeScore,
        away_score: state.awayScore,
        phase: state.phase,
        clock_minute: state.clock.minute ?? null,
        minute_source: state.clock.minuteSource ?? null,
        raw: JSON.stringify({ clock: state.clock, payload: obs.raw ?? null }),
      });
      repos.games.update({ id: row.id }, updated);
    });

    this.merged.set(row.id, merged);
    this.emit('stateUpdated', merged);
    if (row.phase !== merged.phase) {
      this.log.info(
        { gameId: row.id, leagueId: row.league_id, from: row.phase, to: merged.phase },
        `Game ${row.id}: ${row.phase} → ${merged.phase}`,
      );
      this.emit('phaseChanged', {
        gameId: row.id,
        leagueId: row.league_id ?? '',
        from: row.phase as Phase,
        to: merged.phase,
        at: new Date(at),
      });
    }
    if (merged.phase === 'finished') this.archive(row.id);
    return merged;
  }

  private merge(row: Game, sport: Sport, feeds: Map<string, GameState>, at: number): TrackedState {
    const fresh = [...feeds.values()].filter((s) => at - s.observedAt.getTime() <= FRESH_MS);
    const primary = fresh.find((s) => s.source === 'kalshi-live') ?? fresh[0];
    if (!primary) throw new Error('merge without an observation');
    const clockSource =
      sport === 'hockey' ? (fresh.find((s) => s.source === 'nhl-official') ?? primary) : primary;
    const finished = fresh.find((s) => s.phase === 'finished');
    const base = finished ?? clockSource;

    const wasBlocked = row.blocked === 1;
    let blocked = wasBlocked;
    let score = { home: primary.homeScore, away: primary.awayScore };
    if (fresh.length >= 2) {
      const agree = fresh.every(
        (s) => s.homeScore === primary.homeScore && s.awayScore === primary.awayScore,
      );
      if (agree) {
        this.disagreeSince.delete(row.id);
        this.lastAgreed.set(row.id, score);
        blocked = false;
      } else {
        const since = this.disagreeSince.get(row.id) ?? at;
        this.disagreeSince.set(row.id, since);
        score = this.lastAgreed.get(row.id) ?? score;
        if (at - since > DISAGREEMENT_MS) blocked = true;
      }
    } else if (!wasBlocked) {
      this.lastAgreed.set(row.id, score);
    }
    if (blocked && !wasBlocked) {
      this.log.warn(
        {
          gameId: row.id,
          seconds: Math.round((at - (this.disagreeSince.get(row.id) ?? at)) / 1000),
          scores: Object.fromEntries(fresh.map((s) => [s.source, `${s.homeScore}-${s.awayScore}`])),
        },
        `Feeds disagree on the score of ${row.id} for more than 20 s; entries blocked`,
      );
    } else if (!blocked && wasBlocked) {
      this.log.info(
        { gameId: row.id, score: `${score.home}-${score.away}` },
        `Feeds agree again on ${row.id}; unblocked`,
      );
    }

    return {
      ...base,
      homeScore: score.home,
      awayScore: score.away,
      phase: finished ? 'finished' : base.phase,
      clock: { ...base.clock },
      source: fresh.map((s) => s.source).join('+'),
      observedAt: new Date(at),
      blocked,
    };
  }

  /** Writes the goal timeline of a finished game to `hist_games` (`source='live'`); idempotent. */
  archive(gameId: string): boolean {
    const repos = this.repos;
    const row = repos.games.get({ id: gameId });
    if (!row || row.timeline_archived === 1) return false;
    const sport = (repos.leagues.get({ id: row.league_id ?? '' })?.sport ?? 'soccer') as Sport;
    const snapshots = repos.gameSnapshots.listByGame(gameId);
    const primary = snapshots.some((s) => s.feed === 'kalshi-live')
      ? snapshots.filter((s) => s.feed === 'kalshi-live')
      : snapshots;
    const goals = goalEventsFromSnapshots(primary, sport);
    const last = [...primary].reverse().find((s) => s.home_score !== null && s.away_score !== null);
    const finalHome = row.final_home ?? last?.home_score ?? goals.filter((g) => g.side === 'home').length;
    const finalAway = row.final_away ?? last?.away_score ?? goals.filter((g) => g.side === 'away').length;
    const home = row.home_team_id ? repos.teams.get({ id: row.home_team_id }) : undefined;
    const away = row.away_team_id ? repos.teams.get({ id: row.away_team_id }) : undefined;
    const hist = {
      league_id: row.league_id,
      season: seasonOf(ms(row.scheduled_at) ?? this.now()),
      competition: row.competition,
      played_at: row.scheduled_at,
      home: home?.name ?? 'Home',
      away: away?.name ?? 'Away',
      final_home: finalHome,
      final_away: finalAway,
      goal_events: JSON.stringify(goals),
      source: 'live',
      kalshi_event_ticker: row.id,
    };
    const id = `live:${row.id}`;
    this.tx(() => {
      if (repos.histGames.get({ id })) repos.histGames.update({ id }, hist);
      else repos.histGames.insert({ id, ...hist });
      repos.games.update({ id: row.id }, { timeline_archived: 1, updated_at: iso(this.now()) });
    });
    this.log.info(
      { gameId: row.id, goals: goals.length, final: `${finalHome}-${finalAway}` },
      `Goal timeline of ${row.id} archived`,
    );
    return true;
  }
}
