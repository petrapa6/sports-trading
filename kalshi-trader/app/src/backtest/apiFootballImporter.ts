import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { GoalEvent } from '../core/tracker.js';
import type { ApiFootballClient, FixtureEvent } from '../feeds/apiFootball/feed.js';
import type { JobContext } from './jobs.js';

/**
 * Bulk soccer goal timelines from API-Football (SPEC.md §3 Historical, T15, optional): for one league and
 * season, `GET /fixtures?league=…&season=…&status=FT`, then `GET /fixtures/events?fixture=…&type=Goal` for
 * every finished fixture → `hist_games` (`source = 'api_football'`, id `api_football:<fixtureId>`).
 *
 * - Needs a paid key: `GET /status` first, and a `Free` plan stops the job (the free plan has neither the
 *   seasons nor the request volume for a bulk import).
 * - Goals: `type = Goal` except missed penalties; `side` from the event's team id; minute = `elapsed`
 *   (stoppage counts as 45 / 90). Own goals are credited to whichever side makes the events add up to the
 *   final score; a fixture whose goals still do not add up is skipped with a `warn`.
 * - Every request goes through the job (kill switch pause, cancel), the network gate and the daily quota
 *   guard: a used-up quota fails the job; running it again later resumes (existing rows are skipped).
 */

export interface ApiFootballImportDeps {
  client: Pick<ApiFootballClient, 'status' | 'fixtures' | 'goalEvents'>;
  repos: Repositories;
  log: Logger;
  ctx: JobContext;
}

export interface ApiFootballImportOptions {
  leagueId: string;
  /** API-Football league id (`leagues.feed_ids.apiFootball`). */
  apiLeagueId: number;
  /** Season start year (2025 = 2025-26). */
  season: number;
  limit?: number;
}

export interface ApiFootballImportResult {
  fixtures: number;
  imported: number;
  skipped: number;
  failed: number;
}

export class ApiFootballFreePlan extends Error {
  override name = 'ApiFootballFreePlan';
}

/** `2025` → `2025-26`. */
export const seasonLabelOf = (season: number): string =>
  `${season}-${String((season + 1) % 100).padStart(2, '0')}`;

/**
 * Goal events of one fixture, or `null` when they cannot be made to add up to the final score (own goals
 * are tried both ways: credited to the event's team, then to the other side).
 */
export function goalTimeline(
  events: readonly FixtureEvent[],
  homeId: number | null | undefined,
  awayId: number | null | undefined,
  final: { home: number | null | undefined; away: number | null | undefined },
): GoalEvent[] | null {
  const goals = events
    .filter((e) => (e.type ?? '').toLowerCase() === 'goal' && !/missed/i.test(e.detail ?? ''))
    .sort((a, b) => (a.time.elapsed ?? 0) - (b.time.elapsed ?? 0));
  const build = (flipOwnGoals: boolean): GoalEvent[] | null => {
    const out: GoalEvent[] = [];
    for (const e of goals) {
      const team = e.team?.id;
      let side: GoalEvent['side'] | null = team === homeId ? 'home' : team === awayId ? 'away' : null;
      if (side === null || e.time.elapsed == null) return null;
      if (flipOwnGoals && /own goal/i.test(e.detail ?? '')) side = side === 'home' ? 'away' : 'home';
      const elapsed = e.time.elapsed;
      const minute = Math.max(0, Math.min(90, elapsed));
      out.push({ side, period: elapsed <= 45 ? 1 : 2, minute, second: 0 });
    }
    return out;
  };
  const addsUp = (list: GoalEvent[]) =>
    final.home == null ||
    final.away == null ||
    (list.filter((g) => g.side === 'home').length === final.home &&
      list.filter((g) => g.side === 'away').length === final.away);
  for (const flip of [false, true]) {
    const list = build(flip);
    if (list && addsUp(list)) return list;
  }
  return null;
}

export async function importApiFootballSeason(
  deps: ApiFootballImportDeps,
  o: ApiFootballImportOptions,
): Promise<ApiFootballImportResult> {
  const { client, repos, log, ctx } = deps;
  const status = await ctx.request((signal) => client.status(signal));
  const plan = status.subscription?.plan ?? '';
  if (/^free$/i.test(plan.trim()))
    throw new ApiFootballFreePlan(
      'The bulk import needs a paid API-Football plan; this key is on the Free plan.',
    );
  ctx.progress(0, null, `Listing ${o.leagueId} ${seasonLabelOf(o.season)} fixtures`);
  const all = await ctx.request((signal) =>
    client.fixtures({ league: o.apiLeagueId, season: o.season, status: 'FT' }, signal),
  );
  const fixtures = all
    .filter((f) => f.fixture.status.short.toUpperCase() === 'FT')
    .sort((a, b) => (a.fixture.date ?? '').localeCompare(b.fixture.date ?? ''))
    .slice(0, o.limit ?? Number.MAX_SAFE_INTEGER);
  const result: ApiFootballImportResult = { fixtures: fixtures.length, imported: 0, skipped: 0, failed: 0 };
  let done = 0;
  ctx.progress(0, fixtures.length, null);
  for (const f of fixtures) {
    await ctx.checkpoint();
    const id = `api_football:${f.fixture.id}`;
    if (repos.histGames.get({ id })) {
      result.skipped++;
    } else {
      const events = await ctx.request((signal) => client.goalEvents(f.fixture.id, signal));
      const goals = goalTimeline(events, f.teams.home.id, f.teams.away.id, {
        home: f.goals?.home,
        away: f.goals?.away,
      });
      if (!goals) {
        result.failed++;
        log.warn(
          { fixtureId: f.fixture.id, final: `${f.goals?.home ?? '?'}-${f.goals?.away ?? '?'}` },
          `API-Football fixture ${f.fixture.id}: goal events do not add up to the final score; skipped`,
        );
      } else {
        repos.histGames.insert({
          id,
          league_id: o.leagueId,
          season: seasonLabelOf(o.season),
          competition: null,
          played_at: f.fixture.date ? new Date(f.fixture.date).toISOString() : null,
          home: f.teams.home.name ?? 'Home',
          away: f.teams.away.name ?? 'Away',
          final_home: f.goals?.home ?? goals.filter((g) => g.side === 'home').length,
          final_away: f.goals?.away ?? goals.filter((g) => g.side === 'away').length,
          goal_events: JSON.stringify(goals),
          source: 'api_football',
          kalshi_event_ticker: null,
        });
        result.imported++;
      }
    }
    done++;
    ctx.progress(done, fixtures.length, null);
  }
  log.info(
    { leagueId: o.leagueId, season: o.season, ...result },
    `API-Football import ${o.leagueId} ${seasonLabelOf(o.season)}: ${result.imported} imported, ` +
      `skipped ${result.skipped} existing, ${result.failed} failed`,
  );
  return result;
}
