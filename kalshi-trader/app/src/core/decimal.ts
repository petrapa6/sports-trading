/**
 * Exact conversions between Kalshi decimal strings and the integer units used
 * everywhere in the app (see SPEC.md "Conventions used everywhere").
 *
 * - price:  `*_dollars` string -> integer units of $0.0001  (`_bp`)
 * - money:  `*_dollars` string -> integer micro-dollars     (`_micros`)
 * - count:  `*_fp` string      -> integer centi-contracts   (`_cc`)
 *
 * Parsing is done on the decimal string itself; no value ever passes through
 * floating point. Inputs carrying more precision than the target unit throw
 * (trailing zeros beyond the unit are harmless and accepted).
 */

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export class DecimalError extends Error {
  override name = 'DecimalError';
}

function parseScaled(input: string, scale: number, what: string): number {
  if (typeof input !== 'string') {
    throw new DecimalError(`${what}: expected a decimal string, got ${typeof input}`);
  }
  const m = DECIMAL_RE.exec(input);
  if (!m) throw new DecimalError(`${what}: not a decimal string: "${input}"`);
  const [, sign, intPart = '0', rawFrac = ''] = m;
  const frac = rawFrac.replace(/0+$/, '');
  if (frac.length > scale) {
    throw new DecimalError(
      `${what}: "${input}" has more than ${scale} decimal places (precision would be lost)`,
    );
  }
  const digits = BigInt(intPart + frac.padEnd(scale, '0'));
  const value = sign ? -digits : digits;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DecimalError(`${what}: "${input}" is out of the safe integer range`);
  }
  // `0 * -1` would produce -0; normalise.
  return value === 0n ? 0 : Number(value);
}

function formatScaled(value: number, scale: number, what: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new DecimalError(`${what}: expected a safe integer, got ${String(value)}`);
  }
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${intPart}${scale > 0 ? `.${frac}` : ''}`;
}

/** Price units of $0.0001 per dollar. */
export const BP_SCALE = 4;
/** Micro-dollars per dollar. */
export const MICROS_SCALE = 6;
/** Centi-contracts per contract. */
export const CC_SCALE = 2;

/** `"0.9300"` -> `9300` */
export function dollarsToBp(dollars: string): number {
  return parseScaled(dollars, BP_SCALE, 'dollarsToBp');
}

/** `"0.007896"` -> `7896` */
export function dollarsToMicros(dollars: string): number {
  return parseScaled(dollars, MICROS_SCALE, 'dollarsToMicros');
}

/** `"1.55"` -> `155` */
export function fpToCc(fp: string): number {
  return parseScaled(fp, CC_SCALE, 'fpToCc');
}

/** `9400` -> `"0.9400"` */
export function bpToDollars(bp: number): string {
  return formatScaled(bp, BP_SCALE, 'bpToDollars');
}

/** `7896` -> `"0.007896"` */
export function microsToDollars(micros: number): string {
  return formatScaled(micros, MICROS_SCALE, 'microsToDollars');
}

/** `200` -> `"2.00"` */
export function ccToFp(cc: number): string {
  return formatScaled(cc, CC_SCALE, 'ccToFp');
}
