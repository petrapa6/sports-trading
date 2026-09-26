import type { Logger } from 'pino';
import {
  derivedSoccerMinute,
  hockeyMinute,
  OnceSet,
  parseClock,
  type FeedObservation,
  type GameClock,
  type GameState,
  type Phase,
  type ScoreFeed,
  type TrackedGame,
} from '../gameState.js';
import type { KalshiClient } from './client.js';
import type { LiveData } from './schemas.js';

/**
 * `kalshi-live` adapter (SPEC.md §3, T07): one batch live-data call per tick for every tracked
 * milestone → `GameState`. `details` is an open object, so every field is checked here at runtime.
 *
 * - Hockey: `round` = period, `final_round_time_left` = clock; `00:00` in round 1 or 2 = intermission.
 * - Soccer: the minute is parsed from `tileLiveText` / `widgetLiveText` (`78'`, `45+2'`, `HT`, `FT`);
 *   when the text has no minute, the minute is derived from the observed kick-off / second-half start
 *   (`minuteSource: 'derived'`); an unknown text is derived too and logged once per game.
 * - `status`: `none` → scheduled, `live` → in play, `finished` → finished (regulation over).
 */

export type SoccerText =
  | { kind: 'minute'; minute: number; half: 1 | 2 }
  | { kind: 'half'; half: 1 | 2 }
  | { kind: 'halftime' }
  | { kind: 'finished' }
  | { kind: 'postponed' }
  | { kind: 'unknown' };

/** Parses Kalshi's soccer live text. Stoppage time counts as 45 / 90 (`45+2'` → 45, `90+4'` → 90). */
export function parseSoccerLiveText(text: string): SoccerText {
  const t = text.trim().replace(/[’′]/g, "'");
  let m = /^(\d{1,3})\s*\+\s*\d{1,2}\s*'?$/.exec(t);
  if (m) {
    const base = Number.parseInt(m[1] ?? '', 10);
    if (base === 45) return { kind: 'minute', minute: 45, half: 1 };
    if (base === 90) return { kind: 'minute', minute: 90, half: 2 };
    return { kind: 'unknown' };
  }
  m = /^(\d{1,3})\s*'$/.exec(t);
  if (m) {
    const minute = Number.parseInt(m[1] ?? '', 10);
    if (minute < 0 || minute > 130) return { kind: 'unknown' };
    return { kind: 'minute', minute: Math.min(minute, 90), half: minute <= 45 ? 1 : 2 };
  }
  if (/^(HT|half[\s-]?time)$/i.test(t)) return { kind: 'halftime' };
  if (/^(FT|full[\s-]?time|final|ended)$/i.test(t)) return { kind: 'finished' };
  if (/^(1st|first)\s+half$/i.test(t)) return { kind: 'half', half: 1 };
  if (/^(2nd|second)\s+half$/i.test(t)) return { kind: 'half', half: 2 };
  if (/^(postponed|ppd|cancell?ed|abandoned|suspended)$/i.test(t)) return { kind: 'postponed' };
  return { kind: 'unknown' };
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && /^\d+$/.test(v)
      ? Number.parseInt(v, 10)
      : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function feedUpdatedAt(details: Record<string, unknown>): Date | undefined {
  for (const key of ['last_updated_ts', 'updated_ts', 'last_update_ts', 'updated_at', 'last_updated']) {
    const v = details[key];
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (!Number.isNaN(ms)) return new Date(ms);
    }
  }
  return undefined;
}

export interface LiveConversionContext {
  now: number;
  log: Pick<Logger, 'warn'>;
  /** Warn-once registry for unknown soccer texts (one warn per game id). */
  unknownText: OnceSet;
}

/** Converts one Kalshi live-data record of a tracked game into a `GameState`. */
export function liveDataToState(live: LiveData, game: TrackedGame, ctx: LiveConversionContext): GameState {
  const d = live.details;
  const status = str(d['status'])?.toLowerCase() ?? 'none';
  const homeScore = num(d['home_points']) ?? 0;
  const awayScore = num(d['away_points']) ?? 0;
  const round = num(d['round']);
  let phase: Phase = 'scheduled';
  const clock: GameClock = { regulationOver: false };

  if (status === 'finished') {
    phase = 'finished';
    clock.regulationOver = true;
    if (game.sport === 'hockey') {
      clock.minute = 60;
      clock.minuteSource = 'feed';
      if (round !== undefined) clock.period = round;
    } else {
      clock.minute = 90;
      clock.minuteSource = 'feed';
      clock.period = 2;
    }
  } else if (status === 'live') {
    phase = 'live';
    if (game.sport === 'hockey') {
      const left = parseClock(d['final_round_time_left']);
      if (round !== undefined && round >= 1) {
        clock.period = round;
        if (left !== undefined) clock.secondsLeftInPeriod = left;
        clock.minute = hockeyMinute(round, left);
        clock.minuteSource = 'feed';
        if (left === 0 && (round === 1 || round === 2)) phase = 'intermission';
        if (round >= 4 || (round === 3 && left === 0)) clock.regulationOver = true;
      }
    } else {
      soccerClock(d, round, game, ctx, clock, (p) => (phase = p));
    }
  } else {
    // `none` (not started) — or a postponement announced in the text.
    const text = str(d['tileLiveText']) ?? str(d['widgetLiveText']);
    if (text && parseSoccerLiveText(text).kind === 'postponed') phase = 'postponed';
  }

  const updated = feedUpdatedAt(d);
  return {
    gameId: game.id,
    leagueId: game.leagueId,
    homeTeam: game.home?.name ?? '',
    awayTeam: game.away?.name ?? '',
    homeScore,
    awayScore,
    phase,
    clock,
    source: 'kalshi-live',
    observedAt: new Date(ctx.now),
    ...(updated ? { feedUpdatedAt: updated } : {}),
  };
}

