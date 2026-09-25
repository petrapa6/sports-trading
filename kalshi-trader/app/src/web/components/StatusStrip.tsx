import { useQuery } from '@tanstack/react-query';
import { api, type Status } from '../api';
import { useLive } from '../live';

function Item({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'ok' | 'muted' }) {
  return (
    <div className={`status-item${tone ? ` status-item--${tone}` : ''}`}>
      <span className="status-label">{label}</span>
      <span className="status-value">{value}</span>
    </div>
  );
}

/** Dashboard status strip: loop state and the three global controls (SPEC.md §8). */
export function StatusStrip() {
  const live = useLive();
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('api/status') });
  const s = live.switches ?? status.data;
  if (!s) return <section className="status-strip" aria-label="Status" />;
  return (
    <section className="status-strip" aria-label="Status">
      <Item
        label="Loop"
        value={s.globalKillSwitch ? 'paused by kill switch' : 'idle'}
        tone={s.globalKillSwitch ? 'danger' : 'muted'}
      />
      <Item
        label="Kill switch"
        value={s.globalKillSwitch ? 'ON' : 'off'}
        tone={s.globalKillSwitch ? 'danger' : 'ok'}
      />
      <Item label="Global dry run" value={s.globalDryRun ? 'ON' : 'off'} />
      <Item
        label="Add-on live lock"
        value={s.allowLiveOrders ? 'live orders allowed' : 'locked (no live orders)'}
      />
      <Item label="Kalshi" value={s.kalshiEnv} />
    </section>
  );
}
