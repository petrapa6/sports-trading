// Formatting helpers with no browser dependencies (usable in server-rendered component tests).

/** Micro-dollars as `$1,234.56` (integer arithmetic; rounds half away from zero to the cent). */
export function formatUsd(micros: number): string {
  const negative = micros < 0;
  const cents = Math.floor((Math.abs(micros) + 5000) / 10_000);
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `${negative ? '−' : ''}$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** Micro-dollars exactly, with at least 2 and at most 6 decimals (`$0.0079`, `−$1.8879`, `$2.00`). */
export function formatUsdExact(micros: number): string {
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000).toLocaleString('en-US');
  const frac = String(abs % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${negative ? '−' : ''}$${whole}.${frac}`;
}

/** A price in units of $0.0001 as dollars (`9400` → `$0.94`, `9350` → `$0.935`). */
export function formatPrice(bp: number): string {
  const whole = Math.floor(bp / 10_000);
  const frac = String(bp % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `$${whole}.${frac}`;
}

/** Centi-contracts as contracts (`200` → `2`, `150` → `1.5`). */
export function formatContracts(cc: number): string {
  const whole = Math.trunc(cc / 100);
  const frac = String(Math.abs(cc % 100))
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
