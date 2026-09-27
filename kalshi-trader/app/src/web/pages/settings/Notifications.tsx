import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  kalshiErrorMessage,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationSettings,
} from '../../api';

const EVENT_LABEL: Record<NotificationEvent, string> = {
  trade_filled: 'Trade filled',
  trade_settled: 'Trade settled',
  kill_switch_changed: 'Global kill switch changed',
  global_dry_run_changed: 'Global dry run changed',
  feed_disagreement: 'Feed disagreement (entries blocked)',
};

/**
 * Settings → Notifications (T15): Home Assistant notifications per event and per mode. A notification is
 * sent only when both its event and its mode are on; every message starts with `[LIVE]` or `[DRY RUN]`.
 */
export function NotificationsSettings() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationSettings>('api/settings/notifications'),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(
        ['notifications'],
        await api.post<NotificationSettings>('api/settings/notifications', body),
      );
    } catch (err) {
      setError(kalshiErrorMessage(err));
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } finally {
      setBusy(false);
    }
  };

  const s = q.data;
  const toggle = (id: string, label: string, checked: boolean, onChange: (on: boolean) => void) => (
    <li key={id} className="league-card" data-testid={`notify-${id}`}>
      <div className="league-head">
        <strong>{label}</strong>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`${label} notifications`}
            checked={checked}
            disabled={busy}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="track" aria-hidden="true" />
          <span>{checked ? 'On' : 'Off'}</span>
        </label>
      </div>
    </li>
  );

  return (
    <section className="settings-section" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <p className="muted">
        Home Assistant persistent notifications through the Supervisor. Every message states its mode (
        <code>[LIVE]</code> / <code>[DRY RUN]</code>) and the Kalshi environment. While the global kill switch
        is on nothing is sent.
      </p>
      {!s && <p className="muted">Loading…</p>}
      {s && !s.available && (
        <p className="muted" data-testid="notifications-unavailable">
          Not running inside Home Assistant (no Supervisor token): nothing is sent, but the settings are kept.
        </p>
      )}
      {s && (
        <>
          <h3>Modes</h3>
          <ul className="league-list">
            {toggle(
              'mode-live',
              'Live trades and events',
              s.modes.live,
              (on) => void change({ modes: { live: on } }),
            )}
            {toggle(
              'mode-dry_run',
              'Dry-run trades and events',
              s.modes.dry_run,
              (on) => void change({ modes: { dry_run: on } }),
            )}
          </ul>
          <h3>Events</h3>
          <ul className="league-list">
            {NOTIFICATION_EVENTS.map((e) =>
              toggle(e, EVENT_LABEL[e], s.events[e], (on) => void change({ events: { [e]: on } })),
            )}
          </ul>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
