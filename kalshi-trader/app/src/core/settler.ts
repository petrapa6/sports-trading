import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { Trade } from '../db/schema.js';
import { KalshiApiError, type KalshiClient } from '../feeds/kalshi/client.js';
import type { HistoricalCutoff, Market, Settlement } from '../feeds/kalshi/schemas.js';
import { payoutMicros, realizedPnlMicros } from './pricing.js';
import { adjustBankroll, transitionTrade, type TradeStatus } from './trades.js';

/**
 * Settler (SPEC.md §6 Settling, T09): every 60 s — never while the global kill switch is on, when it makes no
 * request at all — reads the market of every `filled` trade, and once it is `settled` / `finalized` with a
 * `settlement_value_dollars`:
 *
 * - `payout = fill_cc × settlement_value_bp`; `settled_won` (10000), `settled_lost` (0) or `settled_void`;
 *   `realized_pnl = payout − cost − fee`;
 * - dry run: the payout is credited to the shared bankroll with a `bankroll_snapshots` row (`settlement`) in
 *   the same transaction;
 * - live (T13): reconciled against `GET /portfolio/settlements?ticker=`: when the exchange's `revenue` for the
 *   ticker differs from the app's payout (the sum over its live trades on that ticker) by more than
 *   `RECONCILE_TOLERANCE_MICROS`, `trades.reconcile_warning` is set and one `warn` logged. While Kalshi lists no
 *   settlement for the ticker yet, live trades wait (up to `RECONCILE_WAIT_MS`, then they settle with a warning).
 *
 * Markets settled before the historical cutoff (`GET /historical/cutoff` → `market_settled_ts`) are read from
 * `/historical/markets/{ticker}`; a `404` from `/markets/{ticker}` also falls back to it.
 */

export const SETTLE_INTERVAL_MS = 60_000;
/** §6 Settling: a difference above $0.01 between Kalshi's revenue and the app's payout is flagged. */
export const RECONCILE_TOLERANCE_MICROS = 10_000;
/** How long live trades of a settled market wait for Kalshi to list the settlement before settling anyway. */
export const RECONCILE_WAIT_MS = 30 * 60_000;

export type SettlerKalshi = Pick<
  KalshiClient,
  'getMarket' | 'getHistoricalMarket' | 'getHistoricalCutoff' | 'getSettlements'
>;

export interface SettlerOptions {
  repos: () => Repositories;
  log: Logger;
  kalshi: () => SettlerKalshi | undefined;
  transaction: (fn: () => void) => void;
  now?: () => number;
  intervalMs?: number;
  /** Runs at the start of every pass (the executor's window sweep, pending live attempts). */
  beforeRun?: () => unknown;
}

export interface SettleResult {
  checked: number;
  settled: number;
  skipped: 'paused' | 'not_configured' | null;
}

const SETTLED_MARKET = new Set(['settled', 'finalized']);
const iso = (ms: number) => new Date(ms).toISOString();

