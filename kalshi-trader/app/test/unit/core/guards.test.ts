import { describe, expect, it } from 'vitest';
import { evaluateEntry, GUARDS, type EntryInput } from '../../../src/core/guards.js';

const NOW = Date.parse('2026-10-17T15:30:00Z');

/** Everything passes: $100 bankroll, 2 %, ask 0.93 with 50 contracts ≤ 0.94. */
const base: EntryInput = {
  effectiveMode: 'dry_run',
  nowMs: NOW,
  market: { status: 'open', closeTimeMs: NOW + 3_600_000 },
  tradingActive: true,
  newestObservationMs: NOW - 2000,
  maxFeedAgeSec: 15,
  blocked: false,
  asks: [
    { price_bp: 9300, size_cc: 3000 },
    { price_bp: 9400, size_cc: 2000 },
    { price_bp: 9600, size_cc: 10_000 },
  ],
  maxPriceBp: 9700,
  minPriceBp: null,
  maxSlippageBp: 100,
  minDepthContracts: 20,
  balanceMicros: 100_000_000,
  percentCenti: 200,
  minStakeMicros: 1_000_000,
  maxStakeMicros: 50_000_000,
};

const reason = (patch: Partial<EntryInput>) => {
  const r = evaluateEntry({ ...base, ...patch });
  return r.ok ? 'ok' : `${r.class}:${r.reason}`;
};

describe('guards (SPEC.md §5), evaluated in order', () => {
  it('happy path: limit 9400, 50 contracts offered, stake $2 → 2 contracts', () => {
    expect(evaluateEntry(base)).toMatchObject({
      ok: true,
      bestAskBp: 9300,
      limitBp: 9400,
      depthCc: 5000,
      stakeMicros: 2_000_000,
      requestedCc: 200,
    });
  });

  it('each guard names its reason and class', () => {
    expect(reason({ effectiveMode: 'paused' })).toBe('hard:paused');
    expect(reason({ market: { status: 'closed', closeTimeMs: NOW + 1 } })).toBe('hard:market_closed');
    expect(reason({ market: { status: 'open', closeTimeMs: NOW - 1 } })).toBe('hard:market_closed');
    expect(reason({ market: { status: 'active', closeTimeMs: null } })).toBe('ok');
    expect(reason({ tradingActive: false })).toBe('soft:exchange_paused');
    expect(reason({ newestObservationMs: NOW - 20_000 })).toBe('soft:stale_feed');
    expect(reason({ newestObservationMs: NOW - 15_000 })).toBe('ok');
    expect(reason({ newestObservationMs: null })).toBe('soft:stale_feed');
    expect(reason({ blocked: true })).toBe('soft:feed_blocked');
    expect(reason({ asks: [{ price_bp: 9800, size_cc: 5000 }] })).toBe('soft:price');
    expect(reason({ minPriceBp: 9500 })).toBe('soft:min_price');
    expect(reason({ asks: [{ price_bp: 9300, size_cc: 500 }] })).toBe('soft:liquidity');
    expect(reason({ asks: [] })).toBe('soft:liquidity');
    expect(reason({ balanceMicros: 1_000_000, minStakeMicros: 10_000 })).toBe('hard:too_small');
  });

  it('order: the first failing guard wins', () => {
    expect(reason({ effectiveMode: 'paused', tradingActive: false, blocked: true })).toBe('hard:paused');
    expect(reason({ tradingActive: false, blocked: true, asks: [] })).toBe('soft:exchange_paused');
    expect(reason({ blocked: true, asks: [] })).toBe('soft:feed_blocked');
  });

  it('omitted inputs are not checked (backtest)', () => {
    const rest: EntryInput = { ...base };
    delete rest.market;
    delete rest.tradingActive;
    delete rest.newestObservationMs;
    delete rest.blocked;
    expect(evaluateEntry(rest).ok).toBe(true);
  });

  it('the guard table classes (§5)', () => {
    expect(GUARDS).toEqual({
      paused: 'hard',
      market_closed: 'hard',
      exchange_paused: 'soft',
      stale_feed: 'soft',
      feed_blocked: 'soft',
      price: 'soft',
      min_price: 'soft',
      liquidity: 'soft',
      too_small: 'hard',
      unfilled: 'soft',
      order_group_limit: 'soft',
      order_rejected: 'hard',
      error: 'soft',
    });
  });
});
