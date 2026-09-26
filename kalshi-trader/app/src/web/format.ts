// Formatting helpers with no browser dependencies (usable in server-rendered component tests).

/** Micro-dollars as `$1,234.56` (integer arithmetic; rounds half away from zero to the cent). */
export function formatUsd(micros: number): string {
  const negative = micros < 0;
  const cents = Math.floor((Math.abs(micros) + 5000) / 10_000);
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `${negative ? '−' : ''}$${whole}.${String(cents % 100).padStart(2, '0')}`;
}
