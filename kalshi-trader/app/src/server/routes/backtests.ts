import type { FastifyInstance, FastifyRequest } from 'fastify';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { hist_games, type Backtest } from '../../db/schema.js';
import type { ResolvedRequest, StoredSummary } from '../../backtest/data.js';
import { BacktestBusyError, deleteBacktest, type BacktestRunner } from '../../backtest/runner.js';
import type { BacktestSummary } from '../../backtest/simulator.js';
import {
  parseVersionPayload,
  StrategyDefinitionSchema,
  strategyUsdMicros,
  type StrategySport,
} from '../../core/strategy.js';
import {
  createStrategy,
  loadStrategy,
  readGlobalSwitches,
  strategyRunningMode,
  strategyView,
  loadVersions,
} from '../../core/strategyStore.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import type { LiveHub } from '../live.js';
import { authOf, clientContext } from '../security.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const RunBody = z
  .object({
    /** Leagues replayed; default: the strategy's leagues. */
    leagueIds: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
    /** `hist_games.season` values; empty = every season. */
    seasons: z.array(z.string().min(1).max(20)).max(30).default([]),
    /** Only games played in the last N days (quick test). */
    lastDays: z.number().int().min(1).max(3650).optional(),
    /** An existing strategy (current version unless `version` is given)… */
    strategyId: z.string().min(1).max(64).optional(),
    version: z.number().int().min(1).optional(),
    /** …or ad-hoc parameters (the §5 definition; `name` optional). */
    definition: z.record(z.string(), z.unknown()).optional(),
    initialBankrollUsd: z
      .number()
      .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), 'initialBankrollUsd must have at most 2 decimals')
      .refine((n) => n >= 1 && n <= 10_000_000, 'initialBankrollUsd must be between $1 and $10,000,000')
      .default(100),
    priceMode: z.enum(['exact', 'modelled']).default('exact'),
    name: z.string().trim().min(1).max(80).optional(),
    quick: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.strategyId === undefined) !== (b.definition === undefined), {
    message: 'give either strategyId or definition',
    path: ['strategyId'],
  });

const SaveBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const PromoteBody = z.object({ name: z.string().trim().min(1).max(80).optional() }).strict();

export type BacktestStatus = 'running' | 'done' | 'failed' | 'interrupted';

function parseParams(row: Backtest): ResolvedRequest | null {
  try {
    return JSON.parse(row.params ?? 'null') as ResolvedRequest | null;
  } catch {
    return null;
  }
}

function parseSummary(row: Backtest): StoredSummary | null {
  if (row.result_summary === null) return null;
  try {
    return JSON.parse(row.result_summary) as StoredSummary;
  } catch {
    return { error: 'the stored result is not valid JSON' };
  }
}

const isError = (s: StoredSummary | null): s is { error: string } => s !== null && 'error' in s;

/**
 * Backtests API (SPEC.md §8 Backtest page, §9, T12). Backtests are their own category: nothing here reads or
 * writes live or dry-run trades.
 *
 * - `GET /api/backtests/options` — leagues with replayable seasons (games, games with Kalshi prices).
 * - `POST /api/backtests` — run an existing strategy version (`strategyId`, `version`) or ad-hoc parameters
 *   (`definition`) over `leagueIds` × `seasons` (or the `lastDays`) with `priceMode` exact / modelled; `202`
 *   `{id}`, progress on SSE `backtest` events.
 * - `GET /api/backtests` — every run (newest first) with status and summary tiles; `GET /api/backtests/:id` —
 *   one run with its summary, series and trades.
 * - `POST /api/backtests/:id/save` `{name}`, `POST /api/backtests/:id/delete` (or `DELETE`),
 *   `POST /api/backtests/:id/promote` `{name?}` — creates a strategy (kill switch on, dry run) whose version 1
 *   equals the replayed parameters.
 */
