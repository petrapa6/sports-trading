import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import type { Repositories } from '../../db/repositories.js';
import {
  createStrategy,
  editStrategy,
  loadStrategy,
  loadVersions,
  readGlobalSwitches,
  strategyRunningMode,
  strategyView,
  strategyViews,
  type StrategyRecord,
} from '../../core/strategyStore.js';
import {
  StrategyCreateSchema,
  StrategyDefinitionSchema,
  STRATEGY_MODES,
  type StrategyDefinition,
} from '../../core/strategy.js';
import { userActor } from '../audit.js';
import { HttpError, parseBody } from '../http.js';
import type { LiveHub } from '../live.js';
import { authOf, clientContext } from '../security.js';

const KillSwitchBody = z.object({ killSwitch: z.boolean() }).strict();
const ModeBody = z.object({ mode: z.enum(STRATEGY_MODES) }).strict();

/** `leagueIds` must name existing leagues of the strategy's sport; otherwise `400` naming the index. */
function checkLeagues(repos: Repositories, def: StrategyDefinition): void {
  const issues: string[] = [];
  def.leagueIds.forEach((id, i) => {
    const league = repos.leagues.get({ id });
    if (!league) issues.push(`leagueIds.${i}: unknown league "${id}"`);
    else if (league.sport !== def.sport)
      issues.push(`leagueIds.${i}: ${league.name} is a ${league.sport} league, not ${def.sport}`);
  });
  if (issues.length > 0) throw new HttpError(400, 'bad_request', { issues });
}

/**
 * Strategies API (SPEC.md §5, §8, T08):
 *
 * - `GET /api/strategies[?includeDeleted=1]` — every strategy with its current version, effective mode and
 *   30-day trades / P&L per mode (soft-deleted ones only with `includeDeleted`).
 * - `GET /api/strategies/:id` — one strategy plus its version history.
 * - `POST /api/strategies` — create (kill switch on, `dry_run`, version 1).
 * - `POST /api/strategies/:id` — edit: a changed name updates the row; changed leagues / rule / sizing /
 *   execution add a version (`current_version` + 1; earlier versions are never changed).
 * - `POST /api/strategies/:id/kill-switch` `{killSwitch}` and `POST /api/strategies/:id/mode` `{mode}` —
 *   no version; audited as `strategy_kill_switch_changed` / `strategy_mode_changed`. Turning the kill
 *   switch **off** and switching to **live** need step-up (`403 reauth_required`); the way to safety
 *   does not.
 * - `POST /api/strategies/:id/delete` — soft delete (`deleted_at`); its trades stay in reports.
 */