export class Settler extends EventEmitter<{
  trade: [{ id: string; status: string; mode: 'live' | 'dry_run' }];
}> {
  private readonly log: Logger;
  private readonly now: () => number;
  /** When a settled market with live trades was first seen without a Kalshi settlement (ticker → ms). */
  private readonly awaitingSettlement = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SettleResult> | null = null;
  private stopped = true;

  constructor(private readonly options: SettlerOptions) {
    super();
    this.setMaxListeners(0);
    this.log = options.log.child({ component: 'settler' });
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
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule());
    }, this.options.intervalMs ?? SETTLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** One pass (also run by tests); concurrent calls share the pass in progress. */
  runOnce(): Promise<SettleResult> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<SettleResult> {
    const result: SettleResult = { checked: 0, settled: 0, skipped: null };
    let repos: Repositories;
    try {
      repos = this.options.repos();
      if (repos.settings.get('global_kill_switch')) {
        result.skipped = 'paused';
        return result;
      }
    } catch (err) {
      this.log.error(
        { err: { message: (err as Error).message } },
        'Settlement skipped: database unavailable',
      );
      return result;
    }
    try {
      await this.options.beforeRun?.();
    } catch (err) {
      this.log.error({ err: { message: (err as Error).message } }, 'Pre-settlement checks failed');
    }
    const filled = repos.trades.listByStatus(['filled']);
    if (filled.length === 0) return result;
    const kalshi = this.options.kalshi();
    if (!kalshi) {
      result.skipped = 'not_configured';
      return result;
    }

    let cutoff: HistoricalCutoff | null = null;
    try {
      cutoff = await kalshi.getHistoricalCutoff();
    } catch (err) {
      this.log.warn({ err: { message: (err as Error).message } }, 'Historical cutoff could not be read');
    }

    const byTicker = new Map<string, Trade[]>();
    for (const t of filled) {
      if (!t.market_ticker) continue;
      byTicker.set(t.market_ticker, [...(byTicker.get(t.market_ticker) ?? []), t]);
    }
    for (const [ticker, trades] of byTicker) {
      // The kill switch may have been turned on during the pass: stop making requests.
      if (repos.settings.get('global_kill_switch')) {
        result.skipped = 'paused';
        break;
      }
      result.checked += trades.length;
      let market: Market;
      try {
        market = await this.readMarket(kalshi, repos, ticker, cutoff);
      } catch (err) {
        this.log.warn(
          {
            mode: trades[0]?.effective_mode === 'live' ? 'live' : 'dry_run',
            ticker,
            err: { message: (err as Error).message },
          },
          `Settlement check of ${ticker} failed; retried next minute`,
        );
        continue;
      }
      this.recordMarket(repos, ticker, market);
      if (!market.status || !SETTLED_MARKET.has(market.status) || market.settlement_value_bp === null)
        continue;
      const valueBp = market.settlement_value_bp;
      const live = trades.filter((t) => t.effective_mode === 'live');
      for (const t of trades) {
        if (t.effective_mode !== 'live' && this.settle(repos, t, valueBp)) result.settled++;
      }
      if (live.length > 0) result.settled += await this.settleLive(kalshi, repos, ticker, live, valueBp);
    }
    return result;
  }

  /**
   * Live trades of a settled market (§6 Settling 4): settled from the market like dry-run trades (no bankroll),
   * then reconciled with Kalshi's settlement for the ticker. Returns how many were settled.
   */
  private async settleLive(
    kalshi: SettlerKalshi,
    repos: Repositories,
    ticker: string,
    trades: Trade[],
    valueBp: number,
  ): Promise<number> {
    let settlement: Settlement | null = null;
    let error: string | null = null;
    try {
      settlement = (await kalshi.getSettlements({ ticker })).find((s) => s.ticker === ticker) ?? null;
    } catch (err) {
      error = (err as Error).message;
    }
    let warning: string | null = null;
    if (settlement === null || settlement.revenue_micros === null) {
      const first = this.awaitingSettlement.get(ticker) ?? this.now();
      this.awaitingSettlement.set(ticker, first);
      if (this.now() - first < RECONCILE_WAIT_MS) {
        this.log.info(
          { mode: 'live', ticker, ...(error ? { err: { message: error } } : {}) },
          `Waiting for Kalshi to list the settlement of ${ticker}`,
        );
        return 0;
      }
      warning = `Kalshi listed no settlement for ${ticker} within ${RECONCILE_WAIT_MS / 60_000} minutes`;
    }
    this.awaitingSettlement.delete(ticker);
    const expected = trades.reduce((sum, t) => sum + payoutMicros(t.fill_cc ?? 0, valueBp), 0);
    const revenue = settlement?.revenue_micros ?? null;
    if (revenue !== null && Math.abs(revenue - expected) > RECONCILE_TOLERANCE_MICROS) {
      warning =
        `Kalshi reported revenue ${fmtUsd(revenue)} for ${ticker}; the app computed ${fmtUsd(expected)} ` +
        `(difference ${fmtUsd(revenue - expected)})`;
    }
    let settled = 0;
    for (const t of trades) if (this.settle(repos, t, valueBp, warning)) settled++;
    if (warning !== null)
      this.log.warn(
        {
          mode: 'live',
          ticker,
          revenueMicros: revenue,
          payoutMicros: expected,
          tradeIds: trades.map((t) => t.id),
        },
        `Reconciliation warning: ${warning}`,
      );
    return settled;
  }

  private async readMarket(
    kalshi: SettlerKalshi,
    repos: Repositories,
    ticker: string,
    cutoff: HistoricalCutoff | null,
  ): Promise<Market> {
    const row = repos.markets.get({ ticker });
    const closeMs = row?.close_time ? Date.parse(row.close_time) : NaN;
    const settledCutoff = cutoff?.market_settled_ms ?? null;
    if (settledCutoff !== null && !Number.isNaN(closeMs) && closeMs < settledCutoff) {
      return kalshi.getHistoricalMarket(ticker);
    }
    try {
      return await kalshi.getMarket(ticker);
    } catch (err) {
      if (err instanceof KalshiApiError && err.status === 404) return kalshi.getHistoricalMarket(ticker);
      throw err;
    }
  }

  private recordMarket(repos: Repositories, ticker: string, m: Market): void {
    if (!repos.markets.get({ ticker })) return;
    repos.markets.update(
      { ticker },
      {
        status: m.status,
        result: m.result,
        settlement_value_bp: m.settlement_value_bp,
        close_time: m.close_time,
        yes_bid_bp: m.yes_bid_bp,
        yes_ask_bp: m.yes_ask_bp,
        updated_at: iso(this.now()),
      },
    );
  }

  /** Settles one trade (one transaction with the bankroll credit); returns whether it changed. */
  private settle(
    repos: Repositories,
    trade: Trade,
    valueBp: number,
    reconcileWarning: string | null = null,
  ): boolean {
    const fillCc = trade.fill_cc ?? 0;
    const avgBp = trade.avg_fill_price_bp ?? 0;
    const fee = trade.fee_micros ?? 0;
    const payout = payoutMicros(fillCc, valueBp);
    const pnl = realizedPnlMicros({ fillCc, avgBp, feeMicros: fee, payoutMicros: payout });
    const status: TradeStatus =
      valueBp === 10_000 ? 'settled_won' : valueBp === 0 ? 'settled_lost' : 'settled_void';
    const dryRun = trade.effective_mode !== 'live';
    const at = iso(this.now());
    let updated: Trade | undefined;
    let bankroll: number | null = null;
    this.options.transaction(() => {
      const current = repos.trades.get({ id: trade.id });
      if (!current || current.status !== 'filled') return;
      updated = transitionTrade(
        repos,
        at,
        current,
        status,
        {
          settled_at: at,
          settlement_value_bp: valueBp,
          payout_micros: payout,
          realized_pnl_micros: pnl,
          ...(dryRun ? {} : { reconcile_warning: reconcileWarning }),
        },
        {
          settlementValueBp: valueBp,
          payoutMicros: payout,
          realizedPnlMicros: pnl,
          ...(reconcileWarning ? { reconcileWarning } : {}),
        },
      );
      if (dryRun) bankroll = adjustBankroll(repos, at, payout, 'settlement', trade.id);
    });
    if (!updated) return false;
    this.log.info(
      {
        mode: dryRun ? 'dry_run' : 'live',
        tradeId: trade.id,
        marketTicker: trade.market_ticker,
        settlementValueBp: valueBp,
        payoutMicros: payout,
        realizedPnlMicros: pnl,
        ...(bankroll !== null ? { bankrollMicros: bankroll } : {}),
      },
      `Trade settled: ${status.replace('settled_', '')} (${trade.market_ticker ?? ''})`,
    );
    this.emit('trade', { id: updated.id, status: updated.status, mode: dryRun ? 'dry_run' : 'live' });
    return true;
  }
}

/** `$1.2345` from micro-dollars (log and warning text only). */
function fmtUsd(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}$${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000)
    .padStart(6, '0')
    .slice(0, 4)}`;
}
