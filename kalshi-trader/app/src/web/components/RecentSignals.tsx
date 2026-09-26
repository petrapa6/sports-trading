import { useLive } from '../live';
import { ModeBadge } from './ModeBadge';

/**
 * The most recent strategy signals (SSE `signals` / `signal`, T08): which strategy matched which game, at
 * which score and minute, for which market, and in which mode. Nothing acts on them until the executor (T09).
 */
export function RecentSignals() {
  const { signals } = useLive();
  return (
    <section className="card" aria-labelledby="signals-heading">
      <h2 id="signals-heading">Recent signals</h2>
      {signals.length === 0 ? (
        <p className="muted" data-testid="no-signals">
          No strategy has matched a game yet.
        </p>
      ) : (
        <ul className="signal-list" data-testid="signal-list">
          {[...signals].reverse().map((s) => (
            <li key={`${s.strategyId}-${s.gameId}`} data-testid={`signal-${s.strategyId}-${s.gameId}`}>
              <ModeBadge effective={s.effectiveMode} configured={s.configuredMode} reason={s.modeReason} />{' '}
              <strong>{s.strategyName}</strong> v{s.version} —{' '}
              {s.side === 'home' ? s.snapshot.homeTeam : s.snapshot.awayTeam} leads {s.snapshot.homeScore}-
              {s.snapshot.awayScore} at minute {s.minute}
              {s.snapshot.clock.minuteSource === 'derived' ? ' (derived)' : ''}{' '}
              <span className="muted">
                {s.marketTicker ?? 'no market'} · {new Date(s.at).toLocaleTimeString('en-GB')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
