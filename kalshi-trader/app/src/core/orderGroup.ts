import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import { KalshiApiError, type KalshiClient } from '../feeds/kalshi/client.js';

/**
 * The Kalshi order group (SPEC.md §10 Blast radius, T13): an exchange-enforced cap on the contracts matched in
 * a rolling 15-second window. Every live order carries its id.
 *
 * - `ensure()` runs at start-up when live orders are possible (`allow_live_orders` and a Kalshi client): the id
 *   stored in `settings.kalshi_order_group_id` is reused while `GET /portfolio/order_groups/{id}` still knows
 *   it; otherwise a group is created with `order_group_contract_limit` and its id stored.
 * - `currentId()` is what the executor asks before every live order (it creates the group when none exists).
 * - A rejection because the group's limit was hit is recorded with `markLimitHit()`; `reset()` (Settings →
 *   Trading, step-up) resets the group on the exchange — or creates one when there is none — and clears it.
 */

export type OrderGroupKalshi = Pick<KalshiClient, 'createOrderGroup' | 'getOrderGroup' | 'resetOrderGroup'>;

export interface OrderGroupStatus {
  /** `false` while live orders are impossible (`allow_live_orders: false` or no Kalshi credentials). */
  enabled: boolean;
  id: string | null;
  /** `order_group_contract_limit`: applied when a group is created. */
  contractsLimit: number;
  /** `active`: known to the exchange; `limit_hit`: an order was rejected by the group; `unknown`: not checked. */
  state: 'disabled' | 'unknown' | 'active' | 'limit_hit' | 'error';
  lastError: string | null;
  checkedAt: string | null;
  limitHitAt: string | null;
}

export interface OrderGroupOptions {
  repos: () => Repositories;
  log: Logger;
  kalshi: () => OrderGroupKalshi | undefined;
  /** `allow_live_orders` from the process configuration. */
  allowLiveOrders: boolean;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** A Kalshi rejection that names the order group as unknown (it expired or was deleted). */
export function isUnknownOrderGroup(err: unknown): boolean {
  return err instanceof KalshiApiError && err.status === 404;
}

/**
 * Whether an order rejection means the order group's contract limit was hit (soft `order_group_limit`) rather
 * than any other rejection (hard `order_rejected`): the error code or message names the order group.
 */
export function isOrderGroupLimit(err: unknown): boolean {
  if (!(err instanceof KalshiApiError) || err.status === 404) return false;
  return /order[\s_-]?group/i.test(`${err.code ?? ''} ${err.message}`);
}

export class OrderGroupManager {
  private readonly log: Logger;
  private readonly now: () => number;
  private state: OrderGroupStatus['state'] = 'unknown';
  private lastError: string | null = null;
  private checkedAt: number | null = null;
  private limitHitAt: number | null = null;
  private inFlight: Promise<string | null> | null = null;

  constructor(private readonly options: OrderGroupOptions) {
    this.log = options.log.child({ component: 'order-group' });
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.options.allowLiveOrders && this.options.kalshi() !== undefined;
  }

  private storedId(): string | null {
    return this.options.repos().settings.get('kalshi_order_group_id');
  }

  status(): OrderGroupStatus {
    const repos = this.options.repos();
    return {
      enabled: this.enabled,
      id: repos.settings.get('kalshi_order_group_id'),
      contractsLimit: repos.settings.get('order_group_contract_limit'),
      state: this.enabled ? (this.limitHitAt !== null ? 'limit_hit' : this.state) : 'disabled',
      lastError: this.lastError,
      checkedAt: this.checkedAt === null ? null : iso(this.checkedAt),
      limitHitAt: this.limitHitAt === null ? null : iso(this.limitHitAt),
    };
  }

  /** Reuses the stored group while the exchange still knows it, else creates one. `null` when impossible. */
  ensure(): Promise<string | null> {
    this.inFlight ??= this.doEnsure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The id every live order carries (created on demand). */
  async currentId(): Promise<string | null> {
    const id = this.storedId();
    if (id !== null && this.state !== 'error') return id;
    return this.ensure();
  }

  private async doEnsure(): Promise<string | null> {
    const kalshi = this.options.kalshi();
    if (!this.options.allowLiveOrders || !kalshi) return null;
    const stored = this.storedId();
    if (stored !== null) {
      try {
        await kalshi.getOrderGroup(stored);
        this.mark('active');
        this.log.info({ mode: 'live', orderGroupId: stored }, 'Reusing the Kalshi order group');
        return stored;
      } catch (err) {
        if (!isUnknownOrderGroup(err)) {
          // The group may well still exist (Kalshi unreachable): keep it and let the order find out.
          this.mark('unknown', err);
          this.log.warn(
            { mode: 'live', orderGroupId: stored, err: { message: message(err) } },
            'The Kalshi order group could not be checked; keeping the stored id',
          );
          return stored;
        }
        this.log.warn(
          { mode: 'live', orderGroupId: stored },
          'The stored Kalshi order group no longer exists',
        );
      }
    }
    return this.create(kalshi);
  }

  private async create(kalshi: OrderGroupKalshi): Promise<string | null> {
    const repos = this.options.repos();
    const limit = repos.settings.get('order_group_contract_limit');
    try {
      const id = await kalshi.createOrderGroup(limit);
      repos.settings.set('kalshi_order_group_id', id);
      this.mark('active');
      this.limitHitAt = null;
      repos.auditLog.insert({
        at: iso(this.now()),
        actor: 'system',
        mode: 'live',
        action: 'order_group_created',
        entity: 'settings',
        entity_id: 'kalshi_order_group_id',
        detail: JSON.stringify({ orderGroupId: id, contractsLimit: limit }),
      });
      this.log.info(
        { mode: 'live', orderGroupId: id, contractsLimit: limit },
        'Created a Kalshi order group',
      );
      return id;
    } catch (err) {
      this.mark('error', err);
      this.log.error(
        { mode: 'live', err: { message: message(err) } },
        'The Kalshi order group could not be created; live orders wait until it can',
      );
      return null;
    }
  }

  private mark(state: OrderGroupStatus['state'], err?: unknown): void {
    this.state = state;
    this.lastError = err === undefined ? null : message(err);
    this.checkedAt = this.now();
  }

  /** An order was rejected because the group's limit was hit: shown in Settings until a reset. */
  markLimitHit(): void {
    this.limitHitAt = this.now();
  }

  /** The stored group is unknown to the exchange: the next live order creates a new one. */
  invalidate(): void {
    this.state = 'error';
    this.lastError = 'The exchange no longer knows the order group';
  }

  /**
   * Settings → Trading "Reset" (step-up checked by the route): resets the group on the exchange (or creates
   * one when there is none, or the exchange no longer knows it). Throws when Kalshi rejects it.
   */
  async reset(): Promise<OrderGroupStatus> {
    const kalshi = this.options.kalshi();
    if (!this.enabled || !kalshi) throw new Error('live orders are disabled');
    const stored = this.storedId();
    if (stored !== null) {
      try {
        await kalshi.resetOrderGroup(stored);
        this.mark('active');
        this.limitHitAt = null;
        this.log.info({ mode: 'live', orderGroupId: stored }, 'Kalshi order group reset');
        return this.status();
      } catch (err) {
        if (!isUnknownOrderGroup(err)) {
          this.mark(this.state === 'active' ? 'active' : 'unknown', err);
          throw err;
        }
      }
    }
    const id = await this.create(kalshi);
    if (id === null) throw new Error(this.lastError ?? 'the order group could not be created');
    return this.status();
  }
}
