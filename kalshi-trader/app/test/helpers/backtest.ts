import { candleMinuteMs } from '../../src/backtest/clock.js';
import type { SimGame, SimInput } from '../../src/backtest/simulator.js';
import { StrategyDefinitionSchema, type StrategyDefinitionInput } from '../../src/core/strategy.js';
import type { GoalEvent } from '../../src/core/tracker.js';
import type { Repositories } from '../../src/db/repositories.js';
import type { Sport } from '../../src/feeds/gameState.js';

/** Shared fixtures of the T12 backtest tests: goal timelines, hist games with markets and candles. */

export const SOCCER_DEF: StrategyDefinitionInput = {
  name: 'EPL lead at 80',
  sport: 'soccer',
  leagueIds: ['epl'],
  rule: { type: 'lead_at_time', minLead: 1, atMinute: 80, windowMinutes: 5 },
  sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
  execution: { maxPrice: 0.97, maxSlippage: 0.01, minDepthContracts: 20, maxFeedAgeSec: 15 },
};

export const HOCKEY_DEF: StrategyDefinitionInput = {
  name: 'NHL lead at 50',
  sport: 'hockey',
  leagueIds: ['nhl'],
  rule: { type: 'lead_at_time', minLead: 1, atMinute: 50, windowMinutes: 3 },
  sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
  execution: { maxPrice: 0.97, maxSlippage: 0.01, minDepthContracts: 20, maxFeedAgeSec: 15 },
};

export function params(
  def: Partial<StrategyDefinitionInput> = {},
  base: StrategyDefinitionInput = SOCCER_DEF,
) {
  return StrategyDefinitionSchema.parse({ ...base, ...def });
}

export const goal = (side: 'home' | 'away', minute: number, period = minute > 45 ? 2 : 1): GoalEvent => ({
  side,
  period,
  minute,
  second: 0,
});

export interface GameSpec {
  id: string;
  playedAt: string;
  goals: GoalEvent[];
  final?: [number, number];
  /** Kalshi event ticker: markets `<ev>-H` (home) and `<ev>-A` (away) are created with it. */
  event?: string;
}

export function simGame(spec: GameSpec): SimGame {
  const home = spec.goals.filter((g) => g.side === 'home').length;
  const away = spec.goals.filter((g) => g.side === 'away').length;
  return {
    id: spec.id,
    playedAt: spec.playedAt,
    kickoffMs: Date.parse(spec.playedAt),
    secondHalfMs: null,
    finalHome: spec.final?.[0] ?? home,
    finalAway: spec.final?.[1] ?? away,
    goals: spec.goals,
    markets: spec.event ? { home: { ticker: `${spec.event}-H` }, away: { ticker: `${spec.event}-A` } } : {},
  };
}

/** A pure simulator input over `games` with exact candles `{ticker: {minute: askBp}}` (game minutes). */
export function simInput(
  sport: Sport,
  games: GameSpec[],
  opts: {
    def?: Partial<StrategyDefinitionInput>;
    candles?: Record<string, Record<number, number>>;
    priceMode?: SimInput['priceMode'];
    bankroll?: number;
    priceModel?: SimInput['priceModel'];
  } = {},
): SimInput {
  const sims = games.map(simGame);
  const candles = new Map<string, Map<number, number>>();
  for (const [ticker, byMinute] of Object.entries(opts.candles ?? {})) {
    const game = sims.find((g) => ticker.startsWith(`${games.find((s) => s.id === g.id)?.event ?? '?'}-`));
    if (!game) throw new Error(`no game for ${ticker}`);
    const series = new Map<number, number>();
    for (const [minute, ask] of Object.entries(byMinute)) {
      series.set(candleMinuteMs(sport, game.kickoffMs, Number(minute), game.secondHalfMs), ask);
    }
    candles.set(ticker, series);
  }
  const p = params(opts.def, sport === 'soccer' ? SOCCER_DEF : HOCKEY_DEF);
  return {
    sport,
    params: { rule: p.rule, sizing: p.sizing, execution: p.execution },
    priceMode: opts.priceMode ?? 'exact',
    initialBankrollMicros: opts.bankroll ?? 100_000_000,
    precisionMicros: 100,
    priceModel: opts.priceModel ?? null,
    candles,
    games: sims,
  };
}

/** Inserts a `hist_games` row (and, with `event`, its two markets). */
export function seedHistGame(
  repos: Repositories,
  leagueId: string,
  season: string,
  spec: GameSpec,
  source = 'csv',
): void {
  const home = spec.goals.filter((g) => g.side === 'home').length;
  const away = spec.goals.filter((g) => g.side === 'away').length;
  repos.histGames.insert({
    id: spec.id,
    league_id: leagueId,
    season,
    played_at: spec.playedAt,
    home: `Home ${spec.id}`,
    away: `Away ${spec.id}`,
    final_home: spec.final?.[0] ?? home,
    final_away: spec.final?.[1] ?? away,
    goal_events: JSON.stringify(spec.goals),
    source,
    kalshi_event_ticker: spec.event ?? null,
  });
  if (spec.event) {
    if (!repos.games.get({ id: spec.event })) {
      repos.games.insert({
        id: spec.event,
        league_id: leagueId,
        scheduled_at: spec.playedAt,
        phase: 'finished',
        updated_at: spec.playedAt,
      });
    }
    for (const [suffix, outcome] of [
      ['H', 'home'],
      ['A', 'away'],
    ] as const) {
      repos.markets.insert({
        ticker: `${spec.event}-${suffix}`,
        game_id: spec.event,
        outcome,
        status: 'finalized',
        updated_at: spec.playedAt,
      });
    }
  }
}

/** Inserts 1-minute candles for a market at game minutes (`{minute: [askClose, tradeClose|null]}`). */
export function seedCandles(
  repos: Repositories,
  sport: Sport,
  playedAt: string,
  ticker: string,
  byMinute: Record<number, [number, number | null]>,
): void {
  const kickoff = Date.parse(playedAt);
  repos.histPrices.insertMany(
    Object.entries(byMinute).map(([minute, [ask, trade]]) => ({
      market_ticker: ticker,
      minute_ts: new Date(candleMinuteMs(sport, kickoff, Number(minute))).toISOString(),
      ask_open_bp: ask,
      ask_high_bp: ask,
      ask_low_bp: ask,
      ask_close_bp: ask,
      bid_close_bp: ask - 200,
      trade_close_bp: trade,
      volume_cc: trade === null ? 0 : 1000,
    })),
  );
}

/**
 * `n` synthetic games for load tests: every third game has a 2-goal lead at 80' (home or away), the rest are
 * level or 1-goal games; played one per 3 hours from 2025-08-01.
 */
export function syntheticGames(n: number, prefix = 'syn'): GameSpec[] {
  const out: GameSpec[] = [];
  const t0 = Date.parse('2025-08-01T12:00:00.000Z');
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 'home' : 'away';
    const other = side === 'home' ? 'away' : 'home';
    const goals =
      i % 3 === 0
        ? [goal(side, 10 + (i % 30)), goal(side, 50 + (i % 20)), ...(i % 7 === 0 ? [goal(other, 88)] : [])]
        : i % 3 === 1
          ? [goal(side, 30)]
          : [goal(side, 20), goal(other, 70)];
    out.push({
      id: `${prefix}-${String(i).padStart(5, '0')}`,
      playedAt: new Date(t0 + i * 3 * 3_600_000).toISOString(),
      goals,
    });
  }
  return out;
}
