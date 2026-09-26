import type { Logger } from 'pino';
import { z } from 'zod';
import {
  hockeyMinute,
  parseClock,
  type FeedObservation,
  type GameClock,
  type GameState,
  type Phase,
  type ScoreFeed,
  type TrackedGame,
} from '../gameState.js';
import type { NetworkGate } from '../network.js';

/**
 * `nhl-official` adapter (SPEC.md §3, T07): `GET /v1/score/now` of the NHL Web API (no key), plus
 * `GET /v1/gamecenter/{id}/landing` for a tracked game whose NHL id is known but that is missing from
 * `score/now`. Games are matched through the tricodes (`teams.abbreviation` / `teams.aliases`) and the
 * start time, or through an NHL id found in the milestone `source_ids`. Every request passes the
 * network gate; only the path is logged.
 */

export const NHL_BASE_URL = 'https://api-web.nhle.com/v1';
const TIMEOUT_MS = 10_000;
/** A tracked game and an NHL game match when their start times are this close (plus the tricodes). */
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

const TeamSchema = z
  .object({
    id: z.number().int().nullish(),
    abbrev: z.string(),
    score: z.number().int().nullish(),
  })
  .passthrough();

export const NhlGameSchema = z
  .object({
    id: z.number().int(),
    gameState: z.string(),
    startTimeUTC: z.string().nullish(),
    period: z.number().int().nullish(),
    periodDescriptor: z.object({ number: z.number().int().nullish() }).passthrough().nullish(),
    clock: z
      .object({
        timeRemaining: z.string().nullish(),
        secondsRemaining: z.number().int().nullish(),
        inIntermission: z.boolean().nullish(),
        running: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
    homeTeam: TeamSchema,
    awayTeam: TeamSchema,
  })
  .passthrough();
export type NhlGame = z.output<typeof NhlGameSchema>;

export const NhlScoreNowSchema = z
  .object({ currentDate: z.string().nullish(), games: z.array(NhlGameSchema).nullish() })
  .passthrough();

export class NhlApiError extends Error {
  override name = 'NhlApiError';
}

/** NHL `gameState` → phase: `FUT`/`PRE` scheduled, `LIVE`/`CRIT` live, `FINAL`/`OFF` finished. */
export function nhlPhase(gameState: string, inIntermission: boolean): Phase {
  switch (gameState.toUpperCase()) {
    case 'LIVE':
    case 'CRIT':
      return inIntermission ? 'intermission' : 'live';
    case 'FINAL':
    case 'OFF':
      return 'finished';
    case 'PPD':
    case 'SUSP':
    case 'CNCL':
      return 'postponed';
    default:
      return 'scheduled';
  }
}

/** Converts one NHL game (score/now or landing) into a `GameState` for a tracked game. */
export function nhlGameToState(g: NhlGame, game: TrackedGame, now: number): GameState {
  const period = g.periodDescriptor?.number ?? g.period ?? undefined;
  const left = g.clock?.secondsRemaining ?? parseClock(g.clock?.timeRemaining);
  const phase = nhlPhase(g.gameState, g.clock?.inIntermission === true);
  const clock: GameClock = { regulationOver: false };
  if (phase === 'finished') {
    clock.regulationOver = true;
    clock.minute = 60;
    clock.minuteSource = 'feed';
    if (period !== undefined) clock.period = period;
  } else if ((phase === 'live' || phase === 'intermission') && period !== undefined && period >= 1) {
    clock.period = period;
    if (left !== undefined) clock.secondsLeftInPeriod = left;
    clock.minute = phase === 'intermission' ? hockeyMinute(period, 0) : hockeyMinute(period, left);
    clock.minuteSource = 'feed';
    if (period >= 4 || (period === 3 && left === 0)) clock.regulationOver = true;
  }
  return {
    gameId: game.id,
    leagueId: game.leagueId,
    homeTeam: game.home?.name ?? g.homeTeam.abbrev,
    awayTeam: game.away?.name ?? g.awayTeam.abbrev,
    homeScore: g.homeTeam.score ?? 0,
    awayScore: g.awayTeam.score ?? 0,
    phase,
    clock,
    source: 'nhl-official',
    observedAt: new Date(now),
  };
}

const codes = (t: TrackedGame['home']): Set<string> =>
  new Set(
    [t?.abbreviation, ...(t?.aliases ?? [])]
      .filter((s): s is string => typeof s === 'string' && s !== '')
      .map((s) => s.toUpperCase()),
  );

/** The NHL id of a tracked game, if known (`feed_game_ids.nhl`). */
export function knownNhlId(game: TrackedGame): number | undefined {
  const v = game.feedGameIds['nhl'];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/** Finds the tracked game an NHL game belongs to (known id, a milestone source id, or tricodes + date). */
export function matchNhlGame(g: NhlGame, games: readonly TrackedGame[]): TrackedGame | undefined {
  const id = String(g.id);
  const byId = games.find(
    (t) => knownNhlId(t) === g.id || Object.values(t.feedGameIds).some((v) => String(v) === id),
  );
  if (byId) return byId;
  const start = g.startTimeUTC ? Date.parse(g.startTimeUTC) : Number.NaN;
  const home = g.homeTeam.abbrev.toUpperCase();
  const away = g.awayTeam.abbrev.toUpperCase();
  return games.find(
    (t) =>
      codes(t.home).has(home) &&
      codes(t.away).has(away) &&
      (Number.isNaN(start) || Math.abs(start - t.scheduledAt) <= MATCH_WINDOW_MS),
  );
}

export interface NhlFeedOptions {
  gate: NetworkGate;
  log: Logger;
  games: () => readonly TrackedGame[];
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class NhlFeed implements ScoreFeed {
  readonly id = 'nhl-official' as const;
  readonly sports = ['hockey'] as const;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly options: NhlFeedOptions) {
    this.baseUrl = (options.baseUrl ?? NHL_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log.child({ component: 'nhl' });
  }

  private async fetchJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
    this.options.gate.assertNetworkAllowed();
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      this.log.debug({ path }, 'NHL request failed (network)');
      throw new NhlApiError(
        `NHL API could not be reached: GET ${path}${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }
    this.log.debug({ path, status: res.status }, 'NHL request');
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new NhlApiError(`NHL API answered ${res.status} for GET ${path}`);
    }
    return schema.parse(await res.json()) as z.output<T>;
  }

  /** Today's games (`/score/now`). */
  async scoreNow(): Promise<NhlGame[]> {
    return (await this.fetchJson('/score/now', NhlScoreNowSchema)).games ?? [];
  }

  /** One game (`/gamecenter/{id}/landing`). */
  landing(nhlId: number): Promise<NhlGame> {
    return this.fetchJson(`/gamecenter/${nhlId}/landing`, NhlGameSchema);
  }

  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    const hockey = games.filter((g) => g.sport === 'hockey');
    if (hockey.length === 0) return [];
    const now = this.now();
    const out: FeedObservation[] = [];
    const seen = new Set<string>();
    for (const g of await this.scoreNow()) {
      const game = matchNhlGame(g, hockey);
      if (!game || seen.has(game.id)) continue;
      seen.add(game.id);
      out.push({
        state: nhlGameToState(g, game, now),
        raw: g,
        feedGameId: { key: 'nhl', value: g.id },
      });
    }
    // Tracked games missing from score/now (e.g. past midnight Eastern) but with a known NHL id.
    for (const game of hockey) {
      if (seen.has(game.id)) continue;
      const id = knownNhlId(game);
      if (id === undefined) continue;
      const g = await this.landing(id);
      out.push({ state: nhlGameToState(g, game, this.now()), raw: g, feedGameId: { key: 'nhl', value: id } });
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
    const id = knownNhlId(game);
    if (id !== undefined) return nhlGameToState(await this.landing(id), game, this.now());
    const [obs] = await this.poll([game]);
    if (!obs) throw new Error(`the NHL API has no game matching ${gameId}`);
    return obs.state;
  }

  async test(games: readonly TrackedGame[]): Promise<string> {
    const today = await this.scoreNow();
    const matched = today.filter((g) => matchNhlGame(g, games)).length;
    return `${today.length} NHL game(s) today${games.length > 0 ? `, ${matched} matched to tracked games` : ''}`;
  }
}
