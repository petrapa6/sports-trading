import { and, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { seasonOf } from '../core/tracker.js';
import type { Repositories } from '../db/repositories.js';
import { games as gamesTable, type League } from '../db/schema.js';
import type { KalshiClient } from '../feeds/kalshi/client.js';
import { chooseMilestone, isPreseason, upsertEvent } from '../feeds/kalshi/discovery.js';
import type { KalshiEvent } from '../feeds/kalshi/schemas.js';
import { NetworkPaused } from '../feeds/network.js';
import type { JobContext } from './jobs.js';
import { PbpUnusable, timelineFromGameStats } from './kalshiPbp.js';

/**
 * Kalshi backfill (SPEC.md §3 "Backfill discovery", T11): the discovery walk with `status=settled` over
 * a date range, so past Kalshi games can be backtested exactly although the app never saw them live.
 *
 * 1. For each enabled league (or the chosen ones): every settled event of the series (all pages);
 *    events whose markets closed outside `[from, to]` (UTC days, inclusive) are ignored; preseason
 *    events are skipped unless the league includes them.
 * 2. `GET /milestones?related_event_ticker=…` → upsert teams, the game (`historical = 1`, `phase =
 *    'finished'`: the scheduler never tracks it, the engine never trades it) and its markets with their
 *    settlement values.
 * 3. Play-by-play (unless disabled): `GET /live_data/milestone/{id}/game_stats` for every finished game
 *    with a milestone and no archived timeline → `hist_games` (`source = 'kalshi_pbp'`, id
 *    `kalshi_pbp:<event>`, `kalshi_event_ticker` set) and `games.timeline_archived = 1`. A game whose
 *    live timeline was already archived (`live:<event>`) is skipped; an unusable payload is logged and
 *    counted, the others continue.
 */

export interface BackfillOptions {
  /** `YYYY-MM-DD`, inclusive (UTC). */
  from: string;
  to: string;
  leagueIds?: readonly string[];
  /** Import play-by-play timelines after the discovery (default true). */
  playByPlay?: boolean;
}

export interface BackfillLeague {
  leagueId: string;
  series: string;
  settledEvents: number;
  inRange: number;
  skippedPreseason: number;
  skippedNoMilestone: number;
  games: number;
  markets: number;
  error?: string;
}

export interface PbpImportResult {
  imported: number;
  skippedLive: number;
  unusable: number;
  failed: number;
}

export interface BackfillResult {
  from: string;
  to: string;
  leagues: BackfillLeague[];
  playByPlay: PbpImportResult | null;
}

export interface BackfillDeps {
  client: Pick<KalshiClient, 'listAllEvents' | 'listMilestones' | 'getGameStats'>;
  repos: Repositories;
  log: Logger;
  transaction?: (fn: () => void) => void;
  now?: () => number;
  ctx?: Pick<JobContext, 'request' | 'progress' | 'checkpoint'>;
}

const DIRECT: Pick<JobContext, 'request' | 'progress' | 'checkpoint'> = {
  request: (fn) => fn(new AbortController().signal),
  progress: () => undefined,
  checkpoint: async () => undefined,
};

const DAY_MS = 86_400_000;

/** The UTC day an event belongs to: its markets' earliest close time (`null` when none has one). */
export function eventDay(event: KalshiEvent): string | null {
  const closes = event.markets
    .map((m) => (m.close_time ? Date.parse(m.close_time) : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  if (closes.length === 0) return null;
  return new Date(Math.min(...closes)).toISOString().slice(0, 10);
}

export async function runBackfill(deps: BackfillDeps, options: BackfillOptions): Promise<BackfillResult> {
  const { client, repos, log } = deps;
  const ctx = deps.ctx ?? DIRECT;
  const now = deps.now ?? Date.now;
  const leagues = repos.leagues
    .listEnabled()
    .filter((l) => options.leagueIds === undefined || options.leagueIds.includes(l.id));
  const result: BackfillResult = { from: options.from, to: options.to, leagues: [], playByPlay: null };
  const touched: string[] = [];

  for (const league of leagues) {
    const row: BackfillLeague = {
      leagueId: league.id,
      series: league.kalshi_series,
      settledEvents: 0,
      inRange: 0,
      skippedPreseason: 0,
      skippedNoMilestone: 0,
      games: 0,
      markets: 0,
    };
    result.leagues.push(row);
    try {
      await backfillLeague(league, row);
    } catch (err) {
      // Cancel and the kill switch stop the whole run; any other failure only this league.
      if (isJobStop(err) || err instanceof NetworkPaused) throw err;
      row.error = (err as Error).message;
      log.warn({ leagueId: league.id, err: { message: row.error } }, 'Backfill failed for a league');
    }
  }

  async function backfillLeague(league: League, row: BackfillLeague): Promise<void> {
    const events = await ctx.request(() => client.listAllEvents(league.kalshi_series, 'settled', true));
    row.settledEvents = events.length;
    const inRange = events.filter((e) => {
      const day = eventDay(e);
      return day !== null && day >= options.from && day <= options.to;
    });
    row.inRange = inRange.length;
    for (const event of inRange) {
      if (isPreseason(event.competition) && league.include_preseason !== 1) {
        row.skippedPreseason++;
        continue;
      }
      const milestones = await ctx.request(() =>
        client.listMilestones({ relatedEventTicker: event.event_ticker }),
      );
      const milestone = chooseMilestone(event.event_ticker, milestones);
      if (!milestone) {
        row.skippedNoMilestone++;
        log.warn(
          { leagueId: league.id, event: event.event_ticker },
          'Backfill: event has no milestone; skipped',
        );
        continue;
      }
      const counts = upsertEvent(deps, league, event, milestone, new Date(now()).toISOString(), {
        historical: true,
      });
      row.games++;
      row.markets += counts.markets;
      touched.push(event.event_ticker);
      ctx.progress(touched.length, null, `${league.id}: ${event.event_ticker}`);
    }
    log.info({ ...row }, 'Backfill done for league');
  }

  if (options.playByPlay !== false) {
    result.playByPlay = await importPlayByPlay(deps, touched);
  }
  return result;
}

const isJobStop = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'JobCancelled' || err.name === 'AbortError');

/**
 * Play-by-play timelines for the given games (default: every finished game with a milestone whose
 * timeline is not archived yet).
 */
export async function importPlayByPlay(
  deps: BackfillDeps,
  gameIds?: readonly string[],
): Promise<PbpImportResult> {
  const { client, repos, log } = deps;
  const ctx = deps.ctx ?? DIRECT;
  const now = deps.now ?? Date.now;
  const tx = deps.transaction ?? ((fn: () => void) => fn());
  const result: PbpImportResult = { imported: 0, skippedLive: 0, unusable: 0, failed: 0 };
  const candidates = repos.games
    .list(
      and(
        eq(gamesTable.phase, 'finished'),
        eq(gamesTable.timeline_archived, 0),
        isNotNull(gamesTable.milestone_id),
      ),
    )
    .filter((g) => gameIds === undefined || gameIds.includes(g.id));
  const sports = new Map(repos.leagues.list().map((l) => [l.id, l.sport]));
  let n = 0;
  for (const game of candidates) {
    n++;
    ctx.progress(n, candidates.length, `Play-by-play ${game.id}`);
    if (repos.histGames.get({ id: `live:${game.id}` })) {
      result.skippedLive++;
      continue;
    }
    const sport = sports.get(game.league_id ?? '');
    if (sport !== 'soccer' && sport !== 'hockey') continue;
    let stats;
    try {
      stats = await ctx.request(() => client.getGameStats(game.milestone_id as string));
    } catch (err) {
      if (isJobStop(err) || err instanceof NetworkPaused) throw err;
      result.failed++;
      log.warn({ gameId: game.id, err: { message: (err as Error).message } }, 'Play-by-play request failed');
      continue;
    }
    let timeline;
    try {
      timeline = timelineFromGameStats(stats, sport);
    } catch (err) {
      if (!(err instanceof PbpUnusable)) throw err;
      result.unusable++;
      log.warn({ gameId: game.id, reason: err.message }, 'Play-by-play unusable; game skipped');
      continue;
    }
    const home = game.home_team_id ? repos.teams.get({ id: game.home_team_id }) : undefined;
    const away = game.away_team_id ? repos.teams.get({ id: game.away_team_id }) : undefined;
    const id = `kalshi_pbp:${game.id}`;
    const hist = {
      league_id: game.league_id,
      season: seasonOf(Date.parse(game.scheduled_at)),
      competition: game.competition,
      played_at: game.scheduled_at,
      home: home?.name ?? 'Home',
      away: away?.name ?? 'Away',
      final_home: timeline.finalHome,
      final_away: timeline.finalAway,
      goal_events: JSON.stringify(timeline.goals),
      source: 'kalshi_pbp',
      kalshi_event_ticker: game.id,
    };
    tx(() => {
      if (repos.histGames.get({ id })) repos.histGames.update({ id }, hist);
      else repos.histGames.insert({ id, ...hist });
      repos.games.update(
        { id: game.id },
        {
          timeline_archived: 1,
          final_home: game.final_home ?? timeline.finalHome,
          final_away: game.final_away ?? timeline.finalAway,
          updated_at: new Date(now()).toISOString(),
        },
      );
    });
    result.imported++;
  }
  log.info({ ...result }, 'Play-by-play import finished');
  return result;
}

/** `[from, to]` as validated UTC days (throws `RangeError`). */
export function validateRange(from: string, to: string, maxDays = 400): void {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    Number.isNaN(f) ||
    Number.isNaN(t)
  )
    throw new RangeError('from and to must be dates (YYYY-MM-DD)');
  if (t < f) throw new RangeError('to must not be before from');
  if ((t - f) / DAY_MS > maxDays) throw new RangeError(`the range must not exceed ${maxDays} days`);
}
