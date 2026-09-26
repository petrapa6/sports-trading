import { evaluateLeadAtTime, type Side } from '../core/engine.js';
import { evaluateEntry, GUARDS, type GuardReason } from '../core/guards.js';
import { costMicros, feeMicros, payoutMicros, realizedPnlMicros, type PriceRange } from '../core/pricing.js';
import { ratio, roundDiv } from '../core/stats.js';
import {
  strategyPercentCenti,
  strategyPriceBp,
  strategyUsdMicros,
  type VersionPayload,
} from '../core/strategy.js';
import type { GoalEvent } from '../core/tracker.js';
import type { Sport } from '../feeds/gameState.js';
import { LAST_MINUTE, scoreAt, stateAt, wallMinuteOf } from './clock.js';
import { priceModelLookup, REGULATION_MINUTES, seedModel, type PriceModel } from './priceModel.js';

/**
 * The backtest simulator (SPEC.md §9, T12): replays a strategy over historical games with the production
 * `engine.ts` rule (`evaluateLeadAtTime`), `guards.ts` (`evaluateEntry`) and `pricing.ts` unchanged. Pure and
 * deterministic: the same input always yields the same trades and summary (no clock, no randomness).
 *
 * For each game, in date order: minute ticks from the goal timeline; when the rule first matches, the leader's
 * YES ask comes from the price provider; the guards run with depth not modelled (one ask level of unlimited
 * size, `minDepthContracts` ignored) and no market / exchange / feed checks; a soft failure retries on the next
 * minute while the rule still matches for the same leader and the window is open, exactly like the live
 * executor; the window closing ends the entry `skipped` with the last soft reason. A fill is settled from the
 * final score (soccer 90' + stoppage, hockey incl. OT / SO, an NHL tie at $0.50) and the bankroll compounds.
 */

export type PriceMode = 'exact' | 'modelled';
export type PriceSource = 'candle' | 'next_candle' | 'model';
/** No candle at the minute or within the next 3 (exact mode), or no market for the leader. */
export const NO_PRICE = 'skipped_no_price';
/** The window closed before any attempt could be made (never happens with a soft reason recorded). */
export const WINDOW_EXPIRED = 'window_expired';
/** Exact mode looks this many minutes past a missing candle. */
export const NEXT_CANDLE_MINUTES = 3;
/** The Kalshi series fee multiplier of every configured sport series (§2), in thousandths. */
export const DEFAULT_MULTIPLIER_MILLI = 1000;

export interface SimMarket {
  ticker: string;
  priceRanges?: readonly PriceRange[];
}

export interface SimGame {
  id: string;
  playedAt: string;
  finalHome: number;
  finalAway: number;
  goals: GoalEvent[];
  /** The leader markets (exact mode). */
  markets: { home?: SimMarket; away?: SimMarket };
}

export interface SimInput {
  sport: Sport;
  params: Pick<VersionPayload, 'rule' | 'sizing' | 'execution'>;
  priceMode: PriceMode;
  initialBankrollMicros: number;
  /** `fee_balance_precision_micros`. */
  precisionMicros: number;
  multiplierMilli?: number;
  /** `settings.price_model` built by T11 (modelled mode); `null` → the full seed table. */
  priceModel?: PriceModel | null;
  /**
   * Exact mode: YES ask close by market ticker and wall minute after the game's scheduled start (`e` of T11's
   * clock model, see `clock.ts`).
   */
  candles?: ReadonlyMap<string, ReadonlyMap<number, number>>;
  games: readonly SimGame[];
}

/** One `backtest_trades` row without its ids. */
export interface SimTrade {
  hist_game_id: string;
  minute: number;
  side: Side;
  price_source: PriceSource | null;
  /** Fill (limit) price; for a skip the last ask seen, if any. */
  price_bp: number | null;
  contracts_cc: number | null;
  stake_micros: number | null;
  fee_micros: number | null;
  settlement_value_bp: number | null;
  pnl_micros: number | null;
  bankroll_after_micros: number;
  skip_reason: string | null;
}

export interface EquityPoint {
  t: string;
  gameId: string;
  cumMicros: number;
  bankrollMicros: number;
}

export interface BacktestSummary {
  priceMode: PriceMode;
  /** Modelled mode: the smallest sample size behind a price used (0 = seed only); exact mode `null`. */
  minSampleSize: number | null;
  /** Modelled mode: prices that came from the seed table. */
  seededPrices: number;
  games: number;
  /** Games on which the rule matched (a trade or a skip). */
  matched: number;
  /** Filled (and settled) trades. */
  trades: number;
  won: number;
  lost: number;
  void: number;
  winRate: number;
  netPnlMicros: number;
  investedMicros: number;
  roi: number;
  maxDrawdownMicros: number;
  avgPriceBp: number;
  avgFeeMicros: number;
  impliedVsActual: { impliedBp: number; actualWinRate: number; n: number };
  initialBankrollMicros: number;
  finalBankrollMicros: number;
  skips: { reason: string; count: number }[];
  series: {
    equity: EquityPoint[];
    drawdown: { t: string; drawdownMicros: number }[];
    monthly: { month: string; pnlMicros: number }[];
  };
}

