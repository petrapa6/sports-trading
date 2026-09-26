import { useQuery } from '@tanstack/react-query';
import { api, type GameView } from '../api';
import { useLive } from '../live';
import { GameCard } from './GameCard';

/** Live game cards (SPEC.md §8 Dashboard): pushed over `/api/live`, first loaded from `/api/games`. */
export function GameCards() {
  const live = useLive();
  const initial = useQuery({
    queryKey: ['games'],
    queryFn: () => api.get<{ games: GameView[] }>('api/games'),
    enabled: live.games === null,
  });
  const games = live.games ?? initial.data?.games ?? [];
  return (
    <section className="card" aria-labelledby="games-heading">
      <h2 id="games-heading">Live games</h2>
      {games.length === 0 ? (
        <p className="muted" data-testid="no-games">
          No games in progress or starting within the hour.
        </p>
      ) : (
        <ul className="game-cards">
          {games.map((g) => (
            <GameCard key={g.id} game={g} />
          ))}
        </ul>
      )}
    </section>
  );
}
