import { describe, expect, it } from 'vitest';
import { costMicros, feeMicros } from '../../src/core/pricing.js';

describe('fees (SPEC.md §2, PREC = 100)', () => {
  it.each([
    [100, 9200, 5200], // 1 contract at $0.92 → $0.0052
    [200, 9400, 7900], // 2 at $0.94 → $0.0079
    [10_000, 5000, 1_750_000], // 100 at $0.50 → $1.75
    [200, 9300, 9200], // 2 at $0.93 → $0.0092
  ])('%i cc at %i bp → %i micros', (cc, bp, fee) => {
    expect(feeMicros({ cc, bp })).toBe(fee);
  });

  it('whole-cent precision and the series multiplier', () => {
    expect(feeMicros({ cc: 100, bp: 9200, precisionMicros: 10_000 })).toBe(10_000);
    expect(feeMicros({ cc: 100, bp: 5000, multiplierMilli: 0 })).toBe(0);
  });

  it('rejects non-integers; cost = cc × bp', () => {
    expect(() => feeMicros({ cc: 1.5, bp: 9000 })).toThrow(RangeError);
    expect(costMicros(200, 9400)).toBe(1_880_000);
  });
});
