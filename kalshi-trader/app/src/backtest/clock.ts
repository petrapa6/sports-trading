import type { RuleState } from '../core/engine.js';
import type { GoalEvent } from '../core/tracker.js';
import type { Sport } from '../feeds/gameState.js';

/**
 * Synthetic game clock of the backtester (SPEC.md §9 Algorithm, step 1): a minute-by-minute timeline built
 * from `hist_games.goal_events`, turned into the same `RuleState` the live tracker hands the engine, and the
 * mapping from a game minute to the wall-clock minute of a Kalshi 1-minute candle (`hist_prices.minute_ts`).
 *
 * - Soccer: match minutes 1–90 (a goal recorded at `90` or later counts at 90, as stoppage does live).
 * - Hockey: elapsed minutes 1–60, `period` and `secondsLeftInPeriod` derived so that `ruleMinute()` returns
 *   the same minute the live NHL clock would.
 * - A goal at minute `m` is part of the score from tick `m` on (the live feeds report the new score within
 *   the minute the goal was scored in, and the rule minute is floored).
 */

/** The last tick of a game: soccer 90, hockey 60 (regulation). */
export const LAST_MINUTE: Record<Sport, number> = { soccer: 90, hockey: 60 };

/** Score after every goal with `minute ≤ m`. */
export function scoreAt(goals: readonly GoalEvent[], minute: number): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const g of goals) {
    if (g.minute > minute) continue;
    if (g.side === 'home') home++;
    else away++;
  }
  return { home, away };
}

/** The rule's view of the game at tick `minute` (always `live`, never blocked: feeds cannot disagree here). */
export function stateAt(sport: Sport, goals: readonly GoalEvent[], minute: number): RuleState {
  const { home, away } = scoreAt(goals, minute);
  if (sport === 'hockey') {
    const period = Math.min(3, Math.floor(minute / 20) + 1);
    const secondsLeftInPeriod = 1200 - (minute - (period - 1) * 20) * 60;
    return {
      phase: 'live',
      homeScore: home,
      awayScore: away,
      blocked: false,
      clock: { minute, minuteSource: 'feed', period, secondsLeftInPeriod, regulationOver: false },
    };
  }
  return {
    phase: 'live',
    homeScore: home,
    awayScore: away,
    blocked: false,
    clock: { minute, minuteSource: 'feed', period: minute > 45 ? 2 : 1, regulationOver: false },
  };
}

const MINUTE_MS = 60_000;
/** Soccer: first-half stoppage allowance plus the 15-minute break, when the second half start is unknown. */
export const SOCCER_BREAK_MIN = 17;
/** Hockey: wall-clock minutes of one 20-minute period (stoppages included) and of an intermission. */
export const HOCKEY_PERIOD_WALL_MIN = 37;
export const HOCKEY_INTERMISSION_MIN = 18;

/** The start of the UTC minute containing `ms`. */
export const floorMinute = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * The wall-clock minute (epoch ms, start of the minute) whose candle stands for game minute `minute`:
 *
 * - soccer: kick-off + `minute` for the first half; for the second half the observed second-half start (live
 *   games archived by the tracker) + `minute − 45`, else kick-off + `minute` + 17 (stoppage + break);
 * - hockey: kick-off + 55 min per completed period (37 of play incl. stoppages + an 18-minute intermission) +
 *   the elapsed minutes of the current period scaled by 37 / 20.
 *
 * The same function positions the orderbook in the parity test, so live replay and simulator read one candle.
 */
export function candleMinuteMs(
  sport: Sport,
  kickoffMs: number,
  minute: number,
  secondHalfMs: number | null = null,
): number {
  if (sport === 'hockey') {
    const period = Math.min(3, Math.floor(minute / 20) + 1);
    const inPeriod = minute - (period - 1) * 20;
    const wall =
      (period - 1) * (HOCKEY_PERIOD_WALL_MIN + HOCKEY_INTERMISSION_MIN) +
      Math.floor((inPeriod * HOCKEY_PERIOD_WALL_MIN) / 20);
    return floorMinute(kickoffMs) + wall * MINUTE_MS;
  }
  if (minute <= 45) return floorMinute(kickoffMs) + minute * MINUTE_MS;
  if (secondHalfMs !== null) return floorMinute(secondHalfMs) + (minute - 45) * MINUTE_MS;
  return floorMinute(kickoffMs) + (minute + SOCCER_BREAK_MIN) * MINUTE_MS;
}
