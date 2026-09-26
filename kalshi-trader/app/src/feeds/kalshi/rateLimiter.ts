/**
 * Token buckets for the Kalshi rate limits (SPEC.md §2, Basic tier): reads refill at 200 tokens/s and
 * hold 3 s worth (600 tokens), writes refill at 100 tokens/s and hold 1 s (100 tokens); a request costs
 * 10 tokens unless configured otherwise. Waiting requests are served strictly in arrival order.
 * Timers are resolved at call time, so Vitest fake timers apply.
 */

export interface BucketOptions {
  /** Tokens added per second. */
  ratePerSec: number;
  /** Seconds of refill the bucket holds (capacity = rate × seconds). */
  capacitySec: number;
  now?: () => number;
}

interface Waiter {
  cost: number;
  resolve: () => void;
}

export class TokenBucket {
  readonly capacity: number;
  private tokens: number;
  private last: number;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: BucketOptions) {
    this.now = options.now ?? (() => Date.now());
    this.capacity = options.ratePerSec * options.capacitySec;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.options.ratePerSec) / 1000);
    }
    this.last = t;
  }

  /** Tokens currently available (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Resolves once `cost` tokens have been taken; FIFO with every other waiter. */
  take(cost: number): Promise<void> {
    if (cost > this.capacity)
      throw new RangeError(`request cost ${cost} exceeds bucket capacity ${this.capacity}`);
    this.refill();
    if (this.queue.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ cost, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer !== undefined) return;
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0] as Waiter;
      if (this.tokens < head.cost) break;
      this.tokens -= head.cost;
      this.queue.shift();
      head.resolve();
    }
    const head = this.queue[0];
    if (!head) return;
    const waitMs = Math.max(1, Math.ceil(((head.cost - this.tokens) * 1000) / this.options.ratePerSec));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, waitMs);
  }
}

export interface RateLimitOptions {
  readPerSec: number;
  readCapacitySec: number;
  writePerSec: number;
  writeCapacitySec: number;
  /** Tokens per request unless `costs` names the endpoint. */
  defaultCost: number;
  /** Per-endpoint costs (`GET /account/endpoint_costs`), keyed `METHOD /path-template`. */
  costs?: Record<string, number>;
}

/** Basic tier (SPEC.md §2). */
export const BASIC_TIER: RateLimitOptions = {
  readPerSec: 200,
  readCapacitySec: 3,
  writePerSec: 100,
  writeCapacitySec: 1,
  defaultCost: 10,
};
