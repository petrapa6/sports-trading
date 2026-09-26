import type { Logger } from 'pino';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import type { GoalEvent } from '../core/tracker.js';
import type { NetworkGate } from '../feeds/network.js';
import { NHL_BASE_URL } from '../feeds/nhl/feed.js';
import type { JobContext } from './jobs.js';

/**
 * NHL goal timelines (SPEC.md §3 Historical, T11): `GET /v1/schedule/{date}` week by week over a
 * season, then `GET /v1/gamecenter/{gameId}/play-by-play` for every finished game → `hist_games`
 * (`source = 'nhl'`, id `nhl:<gameId>`).
 *
 * - Preseason games (`gameType` 1) are skipped unless requested; regular season (2) and playoffs (3)
 *   are imported; other types (all-star, …) never.
 * - Goal events come from the `goal` plays of every period except the shootout (`periodType` `SO`):
 *   `side` from `details.eventOwnerTeamId` (home team id → `home`), `period` from the period number,
 *   `minute`/`second` = elapsed game time from `timeInPeriod` (`(period − 1) × 20 + mm`; overtime goals
 *   therefore have minute ≥ 60). The final is the official one (`homeTeam.score`, incl. the shootout
 *   winner's extra goal), so a 3-2 shootout game has 2 + 2 goal events. A game whose goal events do not
 *   add up to the final (other than the one shootout goal) is skipped with a `warn`.
 * - `home` / `away` hold the NHL tricodes (`BUF`), which the candle collector matches against the Kalshi
 *   team codes to set `kalshi_event_ticker`.
 * - Resumable: games already in `hist_games` are not fetched again (`skipped N existing`). At most 4
 *   requests per second; every request passes the network gate and the job's pause / cancel checks.
 */

export const NHL_REQUESTS_PER_SECOND = 4;

const TeamSchema = z
  .object({
    id: z.number().int(),
    abbrev: z.string(),
    score: z.number().int().nullish(),
    commonName: z.object({ default: z.string() }).passthrough().nullish(),
    placeName: z.object({ default: z.string() }).passthrough().nullish(),
  })
  .passthrough();

const ScheduleGameSchema = z
  .object({
    id: z.number().int(),
    season: z.number().int(),
    gameType: z.number().int(),
    startTimeUTC: z.string(),
    gameState: z.string(),
    homeTeam: TeamSchema.pick({ id: true, abbrev: true }).passthrough(),
    awayTeam: TeamSchema.pick({ id: true, abbrev: true }).passthrough(),
  })
  .passthrough();

export const NhlScheduleSchema = z
  .object({
    nextStartDate: z.string().nullish(),
    preSeasonStartDate: z.string().nullish(),
    regularSeasonStartDate: z.string().nullish(),
    regularSeasonEndDate: z.string().nullish(),
    playoffEndDate: z.string().nullish(),
    gameWeek: z.array(z.object({ date: z.string(), games: z.array(ScheduleGameSchema) }).passthrough()),
  })
  .passthrough();
export type NhlSchedule = z.output<typeof NhlScheduleSchema>;
export type NhlScheduleGame = z.output<typeof ScheduleGameSchema>;

