import type { GameStats } from '../feeds/kalshi/schemas.js';
import type { GoalEvent } from '../core/tracker.js';

/**
 * Goal timelines from Kalshi `GET /live_data/milestone/{id}/game_stats` (SPEC.md §3 Historical, T11).
 * Payload shapes seen on production on 2026-09-26 (recorded in docs/verification/T11.md):
 *
 * - `pbp.periods[]` (not necessarily in order) with `period_number`, `period_type`, and `events[]`
 *   **newest first**. Every event carries the running score `home_points` / `away_points` after it.
 * - Soccer (`type: "soccer_event"`): `clock` is the match clock (`"62:25"`, `"90+1"`), `match_time` the
 *   displayed minute (`63`, `90`), `event_type` e.g. `score_change` / `possible_goal`.
 * - Hockey (`type: "hockey_play"`): `clock` is the time **remaining** in the period (`"00:22"`, `"2:16"`),
 *   `description` e.g. `"Goal scored by …"`, `attribution` the team id.
 *
 * A goal is a rise of `home_points` / `away_points` between consecutive events in time order (so a
 * VAR-cancelled `possible_goal` never counts, and an own goal counts for the side it was credited to);
 * a fall removes that side's last goal. Soccer goals get `minute = match_time` (stoppage counts as 45 /
 * 90, like the live feed and the CSV importer) and the clock's seconds; hockey goals the elapsed game
 * time from the period number and the remaining clock (overtime: 5-minute periods unless the clock shows
 * more). Shootout periods are ignored for goals. The goal events must add up to the final score (the
 * shootout winner's extra goal aside), otherwise the game is rejected with `PbpUnusable`.
 */

export class PbpUnusable extends Error {
  override name = 'PbpUnusable';
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `"62:25"` → 3745 s; `"90+1"` → base 90, stoppage 1 min; else `undefined`. */
function parseSoccerClock(clock: string): { half: 1 | 2; seconds: number; second: number } | undefined {
  const plus = /^(\d{1,3})\+(\d{1,2})$/.exec(clock.trim());
  if (plus) {
    const base = Number.parseInt(plus[1] as string, 10);
    const extra = Number.parseInt(plus[2] as string, 10);
    return { half: base <= 45 ? 1 : 2, seconds: (base + extra) * 60, second: 0 };
  }
  const mm = /^(\d{1,3}):(\d{2})$/.exec(clock.trim());
  if (!mm) return undefined;
  const m = Number.parseInt(mm[1] as string, 10);
  const s = Number.parseInt(mm[2] as string, 10);
  return { half: m < 45 ? 1 : 2, seconds: m * 60 + s, second: s };
}

function parseRemaining(clock: string): number | undefined {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!mm) return undefined;
  return Number.parseInt(mm[1] as string, 10) * 60 + Number.parseInt(mm[2] as string, 10);
}

const isShootout = (period: Json): boolean => /shoot|^so$/i.test(str(period['period_type']));

interface TimedEvent {
  /** Sort key (half / period, seconds). */
  a: number;
  b: number;
  /** Original position, newest first → larger is older. */
  order: number;
  home: number;
  away: number;
  at: Omit<GoalEvent, 'side'> | undefined;
  shootout: boolean;
}

export interface PbpTimeline {
  goals: GoalEvent[];
  finalHome: number;
  finalAway: number;
}

/** Parses a `game_stats` payload; throws `PbpUnusable` with the reason when it has no usable goal timeline. */
export function timelineFromGameStats(stats: GameStats, sport: 'soccer' | 'hockey'): PbpTimeline {
  const periods = (stats.pbp?.periods ?? []) as Json[];
  if (periods.length === 0) throw new PbpUnusable('the payload has no play-by-play periods');
  const events: TimedEvent[] = [];
  let order = 0;
  for (const period of periods) {
    const number = num(period['period_number']) ?? 0;
    const shootout = isShootout(period);
    const list = (Array.isArray(period['events']) ? period['events'] : []) as Json[];
    // Hockey overtime length: 5 minutes in the regular season, 20 in the playoffs.
    const maxRemaining = Math.max(0, ...list.map((e) => parseRemaining(str(e['clock'])) ?? 0));
    const length = number >= 4 && maxRemaining <= 300 ? 300 : 1200;
    for (const e of list) {
      order++;
      const home = num(e['home_points']);
      const away = num(e['away_points']);
      if (home === undefined || away === undefined) continue;
      const clock = str(e['clock']);
      if (sport === 'soccer') {
        const c = parseSoccerClock(clock);
        if (!c) continue;
        const minute = Math.min(
          num(e['match_time']) ?? Math.floor(c.seconds / 60) + 1,
          c.half === 1 ? 45 : 90,
        );
        events.push({
          a: c.half,
          b: c.seconds,
          order,
          home,
          away,
          at: { period: number >= 1 ? number : c.half, minute, second: c.second },
          shootout,
        });
      } else {
        const left = parseRemaining(clock);
        if (left === undefined || number < 1) continue;
        const elapsed =
          number <= 3 ? (number - 1) * 1200 + (1200 - left) : 3600 + (number - 4) * length + (length - left);
        events.push({
          a: number,
          b: number <= 3 ? 1200 - left : length - left,
          order,
          home,
          away,
          at: { period: number, minute: Math.floor(elapsed / 60), second: elapsed % 60 },
          shootout,
        });
      }
    }
  }
  if (events.length === 0) throw new PbpUnusable('no event carries a usable clock and score');
  // Oldest first; events at the same clock keep the feed's order (newest first → larger `order` is older).
  events.sort((x, y) => x.a - y.a || x.b - y.b || y.order - x.order);

  const goals: GoalEvent[] = [];
  let home = 0;
  let away = 0;
  let shootoutSeen = false;
  for (const e of events) {
    if (e.shootout) {
      shootoutSeen = true;
      continue;
    }
    for (const [side, now, before] of [
      ['home', e.home, home],
      ['away', e.away, away],
    ] as const) {
      for (let i = before; i < now; i++) goals.push({ side, ...(e.at as Omit<GoalEvent, 'side'>) });
      for (let i = now; i < before; i++) {
        const last = goals.map((g) => g.side).lastIndexOf(side);
        if (last !== -1) goals.splice(last, 1);
      }
    }
    home = e.home;
    away = e.away;
  }
  // The final is the score after the last event (a shootout period included).
  const { home: finalHome, away: finalAway } = events[events.length - 1] as TimedEvent;
  const h = goals.filter((g) => g.side === 'home').length;
  const a = goals.length - h;
  const dh = finalHome - h;
  const da = finalAway - a;
  const consistent = (dh === 0 && da === 0) || (shootoutSeen && dh >= 0 && da >= 0 && dh + da === 1);
  if (!consistent)
    throw new PbpUnusable(
      `goal events (${h}-${a}) do not add up to the final score (${finalHome}-${finalAway})`,
    );
  return { goals, finalHome, finalAway };
}
