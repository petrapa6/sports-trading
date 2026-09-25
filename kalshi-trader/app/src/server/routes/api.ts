import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { SETTINGS } from '../../db/settings.js';
import { userActor } from '../audit.js';
import { parseBody } from '../http.js';
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
 * Settings writable through `POST /api/settings` so far. Switches and the bankroll reset need
 * step-up and arrive with the Settings page (T04).
 */
const SettingsPatch = z
  .object({
    order_group_contract_limit: SETTINGS.order_group_contract_limit.schema.optional(),
  })
  .strict();

export function registerApiRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
): void {
  const auth = app.authService;

  /** A CSRF token for the current session; send it as `x-csrf-token` on every state-changing request. */
  app.get('/api/csrf', async (req, reply) => ({ token: app.csrfToken(req, reply) }));

  app.get('/api/settings', async () => {
    const settings = database.repositories.settings;
    return Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, settings.get(k)]));
  });

  app.post('/api/settings', async (req) => {
    const patch = parseBody(SettingsPatch, req.body);
    const settings = database.repositories.settings;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch) as [keyof typeof patch, number | undefined][]) {
      if (value === undefined) continue;
      const from = settings.get(key);
      if (from === value) continue;
      settings.set(key, value);
      changes[key] = { from, to: value };
    }
    if (Object.keys(changes).length > 0) {
      auth.audit(
        { actor: userActor(authOf(req).user.username), ...clientContext(req) },
        { action: 'settings_change', entity: 'settings', detail: changes },
      );
    }
    return Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, settings.get(k)]));
  });
}
