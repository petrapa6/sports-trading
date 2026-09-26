import { dollarsToBp } from './decimal.js';

/**
 * Fee, limit price, sizing, cost and P&L math in integer units (SPEC.md §2 Fees, §2 The trade, §5 Sizing, §6).
 * Pure functions; no floating point in money paths.
 *
 *   raw_micros  = ceil( 7 × M × cc × bp × (10000 − bp) / 1_000_000 )
 *   cost_micros = cc × bp
 *   fee_micros  = ceil( (cost_micros + raw_micros) / PREC ) × PREC − cost_micros
 *
 * `M` (the series `fee_multiplier`) is passed as `multiplier` (the API's number, e.g. `1`) or in thousandths
 * (`multiplierMilli`, 1000 = 1) so that fractional multipliers stay exact.
 */

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Cost of `cc` centi-contracts at `bp` price units, in micro-dollars (`cc × bp`). */
export function costMicros(cc: number, bp: number): number {
  return cc * bp;
}

export interface FeeInput {
  /** Centi-contracts. */
  cc: number;
  /** Price in units of $0.0001. */
  bp: number;
  /** Series fee multiplier as Kalshi reports it (`fee_multiplier`, e.g. `1`); overrides `multiplierMilli`. */
  multiplier?: number;
  /** Series fee multiplier × 1000 (default 1000 = 1). */
  multiplierMilli?: number;
  /** `fee_balance_precision_micros` (default 100 = $0.0001). */
  precisionMicros?: number;
}

/** Taker fee in micro-dollars for one order. */
export function feeMicros({
  cc,
  bp,
  multiplier,
  multiplierMilli: milli = 1000,
  precisionMicros = 100,
}: FeeInput): number {
  const multiplierMilli = multiplier === undefined ? milli : toMultiplierMilli(multiplier);
  for (const [name, v] of Object.entries({ cc, bp, multiplierMilli, precisionMicros })) {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new RangeError(`feeMicros: ${name} must be a non-negative integer`);
  }
  if (bp > 10_000) throw new RangeError('feeMicros: bp must be ≤ 10000');
  if (precisionMicros === 0) throw new RangeError('feeMicros: precisionMicros must be positive');
  // 7 × (M/1000) × cc × bp × (10000 − bp) / 1e6  =  7 × Mmilli × cc × bp × (10000 − bp) / 1e9
  const raw = ceilDiv(
    7n * BigInt(multiplierMilli) * BigInt(cc) * BigInt(bp) * BigInt(10_000 - bp),
    1_000_000_000n,
  );
  const cost = BigInt(cc) * BigInt(bp);
  const prec = BigInt(precisionMicros);
  return Number(ceilDiv(cost + raw, prec) * prec - cost);
}

/**
 * A fee multiplier (a JSON number such as `1` or `0.5`) in thousandths. Exact for up to 3 decimals; a
 * multiplier with more precision is rounded up (the conservative direction for a fee).
 */
export function toMultiplierMilli(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new RangeError('fee multiplier must be a non-negative number');
  }
  const text = String(multiplier);
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (m) return Number.parseInt(m[1] ?? '0', 10) * 1000 + Number.parseInt((m[2] ?? '').padEnd(3, '0'), 10);
  return Math.ceil(multiplier * 1000);
}

/** One `price_ranges` entry of a market (`[{start, end, step}]`, dollar strings). */
export interface PriceRange {
  start: string;
  end: string;
  step: string;
}

/** The `linear_cent` grid ($0.01 steps from $0.01 to $0.99), used when a market reports no ranges. */
export const LINEAR_CENT: readonly PriceRange[] = [{ start: '0.0100', end: '0.9900', step: '0.0100' }];

/**
 * The highest valid price of the grid at or below `bp`, or `null` when no grid price is ≤ `bp`.
 * A range covers `start, start + step, …` up to `end`.
 */
