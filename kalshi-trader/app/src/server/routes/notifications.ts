import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DatabaseManager } from '../../db/database.js';
import { NOTIFICATION_EVENTS, type NotificationSettings } from '../../db/settings.js';
import { userActor } from '../audit.js';
import { parseBody } from '../http.js';
import { authOf, clientContext } from '../security.js';

/**
 * Settings → Notifications (T15): `GET /api/settings/notifications` answers every event and mode toggle
 * (defaults filled in) and whether a Supervisor token is present; `POST` changes some of them (audited as
 * `settings_change`, no step-up: a notification cannot lead to an order).
 */

const NotificationsPatch = z
  .object({
    events: z.partialRecord(z.enum(NOTIFICATION_EVENTS), z.boolean()).optional(),
    modes: z.object({ live: z.boolean().optional(), dry_run: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export interface NotificationsView {
  /** `SUPERVISOR_TOKEN` is present (running inside Home Assistant). */
  available: boolean;
  events: Record<(typeof NOTIFICATION_EVENTS)[number], boolean>;
  modes: { live: boolean; dry_run: boolean };
}

export function notificationsView(settings: NotificationSettings, available: boolean): NotificationsView {
  return {
    available,
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((e) => [e, settings.events[e] !== false]),
    ) as NotificationsView['events'],
    modes: { ...settings.modes },
  };
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  database: Pick<DatabaseManager, 'repositories'>,
  available: boolean,
): void {
  const auth = app.authService;
  const view = () => notificationsView(database.repositories.settings.get('notifications'), available);

  app.get('/api/settings/notifications', async () => view());

  app.post('/api/settings/notifications', async (req) => {
    const patch = parseBody(NotificationsPatch, req.body);
    const settings = database.repositories.settings;
    const before = notificationsView(settings.get('notifications'), available);
    const next: NotificationSettings = {
      events: { ...before.events, ...patch.events },
      modes: {
        live: patch.modes?.live ?? before.modes.live,
        dry_run: patch.modes?.dry_run ?? before.modes.dry_run,
      },
    };
    const after = notificationsView(next, available);
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const e of NOTIFICATION_EVENTS)
      if (before.events[e] !== after.events[e])
        changes[`events.${e}`] = { from: before.events[e], to: after.events[e] };
    for (const m of ['live', 'dry_run'] as const)
      if (before.modes[m] !== after.modes[m])
        changes[`modes.${m}`] = { from: before.modes[m], to: after.modes[m] };
    if (Object.keys(changes).length > 0) {
      settings.set('notifications', next);
      auth.audit(
        { actor: userActor(authOf(req).user.username), ...clientContext(req) },
        { action: 'settings_change', entity: 'settings', entityId: 'notifications', detail: changes },
      );
      req.log.info({ changes }, 'Notification settings changed');
    }
    return view();
  });
}