const PlaySchema = z
  .object({
    typeDescKey: z.string(),
    timeInPeriod: z.string().nullish(),
    periodDescriptor: z.object({ number: z.number().int(), periodType: z.string().nullish() }).passthrough(),
    details: z.object({ eventOwnerTeamId: z.number().int().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export const NhlPlayByPlaySchema = z
  .object({
    id: z.number().int(),
    season: z.number().int(),
    gameType: z.number().int(),
    startTimeUTC: z.string(),
    gameState: z.string(),
    homeTeam: TeamSchema,
    awayTeam: TeamSchema,
    gameOutcome: z.object({ lastPeriodType: z.string().nullish() }).passthrough().nullish(),
    plays: z.array(PlaySchema),
  })
  .passthrough();
export type NhlPlayByPlay = z.output<typeof NhlPlayByPlaySchema>;

export class NhlHistoryError extends Error {
  override name = 'NhlHistoryError';
}

/** `20252026` → `2025-26` (the label `hist_games.season` uses everywhere). */
export function seasonLabel(season: string | number): string {
  const s = String(season);
  if (!/^\d{8}$/.test(s)) throw new NhlHistoryError(`season must look like 20252026, got ${s}`);
  const start = Number.parseInt(s.slice(0, 4), 10);
  const end = Number.parseInt(s.slice(4), 10);
  if (end !== start + 1) throw new NhlHistoryError(`season ${s} must span two consecutive years`);
  return `${start}-${String(end % 100).padStart(2, '0')}`;
}

const FINISHED_STATES = new Set(['OFF', 'FINAL']);
const COMPETITION: Record<number, string> = {
  1: 'Pro Hockey Preseason',
  2: 'Pro Hockey',
  3: 'Pro Hockey Playoffs',
};

/** `"12:34"` → seconds, or `undefined`. */
function mmss(text: string | null | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text ?? '');
  if (!m) return undefined;
  return Number.parseInt(m[1] as string, 10) * 60 + Number.parseInt(m[2] as string, 10);
}

export interface NhlGameTimeline {
  goals: GoalEvent[];
  finalHome: number;
  finalAway: number;
  shootout: boolean;
}

/**
 * Goal events and the official final of one play-by-play. Throws `NhlHistoryError` when the goal
 * events do not add up to the final (other than the shootout winner's goal).
 */
export function timelineFromPlayByPlay(pbp: NhlPlayByPlay): NhlGameTimeline {
  const homeId = pbp.homeTeam.id;
  const awayId = pbp.awayTeam.id;
  const goals: GoalEvent[] = [];
  let shootout = pbp.gameOutcome?.lastPeriodType === 'SO';
  for (const play of pbp.plays) {
    if (play.periodDescriptor.periodType === 'SO') {
      shootout = true;
      continue;
    }
    if (play.typeDescKey !== 'goal') continue;
    const owner = play.details?.eventOwnerTeamId;
    if (owner !== homeId && owner !== awayId)
      throw new NhlHistoryError(`goal without a known team (eventOwnerTeamId ${String(owner)})`);
    const inPeriod = mmss(play.timeInPeriod);
    if (inPeriod === undefined)
      throw new NhlHistoryError(`goal without a usable timeInPeriod (${String(play.timeInPeriod)})`);
    const period = play.periodDescriptor.number;
    const elapsed = (period - 1) * 1200 + inPeriod;
    goals.push({
      side: owner === homeId ? 'home' : 'away',
      period,
      minute: Math.floor(elapsed / 60),
      second: elapsed % 60,
    });
  }
  const finalHome = pbp.homeTeam.score;
  const finalAway = pbp.awayTeam.score;
  if (finalHome === null || finalHome === undefined || finalAway === null || finalAway === undefined)
    throw new NhlHistoryError('the play-by-play has no final score');
  const home = goals.filter((g) => g.side === 'home').length;
  const away = goals.length - home;
  const dh = finalHome - home;
  const da = finalAway - away;
  const consistent = (dh === 0 && da === 0) || (shootout && dh + da === 1 && dh >= 0 && da >= 0);
  if (!consistent)
    throw new NhlHistoryError(
      `goal events (${home}-${away}) do not match the final (${finalHome}-${finalAway}${shootout ? ' SO' : ''})`,
    );
  return { goals, finalHome, finalAway, shootout };
}

/** Minimal NHL Web API client for the importer (network gate, 4 req/s, abortable). */
export class NhlHistoryClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly minIntervalMs: number;
  private nextAt = 0;
  requests = 0;

  constructor(
    private readonly options: {
      gate: NetworkGate;
      log: Pick<Logger, 'debug'>;
      baseUrl?: string;
      fetch?: typeof fetch;
      requestsPerSecond?: number;
    },
  ) {
    this.baseUrl = (options.baseUrl ?? NHL_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = Math.ceil(1000 / (options.requestsPerSecond ?? NHL_REQUESTS_PER_SECOND));
  }

  private async get<T extends z.ZodType>(
    path: string,
    schema: T,
    signal?: AbortSignal,
  ): Promise<z.output<T>> {
    this.options.gate.assertNetworkAllowed();
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
      // The switch may have been turned on while this request waited for its slot.
      this.options.gate.assertNetworkAllowed();
    }
    this.nextAt = Date.now() + this.minIntervalMs;
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      throw new NhlHistoryError(
        `NHL API could not be reached: GET ${path}${typeof code === 'string' ? ` (${code})` : ''}`,
        { cause: err },
      );
    }
    this.options.log.debug({ path, status: res.status }, 'NHL request');
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new NhlHistoryError(`NHL API answered ${res.status} for GET ${path}`);
    }
    return schema.parse(await res.json()) as z.output<T>;
  }

  schedule(date: string, signal?: AbortSignal): Promise<NhlSchedule> {
    return this.get(`/schedule/${date}`, NhlScheduleSchema, signal);
  }

  playByPlay(gameId: number, signal?: AbortSignal): Promise<NhlPlayByPlay> {
    return this.get(`/gamecenter/${gameId}/play-by-play`, NhlPlayByPlaySchema, signal);
  }
}

export interface NhlImportOptions {
  /** `20252026`. */
  season: string;
  includePreseason?: boolean;
  /** Stop after this many inserted games. */
  limit?: number;
}

