import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type Status } from '../../api';
import { useStepUp } from '../../reauth';

type SwitchKey = 'global_kill_switch' | 'global_dry_run';

export function TradingSettings() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('api/status') });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = async (key: SwitchKey, value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await stepUp(() => api.post('api/settings', { [key]: value }));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Could not change the setting (${err.code}).`
          : 'Could not change the setting.',
      );
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['status'] });
    }
  };

  const s = status.data;
  if (!s) return <p className="muted">Loading…</p>;

  return (
    <section className="settings-section" aria-labelledby="trading-heading">
      <h2 id="trading-heading">Trading</h2>

      <div className={`switch-card kill${s.globalKillSwitch ? ' on' : ''}`}>
        <label className="switch big">
          <input
            type="checkbox"
            role="switch"
            aria-label="Global kill switch"
            checked={s.globalKillSwitch}
            disabled={busy}
            onChange={(e) => void change('global_kill_switch', e.target.checked)}
          />
          <span className="track" aria-hidden="true" />
          <span>
            <strong>Global kill switch</strong> — {s.globalKillSwitch ? 'ON: everything is paused' : 'off'}
          </span>
        </label>
        <p className="muted">
          Pauses everything: no score feeds, no Kalshi requests, no orders. Turning it off needs your
          password.
        </p>
      </div>

      <div className="switch-card">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Global dry run"
            checked={s.globalDryRun}
            disabled={busy}
            onChange={(e) => void change('global_dry_run', e.target.checked)}
          />
          <span className="track" aria-hidden="true" />
          <span>
            <strong>Global dry run</strong> — {s.globalDryRun ? 'ON: every strategy runs as dry run' : 'off'}
          </span>
        </label>
        <p className="muted">
          Feeds and Kalshi reads keep running; no real orders. Turning it off needs your password.
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h3>Set in Home Assistant</h3>
      <p className="muted">
        These are changed in the app's Configuration tab in Home Assistant (which restarts the app).
      </p>
      <dl className="readonly-list">
        <div className="readonly-item locked" data-testid="allow-live-orders" aria-readonly="true">
          <dt>
            <span aria-hidden="true">🔒 </span>
            <code>allow_live_orders</code>
          </dt>
          <dd>
            <code>allow_live_orders: {String(s.allowLiveOrders)}</code>{' '}
            <span className="muted">(read-only{s.allowLiveOrders ? '' : '; no real order can be sent'})</span>
          </dd>
        </div>
        <div className="readonly-item" aria-readonly="true">
          <dt>Kalshi environment</dt>
          <dd>
            <code>{s.kalshiEnv}</code>
          </dd>
        </div>
        <div className="readonly-item" aria-readonly="true">
          <dt>Kalshi subaccount</dt>
          <dd>
            <code>{s.kalshiSubaccount === 0 ? '0 (primary)' : s.kalshiSubaccount}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}
