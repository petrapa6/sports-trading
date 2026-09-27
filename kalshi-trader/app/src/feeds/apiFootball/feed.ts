import type { Logger } from 'pino';
import { z } from 'zod';
import type { SettingsRepository } from '../../db/settings.js';
import {
  FeedQuotaExhausted,
  IN_PROGRESS,
  type FeedObservation,
  type GameClock,
  type GameState,
  type Phase,
  type ScoreFeed,
  type TeamRef,
  type TrackedGame,
} from '../gameState.js';
import type { NetworkGate } from '../network.js';

/**
 * `api-football` adapter (SPEC.md §3): `GET /fixtures?live=all` of API-Football v3 → `GameState`,
 * with `fixture.status.elapsed` as the soccer minute (`minuteSource: 'feed'`) and the status codes mapped
 * to phases. Off by default (Settings → Feeds) and unavailable until a key is stored.
 *
 * - The key is stored encrypted (`settings.api_football_key_enc`, `encryptSetting`), decrypted for each
 *   request and sent only in the `x-apisports-key` header; it is never logged (only the path is).
 * - Every request passes the network gate first, then the daily quota guard (`ApiFootballQuota`).
 * - Fixtures are matched to tracked games through a known fixture id (`feed_game_ids.apiFootball`), or the
 *   league (`leagues.feed_ids.apiFootball`), the kick-off time and the team names.
 * - A tracked game in progress that dropped out of `live=all` (it just finished) and whose fixture id is
 *   known is read with one extra `GET /fixtures?ids=…` per tick.
 */

export const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
export const DEFAULT_DAILY_LIMIT = 100;
const TIMEOUT_MS = 10_000;
/** A fixture and a tracked game with matching team names match when their kick-offs are this close. */
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
/** One team name matching is enough when the kick-offs are this close (same league). */
const TIGHT_WINDOW_MS = 15 * 60 * 1000;
/** `GET /fixtures?ids=` takes at most 20 ids. */
const MAX_IDS = 20;

const TeamSchema = z.object({ id: z.number().int().nullish(), name: z.string().nullish() }).passthrough();

