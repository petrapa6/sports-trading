import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { SETTINGS } from '../../db/settings.js';
import { resetBankroll } from '../../core/trades.js';
import { userActor } from '../audit.js';
import { parseBody } from '../http.js';
import { globalMode, type LiveHub } from '../live.js';
import { authOf, clientContext } from '../security.js';

/** Settings the API exposes (secrets such as `api_football_key_enc` never leave the server). */
const PUBLIC_SETTINGS = [
  'global_kill_switch',
  'global_dry_run',
  'dry_run_bankroll_micros',
  'dry_run_initial_bankroll_micros',
  'fee_balance_precision_micros',
  'order_group_contract_limit',
] as const;

/**
 * Settings writable through `POST /api/settings`. Turning the global kill switch or global dry run
 * **off** can lead to real orders and needs step-up (SPEC.md §1, §10); turning either on does not.
 */
const SettingsPatch = z
  .object({
    global_kill_switch: SETTINGS.global_kill_switch.schema.optional(),
    global_dry_run: SETTINGS.global_dry_run.schema.optional(),
    order_group_contract_limit: SETTINGS.order_group_contract_limit.schema.optional(),
    /** Fee rounding (§2 Fees): $0.0001 (100) by default, $0.01 (10000) for conservative dry runs. */
    fee_balance_precision_micros: SETTINGS.fee_balance_precision_micros.schema.optional(),
    /** The value a bankroll reset restores (the current bankroll changes only on reset). */
    dry_run_initial_bankroll_micros: SETTINGS.dry_run_initial_bankroll_micros.schema
      .refine((n) => n >= 1_000_000, 'must be at least $1')
      .refine((n) => n <= 10_000_000_000_000, 'must be at most $10,000,000')
      .optional(),
  })
  .strict();

const SWITCHES = { global_kill_switch: 'Global kill switch', global_dry_run: 'Global dry run' } as const;
type SwitchKey = keyof typeof SWITCHES;
const isSwitch = (key: string): key is SwitchKey => key in SWITCHES;

/** Size of the database file plus its WAL, in bytes (0 for a missing file). */
export function dbSizeBytes(path: string): number {
  let total = 0;
  for (const p of [path, `${path}-wal`]) {
    try {
      total += statSync(p).size;
    } catch {
      // missing file
    }
  }
  return total;
}

export function registerApiRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  hub: LiveHub,
  now: () => number = Date.now,
): void {
  const auth = app.authService;

  /** A CSRF token for the current session; send it as `x-csrf-token` on every state-changing request. */
  app.get('/api/csrf', async (req, reply) => ({ token: app.csrfToken(req, reply) }));

  const publicSettings = () => {
    const settings = database.repositories.settings;
    return Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, settings.get(k)]));
  };

  app.get('/api/settings', async () => publicSettings());

  app.post('/api/settings', async (req, reply) => {
    const patch = parseBody(SettingsPatch, req.body);
    const settings = database.repositories.settings;
    const { user, session } = authOf(req);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch) as [
      keyof typeof patch,
      boolean | number | undefined,
    ][]) {
      if (value === undefined) continue;
      const from = settings.get(key);
      if (from !== value) changes[key] = { from, to: value };
    }
    // Step-up is checked before anything is written, so a rejected request changes nothing.
    const towardsLive = Object.entries(changes).some(([key, c]) => isSwitch(key) && c.to === false);
    if (towardsLive && !auth.isRecentAuth(session)) {
      return reply.code(403).send({ error: 'reauth_required' });
    }

    const actor = { actor: userActor(user.username), ...clientContext(req) };
    const other: typeof changes = {};
    for (const [key, change] of Object.entries(changes) as [keyof typeof patch, (typeof changes)[string]][]) {
      settings.set(key, change.to as never);
      if (!isSwitch(key)) {
        other[key] = change;
        continue;
      }
      const state = change.to ? 'on' : 'off';
      const mode = globalMode(hub.switches());
      auth.audit(actor, { action: `${key}_${state}`, entity: 'settings', entityId: key, mode });
      req.log.info({ mode, setting: key, value: change.to }, `${SWITCHES[key]} turned ${state}`);
    }
    if (Object.keys(other).length > 0) {
      auth.audit(actor, { action: 'settings_change', entity: 'settings', detail: other });
    }
    if (Object.keys(changes).some(isSwitch)) hub.switchesChanged();
    return publicSettings();
  });

  /**
   * Resets the shared dry-run bankroll to its initial value (§5 Sizing, §8 Settings → Trading): needs step-up,
   * writes a `bankroll_snapshots` row (`reset`) and an audit row (`mode = 'dry_run'`).
   */
  app.post('/api/settings/bankroll/reset', async (req, reply) => {
    const { user, session } = authOf(req);
    if (!auth.isRecentAuth(session)) return reply.code(403).send({ error: 'reauth_required' });
    const repos = database.repositories;
    const at = new Date(now()).toISOString();
    const change = resetBankroll(repos, at);
    auth.audit(
      { actor: userActor(user.username), ...clientContext(req) },
      {
        action: 'dry_run_bankroll_reset',
        entity: 'settings',
        entityId: 'dry_run_bankroll_micros',
        mode: 'dry_run',
        detail: { fromMicros: change.from, toMicros: change.to },
      },
    );
    req.log.info({ mode: 'dry_run', ...change }, 'Dry-run bankroll reset to its initial value');
    hub.strategiesChanged();
    return publicSettings();
  });

  /** Switch states plus the read-only process facts (add-on lock, Kalshi env, subaccount, version). */
  app.get('/api/status', async () => ({ ...hub.switches(), version: hub.runtime.version }));

  app.get('/api/diagnostics', async () => ({
    version: hub.runtime.version,
    dbPath: hub.runtime.dbPath,
    dbSizeBytes: dbSizeBytes(hub.runtime.dbPath),
  }));
}
