import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { listTrades, tradeDetail, type StatusFilter } from '../../core/trades.js';
import { HttpError } from '../http.js';
import type { LiveHub } from '../live.js';

const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const idList = z
  .string()
  .max(2000)
  .transform((v) => [...new Set(v.split(',').filter((x) => ID.test(x)))]);

const TradeQuery = z.object({
  sport: z.enum(['all', 'soccer', 'hockey']).default('all'),
  leagues: idList.optional(),
  strategies: idList.optional(),
  mode: z.enum(['live', 'dry_run', 'both']).default('both'),
  env: z.enum(['demo', 'prod']).optional(),
  range: z.enum(['7d', '30d', 'season', 'all']).default('all'),
  status: z.enum(['all', 'open', 'waiting', 'filled', 'settled', 'skipped']).default('all'),
  reason: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the date-range preset (§8 filter bar): 7d, 30d, the season (from 1 July, UTC) or everything. */
export function rangeStart(range: '7d' | '30d' | 'season' | 'all', nowMs: number): string | undefined {
  if (range === '7d') return new Date(nowMs - 7 * DAY_MS).toISOString();
  if (range === '30d') return new Date(nowMs - 30 * DAY_MS).toISOString();
  if (range === 'season') {
    const d = new Date(nowMs);
    const year = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return new Date(Date.UTC(year, 6, 1)).toISOString();
  }
  return undefined;
}

/**
 * Trades API (SPEC.md §8 Trades page, T09):
 *
 * - `GET /api/trades?sport&leagues&strategies&mode&env&range&status&reason` — trades newest first, each with its
 *   own `effectiveMode` / `configuredMode` / `modeReason` / `kalshiEnv` (never aggregated across modes). `env`
 *   defaults to the Kalshi environment the app runs against; `status` is a group (`open`, `waiting`,
 *   `filled`, `settled`, `skipped`) and `reason` narrows to one skip reason.
 * - `GET /api/trades/:id` — one trade with its trigger snapshot, attempts and audit trail.
 */
export function registerTradeRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  now: () => number = Date.now,
): void {
  app.get('/api/trades', async (req) => {
    const parsed = TradeQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`),
      });
    }
    const q = parsed.data;
    const trades = listTrades(database.repositories, {
      sport: q.sport,
      leagueIds: q.leagues ?? [],
      strategyIds: q.strategies ?? [],
      mode: q.mode,
      kalshiEnv: q.env ?? hub.runtime.kalshiEnv,
      sinceIso: rangeStart(q.range, now()),
      status: q.status as StatusFilter,
      reason: q.reason,
    });
    return { trades };
  });

  app.get<{ Params: { id: string } }>('/api/trades/:id', async (req) => {
    if (!ID.test(req.params.id)) throw new HttpError(404, 'not_found');
    const detail = tradeDetail(database.repositories, req.params.id);
    if (!detail) throw new HttpError(404, 'not_found');
    return detail;
  });
}
