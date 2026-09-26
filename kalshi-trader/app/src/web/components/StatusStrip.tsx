import { useQuery } from '@tanstack/react-query';
import { api, type LoopStatus, type Status } from '../api';
import { useLive } from '../live';
import { StatusStripView } from './StatusStripView';

/** Dashboard status strip: loop state, last poll, feeds, Kalshi env + balance, the three switches (SPEC.md §8). */
export function StatusStrip() {
  const live = useLive();
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('api/status') });
  const loop = useQuery({
    queryKey: ['loop'],
    queryFn: () => api.get<LoopStatus | null>('api/loop'),
    enabled: live.loop === null,
  });
  const s = live.switches ?? status.data;
  if (!s) return <section className="status-strip" aria-label="Status" />;
  return <StatusStripView switches={s} loop={live.loop ?? loop.data ?? null} />;
}