export function registerStrategyRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  now: () => number = Date.now,
): void {
  const auth = app.authService;
  const repos = () => database.repositories;
  const switches = () => readGlobalSwitches(repos(), hub.runtime.allowLiveOrders);
  const actorOf = (req: FastifyRequest) => ({
    actor: userActor(authOf(req).user.username),
    ...clientContext(req),
  });
  const view = (s: StrategyRecord) => strategyView(repos(), s, switches(), now());

  const find = (id: string): StrategyRecord => {
    const s = loadStrategy(repos(), id);
    if (!s || s.deletedAt !== null) throw new HttpError(404, 'not_found');
    return s;
  };

  app.get<{ Querystring: { includeDeleted?: string } }>('/api/strategies', async (req) => {
    const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
    return strategyViews(repos(), switches(), now(), includeDeleted);
  });

  app.get<{ Params: { id: string } }>('/api/strategies/:id', async (req) => {
    const s = loadStrategy(repos(), req.params.id);
    if (!s) throw new HttpError(404, 'not_found');
    return { ...view(s), versions: loadVersions(repos(), s.id) };
  });

  app.post('/api/strategies', async (req, reply) => {
    const def = parseBody(StrategyCreateSchema, req.body);
    checkLeagues(repos(), def);
    const at = new Date(now()).toISOString();
    const s = createStrategy(repos(), def, at);
    const mode = strategyRunningMode(s, switches());
    auth.audit(actorOf(req), {
      action: 'strategy_created',
      entity: 'strategy',
      entityId: s.id,
      mode,
      detail: { name: s.name, sport: s.sport, version: 1 },
    });
    req.log.info({ mode, strategyId: s.id }, `Strategy "${s.name}" created (kill switch on, dry run)`);
    hub.strategiesChanged();
    return reply.code(201).send({ ...view(s), versions: loadVersions(repos(), s.id) });
  });

  app.post<{ Params: { id: string } }>('/api/strategies/:id', async (req) => {
    const existing = find(req.params.id);
    const def = parseBody(StrategyDefinitionSchema, req.body);
    if (def.sport !== existing.sport) {
      throw new HttpError(400, 'bad_request', {
        issues: ['sport: the sport of a strategy cannot be changed; create a new strategy instead'],
      });
    }
    checkLeagues(repos(), def);
    const { record, versionCreated } = editStrategy(repos(), existing, def, new Date(now()).toISOString());
    if (versionCreated || record.name !== existing.name) {
      const mode = strategyRunningMode(record, switches());
      auth.audit(actorOf(req), {
        action: 'strategy_edited',
        entity: 'strategy',
        entityId: record.id,
        mode,
        detail: {
          version: record.currentVersion,
          versionCreated,
          ...(record.name !== existing.name ? { name: { from: existing.name, to: record.name } } : {}),
        },
      });
      req.log.info(
        { mode, strategyId: record.id, version: record.currentVersion },
        versionCreated
          ? `Strategy "${record.name}" edited: version ${record.currentVersion}`
          : `Strategy "${record.name}" renamed`,
      );
      hub.strategiesChanged();
    }
    return { ...view(record), versions: loadVersions(repos(), record.id) };
  });

  app.post<{ Params: { id: string } }>('/api/strategies/:id/kill-switch', async (req, reply) => {
    const s = find(req.params.id);
    const { killSwitch } = parseBody(KillSwitchBody, req.body);
    if (killSwitch === s.killSwitch) return view(s);
    // Turning the kill switch off lets the strategy trade: step-up before anything is written.
    if (!killSwitch && !auth.isRecentAuth(authOf(req).session)) {
      return reply.code(403).send({ error: 'reauth_required' });
    }
    const at = new Date(now()).toISOString();
    repos().strategies.update({ id: s.id }, { kill_switch: killSwitch ? 1 : 0, updated_at: at });
    const updated = find(s.id);
    const mode = strategyRunningMode(updated, switches());
    auth.audit(actorOf(req), {
      action: 'strategy_kill_switch_changed',
      entity: 'strategy',
      entityId: s.id,
      mode,
      detail: { from: s.killSwitch, to: killSwitch },
    });
    req.log.info(
      { mode, strategyId: s.id, killSwitch },
      `Strategy "${s.name}": kill switch ${killSwitch ? 'on (paused)' : 'off'}`,
    );
    hub.strategiesChanged();
    return view(updated);
  });

  app.post<{ Params: { id: string } }>('/api/strategies/:id/mode', async (req, reply) => {
    const s = find(req.params.id);
    const { mode: to } = parseBody(ModeBody, req.body);
    if (to === s.mode) return view(s);
    if (to === 'live' && !auth.isRecentAuth(authOf(req).session)) {
      return reply.code(403).send({ error: 'reauth_required' });
    }
    const at = new Date(now()).toISOString();
    repos().strategies.update({ id: s.id }, { mode: to, updated_at: at });
    const updated = find(s.id);
    const mode = strategyRunningMode(updated, switches());
    auth.audit(actorOf(req), {
      action: 'strategy_mode_changed',
      entity: 'strategy',
      entityId: s.id,
      mode,
      detail: { from: s.mode, to },
    });
    req.log.info(
      { mode, strategyId: s.id, configuredMode: to },
      `Strategy "${s.name}": mode ${s.mode} → ${to}` + (mode !== to ? ` (runs as ${mode})` : ''),
    );
    hub.strategiesChanged();
    return view(updated);
  });

  app.post<{ Params: { id: string } }>('/api/strategies/:id/delete', async (req) => {
    const s = find(req.params.id);
    const at = new Date(now()).toISOString();
    repos().strategies.update({ id: s.id }, { deleted_at: at, updated_at: at });
    const mode = strategyRunningMode(s, switches());
    auth.audit(actorOf(req), { action: 'strategy_deleted', entity: 'strategy', entityId: s.id, mode });
    req.log.info({ mode, strategyId: s.id }, `Strategy "${s.name}" deleted`);
    hub.strategiesChanged();
    return { ok: true };
  });
}