export function registerBacktestRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  runner: BacktestRunner | undefined,
  now: () => number = Date.now,
): void {
  const repos = () => database.repositories;
  const auth = app.authService;
  const actorOf = (req: FastifyRequest) => ({
    actor: userActor(authOf(req).user.username),
    ...clientContext(req),
  });

  const statusOf = (row: Backtest, summary: StoredSummary | null): BacktestStatus => {
    if (summary === null) return runner?.progress(row.id)?.status === 'running' ? 'running' : 'interrupted';
    return isError(summary) ? 'failed' : 'done';
  };

  const item = (row: Backtest) => {
    const params = parseParams(row);
    const summary = parseSummary(row);
    const status = statusOf(row, summary);
    const progress = runner?.progress(row.id);
    const tiles = summary && !isError(summary) ? { ...summary, series: undefined } : null;
    return {
      id: row.id,
      createdAt: row.created_at,
      name: params?.name ?? null,
      saved: params?.saved === true,
      quick: params?.quick === true,
      sport: params?.sport ?? null,
      leagueIds: params?.leagueIds ?? (row.league_id ? row.league_id.split(',') : []),
      seasons: params?.seasons ?? [],
      sinceIso: params?.sinceIso ?? null,
      strategy: params?.strategy ?? null,
      strategyName: params?.definition.name ?? null,
      priceMode: row.price_mode,
      initialBankrollMicros: row.initial_bankroll_micros,
      status,
      ...(status === 'running' && progress
        ? { progress: { done: progress.done, total: progress.total } }
        : {}),
      ...(isError(summary) ? { error: summary.error } : {}),
      summary: tiles as Omit<BacktestSummary, 'series'> | null,
    };
  };

  const find = (id: string): Backtest => {
    const row = repos().backtests.get({ id });
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  };

  /** The request as the worker receives it, from a validated body. */
  const resolve = (body: z.output<typeof RunBody>): ResolvedRequest => {
    const r = repos();
    let definition: ResolvedRequest['definition'];
    let sport: StrategySport;
    let strategy: ResolvedRequest['strategy'] = null;
    if (body.strategyId !== undefined) {
      const s = loadStrategy(r, body.strategyId);
      if (!s) throw new HttpError(404, 'not_found', { issues: ['strategyId: unknown strategy'] });
      const version = body.version ?? s.currentVersion;
      const row = r.strategyVersions.get({ strategy_id: s.id, version });
      if (!row)
        throw new HttpError(400, 'bad_request', { issues: [`version: strategy has no version ${version}`] });
      const payload = parseVersionPayload(row);
      definition = { name: s.name, ...payload };
      sport = s.sport;
      strategy = { id: s.id, name: s.name, version };
    } else {
      const parsed = StrategyDefinitionSchema.safeParse({ name: body.name ?? 'Ad-hoc', ...body.definition });
      if (!parsed.success) {
        throw new HttpError(400, 'bad_request', {
          issues: parsed.error.issues.map((i) => `definition.${i.path.join('.')}: ${i.message}`),
        });
      }
      const d = parsed.data;
      definition = {
        name: d.name,
        leagueIds: d.leagueIds,
        rule: d.rule,
        sizing: d.sizing,
        execution: d.execution,
      };
      sport = d.sport;
    }
    const leagueIds = body.leagueIds ?? definition.leagueIds;
    const issues: string[] = [];
    leagueIds.forEach((id, i) => {
      const league = r.leagues.get({ id });
      if (!league) issues.push(`leagueIds.${i}: unknown league "${id}"`);
      else if (league.sport !== sport) issues.push(`leagueIds.${i}: ${league.name} is not a ${sport} league`);
    });
    if (issues.length > 0) throw new HttpError(400, 'bad_request', { issues });
    return {
      name: body.name ?? null,
      saved: false,
      quick: body.quick,
      sport,
      leagueIds: [...new Set(leagueIds)],
      seasons: [...new Set(body.seasons)].sort(),
      sinceIso: body.lastDays !== undefined ? new Date(now() - body.lastDays * DAY_MS).toISOString() : null,
      strategy,
      definition,
      priceMode: body.priceMode,
      initialBankrollMicros: strategyUsdMicros(body.initialBankrollUsd),
    };
  };

  app.get('/api/backtests/options', async () => {
    const r = repos();
    const seasons = r.backtests.seasons();
    const model = r.settings.get('price_model') as { builtAt?: unknown } | null;
    return {
      leagues: r.leagues.list().map((l) => ({
        id: l.id,
        name: l.name,
        sport: l.sport,
        seasons: seasons
          .filter((x) => x.leagueId === l.id)
          .map((x) => ({ season: x.season, games: x.games, withKalshi: x.withKalshi })),
      })),
      priceModel: {
        built: model !== null,
        builtAt: model && typeof model.builtAt === 'string' ? model.builtAt : null,
      },
    };
  });

  app.get('/api/backtests', async () => repos().backtests.listNewest().map(item));

  app.get<{ Params: { id: string } }>('/api/backtests/:id', async (req) => {
    const row = find(req.params.id);
    const r = repos();
    const params = parseParams(row);
    const summary = parseSummary(row);
    const trades = r.backtestTrades.listByBacktest(row.id);
    const ids = [...new Set(trades.map((t) => t.hist_game_id).filter((x): x is string => x !== null))];
    const games = new Map<
      string,
      { playedAt: string | null; home: string | null; away: string | null; final: string }
    >();
    for (let i = 0; i < ids.length; i += 500) {
      for (const g of r.histGames.list(inArray(hist_games.id, ids.slice(i, i + 500)))) {
        games.set(g.id, {
          playedAt: g.played_at,
          home: g.home,
          away: g.away,
          final: `${g.final_home ?? '?'}-${g.final_away ?? '?'}`,
        });
      }
    }
    return {
      ...item(row),
      definition: params?.definition ?? null,
      summary: summary && !isError(summary) ? summary : null,
      trades: trades.map((t) => {
        const g = t.hist_game_id ? games.get(t.hist_game_id) : undefined;
        return {
          id: t.id,
          histGameId: t.hist_game_id,
          playedAt: g?.playedAt ?? null,
          home: g?.home ?? null,
          away: g?.away ?? null,
          final: g?.final ?? null,
          minute: t.minute,
          side: t.side,
          priceSource: t.price_source,
          priceBp: t.price_bp,
          contractsCc: t.contracts_cc,
          stakeMicros: t.stake_micros,
          feeMicros: t.fee_micros,
          settlementValueBp: t.settlement_value_bp,
          pnlMicros: t.pnl_micros,
          bankrollAfterMicros: t.bankroll_after_micros,
          skipReason: t.skip_reason,
        };
      }),
    };
  });

  app.post('/api/backtests', async (req, reply) => {
    if (!runner) throw new HttpError(503, 'backtests_unavailable');
    const request = resolve(parseBody(RunBody, req.body));
    let id: string;
    try {
      id = runner.start(request);
    } catch (err) {
      if (err instanceof BacktestBusyError) throw new HttpError(429, 'backtest_busy');
      throw err;
    }
    return reply.code(202).send({ id, status: 'running' });
  });

  app.post<{ Params: { id: string } }>('/api/backtests/:id/save', async (req) => {
    const row = find(req.params.id);
    const { name } = parseBody(SaveBody, req.body);
    const params = parseParams(row);
    if (!params) throw new HttpError(409, 'invalid_backtest');
    repos().backtests.update({ id: row.id }, { params: JSON.stringify({ ...params, name, saved: true }) });
    return item(find(row.id));
  });

  const remove = async (id: string) => {
    find(id);
    await runner?.cancel(id);
    deleteBacktest(repos(), id);
    return { ok: true };
  };
  app.post<{ Params: { id: string } }>('/api/backtests/:id/delete', async (req) => remove(req.params.id));
  app.delete<{ Params: { id: string } }>('/api/backtests/:id', async (req) => remove(req.params.id));

  app.post<{ Params: { id: string } }>('/api/backtests/:id/promote', async (req, reply) => {
    const row = find(req.params.id);
    const { name } = parseBody(PromoteBody, req.body);
    const params = parseParams(row);
    if (!params) throw new HttpError(409, 'invalid_backtest');
    const r = repos();
    const def = StrategyDefinitionSchema.parse({
      name: name ?? `${params.name ?? params.definition.name} (from backtest)`.slice(0, 80),
      sport: params.sport,
      leagueIds: params.definition.leagueIds,
      rule: params.definition.rule,
      sizing: params.definition.sizing,
      execution: params.definition.execution,
    });
    const s = createStrategy(r, def, new Date(now()).toISOString());
    const switches = readGlobalSwitches(r, hub.runtime.allowLiveOrders);
    const mode = strategyRunningMode(s, switches);
    auth.audit(actorOf(req), {
      action: 'strategy_created',
      entity: 'strategy',
      entityId: s.id,
      mode,
      detail: { name: s.name, sport: s.sport, version: 1, fromBacktest: row.id },
    });
    req.log.info(
      { mode, strategyId: s.id, backtestId: row.id },
      `Strategy "${s.name}" created from backtest ${row.id}`,
    );
    hub.strategiesChanged();
    return reply.code(201).send({ ...strategyView(r, s, switches, now()), versions: loadVersions(r, s.id) });
  });
}
