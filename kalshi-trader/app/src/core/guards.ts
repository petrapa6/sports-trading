import type { EffectiveMode } from './modes.js';
import { contractsFor, limitPriceBp, stakeMicros, type PriceRange } from './pricing.js';

/**
 * The §5 guard table (SPEC.md §5 Guards), identical in live, dry run and backtest: evaluated in order, the
 * first failing guard names the skip reason and its class. A **hard** failure ends the trade (`skipped`); a
 * **soft** one leaves it `waiting`, retried on the next tick while the rule still matches and the window is
 * open. Guards 10–13 are outcomes of a live order (or an error) and are classified here so every caller
 * shares one table.
 *
 * `evaluateEntry` runs guards 1–9 and, on the way, computes everything an attempt records: best ask, the
 * limit price (snapped to the market's grid), the depth at or below it, the stake and the contracts. Pure.
 */

export type GuardClass = 'hard' | 'soft';

export const GUARDS = {
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
} as const satisfies Record<string, GuardClass>;

export type GuardReason = keyof typeof GUARDS;

/** Market statuses in which the exchange accepts orders (`open`; the API reports tradable markets as `active`). */
export const OPEN_MARKET_STATUSES: ReadonlySet<string> = new Set(['open', 'active']);

/** One orderbook level: price and size in centi-contracts. */
export interface AskLevel {
  price_bp: number;
  size_cc: number;
}

export interface EntryInput {
  /** Guard 1: the effective mode recomputed just before the attempt. */
  effectiveMode: EffectiveMode;
  nowMs: number;
  /** Guard 2 (omit to skip, e.g. in a backtest): market status and close time. */
  market?: { status: string | null; closeTimeMs: number | null };
  /** Guard 3 (omit to skip): `GET /exchange/status` → `trading_active`. */
  tradingActive?: boolean;
  /** Guard 4 (omit to skip): when the newest feed observation for the game was received (epoch ms). */
  newestObservationMs?: number | null;
  maxFeedAgeSec: number;
  /** Guard 5 (omit to skip): `games.blocked`. */
  blocked?: boolean;
  /** YES asks, cheapest first. */
  asks: readonly AskLevel[];
  maxPriceBp: number;
  minPriceBp: number | null;
  maxSlippageBp: number;
  priceRanges?: readonly PriceRange[];
  minDepthContracts: number;
  /** Sizing (§5): the balance the stake is a percentage of. */
  balanceMicros: number;
  percentCenti: number;
  minStakeMicros: number;
  maxStakeMicros: number;
}

/** What the attempt row records, filled as far as evaluation got. */
export interface EntryFacts {
  bestAskBp: number | null;
  limitBp: number | null;
  /** Centi-contracts offered at prices ≤ `limitBp`. */
  depthCc: number | null;
  stakeMicros: number | null;
  /** Whole contracts × 100. */
  requestedCc: number | null;
}

export type EntryResult =
  | ({ ok: true; limitBp: number; depthCc: number; stakeMicros: number; requestedCc: number } & EntryFacts)
  | ({ ok: false; reason: GuardReason; class: GuardClass } & EntryFacts);

const fail = (reason: GuardReason, facts: EntryFacts): EntryResult => ({
  ok: false,
  reason,
  class: GUARDS[reason],
  ...facts,
});

/** Centi-contracts offered at prices at or below `limitBp`. */
export function depthAtOrBelow(asks: readonly AskLevel[], limitBp: number): number {
  return asks.reduce((sum, l) => (l.price_bp <= limitBp ? sum + l.size_cc : sum), 0);
}

export function evaluateEntry(i: EntryInput): EntryResult {
  const facts: EntryFacts = {
    bestAskBp: null,
    limitBp: null,
    depthCc: null,
    stakeMicros: null,
    requestedCc: null,
  };
  // 1. A kill switch was turned on mid-window.
  if (i.effectiveMode === 'paused') return fail('paused', facts);
  // 2. Market open and closing in the future.
  if (i.market) {
    const open = i.market.status !== null && OPEN_MARKET_STATUSES.has(i.market.status);
    const future = i.market.closeTimeMs === null || i.market.closeTimeMs > i.nowMs;
    if (!open || !future) return fail('market_closed', facts);
  }
  // 3. Exchange trading.
  if (i.tradingActive === false) return fail('exchange_paused', facts);
  // 4. Fresh feed.
  if (i.newestObservationMs !== undefined) {
    const age = i.newestObservationMs === null ? Infinity : i.nowMs - i.newestObservationMs;
    if (age > i.maxFeedAgeSec * 1000) return fail('stale_feed', facts);
  }
  // 5. Feeds agree.
  if (i.blocked === true) return fail('feed_blocked', facts);
  // 6. / 7. Best ask within [minPrice, maxPrice]; nothing offered at all counts as no liquidity.
  const best = i.asks.reduce<number | null>((m, l) => (m === null || l.price_bp < m ? l.price_bp : m), null);
  facts.bestAskBp = best;
  if (best === null) return fail('liquidity', facts);
  if (best > i.maxPriceBp) return fail('price', facts);
  if (i.minPriceBp !== null && best < i.minPriceBp) return fail('min_price', facts);
  // 8. Depth at or below the limit price.
  const limit = limitPriceBp({
    askBp: best,
    maxSlippageBp: i.maxSlippageBp,
    maxPriceBp: i.maxPriceBp,
    ...(i.priceRanges ? { priceRanges: i.priceRanges } : {}),
  });
  if (limit === null || limit < best) {
    // No grid price at or above the ask within maxPrice: nothing can be bought.
    facts.limitBp = limit;
    return fail('price', facts);
  }
  facts.limitBp = limit;
  const depth = depthAtOrBelow(i.asks, limit);
  facts.depthCc = depth;
  if (depth < i.minDepthContracts * 100) return fail('liquidity', facts);
  // 9. Sizing yields at least one contract.
  const stake = stakeMicros({
    balanceMicros: i.balanceMicros,
    percentCenti: i.percentCenti,
    minStakeMicros: i.minStakeMicros,
    maxStakeMicros: i.maxStakeMicros,
  });
  facts.stakeMicros = stake;
  const contracts = contractsFor({ stakeMicros: stake, limitBp: limit });
  facts.requestedCc = contracts * 100;
  if (contracts < 1) return fail('too_small', facts);
  return {
    ok: true,
    ...facts,
    limitBp: limit,
    depthCc: depth,
    stakeMicros: stake,
    requestedCc: contracts * 100,
  };
}
