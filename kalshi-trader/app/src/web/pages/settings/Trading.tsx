import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type PublicSettings, type Status } from '../../api';
import { formatUsd } from '../../format';
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

      <DryRunBankroll />

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

/** Dollars typed by the user (at most 2 decimals) as micro-dollars, or `null` when not a valid amount. */
function usdToMicros(text: string): number | null {
  const m = /^\s*(\d{1,8})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return (
    Number.parseInt(m[1] ?? '0', 10) * 1_000_000 + Number.parseInt((m[2] ?? '').padEnd(2, '0'), 10) * 10_000
  );
}

const PRECISIONS = [
  { value: 100, label: '$0.0001 (Kalshi balance precision, default)' },
  { value: 10_000, label: '$0.01 (whole cents, conservative)' },
];

/** Settings → Trading: the shared dry-run bankroll (current, initial, reset with step-up) and fee precision. */
function DryRunBankroll() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<PublicSettings>('api/settings'),
  });
  const [initial, setInitial] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const s = settings.data;
  if (!s) return null;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: ok });
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof ApiError ? `The request failed (${err.code}).` : 'The request failed.',
      });
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    }
  };

  const initialText = initial ?? String(s.dry_run_initial_bankroll_micros / 1_000_000);
  const initialMicros = usdToMicros(initialText);

  return (
    <section aria-labelledby="bankroll-heading">
      <h3 id="bankroll-heading">Dry-run bankroll</h3>
      <p className="muted">
        One virtual bankroll shared by every dry-run trade: debited by cost + fee at each virtual fill,
        credited with the payout at settlement.
      </p>
      <dl className="kv">
        <dt>Current</dt>
        <dd data-testid="bankroll-current">{formatUsd(s.dry_run_bankroll_micros)}</dd>
        <dt>Initial</dt>
        <dd data-testid="bankroll-initial">{formatUsd(s.dry_run_initial_bankroll_micros)}</dd>
      </dl>
      <form
        className="bankroll-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (initialMicros === null) return;
          void run(
            () => api.post('api/settings', { dry_run_initial_bankroll_micros: initialMicros }),
            'Initial bankroll saved.',
          ).then(() => setInitial(null));
        }}
      >
        <div className="field">
          <label htmlFor="bankroll-initial-input">Initial bankroll ($)</label>
          <input
            id="bankroll-initial-input"
            inputMode="decimal"
            value={initialText}
            aria-invalid={initialMicros === null ? true : undefined}
            onChange={(e) => setInitial(e.target.value)}
          />
        </div>
        <button type="submit" className="secondary small" disabled={busy || initialMicros === null}>
          Save initial
        </button>
        <button
          type="button"
          className="secondary small danger"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `Reset the dry-run bankroll to ${formatUsd(s.dry_run_initial_bankroll_micros)}?`,
              )
            )
              return;
            void run(() => stepUp(() => api.post('api/settings/bankroll/reset')), 'Bankroll reset.');
          }}
        >
          Reset bankroll
        </button>
      </form>

      <div className="field">
        <label htmlFor="fee-precision">Fee precision</label>
        <select
          id="fee-precision"
          value={s.fee_balance_precision_micros}
          disabled={busy}
          onChange={(e) =>
            void run(
              () => api.post('api/settings', { fee_balance_precision_micros: Number(e.target.value) }),
              'Fee precision saved.',
            )
          }
        >
          {[
            ...PRECISIONS,
            ...(PRECISIONS.some((p) => p.value === s.fee_balance_precision_micros)
              ? []
              : [
                  {
                    value: s.fee_balance_precision_micros,
                    label: `${s.fee_balance_precision_micros} micro-dollars`,
                  },
                ]),
          ].map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="hint">Position cost + fee is rounded up to this amount (SPEC §2 Fees).</span>
      </div>
      {message && (
        <p className={message.ok ? 'success' : 'error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
