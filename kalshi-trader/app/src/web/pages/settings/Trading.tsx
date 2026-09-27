import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type OrderGroupStatus, type PublicSettings, type Status } from '../../api';
import { InfoTip, LabelTip, TitleTip, WithTip } from '../../components/InfoTip';
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
        <InfoTip>
          The emergency stop. On pauses everything: no score feeds, no Kalshi requests, no orders, no
          notifications, and data jobs wait. Turning it off needs your password.
        </InfoTip>
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
        <InfoTip>
          On runs every strategy as dry run, even those set to live: feeds and Kalshi prices keep running, but
          orders are only simulated. Turning it off needs your password.
        </InfoTip>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <DryRunBankroll />

      <OrderGroup />

      <TitleTip
        title="Set in Home Assistant"
        tip="Read-only here: these are changed in the app's Configuration tab in Home Assistant (which restarts the app)."
      />
      <dl className="readonly-list">
        <div className="readonly-item locked" data-testid="allow-live-orders" aria-readonly="true">
          <dt>
            <WithTip tip="The master lock for real money. While false, no real order can be sent: strategies set to live run as dry run (LIVE → DRY RUN (add-on lock)).">
              <span aria-hidden="true">🔒 </span>
              <code>allow_live_orders</code>
            </WithTip>
          </dt>
          <dd>
            <code>allow_live_orders: {String(s.allowLiveOrders)}</code>{' '}
            <span className="muted">(read-only{s.allowLiveOrders ? '' : '; no real order can be sent'})</span>
          </dd>
        </div>
        <div className="readonly-item" aria-readonly="true">
          <dt>
            <WithTip tip="demo = Kalshi's test exchange with play money; prod = the real exchange.">
              Kalshi environment
            </WithTip>
          </dt>
          <dd>
            <code>{s.kalshiEnv}</code>
          </dd>
        </div>
        <div className="readonly-item" aria-readonly="true">
          <dt>
            <WithTip tip="The Kalshi subaccount whose balance live strategies trade with (0 = the primary account).">
              Kalshi subaccount
            </WithTip>
          </dt>
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
      <TitleTip
        id="bankroll-heading"
        title="Dry-run bankroll"
        tip="One virtual bankroll shared by every dry-run trade: debited by cost + fee at each virtual fill, credited with the payout at settlement. Dry-run stakes are a percentage of it."
      />
      <dl className="kv">
        <dt>
          <WithTip tip="The bankroll now, after all dry-run fills and settlements so far.">Current</WithTip>
        </dt>
        <dd data-testid="bankroll-current">{formatUsd(s.dry_run_bankroll_micros)}</dd>
        <dt>
          <WithTip tip="What Reset bankroll restores the bankroll to.">Initial</WithTip>
        </dt>
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
          <LabelTip
            htmlFor="bankroll-initial-input"
            label="Initial bankroll ($)"
            tip="The starting amount; saving it does not change the current bankroll until you reset it."
          />
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
          title="Set the current bankroll back to the initial amount (asks for your password)"
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
        <LabelTip
          htmlFor="fee-precision"
          label="Fee precision"
          tip="A dry-run fill's cost + fee is rounded up to this amount. $0.0001 matches Kalshi's balance precision; $0.01 makes dry runs slightly more conservative."
        />
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
      </div>
      {message && (
        <p className={message.ok ? 'success' : 'error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}

const GROUP_STATE: Record<OrderGroupStatus['state'], string> = {
  disabled: 'Not used: live orders are disabled (allow_live_orders is off or Kalshi is not configured)',
  unknown: 'Not checked yet',
  active: 'Active',
  limit_hit: 'Limit hit: live orders are rejected until the group is reset',
  error: 'Unavailable',
};

/** Settings → Trading: the Kalshi order group (SPEC.md §10 Blast radius) — status, contract limit, reset (step-up). */
function OrderGroup() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const group = useQuery({
    queryKey: ['order-group'],
    queryFn: () => api.get<OrderGroupStatus>('api/settings/order-group'),
  });
  const [limit, setLimit] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const g = group.data;
  if (!g) return null;

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
      await queryClient.invalidateQueries({ queryKey: ['order-group'] });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    }
  };
  const limitText = limit ?? String(g.contractsLimit);
  const limitValue = /^\d{1,7}$/.test(limitText.trim()) ? Number.parseInt(limitText.trim(), 10) : null;

  return (
    <section aria-labelledby="order-group-heading">
      <TitleTip
        id="order-group-heading"
        title="Order group"
        tip="An exchange-side brake on live orders: Kalshi rejects further orders once the contract limit was matched within a rolling 15 seconds, until the group is reset here."
      />
      <dl className="kv">
        <dt>Status</dt>
        <dd data-testid="order-group-state" className={g.state === 'limit_hit' ? 'error' : undefined}>
          {GROUP_STATE[g.state]}
        </dd>
        <dt>
          <WithTip tip="Kalshi's id of the order group the app created at start-up; every live order carries it.">
            Group id
          </WithTip>
        </dt>
        <dd>
          <code>{g.id ?? '—'}</code>
        </dd>
        {g.lastError && (
          <>
            <dt>Last error</dt>
            <dd className="error">{g.lastError}</dd>
          </>
        )}
      </dl>
      <form
        className="bankroll-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (limitValue === null || limitValue < 1) return;
          void run(
            () => api.post('api/settings', { order_group_contract_limit: limitValue }),
            'Contract limit saved; it applies when a new group is created.',
          ).then(() => setLimit(null));
        }}
      >
        <div className="field">
          <LabelTip
            htmlFor="order-group-limit"
            label="Contract limit (per 15 s)"
            tip="Most contracts that may be matched within a rolling 15 seconds. A changed limit applies to the next group created (after a reset or restart)."
          />
          <input
            id="order-group-limit"
            inputMode="numeric"
            value={limitText}
            aria-invalid={limitValue === null || limitValue < 1 ? true : undefined}
            onChange={(e) => setLimit(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="secondary small"
          disabled={busy || limitValue === null || limitValue < 1}
        >
          Save limit
        </button>
        <button
          type="button"
          className="secondary small danger"
          disabled={busy || !g.enabled}
          title="Re-enable live orders after the limit was hit (asks for your password)"
          onClick={() => {
            if (!window.confirm('Reset the Kalshi order group so live orders can be placed again?')) return;
            void run(() => stepUp(() => api.post('api/settings/order-group/reset')), 'Order group reset.');
          }}
        >
          Reset order group
        </button>
      </form>
      {message && (
        <p className={message.ok ? 'success' : 'error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
