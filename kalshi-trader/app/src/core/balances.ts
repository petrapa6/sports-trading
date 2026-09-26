import type { Logger } from 'pino';
import type { KalshiEnv } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { KalshiClient } from '../feeds/kalshi/client.js';

/**
 * Live balance history (SPEC.md §7 `balance_snapshots`, §8 Balance history, T13): the Kalshi cash and portfolio
 * value of the configured subaccount, written every 15 minutes and shortly after each live fill or live
 * settlement. While the global kill switch is on nothing is read and nothing is written.
 */

export const BALANCE_SNAPSHOT_MS = 15 * 60_000;
/** Delay after a live fill / settlement, so a burst of changes writes one row. */
export const BALANCE_AFTER_CHANGE_MS = 250;

export interface BalanceRecorderOptions {
  repos: () => Repositories;
  log: Logger;
  kalshi: () => Pick<KalshiClient, 'getBalance'> | undefined;
  kalshiEnv: KalshiEnv;
  subaccount: number;
  now?: () => number;
  intervalMs?: number;
}

export class BalanceRecorder {
  private readonly log: Logger;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly options: BalanceRecorderOptions) {
    this.log = options.log.child({ component: 'balances' });
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.record('interval').finally(() => this.schedule());
    }, this.options.intervalMs ?? BALANCE_SNAPSHOT_MS);
    this.timer.unref?.();
  }

  /** A live fill or settlement changed the balance: one row shortly after (bursts are merged). */
  recordSoon(reason: string): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.record(reason);
    }, BALANCE_AFTER_CHANGE_MS);
    this.soon.unref?.();
  }

  /** Reads the balance and writes one row; `false` when paused, not configured or the read failed. */
  async record(reason: string): Promise<boolean> {
    const kalshi = this.options.kalshi();
    if (!kalshi) return false;
    try {
      if (this.options.repos().settings.get('global_kill_switch')) return false;
      const balance = await kalshi.getBalance();
      this.options.repos().balanceSnapshots.insert({
        at: new Date(this.now()).toISOString(),
        kalshi_env: this.options.kalshiEnv,
        subaccount: this.options.subaccount,
        cash_micros: balance.cash_micros,
        portfolio_value_micros: balance.portfolio_value_micros,
      });
      this.log.debug({ mode: 'live', reason, cashMicros: balance.cash_micros }, 'Balance snapshot');
      return true;
    } catch (err) {
      this.log.warn(
        { mode: 'live', reason, err: { message: (err as Error).message } },
        'The Kalshi balance could not be recorded',
      );
      return false;
    }
  }
}