export const FixtureSchema = z
  .object({
    fixture: z
      .object({
        id: z.number().int(),
        date: z.string().nullish(),
        status: z
          .object({
            short: z.string(),
            elapsed: z.number().int().nullish(),
            extra: z.number().int().nullish(),
          })
          .passthrough(),
      })
      .passthrough(),
    league: z
      .object({ id: z.number().int().nullish(), season: z.number().int().nullish() })
      .passthrough()
      .nullish(),
    teams: z.object({ home: TeamSchema, away: TeamSchema }).passthrough(),
    goals: z
      .object({ home: z.number().int().nullish(), away: z.number().int().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type Fixture = z.output<typeof FixtureSchema>;

export const GoalEventSchema = z
  .object({
    time: z.object({ elapsed: z.number().int().nullish(), extra: z.number().int().nullish() }).passthrough(),
    team: z.object({ id: z.number().int().nullish() }).passthrough().nullish(),
    type: z.string().nullish(),
    detail: z.string().nullish(),
  })
  .passthrough();
export type FixtureEvent = z.output<typeof GoalEventSchema>;

export const StatusSchema = z
  .object({
    subscription: z
      .object({ plan: z.string().nullish(), active: z.boolean().nullish() })
      .passthrough()
      .nullish(),
    requests: z
      .object({ current: z.number().int().nullish(), limit_day: z.number().int().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type ApiFootballStatus = z.output<typeof StatusSchema>;

/** The envelope of every answer; `errors` is `[]` or an object such as `{"requests": "…"}`. */
const EnvelopeSchema = z
  .object({
    errors: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish(),
    response: z.unknown(),
  })
  .passthrough();

export class ApiFootballError extends Error {
  override name = 'ApiFootballError';
}

/** API-Football status code → phase. Unknown codes count as scheduled (never tradeable). */
export function apiFootballPhase(short: string): Phase {
  switch (short.toUpperCase()) {
    case '1H':
    case '2H':
    case 'ET':
    case 'P':
    case 'LIVE':
      return 'live';
    case 'HT':
    case 'BT':
    case 'INT':
      return 'halftime';
    case 'FT':
    case 'AET':
    case 'PEN':
    case 'AWD':
    case 'WO':
      return 'finished';
    case 'PST':
    case 'CANC':
    case 'ABD':
    case 'SUSP':
      return 'postponed';
    default:
      return 'scheduled';
  }
}

/**
 * The match clock of a fixture: `elapsed` is the minute, stoppage counts as 45 / 90 (`1H` capped at 45,
 * `2H` at 90); extra time and penalties are past regulation.
 */
export function apiFootballClock(short: string, elapsed: number | null | undefined): GameClock {
  const code = short.toUpperCase();
  const clock: GameClock = { regulationOver: false };
  const at = (minute: number, period: number) => {
    clock.minute = minute;
    clock.minuteSource = 'feed';
    clock.period = period;
  };
  switch (code) {
    case '1H':
      if (typeof elapsed === 'number') at(Math.max(0, Math.min(45, elapsed)), 1);
      else clock.period = 1;
      break;
    case 'HT':
      at(45, 1);
      break;
    case '2H':
      if (typeof elapsed === 'number') at(Math.max(45, Math.min(90, elapsed)), 2);
      else clock.period = 2;
      break;
    case 'LIVE':
    case 'INT':
      if (typeof elapsed === 'number') at(Math.min(90, elapsed), elapsed <= 45 ? 1 : 2);
      break;
    case 'ET':
    case 'BT':
    case 'P':
      at(90, 2);
      clock.regulationOver = true;
      break;
    default:
      if (apiFootballPhase(code) === 'finished') {
        at(90, 2);
        clock.regulationOver = true;
      }
  }
  return clock;
}

/** Converts one fixture into a `GameState` for a tracked game. */
export function fixtureToState(f: Fixture, game: TrackedGame, now: number): GameState {
  const short = f.fixture.status.short;
  return {
    gameId: game.id,
    leagueId: game.leagueId,
    homeTeam: game.home?.name ?? f.teams.home.name ?? 'Home',
    awayTeam: game.away?.name ?? f.teams.away.name ?? 'Away',
    homeScore: f.goals?.home ?? 0,
    awayScore: f.goals?.away ?? 0,
    phase: apiFootballPhase(short),
    clock: apiFootballClock(short, f.fixture.status.elapsed),
    source: 'api-football',
    observedAt: new Date(now),
  };
}

const NOISE = new Set([
  'fc',
  'cf',
  'afc',
  'sc',
  'ac',
  'as',
  'ss',
  'ssc',
  'cd',
  'ud',
  'rc',
  'rcd',
  'sd',
  'club',
  'de',
  'calcio',
  'football',
  'sv',
  'vfb',
  'vfl',
  'tsg',
  'bv',
  'bsc',
  'fsv',
  'og',
  'osc',
  'the',
]);

/** A team name reduced for comparison: no accents, case, punctuation, club prefixes or suffixes. */
export function normaliseTeamName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && !/^\d+$/.test(w) && !NOISE.has(w))
    .join(' ');
}

/** Whether a feed team name names the tracked team (name or alias, equal or contained). */
export function teamMatches(team: TeamRef | null, feedName: string | null | undefined): boolean {
  if (!team || !feedName) return false;
  const feed = normaliseTeamName(feedName);
  if (feed === '') return false;
  return [team.name, ...team.aliases].some((candidate) => {
    const c = normaliseTeamName(candidate);
    if (c === '') return false;
    if (c === feed) return true;
    const [short, long] = c.length <= feed.length ? [c, feed] : [feed, c];
    return short.length >= 4 && ` ${long} `.includes(` ${short} `);
  });
}

/** The API-Football fixture id of a tracked game, if known (`feed_game_ids.apiFootball`). */
export function knownFixtureId(game: TrackedGame): number | undefined {
  const v = game.feedGameIds['apiFootball'];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/**
 * Finds the tracked game a fixture belongs to: a known fixture id; else the same league (when the league's
 * API-Football id is known), both team names and a kick-off within 12 h, or one team name and a kick-off
 * within 15 min.
 */
export function matchFixture(
  f: Fixture,
  games: readonly TrackedGame[],
  leagueFeedId: (leagueId: string) => number | null,
): TrackedGame | undefined {
  const byId = games.find((g) => knownFixtureId(g) === f.fixture.id);
  if (byId) return byId;
  const start = f.fixture.date ? Date.parse(f.fixture.date) : Number.NaN;
  const candidates = games.filter((g) => {
    if (knownFixtureId(g) !== undefined) return false;
    const league = leagueFeedId(g.leagueId);
    const fixtureLeague = f.league?.id ?? null;
    return league === null || fixtureLeague === null || league === fixtureLeague;
  });
  const within = (g: TrackedGame, ms: number) => Number.isNaN(start) || Math.abs(start - g.scheduledAt) <= ms;
  const home = (g: TrackedGame) => teamMatches(g.home, f.teams.home.name);
  const away = (g: TrackedGame) => teamMatches(g.away, f.teams.away.name);
  return (
    candidates.find((g) => home(g) && away(g) && within(g, MATCH_WINDOW_MS)) ??
    candidates.find((g) => (home(g) || away(g)) && !Number.isNaN(start) && within(g, TIGHT_WINDOW_MS))
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar date (`YYYY-MM-DD`) of an instant: the quota resets at local midnight. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface QuotaUsage {
  day: string;
  used: number;
  limit: number;
}

/** Today's request count (0 once the stored count belongs to an earlier day) and the limit. */
export function quotaUsage(settings: Pick<SettingsRepository, 'get'>, now: number): QuotaUsage {
  const day = localDay(now);
  const stored = settings.get('api_football_quota');
  return {
    day,
    used: stored?.day === day ? stored.used : 0,
    limit: settings.get('api_football_daily_limit'),
  };
}

/**
 * The daily request guard: a counter in `settings.api_football_quota` for the local calendar day,
 * limit `settings.api_football_daily_limit` (default 100). At the limit no request is made: `take()` throws
 * `FeedQuotaExhausted` and logs one `warn` per day. The counter starts over at local midnight.
 */
export class ApiFootballQuota {
  private warnedDay: string | null = null;

  constructor(
    private readonly settings: () => Pick<SettingsRepository, 'get' | 'set'>,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  usage(): QuotaUsage {
    return quotaUsage(this.settings(), this.now());
  }

  /** Counts one request, or throws `FeedQuotaExhausted` without counting when the day's limit is reached. */
  take(): void {
    const u = this.usage();
    if (u.used >= u.limit) {
      if (this.warnedDay !== u.day) {
        this.warnedDay = u.day;
        this.log.warn(
          { feed: 'api-football', used: u.used, limit: u.limit, day: u.day },
          `API-Football daily quota used up (${u.used}/${u.limit}); no more requests until local midnight`,
        );
      }
      throw new FeedQuotaExhausted(
        `daily quota used up (${u.used}/${u.limit} requests on ${u.day}); it resets at local midnight`,
      );
    }
    this.settings().set('api_football_quota', { day: u.day, used: u.used + 1 });
  }
}

export interface ApiFootballClientOptions {
  gate: NetworkGate;
  log: Logger;
  /** The decrypted key, or `null` when none is stored (read on every request). */
  key: () => string | null;
  quota: ApiFootballQuota;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number>;

/** The API-Football v3 client: network gate, then quota, then one request. */
export class ApiFootballClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;

  constructor(private readonly options: ApiFootballClientOptions) {
    this.baseUrl = (options.baseUrl ?? API_FOOTBALL_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.log = options.log.child({ component: 'api-football' });
  }

  /** Whether a key is stored. */
  configured(): boolean {
    try {
      return this.options.key() !== null;
    } catch {
      return false;
    }
  }

  async get<T extends z.ZodType>(
    path: string,
    query: Query,
    schema: T,
    signal?: AbortSignal,
  ): Promise<z.output<T>> {
    this.options.gate.assertNetworkAllowed();
    let key: string | null;
    try {
      key = this.options.key();
    } catch {
      throw new ApiFootballError('the stored API-Football key cannot be decrypted; enter it again');
    }
    if (key === null) throw new ApiFootballError('no API-Football key is stored');
    this.options.quota.take();
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { accept: 'application/json', 'x-apisports-key': key },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      this.log.debug({ path }, 'API-Football request failed (network)');
      throw new ApiFootballError(
        `API-Football could not be reached: GET ${path}${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }
    this.log.debug({ path, status: res.status }, 'API-Football request');
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new ApiFootballError(`API-Football answered ${res.status} for GET ${path}`);
    }
    const body = EnvelopeSchema.parse(await res.json());
    const errors = body.errors;
    const entries = Array.isArray(errors)
      ? errors.map((e, i) => [String(i), e] as const)
      : Object.entries(errors ?? {});
    if (entries.length > 0) {
      const text = entries.map(([k, v]) => `${k}: ${String(v)}`).join('; ');
      if (entries.some(([k]) => k === 'requests' || k === 'rateLimit'))
        throw new FeedQuotaExhausted(`API-Football refused the request (${text})`);
      throw new ApiFootballError(`API-Football refused GET ${path}: ${text}`);
    }
    return schema.parse(body.response) as z.output<T>;
  }

  fixtures(query: Query, signal?: AbortSignal): Promise<Fixture[]> {
    return this.get('/fixtures', query, z.array(FixtureSchema), signal);
  }

  goalEvents(fixtureId: number, signal?: AbortSignal): Promise<FixtureEvent[]> {
    return this.get(
      '/fixtures/events',
      { fixture: fixtureId, type: 'Goal' },
      z.array(GoalEventSchema),
      signal,
    );
  }

  /** `GET /status`: plan and the provider's own request count. */
  status(signal?: AbortSignal): Promise<ApiFootballStatus> {
    return this.get('/status', {}, StatusSchema, signal);
  }
}

export interface ApiFootballFeedOptions {
  client: ApiFootballClient;
  games: () => readonly TrackedGame[];
  /** `leagues.feed_ids.apiFootball` of a league, `null` when unknown. */
  leagueFeedId: (leagueId: string) => number | null;
  now?: () => number;
}

export class ApiFootballFeed implements ScoreFeed {
  readonly id = 'api-football' as const;
  readonly sports = ['soccer'] as const;
  private readonly now: () => number;

  constructor(private readonly options: ApiFootballFeedOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  isAvailable(): boolean {
    return this.options.client.configured();
  }

  private leagueFeedId = (leagueId: string): number | null => {
    try {
      return this.options.leagueFeedId(leagueId);
    } catch {
      return null;
    }
  };

  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    const soccer = games.filter((g) => g.sport === 'soccer');
    if (soccer.length === 0) return [];
    const out: FeedObservation[] = [];
    const seen = new Set<string>();
    const add = (f: Fixture, game: TrackedGame) => {
      seen.add(game.id);
      out.push({
        state: fixtureToState(f, game, this.now()),
        raw: f,
        feedGameId: { key: 'apiFootball', value: f.fixture.id },
      });
    };
    for (const f of await this.options.client.fixtures({ live: 'all' })) {
      const game = matchFixture(
        f,
        soccer.filter((g) => !seen.has(g.id)),
        this.leagueFeedId,
      );
      if (game) add(f, game);
    }
    // Games in progress that left `live=all` (finished, postponed) but whose fixture id is known.
    const missing = soccer
      .filter((g) => !seen.has(g.id) && IN_PROGRESS.has(g.phase) && knownFixtureId(g) !== undefined)
      .slice(0, MAX_IDS);
    if (missing.length > 0) {
      const ids = missing.map((g) => knownFixtureId(g) as number);
      for (const f of await this.options.client.fixtures({ ids: ids.join('-') })) {
        const game = missing.find((g) => knownFixtureId(g) === f.fixture.id);
        if (game && !seen.has(game.id)) add(f, game);
      }
    }
    return out;
  }

  async listLive(leagueId: string): Promise<GameState[]> {
    const obs = await this.poll(this.options.games().filter((g) => g.leagueId === leagueId));
    return obs.map((o) => o.state);
  }

  async get(gameId: string): Promise<GameState> {
    const game = this.options.games().find((g) => g.id === gameId);
    if (!game) throw new Error(`game ${gameId} is not tracked`);
    const id = knownFixtureId(game);
    if (id !== undefined) {
      const [f] = await this.options.client.fixtures({ id });
      if (f) return fixtureToState(f, game, this.now());
    }
    const [obs] = await this.poll([game]);
    if (!obs) throw new Error(`API-Football has no live fixture matching ${gameId}`);
    return obs.state;
  }

  async test(games: readonly TrackedGame[]): Promise<string> {
    const live = await this.options.client.fixtures({ live: 'all' });
    const matched = live.filter((f) => matchFixture(f, games, this.leagueFeedId)).length;
    return `${live.length} live fixture(s)${games.length > 0 ? `, ${matched} matched to tracked games` : ''}`;
  }
}
