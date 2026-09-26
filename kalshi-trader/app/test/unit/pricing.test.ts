import { describe, expect, it } from 'vitest';
import {
  contractsFor,
  costMicros,
  feeMicros,
  limitPriceBp,
  LINEAR_CENT,
  realizedPnlMicros,
  snapDownBp,
  stakeMicros,
  toMultiplierMilli,
  unrealizedPnlMicros,
} from '../../src/core/pricing.js';

describe('fees (SPEC.md §2, PREC = 100)', () => {
  it.each([
    [100, 9200, 5200], // 1 contract at $0.92 → $0.0052
    [200, 9400, 7900], // 2 at $0.94 → $0.0079
    [10_000, 5000, 1_750_000], // 100 at $0.50 → $1.75
    [10_000, 9200, 515_200], // 100 at $0.92 → $0.5152
    [200, 9300, 9200], // 2 at $0.93 → $0.0092
  ])('%i cc at %i bp → %i micros', (cc, bp, fee) => {
    expect(feeMicros({ cc, bp })).toBe(fee);
    expect(feeMicros({ cc, bp, multiplier: 1, precisionMicros: 100 })).toBe(fee);
  });

  it('T09 acceptance values with {multiplier, precisionMicros}', () => {
    expect(feeMicros({ cc: 100, bp: 9200, multiplier: 1, precisionMicros: 100 })).toBe(5200);
    expect(feeMicros({ cc: 200, bp: 9400, multiplier: 1, precisionMicros: 100 })).toBe(7900);
    expect(feeMicros({ cc: 10_000, bp: 5000, multiplier: 1, precisionMicros: 100 })).toBe(1_750_000);
    expect(feeMicros({ cc: 10_000, bp: 9200, multiplier: 1, precisionMicros: 100 })).toBe(515_200);
    expect(feeMicros({ cc: 10_000, bp: 9200, multiplier: 0, precisionMicros: 100 })).toBe(0);
    expect(feeMicros({ cc: 100, bp: 9200, multiplier: 1, precisionMicros: 10_000 })).toBe(10_000);
  });

  it('whole-cent precision and the series multiplier', () => {
    expect(feeMicros({ cc: 100, bp: 9200, precisionMicros: 10_000 })).toBe(10_000);
    expect(feeMicros({ cc: 100, bp: 5000, multiplierMilli: 0 })).toBe(0);
    // M = 0.5 halves the model fee before rounding: 100 cc at $0.50 → $0.00875 → $0.0088.
    expect(feeMicros({ cc: 100, bp: 5000, multiplier: 0.5 })).toBe(8800);
  });

  it('multipliers convert exactly (more precision rounds up)', () => {
    expect(toMultiplierMilli(1)).toBe(1000);
    expect(toMultiplierMilli(0)).toBe(0);
    expect(toMultiplierMilli(0.25)).toBe(250);
    expect(toMultiplierMilli(1.5)).toBe(1500);
    expect(toMultiplierMilli(0.0005)).toBe(1);
    expect(() => toMultiplierMilli(-1)).toThrow(RangeError);
  });

  it('rejects non-integers; cost = cc × bp', () => {
    expect(() => feeMicros({ cc: 1.5, bp: 9000 })).toThrow(RangeError);
    expect(costMicros(200, 9400)).toBe(1_880_000);
  });
});

describe('limit price (§2): min(ask + slippage, maxPrice), snapped down to the grid', () => {
  it('linear_cent', () => {
    expect(
      limitPriceBp({ askBp: 9300, maxSlippageBp: 100, maxPriceBp: 9700, priceRanges: LINEAR_CENT }),
    ).toBe(9400);
    expect(
      limitPriceBp({ askBp: 9650, maxSlippageBp: 100, maxPriceBp: 9700, priceRanges: LINEAR_CENT }),
    ).toBe(9700);
    // No ranges reported → linear_cent.
    expect(limitPriceBp({ askBp: 9650, maxSlippageBp: 100, maxPriceBp: 9700, priceRanges: [] })).toBe(9700);
    expect(limitPriceBp({ askBp: 9655, maxSlippageBp: 0, maxPriceBp: 9700 })).toBe(9600);
  });

  it('a $0.005 grid with slippage 0.0075: ask 9300 → 9350', () => {
    const grid = [{ start: '0.0050', end: '0.9950', step: '0.0050' }];
    expect(limitPriceBp({ askBp: 9300, maxSlippageBp: 75, maxPriceBp: 9700, priceRanges: grid })).toBe(9350);
  });

  it('sub-cent steps between $0.90 and $1.00, cent steps below', () => {
    const grid = [
      { start: '0.0100', end: '0.9000', step: '0.0100' },
      { start: '0.9000', end: '0.9990', step: '0.0010' },
    ];
    expect(snapDownBp(9377, grid)).toBe(9370);
    expect(snapDownBp(8977, grid)).toBe(8900);
    expect(snapDownBp(50, grid)).toBeNull();
  });
});

describe('sizing and P&L', () => {
  it('contractsFor: floor(stake / (limit × 100))', () => {
    expect(contractsFor({ stakeMicros: 2_000_000, limitBp: 9400 })).toBe(2);
    expect(contractsFor({ stakeMicros: 900_000, limitBp: 9400 })).toBe(0);
    expect(() => contractsFor({ stakeMicros: 1, limitBp: 0 })).toThrow(RangeError);
  });

  it('stake = clamp(balance × percent / 100, min, max)', () => {
    const base = { minStakeMicros: 1_000_000, maxStakeMicros: 50_000_000 };
    expect(stakeMicros({ balanceMicros: 100_000_000, percentCenti: 200, ...base })).toBe(2_000_000);
    expect(stakeMicros({ balanceMicros: 10_000_000, percentCenti: 200, ...base })).toBe(1_000_000);
    expect(stakeMicros({ balanceMicros: 10_000_000_000, percentCenti: 200, ...base })).toBe(50_000_000);
    expect(stakeMicros({ balanceMicros: 1_000_000, percentCenti: 250, ...base, minStakeMicros: 0 })).toBe(
      25_000,
    );
    expect(stakeMicros({ balanceMicros: -5, percentCenti: 200, ...base })).toBe(0);
  });

  it('realized and unrealized P&L', () => {
    expect(realizedPnlMicros({ fillCc: 200, avgBp: 9400, feeMicros: 7900, payoutMicros: 2_000_000 })).toBe(
      112_100,
    );
    expect(realizedPnlMicros({ fillCc: 200, avgBp: 9400, feeMicros: 7900, payoutMicros: 0 })).toBe(
      -1_887_900,
    );
    expect(unrealizedPnlMicros({ fillCc: 200, avgBp: 9400, bidBp: 9600 })).toBe(40_000);
  });
});
