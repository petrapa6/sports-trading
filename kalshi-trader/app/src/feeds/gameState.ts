/**
 * Live game state shared by every score feed (SPEC.md §3 "Live game state — ScoreFeed interface", T07).
 *
 * Adapters turn their payloads into `GameState`; the `GameTracker` (core/tracker.ts) merges the feeds of
 * one game, writes `game_snapshots`, updates `games` and emits `stateUpdated` / `phaseChanged`.
 */

export type Sport = 'soccer' | 'hockey';
export type Phase = 'scheduled' | 'live' | 'halftime' | 'intermission' | 'finished' | 'postponed';
export type MinuteSource = 'feed' | 'derived';

export const PHASES: readonly Phase[] = [
  'scheduled',
  'live',
  'halftime',
  'intermission',
  'finished',
  'postponed',
];

/** Phases during which the game is in progress (the scheduler polls every 5 s). */
export const IN_PROGRESS: ReadonlySet<Phase> = new Set(['live', 'halftime', 'intermission']);

export interface GameClock {
  /** Soccer match minute (stoppage counts as 45 / 90); hockey elapsed minute 0–60. */
  minute?: number;
  minuteSource?: MinuteSource;
  /** Hockey period (4+ = overtime); soccer half (1 / 2). */
  period?: number;
  secondsLeftInPeriod?: number;
  regulationOver: boolean;
}

export interface GameState {
  /** Internal id = Kalshi event ticker. */
  gameId: string;
  leagueId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  phase: Phase;
  clock: GameClock;
  /** Adapter id. */
  source: string;
  /** When this app received it. */
  observedAt: Date;
  /** Timestamp reported by the feed, if any. */
  feedUpdatedAt?: Date;
}

export const FEED_IDS = ['kalshi-live', 'nhl-official'] as const;
export type FeedId = (typeof FEED_IDS)[number];
export const isFeedId = (v: string): v is FeedId => (FEED_IDS as readonly string[]).includes(v);

export const FEED_NAMES: Record<FeedId, string> = {
  'kalshi-live': 'Kalshi live data',
  'nhl-official': 'NHL official API',
};

export interface TeamRef {
  id: string;
  name: string;
  abbreviation: string | null;
  /** Upper-case tricodes and feed names (`teams.aliases` plus the abbreviation). */
  aliases: string[];
}

/** A game the tracker follows, as the adapters need it (from the `games` row and its teams). */
export interface TrackedGame {
  id: string;
  leagueId: string;
  sport: Sport;
  milestoneId: string | null;
  /** Epoch ms. */
  scheduledAt: number;
  phase: Phase;
  home: TeamRef | null;
  away: TeamRef | null;
  /** `games.feed_game_ids` (milestone id, milestone `source_ids`, ids learned from other feeds). */
  feedGameIds: Record<string, unknown>;
  kickoffObservedAt: number | null;
  secondHalfObservedAt: number | null;
}

/** One feed observation of one game: the parsed state and the payload it came from. */
export interface FeedObservation {
  state: GameState;
  raw: unknown;
  /** The game's id in that feed (e.g. the NHL game id), remembered in `games.feed_game_ids`. */
  feedGameId?: { key: string; value: string | number };
}

export interface ScoreFeed {
  readonly id: FeedId;
  readonly sports: readonly Sport[];
  /** One poll for every tracked game this feed covers (the scheduler calls it once per tick). */
  poll(games: readonly TrackedGame[]): Promise<FeedObservation[]>;
  /** SPEC.md §3 interface: live states of a league's tracked games. */
  listLive(leagueId: string): Promise<GameState[]>;
  /** SPEC.md §3 interface: the state of one tracked game. */
  get(gameId: string): Promise<GameState>;
  /** Settings → Feeds → "Test feed": a one-line result (throws on failure). */
  test(games: readonly TrackedGame[]): Promise<string>;
}

const MINUTE_MS = 60_000;

/**
 * Soccer minute derived from wall-clock time (SPEC.md §3 fallback): whole minutes since the observed
 * kick-off (capped at 45), or 45 + whole minutes since the observed second-half start (capped at 90).
 * `undefined` when neither has been observed.
 */
export function derivedSoccerMinute(
  kickoffAt: number | null,
  secondHalfAt: number | null,
  now: number,
): number | undefined {
  if (secondHalfAt !== null)
    return Math.min(90, 45 + Math.max(0, Math.floor((now - secondHalfAt) / MINUTE_MS)));
  if (kickoffAt !== null) return Math.min(45, Math.max(0, Math.floor((now - kickoffAt) / MINUTE_MS)));
  return undefined;
}

/** `"12:34"` → 754 seconds; `undefined` for anything else. */
export function parseClock(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = /^\s*(\d{1,2}):(\d{2})(?:\.\d+)?\s*$/.exec(text);
  if (!m) return undefined;
  const sec = Number.parseInt(m[2] ?? '', 10);
  if (sec >= 60) return undefined;
  return Number.parseInt(m[1] ?? '', 10) * 60 + sec;
}

export const HOCKEY_PERIOD_SECONDS = 20 * 60;

/**
 * Hockey elapsed minute (0–60) from the period and the seconds left in it; overtime counts as 60.
 * Period 2 with 12:34 left → 20 + 7 = 27.
 */
export function hockeyMinute(period: number, secondsLeft: number | undefined): number {
  if (period >= 4) return 60;
  const left = secondsLeft ?? HOCKEY_PERIOD_SECONDS;
  const elapsed = (period - 1) * HOCKEY_PERIOD_SECONDS + (HOCKEY_PERIOD_SECONDS - left);
  return Math.max(0, Math.min(60, Math.floor(elapsed / 60)));
}

/** Warns once per key (e.g. once per game id for an unknown live text). */
export class OnceSet {
  private readonly seen = new Set<string>();
  first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
