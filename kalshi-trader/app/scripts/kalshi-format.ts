import { microsToDollars } from '../src/core/decimal.js';

/** `123450000` → `$123.450000` (exact). */
export const formatMicros = (micros: number): string => `$${microsToDollars(micros)}`;
