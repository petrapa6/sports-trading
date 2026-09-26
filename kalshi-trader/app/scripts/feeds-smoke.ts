/**
 * `npm run feeds:smoke` (SPEC.md §14 T07) — reads today's games from the real NHL Web API
 * (`/v1/score/now`, no key) and prints one line per game, or `no games today`; exits 0. A failure to
 * reach the API prints the error and exits 1. `NHL_SCRIPT_BASE_URL` points it at a stand-in.
 */
import { pino } from 'pino';
import { createNetworkGate } from '../src/feeds/network.js';
import { NhlFeed } from '../src/feeds/nhl/feed.js';

const baseUrl = process.env['NHL_SCRIPT_BASE_URL'];
const feed = new NhlFeed({
  gate: createNetworkGate(() => false),
  log: pino({ level: 'silent' }),
  games: () => [],
  ...(baseUrl ? { baseUrl } : {}),
});

try {
  const games = await feed.scoreNow();
  if (games.length === 0) {
    console.log('no games today');
  } else {
    console.log(`${games.length} NHL game(s) today:`);
    for (const g of games) {
      const score =
        g.homeTeam.score !== null && g.homeTeam.score !== undefined
          ? ` ${g.awayTeam.score ?? 0}-${g.homeTeam.score}`
          : '';
      const clock = g.clock?.timeRemaining && g.period ? ` P${g.period} ${g.clock.timeRemaining}` : '';
      console.log(
        `  ${g.id}  ${g.awayTeam.abbrev} @ ${g.homeTeam.abbrev}  ${g.gameState}${score}${clock}  ${g.startTimeUTC ?? ''}`,
      );
    }
  }
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
  process.exit(1);
}