export interface SimResult {
  trades: SimTrade[];
  summary: BacktestSummary;
}

/**
 * Settlement value of the leader's YES market from the final score (§9 step 4): the leader won → $1.00, lost →
 * $0; a draw settles hockey markets at $0.50 (Kalshi's NHL tie rule) and the soccer team markets at $0 (the tie
 * market wins).
 */
export function settlementValueBp(sport: Sport, side: Side, finalHome: number, finalAway: number): number {
  if (finalHome === finalAway) return sport === 'hockey' ? 5000 : 0;
  const winner: Side = finalHome > finalAway ? 'home' : 'away';
  return winner === side ? 10_000 : 0;
}

/** Ask at `minute` from the exact provider: the candle, else the next one within 3 minutes. */
function exactAsk(
  sport: Sport,
  series: ReadonlyMap<number, number> | undefined,
  minute: number,
): { askBp: number; source: PriceSource } | null {
  if (!series) return null;
  const e = wallMinuteOf(sport, minute);
  const here = series.get(e);
  if (here !== undefined) return { askBp: here, source: 'candle' };
  for (let k = 1; k <= NEXT_CANDLE_MINUTES; k++) {
    const next = series.get(e + k);
    if (next !== undefined) return { askBp: next, source: 'next_candle' };
  }
  return null;
}

export type ProgressFn = (done: number, total: number) => void;

export function simulate(input: SimInput, onProgress?: ProgressFn, progressEvery = 50): SimResult {
  const { sport, params, priceMode } = input;
  const rule = params.rule;
  const exec = params.execution;
  const sizing = params.sizing;
  const model = input.priceModel ?? seedModel('');
  const multiplierMilli = input.multiplierMilli ?? DEFAULT_MULTIPLIER_MILLI;
  const maxPriceBp = strategyPriceBp(exec.maxPrice);
  const minPriceBp = exec.minPrice === null ? null : strategyPriceBp(exec.minPrice);
  const maxSlippageBp = strategyPriceBp(exec.maxSlippage);
  const percentCenti = strategyPercentCenti(sizing.percent);
  const minStakeMicros = strategyUsdMicros(sizing.minStakeUsd);
  const maxStakeMicros = strategyUsdMicros(sizing.maxStakeUsd);
  const lastMinute = Math.min(LAST_MINUTE[sport], rule.atMinute + rule.windowMinutes);

  let bankroll = input.initialBankrollMicros;
  let minSample: number | null = null;
  let seeded = 0;
  const trades: SimTrade[] = [];
  const total = input.games.length;

  input.games.forEach((game, index) => {
    let side: Side | null = null;
    let lastReason: string | null = null;
    let lastMinuteTried = 0;
    let lastAsk: number | null = null;
    let lastSource: PriceSource | null = null;
    let row: SimTrade | null = null;

    for (let minute = rule.atMinute; minute <= lastMinute && row === null; minute++) {
      const result = evaluateLeadAtTime(rule, sport, stateAt(sport, game.goals, minute));
      if (!result.match) continue;
      // The trade is for the first leader's market; a changed leader makes no attempt on this tick.
      if (side === null) side = result.side;
      else if (result.side !== side) continue;
      lastMinuteTried = minute;

      let ask: { askBp: number; source: PriceSource } | null;
      if (priceMode === 'modelled') {
        const score = scoreAt(game.goals, minute);
        const p = priceModelLookup(
          model,
          sport,
          Math.abs(score.home - score.away),
          REGULATION_MINUTES[sport] - minute,
        );
        if (!p) throw new Error(`the price model has no ${sport} cell for minute ${minute}`);
        if (p.seeded) seeded++;
        minSample = minSample === null ? p.sampleSize : Math.min(minSample, p.sampleSize);
        ask = { askBp: p.askBp, source: 'model' };
      } else {
        const market = game.markets[side];
        ask = market ? exactAsk(sport, input.candles?.get(market.ticker), minute) : null;
      }
      if (!ask) {
        lastReason = NO_PRICE; // soft: the next minute may have a candle
        lastSource = null;
        continue;
      }
      lastAsk = ask.askBp;
      lastSource = ask.source;

      const priceRanges = priceMode === 'exact' ? game.markets[side]?.priceRanges : undefined;
      const entry = evaluateEntry({
        effectiveMode: 'dry_run',
        nowMs: 0,
        maxFeedAgeSec: exec.maxFeedAgeSec,
        asks: [{ price_bp: ask.askBp, size_cc: Number.MAX_SAFE_INTEGER }],
        maxPriceBp,
        minPriceBp,
        maxSlippageBp,
        ...(priceRanges && priceRanges.length > 0 ? { priceRanges } : {}),
        minDepthContracts: 0,
        balanceMicros: bankroll,
        percentCenti,
        minStakeMicros,
        maxStakeMicros,
      });
      if (!entry.ok) {
        lastReason = entry.reason;
        if ((GUARDS as Record<GuardReason, string>)[entry.reason] === 'hard') {
          row = skipRow(game.id, minute, side, ask.source, ask.askBp, entry.reason, bankroll);
        }
        continue;
      }

      const fillCc = entry.requestedCc;
      const cost = costMicros(fillCc, entry.limitBp);
      const fee = feeMicros({
        cc: fillCc,
        bp: entry.limitBp,
        multiplierMilli,
        precisionMicros: input.precisionMicros,
      });
      const value = settlementValueBp(sport, side, game.finalHome, game.finalAway);
      const payout = payoutMicros(fillCc, value);
      const pnl = realizedPnlMicros({ fillCc, avgBp: entry.limitBp, feeMicros: fee, payoutMicros: payout });
      bankroll = bankroll - cost - fee + payout;
      row = {
        hist_game_id: game.id,
        minute,
        side,
        price_source: ask.source,
        price_bp: entry.limitBp,
        contracts_cc: fillCc,
        stake_micros: entry.stakeMicros,
        fee_micros: fee,
        settlement_value_bp: value,
        pnl_micros: pnl,
        bankroll_after_micros: bankroll,
        skip_reason: null,
      };
    }

    if (row === null && side !== null) {
      // The window closed without a fill: skipped with the last soft reason.
      row = skipRow(
        game.id,
        lastMinuteTried,
        side,
        lastSource,
        lastAsk,
        lastReason ?? WINDOW_EXPIRED,
        bankroll,
      );
    }
    if (row) trades.push(row);
    if (onProgress && ((index + 1) % progressEvery === 0 || index + 1 === total))
      onProgress(index + 1, total);
  });

  return {
    trades,
    summary: summarize(input, trades, bankroll, priceMode === 'modelled' ? (minSample ?? 0) : null, seeded),
  };
}

