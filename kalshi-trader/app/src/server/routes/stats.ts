import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { computeStats } from '../../core/stats.js';
import { HttpError } from '../http.js';
import type { LiveHub } from '../live.js';
import { idList, rangeStart } from './trades.js';

const StatsQuery = z.object({
  sport: z.enum(['all', 'soccer', 'hockey']).default('all'),
  leagues: idList.optional(),
  strategies: idList.optional(),
  mode: z.enum(['live', 'dry_run', 'both']).default('both'),
  env: z.enum(['demo', 'prod']).optional(),
  range: z.enum(['7d', '30d', 'season', 'all']).default('all'),
});

/**
 * `GET /api/stats?sport&leagues&strategies&mode&env&range` (SPEC.md §6 Metrics, §8, T10): the Dashboard's tiles
 * and chart series, pre-aggregated and keyed by mode — `{ live: {tiles, series}, dry_run: {tiles, series} }`,
 * a mode filtered out is absent. The filter parameters are the Trades page's; `env` defaults to the Kalshi
 * environment the app runs against, and an unknown league id is a `400`.
 */
export function registerStatsRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  now: () => number = Date.now,
): void {
  app.get('/api/stats', async (req) => {
    const parsed = StatsQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`),
      });
    }
    const q = parsed.data;
    const repos = database.repositories;
    const unknown = (q.leagues ?? []).filter((id) => !repos.leagues.get({ id }));
    if (unknown.length > 0) throw new HttpError(400, 'unknown_league', { leagues: unknown });
    return computeStats(repos, {
      mode: q.mode,
      kalshiEnv: q.env ?? hub.runtime.kalshiEnv,
      sport: q.sport === 'all' ? undefined : q.sport,
      leagueIds: q.leagues ?? [],
      strategyIds: q.strategies ?? [],
      sinceIso: rangeStart(q.range, now()),
    });
  });
}
