import { describe, expect, it } from 'vitest';
import {
  bpToDollars,
  ccToFp,
  DecimalError,
  dollarsToBp,
  dollarsToMicros,
  fpToCc,
  microsToDollars,
} from '../../src/core/decimal.js';

describe('decimal converters (spec examples)', () => {
  it('parses', () => {
    expect(dollarsToBp('0.9300')).toBe(9300);
    expect(dollarsToMicros('0.007896')).toBe(7896);
    expect(fpToCc('1.55')).toBe(155);
  });

  it('formats', () => {
    expect(bpToDollars(9400)).toBe('0.9400');
    expect(ccToFp(200)).toBe('2.00');
    expect(microsToDollars(7896)).toBe('0.007896');
  });

  it('throws on more precision than the target unit', () => {
    expect(() => dollarsToBp('0.93005')).toThrow(DecimalError);
    expect(() => fpToCc('1.555')).toThrow(DecimalError);
    expect(() => dollarsToMicros('0.0000001')).toThrow(DecimalError);
  });
});

describe('decimal converters (edge cases)', () => {
  it('accepts fewer decimals, integers and harmless trailing zeros', () => {
    expect(dollarsToBp('0.93')).toBe(9300);
    expect(dollarsToBp('1')).toBe(10000);
    expect(dollarsToBp('0.930000')).toBe(9300);
    expect(fpToCc('2')).toBe(200);
    expect(fpToCc('0.00')).toBe(0);
    expect(dollarsToMicros('12.5')).toBe(12_500_000);
  });

  it('handles negative values', () => {
    expect(dollarsToMicros('-0.25')).toBe(-250_000);
    expect(microsToDollars(-250_000)).toBe('-0.250000');
    expect(bpToDollars(-1)).toBe('-0.0001');
    expect(Object.is(dollarsToBp('-0.0000'), 0)).toBe(true);
  });

  it('formats small and large values', () => {
    expect(bpToDollars(0)).toBe('0.0000');
    expect(bpToDollars(1)).toBe('0.0001');
    expect(bpToDollars(123456789)).toBe('12345.6789');
    expect(ccToFp(5)).toBe('0.05');
  });

  it.each(['', '.5', '1.', 'abc', '1e3', ' 1.0', '1.0 ', '+1', '0x10', 'NaN', '1,5'])(
    'rejects malformed input %j',
    (input) => {
      expect(() => dollarsToBp(input)).toThrow(DecimalError);
    },
  );

  it('rejects non-strings and non-integers', () => {
    expect(() => dollarsToBp(0.93 as unknown as string)).toThrow(DecimalError);
    expect(() => bpToDollars(1.5)).toThrow(DecimalError);
    expect(() => ccToFp(Number.NaN)).toThrow(DecimalError);
    expect(() => microsToDollars(2 ** 60)).toThrow(DecimalError);
  });

  it('rejects values beyond the safe integer range', () => {
    expect(() => dollarsToMicros('99999999999.999999')).toThrow(DecimalError);
  });
});

describe('round trip of 1 000 random values is exact', () => {
  // Deterministic PRNG (mulberry32) so failures are reproducible.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng(20260925);
  const randInt = (max: number) => Math.floor(rand() * max) * (rand() < 0.1 ? -1 : 1);

  const cases = [
    { name: 'bp', parse: dollarsToBp, format: bpToDollars, max: 100_000_000 },
    { name: 'micros', parse: dollarsToMicros, format: microsToDollars, max: 1_000_000_000_000 },
    { name: 'cc', parse: fpToCc, format: ccToFp, max: 100_000_000 },
  ];

  for (const c of cases) {
    it(`${c.name}: integer -> string -> integer and string -> integer -> string`, () => {
      for (let i = 0; i < 1000; i++) {
        const n = randInt(c.max) || 0;
        const s = c.format(n);
        expect(c.parse(s)).toBe(n);
        expect(c.format(c.parse(s))).toBe(s);
      }
    });
  }
});
