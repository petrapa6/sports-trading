/**
 * Fee, cost and P&L math in integer units (SPEC.md §2 Fees). Pure functions; no floating point.
 *
 *   raw_micros  = ceil( 7 × M × cc × bp × (10000 − bp) / 1_000_000 )
 *   cost_micros = cc × bp
 *   fee_micros  = ceil( (cost_micros + raw_micros) / PREC ) × PREC − cost_micros
 *
 * `M` (the series `fee_multiplier`) is passed in thousandths (`multiplierMilli`, 1000 = 1) so that
 * fractional multipliers stay exact.
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
  /** Series fee multiplier × 1000 (default 1000 = 1). */
  multiplierMilli?: number;
  /** `fee_balance_precision_micros` (default 100 = $0.0001). */
  precisionMicros?: number;
}

/** Taker fee in micro-dollars for one order. */
export function feeMicros({ cc, bp, multiplierMilli = 1000, precisionMicros = 100 }: FeeInput): number {
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