export interface NhlImportResult {
  season: string;
  inserted: number;
  skippedExisting: number;
  skippedPreseason: number;
  skippedUnfinished: number;
  failed: number;
  requests: number;
}

export interface NhlImportDeps {
  client: NhlHistoryClient;
  repos: Repositories;
  log: Logger;
  /** Pause / cancel / progress; without it (scripts) requests run directly. */
  ctx?: Pick<JobContext, 'request' | 'progress' | 'checkpoint'>;
}

const DIRECT: Pick<JobContext, 'request' | 'progress' | 'checkpoint'> = {
  request: (fn) => fn(new AbortController().signal),
  progress: () => undefined,
  checkpoint: async () => undefined,
};

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Imports one NHL season into `hist_games`; see the module comment. */
export async function importNhlSeason(
  deps: NhlImportDeps,
  options: NhlImportOptions,
): Promise<NhlImportResult> {
  const { client, repos, log } = deps;
  const ctx = deps.ctx ?? DIRECT;
  const label = seasonLabel(options.season);
  const seasonNumber = Number.parseInt(options.season, 10);
  const startYear = Math.floor(seasonNumber / 10000);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const result: NhlImportResult = {
    season: label,
    inserted: 0,
    skippedExisting: 0,
    skippedPreseason: 0,
    skippedUnfinished: 0,
    failed: 0,
    requests: 0,
  };
  const requestsBefore = client.requests;

  // The first week: September 1st of the start year; `nextStartDate` walks the season week by week.
  let date: string | null = `${startYear}-09-01`;
  let endDate = `${startYear + 1}-06-30`;
  const seen = new Set<number>();
  const games: NhlScheduleGame[] = [];
  let weeks = 0;
  while (date !== null && date <= endDate && result.inserted < limit) {
    const week: NhlSchedule = await ctx.request((signal) => client.schedule(date as string, signal));
    weeks++;
    endDate = week.playoffEndDate ?? week.regularSeasonEndDate ?? endDate;
    const batch = week.gameWeek
      .flatMap((d) => d.games)
      .filter((g) => g.season === seasonNumber && !seen.has(g.id));
    for (const g of batch) seen.add(g.id);
    games.push(...batch);
    ctx.progress(result.inserted, null, `Week ${weeks}: ${date}`);
    await processGames(batch);
    const next: string | null = week.nextStartDate ?? null;
    date = next !== null && next > (date as string) ? next : null;
    if (date === null && week.gameWeek.length > 0) {
      // No next week announced: continue after the last day of this one (off-days inside a season).
      const last = week.gameWeek[week.gameWeek.length - 1]?.date;
      if (last && batch.length > 0) date = addDays(last, 1);
    }
  }

  async function processGames(batch: NhlScheduleGame[]): Promise<void> {
    for (const g of batch) {
      if (result.inserted >= limit) return;
      if (g.gameType === 1 && !options.includePreseason) {
        result.skippedPreseason++;
        continue;
      }
      if (!(g.gameType in COMPETITION)) continue;
      if (!FINISHED_STATES.has(g.gameState.toUpperCase())) {
        result.skippedUnfinished++;
        continue;
      }
      const id = `nhl:${g.id}`;
      if (repos.histGames.get({ id })) {
        result.skippedExisting++;
        continue;
      }
      const pbp = await ctx.request((signal) => client.playByPlay(g.id, signal));
      let timeline: NhlGameTimeline;
      try {
        timeline = timelineFromPlayByPlay(pbp);
      } catch (err) {
        result.failed++;
        log.warn({ gameId: g.id, err: { message: (err as Error).message } }, 'NHL game skipped');
        continue;
      }
      repos.histGames.insert({
        id,
        league_id: 'nhl',
        season: label,
        competition: COMPETITION[g.gameType] ?? null,
        played_at: new Date(pbp.startTimeUTC).toISOString(),
        home: pbp.homeTeam.abbrev,
        away: pbp.awayTeam.abbrev,
        final_home: timeline.finalHome,
        final_away: timeline.finalAway,
        goal_events: JSON.stringify(timeline.goals),
        source: 'nhl',
        kalshi_event_ticker: null,
      });
      result.inserted++;
      ctx.progress(
        result.inserted,
        null,
        `${pbp.awayTeam.abbrev} @ ${pbp.homeTeam.abbrev} ${g.startTimeUTC.slice(0, 10)}`,
      );
    }
  }

  result.requests = client.requests - requestsBefore;
  if (result.skippedExisting > 0)
    log.info({ season: label }, `NHL import: skipped ${result.skippedExisting} existing`);
  log.info({ ...result, games: games.length }, 'NHL import finished');
  return result;
}