function soccerClock(
  d: Record<string, unknown>,
  round: number | undefined,
  game: TrackedGame,
  ctx: LiveConversionContext,
  clock: GameClock,
  setPhase: (p: Phase) => void,
): void {
  const texts = [str(d['tileLiveText']), str(d['widgetLiveText'])].filter((t): t is string => !!t);
  const parsed = texts.map(parseSoccerLiveText);
  const known = parsed.find((p) => p.kind !== 'unknown');
  let half: 1 | 2 | undefined = round === 1 || round === 2 ? round : undefined;

  if (known?.kind === 'minute') {
    clock.minute = known.minute;
    clock.minuteSource = 'feed';
    clock.period = known.half;
    return;
  }
  if (known?.kind === 'halftime') {
    setPhase('halftime');
    clock.minute = 45;
    clock.minuteSource = 'feed';
    clock.period = 1;
    return;
  }
  if (known?.kind === 'finished') {
    setPhase('finished');
    clock.minute = 90;
    clock.minuteSource = 'feed';
    clock.period = 2;
    clock.regulationOver = true;
    return;
  }
  if (known?.kind === 'postponed') {
    setPhase('postponed');
    return;
  }
  if (known?.kind === 'half') half = known.half;
  if (!known && ctx.unknownText.first(game.id)) {
    ctx.log.warn(
      { gameId: game.id, text: texts.join(' | ') || null },
      'Kalshi live text not recognised; deriving the minute from the observed kick-off',
    );
  }
  // Derived minute (SPEC.md §3): not yet observed → this observation is the start.
  const secondHalf = half === 2 ? (game.secondHalfObservedAt ?? ctx.now) : game.secondHalfObservedAt;
  const kickoff = game.kickoffObservedAt ?? ctx.now;
  const minute = derivedSoccerMinute(kickoff, half === 1 ? null : secondHalf, ctx.now);
  if (minute !== undefined) clock.minute = minute;
  clock.minuteSource = 'derived';
  clock.period = half ?? (secondHalf !== null ? 2 : 1);
}

export interface KalshiLiveFeedOptions {
  client: Pick<KalshiClient, 'getLiveDataBatch' | 'getExchangeStatus'>;
  log: Logger;
  /** The games the tracker currently follows (for `listLive` / `get`). */
  games: () => readonly TrackedGame[];
  now?: () => number;
}

export class KalshiLiveFeed implements ScoreFeed {
  readonly id = 'kalshi-live' as const;
  readonly sports = ['soccer', 'hockey'] as const;
  private readonly unknownText = new OnceSet();
  private readonly now: () => number;

  constructor(private readonly options: KalshiLiveFeedOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Exactly one batch request for every tracked game that has a milestone. */
  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    const byMilestone = new Map<string, TrackedGame>();
    for (const g of games) if (g.milestoneId) byMilestone.set(g.milestoneId, g);
    if (byMilestone.size === 0) return [];
    const records = await this.options.client.getLiveDataBatch([...byMilestone.keys()]);
    const ctx: LiveConversionContext = {
      now: this.now(),
      log: this.options.log,
      unknownText: this.unknownText,
    };
    const out: FeedObservation[] = [];
    for (const live of records) {
      const game = live.milestone_id ? byMilestone.get(live.milestone_id) : undefined;
      if (!game) continue;
      out.push({ state: liveDataToState(live, game, ctx), raw: live });
    }
    return out;
  }

  async listLive(leagueId: string): Promise<GameState[]> {
    const obs = await this.poll(this.options.games().filter((g) => g.leagueId === leagueId));
    return obs.map((o) => o.state);
  }

  async get(gameId: string): Promise<GameState> {
    const game = this.options.games().find((g) => g.id === gameId);
    if (!game) throw new Error(`game ${gameId} is not tracked`);
    const [obs] = await this.poll([game]);
    if (!obs) throw new Error(`Kalshi returned no live data for ${gameId}`);
    return obs.state;
  }

  async test(games: readonly TrackedGame[]): Promise<string> {
    const withMilestone = games.filter((g) => g.milestoneId);
    if (withMilestone.length === 0) {
      const status = await this.options.client.getExchangeStatus();
      return `reachable (exchange ${status.exchange_active ? 'active' : 'inactive'}); no tracked games right now`;
    }
    const obs = await this.poll(withMilestone);
    return `${obs.length} of ${withMilestone.length} tracked game(s) returned live data`;
  }
}
