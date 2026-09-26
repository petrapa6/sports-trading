import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KalshiUnavailable } from '../../../src/feeds/kalshi/client.js';
import { TokenBucket } from '../../../src/feeds/kalshi/rateLimiter.js';
import { testClient } from '../../helpers/kalshiMsw.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T20:00:00Z'));
});
afterEach(() => vi.useRealTimers());

/** A fetch stub that records when each request was sent and answers from `statuses` (then 200). */
function stubFetch(statuses: number[] = []) {
  const sent: number[] = [];
  const fetchFn = (async () => {
    sent.push(Date.now());
    const status = statuses.shift() ?? 200;
    return new Response(
      JSON.stringify(status === 200 ? { exchange_active: true, trading_active: true } : {}),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  return { sent, fetchFn };
}

/** Lets resolved promises and zero-delay work run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('token buckets (Basic tier)', () => {
  it('after 3 idle seconds the read bucket holds 600 tokens; 40 + 40 reads → 60 at once, then 20 per second', async () => {
    const { sent, fetchFn } = stubFetch();
    const c = testClient({ fetch: fetchFn });
    // Drain the bucket, then idle 3 s.
    await Promise.all(Array.from({ length: 60 }, () => c.getExchangeStatus()));
    expect(c.tokens().read).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.tokens().read).toBe(600);
    sent.length = 0;

    const t0 = Date.now();
    const first = Array.from({ length: 40 }, () => c.getExchangeStatus());
    await flush();
    expect(sent).toHaveLength(40);
    const second = Array.from({ length: 40 }, () => c.getExchangeStatus());
    await flush();
    expect(sent).toHaveLength(60);
    expect(sent.every((t) => t === t0)).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(70);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(80);
    await Promise.all([...first, ...second]);
    // The queued 20 went out one every 50 ms (20 per second).
    expect(sent.slice(60).map((t) => t - t0)).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 50));
  });

  it('write bucket holds 100 tokens (10 writes), refilled at 100 tokens/s', () => {
    const b = new TokenBucket({ ratePerSec: 100, capacitySec: 1 });
    expect(b.capacity).toBe(100);
    expect(b.available()).toBe(100);
  });
});

describe('backoff on 429 / 5xx', () => {
  it('429, 429, 200 → one result after 0.5 s and 1 s delays', async () => {
    const { sent, fetchFn } = stubFetch([429, 429]);
    const c = testClient({ fetch: fetchFn });
    const t0 = Date.now();
    let result: unknown;
    const p = c.getExchangeStatus().then((r) => (result = r));
    await flush();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(sent.map((t) => t - t0)).toEqual([0, 500, 1500]);
    expect(result).toMatchObject({ trading_active: true });
  });

  it('six consecutive 503s → KalshiUnavailable after 5 attempts', async () => {
    const { sent, fetchFn } = stubFetch([503, 503, 503, 503, 503, 503]);
    const c = testClient({ fetch: fetchFn });
    const t0 = Date.now();
    const p = c.getExchangeStatus().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(err).toBeInstanceOf(KalshiUnavailable);
    expect(err).toMatchObject({ status: 503, attempts: 5 });
    expect(sent.map((t) => t - t0)).toEqual([0, 500, 1500, 3500, 7500]);
  });
});