export function snapDownBp(bp: number, priceRanges: readonly PriceRange[] = LINEAR_CENT): number | null {
  const ranges = priceRanges.length > 0 ? priceRanges : LINEAR_CENT;
  let best: number | null = null;
  for (const r of ranges) {
    const start = dollarsToBp(r.start);
    const end = dollarsToBp(r.end);
    const step = dollarsToBp(r.step);
    if (step <= 0 || bp < start) continue;
    const top = Math.min(bp, end);
    const snapped = start + Math.floor((top - start) / step) * step;
    if (best === null || snapped > best) best = snapped;
  }
  return best;
}

export interface LimitPriceInput {
  /** Best YES ask. */
  askBp: number;
  /** `execution.maxSlippage` in `_bp`. */
  maxSlippageBp: number;
  /** `execution.maxPrice` in `_bp`. */
  maxPriceBp: number;
  /** The market's price grid (`price_ranges`); `linear_cent` when empty or omitted. */
  priceRanges?: readonly PriceRange[];
}

/**
 * `limit_bp = min(best_ask_bp + maxSlippage_bp, maxPrice_bp)`, snapped **down** to the market's price grid
 * (§2 The trade the strategy makes). `null` when no grid price is at or below that value.
 */
export function limitPriceBp({
  askBp,
  maxSlippageBp,
  maxPriceBp,
  priceRanges,
}: LimitPriceInput): number | null {
  for (const [name, v] of Object.entries({ askBp, maxSlippageBp, maxPriceBp })) {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new RangeError(`limitPriceBp: ${name} must be a non-negative integer`);
  }
  return snapDownBp(Math.min(askBp + maxSlippageBp, maxPriceBp), priceRanges);
}

/** Whole contracts a stake buys at the limit price: `floor(stake_micros / (limit_bp × 100))` (§5 Sizing). */
export function contractsFor({ stakeMicros, limitBp }: { stakeMicros: number; limitBp: number }): number {
  if (!Number.isSafeInteger(stakeMicros) || stakeMicros < 0) {
    throw new RangeError('contractsFor: stakeMicros must be a non-negative integer');
  }
  if (!Number.isSafeInteger(limitBp) || limitBp <= 0) {
    throw new RangeError('contractsFor: limitBp must be a positive integer');
  }
  return Math.floor(stakeMicros / (limitBp * 100));
}

export interface StakeInput {
  balanceMicros: number;
  /** `sizing.percent` in hundredths of a percent (2 % → 200). */
  percentCenti: number;
  minStakeMicros: number;
  maxStakeMicros: number;
}

/**
 * `stake_micros = clamp(balance × percent / 100, minStake, maxStake)` (§5 Sizing), floored to the micro-dollar.
 * A balance at or below zero stakes nothing.
 */
export function stakeMicros({
  balanceMicros,
  percentCenti,
  minStakeMicros,
  maxStakeMicros,
}: StakeInput): number {
  for (const [name, v] of Object.entries({ balanceMicros, percentCenti, minStakeMicros, maxStakeMicros })) {
    if (!Number.isSafeInteger(v)) throw new RangeError(`stakeMicros: ${name} must be an integer`);
  }
  if (balanceMicros <= 0) return 0;
  const raw = Number((BigInt(balanceMicros) * BigInt(percentCenti)) / 10_000n);
  return Math.min(Math.max(raw, minStakeMicros), maxStakeMicros);
}

/** Payout at settlement: `fill_cc × settlement_value_bp` (§6 Settling). */
export function payoutMicros(fillCc: number, settlementValueBp: number): number {
  return fillCc * settlementValueBp;
}

/** `realized = payout − cost − fee`, with `cost = fill_cc × avg_fill_price_bp` (§6). */
export function realizedPnlMicros({
  fillCc,
  avgBp,
  feeMicros: fee,
  payoutMicros: payout,
}: {
  fillCc: number;
  avgBp: number;
  feeMicros: number;
  payoutMicros: number;
}): number {
  return payout - costMicros(fillCc, avgBp) - fee;
}

/** Unrealized P&L of an open trade: `fill_cc × (yes_bid_bp − avg_fill_price_bp)` (§6). */
export function unrealizedPnlMicros({
  fillCc,
  avgBp,
  bidBp,
}: {
  fillCc: number;
  avgBp: number;
  bidBp: number;
}): number {
  return fillCc * (bidBp - avgBp);
}
