import type { ReactNode } from 'react';
import type { LoopStatus, SwitchStates } from '../api';
import { formatUsd } from '../format';
import { WithTip } from './InfoTip';

type Tone = 'danger' | 'ok' | 'muted';

function Item({
  label,
  value,
  tone,
  testId,
  tip,
}: {
  label: string;
  value: string;
  tone?: Tone;
  testId?: string;
  tip: ReactNode;
}) {
  return (
    <div className={`status-item${tone ? ` status-item--${tone}` : ''}`} data-testid={testId}>
      <span className="status-label">
        <WithTip tip={tip}>{label}</WithTip>
      </span>
      <span className="status-value">{value}</span>
    </div>
  );
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB') : '—');

function loopItem(s: SwitchStates, loop: LoopStatus | null): { value: string; tone: Tone } {
  if (s.globalKillSwitch || loop?.state === 'paused')
    return { value: 'paused by kill switch', tone: 'danger' };
  switch (loop?.state) {
    case 'running':
      return { value: 'running', tone: 'ok' };
    case 'stale':
      return { value: 'stale', tone: 'danger' };
    case 'stopped':
      return { value: 'stopped', tone: 'danger' };
    case 'idle':
      return { value: 'idle (no games)', tone: 'muted' };
    default:
      return { value: 'starting', tone: 'muted' };
  }
}

/** The status strip as a pure view (rendered in tests without a live stream). */
export function StatusStripView({ switches: s, loop }: { switches: SwitchStates; loop: LoopStatus | null }) {
  const l = loopItem(s, loop);
  const feeds = (loop?.feeds ?? []).filter((f) => f.available && f.enabled);
  const failing = feeds.filter((f) => f.status === 'error');
  const balance = loop?.balance;
  const kalshi =
    balance?.cashMicros !== null && balance?.cashMicros !== undefined
      ? `${s.kalshiEnv} · ${formatUsd(balance.cashMicros)}`
      : `${s.kalshiEnv} · balance ${balance?.error ? 'unavailable' : '—'}`;
  return (
    <section className="status-strip" aria-label="Status">
      <Item
        label="Loop"
        value={l.value}
        tone={l.tone}
        testId="status-loop"
        tip="The trading loop that polls the score feeds and runs the strategies: running, idle (no game in progress or starting within the hour), paused by the kill switch, or stale / stopped (not ticking; the app restarts itself)."
      />
      <Item
        label="Last poll"
        value={time(loop?.lastPollAt ?? null)}
        testId="status-last-poll"
        tip="When the score feeds were last polled: every 5 s during a tracked game, every 60 s in the hour before one."
      />
      <div
        className={`status-item${failing.length > 0 ? ' status-item--danger' : feeds.length > 0 ? ' status-item--ok' : ''}`}
        data-testid="status-feeds"
      >
        <span className="status-label">
          <WithTip tip="The enabled score feeds and their state. Feeds are switched on and off in Settings → Feeds.">
            Feeds
          </WithTip>
        </span>
        <span className="status-value">
          {feeds.length === 0 ? 'none enabled' : failing.length === 0 ? 'OK' : `${failing.length} failing`}
        </span>
        <ul className="feed-states">
          {(loop?.feeds ?? []).map((f) => (
            <li
              key={f.id}
              data-testid={`feed-status-${f.id}`}
              className={`feed-state feed-state--${f.status}`}
            >
              {f.name}: {f.status}
            </li>
          ))}
        </ul>
      </div>
      <Item
        label="Kalshi"
        value={kalshi}
        testId="status-kalshi"
        tip="The Kalshi environment (demo = test money, prod = real money) and the cash balance of the subaccount."
      />
      <Item
        label="Kill switch"
        value={s.globalKillSwitch ? 'ON' : 'off'}
        tone={s.globalKillSwitch ? 'danger' : 'ok'}
        tip="Global kill switch (Settings → Trading). ON pauses everything: no feeds, no Kalshi requests, no orders."
      />
      <Item
        label="Global dry run"
        value={s.globalDryRun ? 'ON' : 'off'}
        tip="Settings → Trading. ON runs every strategy as dry run: real prices, simulated orders."
      />
      <Item
        label="Add-on live lock"
        value={s.allowLiveOrders ? 'live orders allowed' : 'locked (no live orders)'}
        tip="The allow_live_orders option in the app's Configuration tab in Home Assistant. While it is off, no real order can be sent whatever the other settings."
      />
    </section>
  );
}
