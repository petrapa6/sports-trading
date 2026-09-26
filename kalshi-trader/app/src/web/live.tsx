import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type GameView,
  type JobView,
  type LogEntry,
  type LoopStatus,
  type Signal,
  type Status,
  type SwitchStates,
} from './api';
import { endpoint } from './base';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'reconnected';

export interface LiveState {
  status: LiveStatus;
  switches: SwitchStates | null;
  logs: LogEntry[];
  lastHeartbeat: string | null;
  /** Tracked games (live game cards), pushed after every tracker update. */
  games: GameView[] | null;
  /** Loop state, last poll, feed status and Kalshi balance. */
  loop: LoopStatus | null;
  /** Recent strategy signals, newest last (T08). */
  signals: Signal[];
}

const KEEP_LOGS = 200;
const INITIAL: LiveState = {
  status: 'connecting',
  switches: null,
  logs: [],
  lastHeartbeat: null,
  games: null,
  loop: null,
  signals: [],
};
const KEEP_SIGNALS = 20;
const LiveContext = createContext<LiveState>(INITIAL);

/**
 * One `GET /api/live` stream for the signed-in app. `EventSource` reconnects by itself (the server
 * sends `retry: 2000`); when the browser gives up (a non-200 answer while the server restarts) a
 * new stream is opened after 3 s. After any interruption the status reads `reconnected`.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState>(INITIAL);
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let interrupted = false;
    let stopped = false;

    const onSwitches = (switches: SwitchStates) => {
      setState((s) => ({ ...s, switches }));
      queryClient.setQueryData<Status>(['status'], (old) => (old ? { ...old, ...switches } : old));
    };
    // Effective modes change with the switches and with every strategy change (possibly in another tab).
    const onStrategies = () => void queryClient.invalidateQueries({ queryKey: ['strategies'] });

    const connect = () => {
      const es = new EventSource(endpoint('api/live'));
      source = es;
      es.onopen = () => setState((s) => ({ ...s, status: interrupted ? 'reconnected' : 'connected' }));
      es.onerror = () => {
        interrupted = true;
        setState((s) => ({ ...s, status: 'reconnecting' }));
        if (es.readyState === EventSource.CLOSED && !stopped) {
          es.close();
          // A 401 here means the session is gone: this request lets the app redirect to the login page.
          void api.get('auth/me').catch(() => undefined);
          retryTimer = setTimeout(connect, 3000);
        }
      };
      es.addEventListener('switches', (e) => onSwitches(JSON.parse((e as MessageEvent<string>).data)));
      es.addEventListener('logs', (e) => {
        const logs = JSON.parse((e as MessageEvent<string>).data) as LogEntry[];
        setState((s) => ({ ...s, logs }));
      });
      es.addEventListener('log', (e) => {
        const line = JSON.parse((e as MessageEvent<string>).data) as LogEntry;
        setState((s) => ({ ...s, logs: [...s.logs, line].slice(-KEEP_LOGS) }));
      });
      es.addEventListener('games', (e) => {
        const { games } = JSON.parse((e as MessageEvent<string>).data) as { games: GameView[] };
        setState((s) => ({ ...s, games }));
      });
      es.addEventListener('strategies', onStrategies);
      // A trade changed (executor, settler): the Trades page and the bankroll follow.
      es.addEventListener('trade', () => {
        void queryClient.invalidateQueries({ queryKey: ['trades'] });
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
      });
      // A data job (Settings → Data, T11) changed: status and progress go straight into the cache.
      es.addEventListener('job', (e) => {
        const job = JSON.parse((e as MessageEvent<string>).data) as JobView;
        queryClient.setQueryData<{ jobs: JobView[] }>(['jobs'], (old) => {
          const jobs = old?.jobs ?? [];
          return {
            jobs: jobs.some((j) => j.id === job.id)
              ? jobs.map((j) => (j.id === job.id ? job : j))
              : [job, ...jobs],
          };
        });
        if (job.status === 'done' || job.status === 'cancelled' || job.status === 'failed')
          void queryClient.invalidateQueries({ queryKey: ['data-summary'] });
      });
      es.addEventListener('signals', (e) => {
        const { signals } = JSON.parse((e as MessageEvent<string>).data) as { signals: Signal[] };
        setState((s) => ({ ...s, signals }));
      });
      es.addEventListener('signal', (e) => {
        const signal = JSON.parse((e as MessageEvent<string>).data) as Signal;
        setState((s) => ({ ...s, signals: [...s.signals, signal].slice(-KEEP_SIGNALS) }));
      });
      es.addEventListener('loop', (e) => {
        const loop = JSON.parse((e as MessageEvent<string>).data) as LoopStatus;
        setState((s) => ({ ...s, loop }));
      });
      es.addEventListener('heartbeat', (e) => {
        const beat = JSON.parse((e as MessageEvent<string>).data) as {
          at: string;
          switches: SwitchStates | null;
        };
        setState((s) => ({ ...s, lastHeartbeat: beat.at }));
        if (beat.switches) onSwitches(beat.switches);
      });
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export const useLive = (): LiveState => useContext(LiveContext);

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  reconnecting: 'reconnecting…',
  reconnected: 'reconnected',
};

/** Small live-stream indicator for the header. */
export function LiveIndicator() {
  const { status } = useLive();
  return (
    <span className={`live-indicator live-indicator--${status}`} role="status" data-testid="live-status">
      <span className="live-dot" aria-hidden="true" />
      Live: {STATUS_TEXT[status]}
    </span>
  );
}
