import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { Market } from '../db/schema.js';
import type { GameTracker } from './tracker.js';

/**
 * Kick-off prices (SPEC.md §5 `underdogOnly`): when a game goes from `scheduled` to `live`, the YES ask
 * of its home and away markets is read (`GET /markets/{ticker}`, through the network gate like every Kalshi
 * call) and stored in `games.pregame_home_bp` / `pregame_away_bp`. When Kalshi cannot be asked (no
 * credentials, kill switch, error) the last ask discovery or settlement stored in `markets.yes_ask_bp` is
 * used. The pre-game favourite is the market with the higher YES ask; values are written once per game.
 */

export interface PregameKalshi {
  getMarket(ticker: string): Promise<{ yes_ask_bp: number | null }>;
}

export interface PregameRecorderOptions {
  repos: () => Repositories;
  log: Logger;
  kalshi: () => PregameKalshi | undefined;
  now?: () => number;
}

export class PregameRecorder {
  private readonly log: Logger;
  private readonly now: () => number;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PregameRecorderOptions) {
    this.log = options.log.child({ component: 'pregame' });
    this.now = options.now ?? (() => Date.now());
  }

  /** Records the kick-off asks on every `scheduled → live` change. */
  attach(tracker: Pick<GameTracker, 'on'>): this {
    tracker.on('phaseChanged', (c) => {
      if (c.from === 'scheduled' && c.to === 'live') {
        this.pending = Promise.all([this.pending, this.record(c.gameId)]);
      }
    });
    return this;
  }

  /** Resolves once every recording started so far has finished (tests). */
  idle(): Promise<unknown> {
    return this.pending;
  }

  private async ask(market: Market | undefined): Promise<number | null> {
    if (!market) return null;
    try {
      const kalshi = this.options.kalshi();
      if (kalshi) {
        const live = await kalshi.getMarket(market.ticker);
        if (live.yes_ask_bp !== null) return live.yes_ask_bp;
      }
    } catch (err) {
      this.log.debug(
        { ticker: market.ticker, err: { message: (err as Error).message } },
        'Kick-off ask not read from Kalshi; using the stored one',
      );
    }
    return market.yes_ask_bp;
  }

  /** Reads and stores the kick-off asks of a game (once); returns them, or `null` when already stored. */
  async record(gameId: string): Promise<{ homeBp: number | null; awayBp: number | null } | null> {
    try {
      const repos = this.options.repos();
      const game = repos.games.get({ id: gameId });
      if (!game || game.pregame_home_bp !== null || game.pregame_away_bp !== null) return null;
      const markets = repos.markets.listByGame(gameId);
      const [homeBp, awayBp] = await Promise.all([
        this.ask(markets.find((m) => m.outcome === 'home')),
        this.ask(markets.find((m) => m.outcome === 'away')),
      ]);
      const current = this.options.repos();
      const again = current.games.get({ id: gameId });
      if (!again || again.pregame_home_bp !== null || again.pregame_away_bp !== null) return null;
      current.games.update(
        { id: gameId },
        {
          pregame_home_bp: homeBp,
          pregame_away_bp: awayBp,
          updated_at: new Date(this.now()).toISOString(),
        },
      );
      this.log.info({ gameId, homeBp, awayBp }, `Kick-off YES asks of ${gameId} recorded`);
      return { homeBp, awayBp };
    } catch (err) {
      this.log.warn({ gameId, err: { message: (err as Error).message } }, 'Kick-off asks not recorded');
      return null;
    }
  }
}
