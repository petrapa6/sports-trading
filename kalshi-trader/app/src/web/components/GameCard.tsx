import type { GameView } from '../api';
import { ModeBadge } from './ModeBadge';

const pad = (n: number) => String(n).padStart(2, '0');

/** The phase / clock line of a card: `Final`, `HT`, `Intermission`, `P2 12:34`, `78'`, `Starts 19:00`. */
export function phaseLabel(g: GameView): string {
  switch (g.phase) {
    case 'finished':
      return 'Final';
    case 'halftime':
      return 'HT';
    case 'intermission':
      return g.clock.period ? `Intermission after P${g.clock.period}` : 'Intermission';
    case 'postponed':
      return 'Postponed';
    case 'scheduled':
      return `Starts ${new Date(g.scheduledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    default: {
      if (g.sport === 'hockey' && g.clock.period !== undefined) {
        const p = g.clock.period >= 4 ? 'OT' : `P${g.clock.period}`;
        const left = g.clock.secondsLeftInPeriod;
        return left !== undefined ? `${p} ${pad(Math.floor(left / 60))}:${pad(left % 60)}` : p;
      }
      return g.clock.minute !== undefined ? `${g.clock.minute}'` : 'Live';
    }
  }
}

export function GameCard({ game: g }: { game: GameView }) {
  const inPlay = g.phase === 'live' || g.phase === 'halftime' || g.phase === 'intermission';
  return (
    <li className={`game-card game-card--${g.phase}`} data-testid={`game-card-${g.id}`}>
      <div className="game-card-head">
        <span className="muted">{g.leagueId.toUpperCase()}</span>
        <span className="game-phase" data-testid="game-phase">
          {phaseLabel(g)}
        </span>
      </div>
      <div className="game-teams">
        <div className="game-team">
          <span className="game-team-name">{g.homeTeam}</span>
          <span className="game-score" data-testid="home-score">
            {g.homeScore ?? '–'}
          </span>
        </div>
        <div className="game-team">
          <span className="game-team-name">{g.awayTeam}</span>
          <span className="game-score" data-testid="away-score">
            {g.awayScore ?? '–'}
          </span>
        </div>
      </div>
      <div className="game-meta">
        {inPlay && g.clock.minute !== undefined && (
          <span data-testid="game-minute">
            Minute {g.clock.minute}
            {g.clock.minuteSource === 'derived' && (
              <span className="derived-marker" title="Derived from the observed kick-off (±1 min)">
                {' '}
                derived
              </span>
            )}
          </span>
        )}
        {g.blocked && (
          <span className="error" title="The score feeds disagree; entries are blocked">
            feeds disagree — blocked
          </span>
        )}
      </div>
      <div className="game-strategies">
        {g.strategies.length === 0 ? (
          <span className="muted">No strategies armed</span>
        ) : (
          g.strategies.map((s) => (
            <span key={s.id} className="game-strategy">
              {s.name} <ModeBadge effective={s.effectiveMode} />
            </span>
          ))
        )}
      </div>
    </li>
  );
}