function skipRow(
  gameId: string,
  minute: number,
  side: Side,
  source: PriceSource | null,
  askBp: number | null,
  reason: string,
  bankroll: number,
): SimTrade {
  return {
    hist_game_id: gameId,
    minute,
    side,
    price_source: source,
    price_bp: askBp,
    contracts_cc: null,
    stake_micros: null,
    fee_micros: null,
    settlement_value_bp: null,
    pnl_micros: null,
    bankroll_after_micros: bankroll,
    skip_reason: reason,
  };
}

/** The §6 metrics of a backtest, with its equity curve, drawdown and monthly P&L. */
export function summarize(
  input: Pick<SimInput, 'priceMode' | 'initialBankrollMicros' | 'games'>,
  trades: readonly SimTrade[],
  finalBankroll: number,
  minSampleSize: number | null,
  seededPrices: number,
): BacktestSummary {
  const playedAt = new Map(input.games.map((g) => [g.id, g.playedAt]));
  let won = 0;
  let lost = 0;
  let voided = 0;
  let pnl = 0;
  let invested = 0;
  let priceSum = 0;
  let feeSum = 0;
  let decidedPriceSum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity: EquityPoint[] = [];
  const drawdown: { t: string; drawdownMicros: number }[] = [];
  const monthly = new Map<string, number>();
  const skips = new Map<string, number>();
  let filled = 0;

  for (const t of trades) {
    if (t.skip_reason !== null) {
      skips.set(t.skip_reason, (skips.get(t.skip_reason) ?? 0) + 1);
      continue;
    }
    const cc = t.contracts_cc ?? 0;
    const price = t.price_bp ?? 0;
    const fee = t.fee_micros ?? 0;
    const tradePnl = t.pnl_micros ?? 0;
    filled++;
    priceSum += price;
    feeSum += fee;
    invested += costMicros(cc, price) + fee;
    pnl += tradePnl;
    if (t.settlement_value_bp === 10_000) {
      won++;
      decidedPriceSum += price;
    } else if (t.settlement_value_bp === 0) {
      lost++;
      decidedPriceSum += price;
    } else voided++;
    const at = playedAt.get(t.hist_game_id) ?? '';
    equity.push({ t: at, gameId: t.hist_game_id, cumMicros: pnl, bankrollMicros: t.bankroll_after_micros });
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    drawdown.push({ t: at, drawdownMicros: peak - pnl });
    const month = at.slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 0) + tradePnl);
  }

  const decided = won + lost;
  return {
    priceMode: input.priceMode,
    minSampleSize,
    seededPrices,
    games: input.games.length,
    matched: trades.length,
    trades: filled,
    won,
    lost,
    void: voided,
    winRate: ratio(won, decided),
    netPnlMicros: pnl,
    investedMicros: invested,
    roi: ratio(pnl, invested),
    maxDrawdownMicros: maxDrawdown,
    avgPriceBp: roundDiv(priceSum, filled),
    avgFeeMicros: roundDiv(feeSum, filled),
    impliedVsActual: {
      impliedBp: roundDiv(decidedPriceSum, decided),
      actualWinRate: ratio(won, decided),
      n: decided,
    },
    initialBankrollMicros: input.initialBankrollMicros,
    finalBankrollMicros: finalBankroll,
    skips: [...skips]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    series: {
      equity,
      drawdown,
      monthly: [...monthly]
        .map(([month, pnlMicros]) => ({ month, pnlMicros }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    },
  };
}
