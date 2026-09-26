import type { RuleState } from '../core/engine.js';
import type { GoalEvent } from '../core/tracker.js';
import type { Sport } from '../feeds/gameState.js';

/**
 * Synthetic game clock of the backtester (SPEC.md §9 Algorithm, step 1): a minute-by-minute timeline built
 * from `hist_games.goal_events`, turned into the same `RuleState` the live tracker hands the engine, and the
 * mapping from a game minute to the wall-clock minute of a Kalshi 1-minute candle (`hist_prices.minute_ts`).
 *
 * - Soccer: match minutes 1–90 (a goal recorded at `90` or later counts at 90, as stoppage does live).
 * - Hockey: elapsed minutes 1–59, `period` and `secondsLeftInPeriod` derived so that `ruleMinute()` returns
 *   the same minute the live NHL clock would.
 * - A goal at minute `m` is part of the score from tick `m` on (the live feeds report the new score within
 *   the minute the goal was scored in, and the rule minute is floored).
 */

/**
 * The last tick of a game: soccer 90 (stoppage counts as 90), hockey 59 (at 60:00 regulation is over, and
 * overtime goals are recorded at minute ≥ 60).
 */
export const LAST_MINUTE: Record<Sport, number> = { soccer: 90, hockey: 59 };

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

/**
 * The first wall minute `e` (whole minutes after the scheduled start) at which T11's clock model
 * (`matchMinute` in `priceModel.ts`, the same model the price-model builder uses to place candles) reads
 * game minute `minute`: soccer `e = minute` in the first half and `minute + 17` in the second (after the
 * 15-minute break and 2 minutes of first-half stoppage); hockey three 36-minute periods separated by
 * 18-minute intermissions, `e = 54 × period index + ceil(minute in period × 36 / 20)`.
 */
export function wallMinuteOf(sport: Sport, minute: number): number {
  if (sport === 'hockey') {
    const p = Math.min(2, Math.floor(minute / 20));
    return p * 54 + Math.ceil(((minute - p * 20) * 36) / 20);
  }
  return minute <= 45 ? minute : minute + 17;
}

/** Wall minute of a candle: `floor((minute_ts − start) / 1 min)`, as the price-model builder computes it. */
export const wallMinuteAt = (startMs: number, candleMs: number): number =>
  Math.floor((candleMs - startMs) / MINUTE_MS);

/** The candle time (`hist_prices.minute_ts`) that stands for game minute `minute` of a game starting at `startMs`. */
export function candleMinuteMs(sport: Sport, startMs: number, minute: number): number {
  return startMs + wallMinuteOf(sport, minute) * MINUTE_MS;
}
