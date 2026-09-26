import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { KalshiEnv } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { Trade, TradeAttempt } from '../db/schema.js';
import type { Sport } from '../feeds/gameState.js';
import { KalshiApiError, type KalshiClient } from '../feeds/kalshi/client.js';
import type { Order, Orderbook, OrderResult } from '../feeds/kalshi/schemas.js';
import { NetworkPaused } from '../feeds/network.js';
import { evaluateLeadAtTime, type Signal, type StrategyEngine } from './engine.js';
import { evaluateEntry, depthAtOrBelow, type EntryFacts, type GuardReason } from './guards.js';
import { effectiveMode as computeMode, type ModeResult } from './modes.js';
import { isOrderGroupLimit, isUnknownOrderGroup, type OrderGroupManager } from './orderGroup.js';
import { costMicros, feeMicros, toMultiplierMilli, type PriceRange } from './pricing.js';
import {
  parseVersionPayload,
  strategyPercentCenti,
  strategyPriceBp,
  strategyUsdMicros,
  type VersionPayload,
} from './strategy.js';
import { loadStrategy, readGlobalSwitches } from './strategyStore.js';
import type { GameTracker, TrackedState } from './tracker.js';
import {
  adjustBankroll,
  auditTrade,
  OPEN_STATUSES,
  parseSnapshot,
  transitionTrade,
  updateAttempt,
  type TriggerSnapshot,
} from './trades.js';

/**
 * Executor (SPEC.md §4, §5, §6, T09): turns a signal into a trade and each tick of a still-matching rule into
 * an attempt, in dry run a virtual fill against the live orderbook.
 *
 * - On a signal the `trades` row is inserted (`signalled`) at once; attempts then run **serially** in one
 *   queue (§4), so two fills in one tick debit the bankroll one after the other.
 * - Every attempt first inserts its `trade_attempts` row (`pending`, `client_order_id = <trade.id>-<n>`),
 *   **then** recomputes the effective mode from the database, reads the market, the exchange status and the
 *   orderbook, and runs the §5 guards. A soft failure leaves the trade `waiting` (retried on every tick while
 *   the rule still matches and the window is open); a hard one ends it `skipped`; the window closing ends it
 *   `skipped` with `window_expired = 1` and the last soft reason.
 * - Dry run: the stake is a percentage of the shared bankroll; the virtual fill is at the limit price for
 *   `min(contracts, contracts offered ≤ limit)`; the bankroll is debited by cost + fee with a
 *   `bankroll_snapshots` row in the same transaction as the fill.
 * - Live (T13): the stake is a percentage of the Kalshi cash balance minus the cost of this app's live
 *   attempts still `pending`; the trade goes `pending` (attempt row carrying limit and count) **before** the
 *   Create Order V2 request (IOC, `client_order_id = <trade.id>-<n>`, the order group, the subaccount). The
 *   response decides: a fill → `filled` with the exchange's count, average price and fee; nothing filled →
 *   attempt `unfilled`, trade `waiting` (retried); a 4xx → `skipped/order_rejected`, or `waiting/
 *   order_group_limit` when the order group stopped it. When the outcome is unknown (network error, 5xx after
 *   backoff, unreadable response) the order is looked up by `client_order_id`; if that fails too the attempt
 *   stays `pending` and is resolved by `resolvePendingLive()` (settler loop, start-up recovery).
 * - Nothing is ever thrown to the tracker or the scheduler: failures become attempt `error` rows.
 */

/** The Kalshi calls the executor makes (reads, and in live mode the balance and the order endpoints). */
export type ExecutorKalshi = Pick<
  KalshiClient,
  | 'getMarket'
  | 'getOrderbook'
  | 'getExchangeStatus'
  | 'getSeries'
  | 'getEvent'
  | 'getBalance'
  | 'createOrderV2'
  | 'getOrders'
  | 'getHistoricalOrders'
>;

export interface ExecutorOptions {
  repos: () => Repositories;
  log: Logger;
  /** `undefined` while Kalshi is not configured: attempts end as `error`. */
  kalshi: () => ExecutorKalshi | undefined;
  /** `allow_live_orders` from the process configuration. */
  allowLiveOrders: boolean;
  kalshiEnv: KalshiEnv;
  /** Runs `fn` in one SQLite transaction. */
  transaction: (fn: () => void) => void;
  /** The Kalshi order group every live order carries (T13); without it live attempts end as `error`. */
  orderGroups?: Pick<OrderGroupManager, 'currentId' | 'markLimitHit' | 'invalidate'>;
  now?: () => number;
}

/**
 * Why an attempt ended, beyond the §5 guards: `restart` (dry-run attempt pending at start-up),
 * `restart_no_order` / `order_not_found` (a pending live attempt whose order Kalshi does not know, at start-up /
 * later), `mode_changed` (the effective mode left `live` between the reads and the order), `no_market`.
 */
export type AttemptReason =
  GuardReason | 'restart' | 'restart_no_order' | 'order_not_found' | 'mode_changed' | 'no_market';

export interface TradeEvent {
  id: string;
  status: string;
  mode: 'live' | 'dry_run';
}

/** A live order as the exchange reports it (from the Create Order V2 response or an order lookup). */
export interface LiveOutcome {
  orderId: string;
  fillCc: number;
  avgFillPriceBp: number | null;
  costMicros: number;
  feeMicros: number;
  response: Record<string, unknown>;
}

/** `a / b` rounded half up, exact for integers (BigInt). */
function divRound(a: number, b: number): number {
  const q = (2n * BigInt(a) + BigInt(b)) / (2n * BigInt(b));
  return Number(q);
}

/** The outcome of a Create Order V2 response. */
export function outcomeFromResult(r: OrderResult, limitBp: number): LiveOutcome {
  const avg = r.avg_fill_price_bp ?? limitBp;
  return {
    orderId: r.order_id,
    fillCc: r.fill_cc,
    avgFillPriceBp: r.fill_cc > 0 ? avg : null,
    costMicros: r.fill_cc > 0 ? costMicros(r.fill_cc, avg) : 0,
    feeMicros: r.fee_micros,
    response: {
      order_id: r.order_id,
      client_order_id: r.client_order_id,
      fill_cc: r.fill_cc,
      remaining_cc: r.remaining_cc,
      avg_fill_price_bp: r.avg_fill_price_bp,
      fee_micros: r.fee_micros,
      ts_ms: r.ts_ms,
    },
  };
}

/** The outcome of an order found by `client_order_id` (`fill_count_fp`, `taker_fill_cost_dollars`, `taker_fees_dollars`). */
export function outcomeFromOrder(o: Order): LiveOutcome {
  const cost = o.taker_fill_cost_micros ?? (o.yes_price_bp !== null ? o.fill_cc * o.yes_price_bp : 0);
  return {
    orderId: o.order_id,
    fillCc: o.fill_cc,
    avgFillPriceBp: o.fill_cc > 0 ? divRound(cost, o.fill_cc) : null,
    costMicros: o.fill_cc > 0 ? cost : 0,
    feeMicros: o.fill_cc > 0 ? (o.taker_fees_micros ?? 0) : 0,
    response: {
      lookup: true,
      order_id: o.order_id,
      client_order_id: o.client_order_id,
      status: o.status,
      fill_cc: o.fill_cc,
      taker_fill_cost_micros: o.taker_fill_cost_micros,
      taker_fees_micros: o.taker_fees_micros,
    },
  };
}

/** Orders are looked up from this long before the attempt (§4: `min_ts` = attempt time − 60 s). */
export const ORDER_LOOKUP_SLACK_MS = 60_000;
/** A pending live attempt is resolved by the settler loop once it is this old (its request has long ended). */
export const PENDING_LIVE_MIN_AGE_MS = 30_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** What an attempt needs from the game state that triggered it: when it was observed and `blocked`. */
interface ObservedState {
  observedAtMs: number;
  blocked: boolean;
}

/** A rule reason that means the entry window is over for good (not just "no match on this tick"). */
function windowClosed(
  result: ReturnType<typeof evaluateLeadAtTime>,
  rule: VersionPayload['rule'],
  state: TrackedState,
  sport: Sport,
): boolean {
  if (result.match) return false;
  switch (result.reason) {
    case 'regulation_over':
    case 'overtime':
      return true;
    case 'not_live':
      return state.phase === 'finished' || state.phase === 'postponed';
    case 'window': {
      const minute =
        sport === 'hockey' &&
        state.clock.period !== undefined &&
        state.clock.secondsLeftInPeriod !== undefined
          ? Math.floor(((state.clock.period - 1) * 1200 + (1200 - state.clock.secondsLeftInPeriod)) / 60)
          : state.clock.minute;
      return minute !== undefined && minute > rule.atMinute + rule.windowMinutes;
    }
    default:
      return false;
  }
}

/**
 * Wall-clock estimate of the window end, stored as `trades.window_ends_at`: the minutes of the window left
 * after the matching minute, plus the rest of that minute. The live window itself follows the game clock;
 * this estimate decides only at start-up recovery and in the sweep (with a grace period).
 */
export function windowEndsAt(signal: Pick<Signal, 'minute' | 'at'>, rule: VersionPayload['rule']): string {
  const minutesLeft = Math.max(0, rule.atMinute + rule.windowMinutes - signal.minute) + 1;
  return iso(Date.parse(signal.at) + minutesLeft * 60_000);
}

/** A trade whose window end passed this long ago is expired by the sweep even without a game update. */
export const SWEEP_GRACE_MS = 30 * 60_000;

export class Executor extends EventEmitter<{ trade: [TradeEvent] }> {
  private readonly log: Logger;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  /** Trades with an attempt queued or running. */
  private readonly busy = new Set<string>();
  /** Fee multipliers in thousandths by series / event ticker (`null` = not reported). */
  private readonly multipliers = new Map<string, number | null>();

  constructor(private readonly options: ExecutorOptions) {
    super();
    this.setMaxListeners(0);
    this.log = options.log.child({ component: 'executor' });
    this.now = options.now ?? (() => Date.now());
  }

  /** Signals from the engine start trades; every tracker update retries the game's waiting trades. */
  attach(engine: Pick<StrategyEngine, 'on'>, tracker: Pick<GameTracker, 'on'>): this {
    engine.on('signal', (signal) => this.onSignal(signal));
    tracker.on('stateUpdated', (state) => this.onState(state));
    return this;
  }

  /** Resolves once every queued attempt has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private changed(t: Pick<Trade, 'id' | 'status' | 'effective_mode'>): void {
    this.emit('trade', {
      id: t.id,
      status: t.status,
      mode: t.effective_mode === 'live' ? 'live' : 'dry_run',
    });
  }

  private enqueue(tradeId: string, state: ObservedState): void {
    this.busy.add(tradeId);
    this.queue = this.queue
      .then(() => this.attempt(tradeId, state))
      .catch((err: unknown) => {
        this.log.error({ err: { message: (err as Error).message }, tradeId }, 'Attempt failed unexpectedly');
      })
      .finally(() => this.busy.delete(tradeId));
  }

  /** The first match: inserts the `trades` row (`signalled`) and queues the first attempt. */
  onSignal(signal: Signal): Trade | undefined {
    try {
      const repos = this.options.repos();
      const version = repos.strategyVersions.get({ strategy_id: signal.strategyId, version: signal.version });
      if (!version) throw new Error(`strategy ${signal.strategyId} has no version ${signal.version}`);
      const payload = parseVersionPayload(version);
      const snapshot: TriggerSnapshot = { ...signal.snapshot, side: signal.side, minute: signal.minute };
      const at = signal.at;
      const trade = repos.trades.insert({
        id: randomUUID(),
        strategy_id: signal.strategyId,
        strategy_version: signal.version,
        game_id: signal.gameId,
        market_ticker: signal.marketTicker,
        league_id: signal.leagueId,
        kalshi_env: this.options.kalshiEnv,
        configured_mode: signal.configuredMode,
        effective_mode: signal.effectiveMode,
        mode_reason: signal.modeReason,
        status: 'signalled',
        attempts: 0,
        trigger_snapshot: JSON.stringify(snapshot),
        triggered_at: at,
        window_ends_at: windowEndsAt(signal, payload.rule),
      });
      auditTrade(repos, at, trade.id, signal.effectiveMode, 'trade_signalled', {
        strategyId: signal.strategyId,
        version: signal.version,
        gameId: signal.gameId,
        marketTicker: signal.marketTicker,
        minute: signal.minute,
        configuredMode: signal.configuredMode,
        modeReason: signal.modeReason,
      });
      this.changed(trade);
      if (signal.marketTicker === null) {
        const skipped = transitionTrade(repos, iso(this.now()), trade, 'skipped', {
          skip_reason: 'no_market',
        });
        this.log.warn(
          { mode: signal.effectiveMode, tradeId: trade.id, gameId: signal.gameId },
          `Trade skipped: no ${signal.side} market is known for ${signal.gameId}`,
        );
        this.changed(skipped);
        return skipped;
      }
      this.enqueue(trade.id, {
        observedAtMs: Date.parse(signal.snapshot.observedAt),
        blocked: signal.snapshot.blocked,
      });
      return trade;
    } catch (err) {
      this.log.error(
        {
          mode: signal.effectiveMode,
          err: { message: (err as Error).message },
          strategyId: signal.strategyId,
        },
        `Could not record the trade for signal on ${signal.gameId}`,
      );
      return undefined;
    }
  }

  /**
   * A tracker update: for each `waiting` trade of the game (none while the global kill switch is on), an
   * attempt when its rule still matches, the end of the trade when the window has closed, else nothing.
   */
  onState(state: TrackedState): void {
    try {
      const repos = this.options.repos();
      if (repos.settings.get('global_kill_switch')) return;
      const waiting = repos.trades.listByStatus(['waiting'], state.gameId);
      if (waiting.length === 0) return;
      const sport = repos.leagues.get({ id: state.leagueId })?.sport as Sport | undefined;
      if (!sport) return;
      for (const trade of waiting) {
        if (this.busy.has(trade.id)) continue;
        const payload = this.versionOf(repos, trade);
        if (!payload) continue;
        const result = evaluateLeadAtTime(payload.rule, sport, state);
        if (result.match) {
          const side = parseSnapshot(trade.trigger_snapshot)?.side;
          // The leader changed: no attempt on this tick (the trade is for the original leader's market).
          if (side !== undefined && side !== result.side) continue;
          this.enqueue(trade.id, { observedAtMs: state.observedAt.getTime(), blocked: state.blocked });
        } else if (windowClosed(result, payload.rule, state, sport)) {
          this.expire(repos, trade);
        }
      }
    } catch (err) {
      this.log.error(
        { err: { message: (err as Error).message }, gameId: state.gameId },
        'Retry check failed',
      );
    }
  }

  /**
   * Expires `signalled` / `waiting` trades whose game has finished, or whose estimated window end passed more
   * than `SWEEP_GRACE_MS` ago (the feeds stopped updating the game). Run every minute by the settler loop.
   */
  sweep(): number {
    let n = 0;
    try {
      const repos = this.options.repos();
      if (repos.settings.get('global_kill_switch')) return 0;
      const nowMs = this.now();
      for (const trade of repos.trades.listByStatus(OPEN_STATUSES)) {
        if (this.busy.has(trade.id)) continue;
        const phase = repos.games.get({ id: trade.game_id })?.phase;
        const over = phase === 'finished' || phase === 'postponed';
        if (over || Date.parse(trade.window_ends_at) + SWEEP_GRACE_MS < nowMs) {
          this.expire(repos, trade);
          n++;
        }
      }
    } catch (err) {
      this.log.error({ err: { message: (err as Error).message } }, 'Trade sweep failed');
    }
    return n;
  }

  private versionOf(repos: Repositories, trade: Trade): VersionPayload | null {
    const v = repos.strategyVersions.get({ strategy_id: trade.strategy_id, version: trade.strategy_version });
    if (!v) return null;
    try {
      return parseVersionPayload(v);
    } catch {
      return null;
    }
  }

  /** The window closed without a fill: `skipped`, `window_expired = 1`, keeping the last soft reason. */
  private expire(repos: Repositories, trade: Trade): void {
    const updated = transitionTrade(repos, iso(this.now()), trade, 'skipped', {
      window_expired: 1,
      skip_reason: trade.skip_reason ?? 'window_expired',
    });
    this.log.info(
      { mode: updated.effective_mode, tradeId: trade.id, gameId: trade.game_id, reason: updated.skip_reason },
      `Trade skipped: the entry window closed (${updated.skip_reason ?? 'no reason'})`,
    );
    this.changed(updated);
  }

  /** The effective mode right now, read from the database (§1: again before every attempt). */
  private currentMode(repos: Repositories, trade: Trade): ModeResult {
    const s = loadStrategy(repos, trade.strategy_id);
    const g = readGlobalSwitches(repos, this.options.allowLiveOrders);
    if (!s || s.deletedAt !== null) return { mode: 'paused', reason: 'strategy_kill_switch' };
    return computeMode({ ...g, strategyKill: s.killSwitch, strategyMode: s.mode });
  }

  /** One attempt (runs inside the serial queue). */
  private async attempt(tradeId: string, state: ObservedState): Promise<void> {
    const repos = this.options.repos();
    let trade = repos.trades.get({ id: tradeId });
    if (!trade || !(OPEN_STATUSES as readonly string[]).includes(trade.status)) return;
    const payload = this.versionOf(repos, trade);
    if (!payload || trade.market_ticker === null) return;
    const ticker = trade.market_ticker;

    // 1. The attempt row, before any HTTP (§4).
    const mode = this.currentMode(repos, trade);
    const attemptMode: 'live' | 'dry_run' = mode.mode === 'live' ? 'live' : 'dry_run';
    const attemptReason = mode.mode === 'dry_run' ? mode.reason : null;
    const attemptNo = trade.attempts + 1;
    const startedAt = iso(this.now());
    let attempt: TradeAttempt = repos.tradeAttempts.insert({
      trade_id: trade.id,
      attempt_no: attemptNo,
      at: startedAt,
      effective_mode: mode.mode === 'paused' ? trade.effective_mode : attemptMode,
      mode_reason: mode.mode === 'paused' ? trade.mode_reason : attemptReason,
      client_order_id: `${trade.id}-${attemptNo}`,
      status: 'pending',
    });
    trade = repos.trades.update({ id: trade.id }, { attempts: attemptNo }) ?? trade;
    auditTrade(
      repos,
      startedAt,
      trade.id,
      attempt.effective_mode === 'live' ? 'live' : 'dry_run',
      'attempt_pending',
      {
        attemptNo,
        clientOrderId: attempt.client_order_id,
      },
    );
    const modePatch =
      mode.mode === 'paused' ? {} : { effective_mode: attemptMode, mode_reason: attemptReason };

    const finish = (
      status: 'soft_skip' | 'hard_skip' | 'error',
      reason: AttemptReason,
      facts: Partial<EntryFacts> = {},
      response?: Record<string, unknown>,
    ) => {
      const at = iso(this.now());
      const current = repos.trades.get({ id: tradeId }) ?? (trade as Trade);
      attempt = updateAttempt(repos, at, attempt, {
        status,
        reason,
        best_ask_bp: facts.bestAskBp ?? null,
        depth_cc: facts.depthCc ?? null,
        limit_price_bp: facts.limitBp ?? null,
        requested_cc: facts.requestedCc ?? null,
        ...(response ? { response: JSON.stringify(response) } : {}),
      });
      const next = status === 'hard_skip' ? 'skipped' : 'waiting';
      const updated = transitionTrade(repos, at, current, next, { ...modePatch, skip_reason: reason });
      const logMode = updated.effective_mode === 'live' ? 'live' : 'dry_run';
      const fields = { mode: logMode, tradeId, attemptNo, reason, marketTicker: ticker };
      if (status === 'error')
        this.log.error(
          fields,
          `Attempt ${attemptNo} failed (${reason})${response?.['error'] ? `: ${String(response['error'])}` : ''}`,
        );
      else
        this.log.info(
          fields,
          `Attempt ${attemptNo}: ${next === 'skipped' ? 'skipped' : 'waiting'} (${reason})`,
        );
      this.changed(updated);
    };

    // 2. Effective mode again (a kill switch may have been turned on mid-window).
    if (mode.mode === 'paused') return finish('hard_skip', 'paused');
    const live = mode.mode === 'live';

    const kalshi = this.options.kalshi();
    if (!kalshi) return finish('error', 'error', {}, { error: 'Kalshi is not configured' });

    let facts: Partial<EntryFacts> = {};
    try {
      // 3. Market, exchange status, orderbook (and in live mode the Kalshi balance).
      const market = await kalshi.getMarket(ticker);
      const exchange = await kalshi.getExchangeStatus();
      const book = await kalshi.getOrderbook(ticker);
      const nowMs = this.now();
      this.recordMarket(repos, ticker, market, book, nowMs);
      const balance = live
        ? (await kalshi.getBalance()).cash_micros - this.pendingLiveCostMicros(repos, attempt.id)
        : repos.settings.get('dry_run_bankroll_micros');

      const latest = repos.gameSnapshots.latestObservedAt(trade.game_id);
      const observed = [latest ? Date.parse(latest) : null, state.observedAtMs].filter(
        (v): v is number => v !== null && !Number.isNaN(v),
      );
      const game = repos.games.get({ id: trade.game_id });
      const exec = payload.execution;
      const sizing = payload.sizing;
      const priceRanges: PriceRange[] = market.price_ranges;
      const result = evaluateEntry({
        effectiveMode: mode.mode,
        nowMs,
        market: {
          status: market.status,
          closeTimeMs: market.close_time ? Date.parse(market.close_time) : null,
        },
        tradingActive: exchange.trading_active,
        newestObservationMs: observed.length > 0 ? Math.max(...observed) : null,
        maxFeedAgeSec: exec.maxFeedAgeSec,
        blocked: (game?.blocked ?? 0) === 1 || state.blocked,
        asks: book.yes_asks,
        maxPriceBp: strategyPriceBp(exec.maxPrice),
        minPriceBp: exec.minPrice === null ? null : strategyPriceBp(exec.minPrice),
        maxSlippageBp: strategyPriceBp(exec.maxSlippage),
        priceRanges,
        minDepthContracts: exec.minDepthContracts,
        balanceMicros: balance,
        percentCenti: strategyPercentCenti(sizing.percent),
        minStakeMicros: strategyUsdMicros(sizing.minStakeUsd),
        maxStakeMicros: strategyUsdMicros(sizing.maxStakeUsd),
      });
      this.recordOrderbookTop(repos, trade, book, result.limitBp, nowMs);
      if (!result.ok)
        return finish(result.class === 'hard' ? 'hard_skip' : 'soft_skip', result.reason, result);

      if (live) {
        // 4 (live). Whole contracts: the sizing, capped by what is offered at or below the limit.
        const contracts = Math.floor(Math.min(result.requestedCc, result.depthCc) / 100);
        facts = { ...result, requestedCc: contracts * 100 };
        if (contracts < 1) return finish('soft_skip', 'liquidity', facts);
        // The switches once more, right before the order (§10: enforced in the executor before any order).
        const again = this.currentMode(repos, trade);
        if (again.mode === 'paused') return finish('hard_skip', 'paused', facts);
        if (again.mode !== 'live') return finish('soft_skip', 'mode_changed', facts);
        const orderGroupId = (await this.options.orderGroups?.currentId()) ?? null;
        if (orderGroupId === null)
          return finish('error', 'error', facts, { error: 'No Kalshi order group is available' });
        return await this.placeLiveOrder(repos, {
          trade,
          attempt,
          ticker,
          limitBp: result.limitBp,
          contracts,
          balanceMicros: balance,
          stakeMicros: result.stakeMicros,
          bestAskBp: result.bestAskBp,
          depthCc: result.depthCc,
          orderGroupId,
          kalshi,
          finish,
        });
      }

      // 4. Virtual fill at the limit price for min(contracts, contracts offered ≤ limit).
      const multiplierMilli = await this.feeMultiplierMilli(kalshi, trade.league_id, trade.game_id);
      const fillCc = Math.min(result.requestedCc, result.depthCc);
      const precision = repos.settings.get('fee_balance_precision_micros');
      const cost = costMicros(fillCc, result.limitBp);
      const fee = feeMicros({ cc: fillCc, bp: result.limitBp, multiplierMilli, precisionMicros: precision });
      const at = iso(this.now());
      let filled: Trade | undefined;
      let bankroll = 0;
      this.options.transaction(() => {
        const current = repos.trades.get({ id: tradeId }) ?? (trade as Trade);
        const pending = transitionTrade(repos, at, current, 'pending', { ...modePatch, skip_reason: null });
        attempt = updateAttempt(repos, at, attempt, {
          status: 'filled',
          reason: null,
          best_ask_bp: result.bestAskBp,
          depth_cc: result.depthCc,
          limit_price_bp: result.limitBp,
          requested_cc: result.requestedCc,
          fill_cc: fillCc,
          avg_fill_price_bp: result.limitBp,
          fee_micros: fee,
          response: JSON.stringify({ virtual: true, multiplierMilli, precisionMicros: precision }),
        });
        bankroll = adjustBankroll(repos, at, -(cost + fee), 'fill', tradeId);
        filled = transitionTrade(
          repos,
          at,
          pending,
          'filled',
          {
            balance_micros: balance,
            stake_micros: result.stakeMicros,
            limit_price_bp: result.limitBp,
            requested_cc: result.requestedCc,
            fill_cc: fillCc,
            avg_fill_price_bp: result.limitBp,
            cost_micros: cost,
            fee_micros: fee,
          },
          { fillCc, avgBp: result.limitBp, costMicros: cost, feeMicros: fee, bankrollMicros: bankroll },
        );
      });
      if (filled) {
        this.log.info(
          {
            mode: 'dry_run',
            tradeId,
            attemptNo,
            marketTicker: ticker,
            fillCc,
            limitBp: result.limitBp,
            costMicros: cost,
            feeMicros: fee,
            bankrollMicros: bankroll,
          },
          `Dry-run fill: ${fillCc / 100} contracts of ${ticker} at ${result.limitBp / 10_000}`,
        );
        this.changed(filled);
      }
    } catch (err) {
      finish('error', 'error', facts, {
        error: (err as Error).message.slice(0, 300),
        name: (err as Error).name,
      });
    }
  }

  /** Cost (`requested_cc × limit_price_bp`) of this app's live attempts still `pending`, except `exceptId`. */
  pendingLiveCostMicros(repos: Repositories, exceptId?: number): number {
    return repos.tradeAttempts
      .listByStatus('pending')
      .filter((a) => a.effective_mode === 'live' && a.id !== exceptId)
      .reduce((sum, a) => sum + (a.requested_cc ?? 0) * (a.limit_price_bp ?? 0), 0);
  }

  /**
   * The live order (§2 Place order, §6 Filling): the trade goes `pending` with the attempt's limit and count
   * stored first (a crash leaves a findable record), then Create Order V2 is sent and its answer applied.
   */
  private async placeLiveOrder(
    repos: Repositories,
    o: {
      trade: Trade;
      attempt: TradeAttempt;
      ticker: string;
      limitBp: number;
      contracts: number;
      balanceMicros: number;
      stakeMicros: number;
      bestAskBp: number | null;
      depthCc: number;
      orderGroupId: string;
      kalshi: ExecutorKalshi;
      finish: (
        status: 'soft_skip' | 'hard_skip' | 'error',
        reason: AttemptReason,
        facts?: Partial<EntryFacts>,
        response?: Record<string, unknown>,
      ) => void;
    },
  ): Promise<void> {
    const requestedCc = o.contracts * 100;
    const facts: Partial<EntryFacts> = {
      bestAskBp: o.bestAskBp,
      depthCc: o.depthCc,
      limitBp: o.limitBp,
      requestedCc,
    };
    const at = iso(this.now());
    let attempt = o.attempt;
    let pending: Trade | undefined;
    this.options.transaction(() => {
      attempt =
        repos.tradeAttempts.update(
          { id: attempt.id },
          {
            best_ask_bp: o.bestAskBp,
            depth_cc: o.depthCc,
            limit_price_bp: o.limitBp,
            requested_cc: requestedCc,
          },
        ) ?? attempt;
      const current = repos.trades.get({ id: o.trade.id }) ?? o.trade;
      pending = transitionTrade(
        repos,
        at,
        current,
        'pending',
        {
          effective_mode: 'live',
          mode_reason: null,
          skip_reason: null,
          balance_micros: o.balanceMicros,
          stake_micros: o.stakeMicros,
          limit_price_bp: o.limitBp,
          requested_cc: requestedCc,
        },
        { orderGroupId: o.orderGroupId, contracts: o.contracts, limitBp: o.limitBp },
      );
    });
    if (pending) this.changed(pending);
    const fields = {
      mode: 'live',
      tradeId: o.trade.id,
      attemptNo: attempt.attempt_no,
      marketTicker: o.ticker,
      clientOrderId: attempt.client_order_id,
    };
    this.log.info(
      { ...fields, contracts: o.contracts, limitBp: o.limitBp },
      `Placing a live IOC order: ${o.contracts} contracts of ${o.ticker} at ${o.limitBp / 10_000}`,
    );

    let result: OrderResult;
    try {
      result = await o.kalshi.createOrderV2({
        ticker: o.ticker,
        contracts: o.contracts,
        priceBp: o.limitBp,
        clientOrderId: attempt.client_order_id,
        orderGroupId: o.orderGroupId,
      });
    } catch (err) {
      const error = { error: (err as Error).message.slice(0, 300), name: (err as Error).name };
      if (err instanceof NetworkPaused) return o.finish('error', 'error', facts, error);
      if (err instanceof KalshiApiError && err.status !== 429 && err.status < 500) {
        const detail = { ...error, status: err.status, code: err.code };
        if (isOrderGroupLimit(err)) {
          this.options.orderGroups?.markLimitHit();
          this.log.warn(
            { ...fields, code: err.code },
            'Live order rejected by the order group limit; reset the group in Settings → Trading',
          );
          return o.finish('soft_skip', 'order_group_limit', facts, detail);
        }
        if (isUnknownOrderGroup(err)) {
          this.options.orderGroups?.invalidate();
          return o.finish('error', 'error', facts, detail);
        }
        return o.finish('hard_skip', 'order_rejected', facts, detail);
      }
      // The order may or may not exist: look it up by client_order_id before deciding anything.
      let found: Order | null;
      try {
        found = await this.lookupOrder(o.kalshi, o.ticker, attempt);
      } catch (lookupErr) {
        this.log.error(
          { ...fields, err: { message: (lookupErr as Error).message } },
          'Live order outcome unknown; the attempt stays pending and is resolved on the next settler run',
        );
        return;
      }
      if (found) {
        this.recordLiveOutcome(repos, o.trade.id, attempt, outcomeFromOrder(found), 'order_not_found', false);
        return;
      }
      return o.finish('error', 'error', facts, error);
    }
    this.recordLiveOutcome(
      repos,
      o.trade.id,
      attempt,
      outcomeFromResult(result, o.limitBp),
      'unfilled',
      false,
    );
  }

  /** The order of a live attempt, by `client_order_id` among the orders of its ticker since `at − 60 s`. */
  private async lookupOrder(
    kalshi: Pick<ExecutorKalshi, 'getOrders' | 'getHistoricalOrders'>,
    ticker: string,
    attempt: TradeAttempt,
  ): Promise<Order | null> {
    const filter = { ticker, minTs: Date.parse(attempt.at) - ORDER_LOOKUP_SLACK_MS };
    const match = (orders: Order[]) => orders.find((x) => x.client_order_id === attempt.client_order_id);
    return match(await kalshi.getOrders(filter)) ?? match(await kalshi.getHistoricalOrders(filter)) ?? null;
  }

  /**
   * Applies a live order's outcome in one transaction: a fill → attempt and trade `filled` with the exchange's
   * count, average price, cost and fee; nothing filled (or no order: `notFoundReason`) → attempt `unfilled`,
   * trade `waiting` — or `skipped` with `window_expired` when `expireClosedWindow` and the window has ended.
   */
  private recordLiveOutcome(
    repos: Repositories,
    tradeId: string,
    attempt: TradeAttempt,
    outcome: LiveOutcome | null,
    notFoundReason: AttemptReason,
    expireClosedWindow: boolean,
  ): Trade | undefined {
    const nowMs = this.now();
    const at = iso(nowMs);
    let updated: Trade | undefined;
    this.options.transaction(() => {
      const current = repos.trades.get({ id: tradeId });
      if (!current) return;
      if (outcome && outcome.fillCc > 0) {
        updateAttempt(repos, at, attempt, {
          status: 'filled',
          reason: null,
          fill_cc: outcome.fillCc,
          avg_fill_price_bp: outcome.avgFillPriceBp,
          fee_micros: outcome.feeMicros,
          kalshi_order_id: outcome.orderId,
          response: JSON.stringify(outcome.response),
        });
        updated = transitionTrade(
          repos,
          at,
          current,
          'filled',
          {
            effective_mode: 'live',
            mode_reason: null,
            skip_reason: null,
            fill_cc: outcome.fillCc,
            avg_fill_price_bp: outcome.avgFillPriceBp,
            cost_micros: outcome.costMicros,
            fee_micros: outcome.feeMicros,
            kalshi_order_id: outcome.orderId,
          },
          {
            fillCc: outcome.fillCc,
            avgBp: outcome.avgFillPriceBp,
            costMicros: outcome.costMicros,
            feeMicros: outcome.feeMicros,
            orderId: outcome.orderId,
          },
        );
        return;
      }
      const reason: AttemptReason = outcome ? 'unfilled' : notFoundReason;
      updateAttempt(repos, at, attempt, {
        status: 'unfilled',
        reason,
        fill_cc: 0,
        kalshi_order_id: outcome?.orderId ?? null,
        ...(outcome ? { response: JSON.stringify(outcome.response) } : {}),
      });
      const open = !expireClosedWindow || Date.parse(current.window_ends_at) > nowMs;
      updated = transitionTrade(
        repos,
        at,
        current,
        open ? 'waiting' : 'skipped',
        { skip_reason: reason, ...(open ? {} : { window_expired: 1 }) },
        expireClosedWindow ? { recovered: true } : {},
      );
    });
    if (!updated) return undefined;
    const fields = {
      mode: 'live',
      tradeId,
      attemptNo: attempt.attempt_no,
      clientOrderId: attempt.client_order_id,
      marketTicker: updated.market_ticker,
    };
    if (updated.status === 'filled')
      this.log.info(
        {
          ...fields,
          fillCc: updated.fill_cc,
          avgFillPriceBp: updated.avg_fill_price_bp,
          costMicros: updated.cost_micros,
          feeMicros: updated.fee_micros,
          orderId: updated.kalshi_order_id,
        },
        `Live fill: ${(updated.fill_cc ?? 0) / 100} contracts of ${updated.market_ticker ?? ''} at ${(updated.avg_fill_price_bp ?? 0) / 10_000}`,
      );
    else
      this.log.info(
        { ...fields, reason: updated.skip_reason },
        `Live attempt ${attempt.attempt_no}: nothing filled (${updated.skip_reason ?? ''}); trade ${updated.status}`,
      );
    this.changed(updated);
    return updated;
  }

  /**
   * Resolves `pending` live attempts (§4 restart recovery; also every settler run for attempts whose outcome
   * was unknown): the order is looked up by `client_order_id` (`GET /portfolio/orders?ticker&min_ts`, then
   * `/historical/orders`) and applied; no order → `unfilled` with `notFoundReason`. Attempts whose lookup fails
   * stay `pending` (counted as `unresolved`).
   */
  async resolvePendingLive(
    notFoundReason: 'restart_no_order' | 'order_not_found',
    minAgeMs = 0,
  ): Promise<{ filled: number; unfilled: number; unresolved: number }> {
    const out = { filled: 0, unfilled: 0, unresolved: 0 };
    const repos = this.options.repos();
    const nowMs = this.now();
    const pending = repos.tradeAttempts
      .listByStatus('pending')
      .filter(
        (a) =>
          a.effective_mode === 'live' && !this.busy.has(a.trade_id) && nowMs - Date.parse(a.at) >= minAgeMs,
      );
    if (pending.length === 0) return out;
    const kalshi = this.options.kalshi();
    for (const a of pending) {
      const trade = repos.trades.get({ id: a.trade_id });
      if (!trade?.market_ticker || !kalshi) {
        out.unresolved++;
        continue;
      }
      let found: Order | null;
      try {
        found = await this.lookupOrder(kalshi, trade.market_ticker, a);
      } catch (err) {
        out.unresolved++;
        this.log.warn(
          {
            mode: 'live',
            tradeId: a.trade_id,
            clientOrderId: a.client_order_id,
            err: { message: (err as Error).message },
          },
          'A pending live order could not be looked up; retried later',
        );
        continue;
      }
      const updated = this.recordLiveOutcome(
        repos,
        a.trade_id,
        a,
        found ? outcomeFromOrder(found) : null,
        notFoundReason,
        true,
      );
      if (updated?.status === 'filled') out.filled++;
      else out.unfilled++;
    }
    if (out.filled + out.unfilled + out.unresolved > 0)
      this.log.info({ mode: 'live', ...out }, 'Resolved pending live attempts');
    return out;
  }

  /** Keeps the `markets` row current (status, close time, bid / ask, grid). */
  private recordMarket(
    repos: Repositories,
    ticker: string,
    market: Awaited<ReturnType<ExecutorKalshi['getMarket']>>,
    book: Orderbook,
    nowMs: number,
  ): void {
    if (!repos.markets.get({ ticker })) return;
    repos.markets.update(
      { ticker },
      {
        status: market.status,
        close_time: market.close_time,
        price_ranges: JSON.stringify(market.price_ranges),
        yes_bid_bp: book.yes_bids[0]?.price_bp ?? market.yes_bid_bp,
        yes_ask_bp: book.yes_asks[0]?.price_bp ?? market.yes_ask_bp,
        updated_at: iso(nowMs),
      },
    );
  }

  /** The first attempt stores the orderbook top next to the trigger snapshot ("ask at trigger"). */
  private recordOrderbookTop(
    repos: Repositories,
    trade: Trade,
    book: Orderbook,
    limitBp: number | null,
    nowMs: number,
  ): void {
    const snap = parseSnapshot(trade.trigger_snapshot);
    if (!snap || snap.orderbook) return;
    const bestAsk = book.yes_asks[0]?.price_bp ?? null;
    snap.orderbook = {
      at: iso(nowMs),
      bestAskBp: bestAsk,
      bestBidBp: book.yes_bids[0]?.price_bp ?? null,
      askDepthCc: depthAtOrBelow(book.yes_asks, limitBp ?? bestAsk ?? 0),
    };
    repos.trades.update({ id: trade.id }, { trigger_snapshot: JSON.stringify(snap) });
  }

  /**
   * The fee multiplier (§2 Fees): the event's `fee_multiplier` when it reports one, else the series'; both
   * are read once per process. A failed lookup falls back to 1 (every configured series reports 1) with a
   * `warn`.
   */
  private async feeMultiplierMilli(
    kalshi: ExecutorKalshi,
    leagueId: string,
    eventTicker: string,
  ): Promise<number> {
    const repos = this.options.repos();
    const series = repos.leagues.get({ id: leagueId })?.kalshi_series;
    const lookup = async (key: string, read: () => Promise<number | null | undefined>) => {
      if (this.multipliers.has(key)) return this.multipliers.get(key) ?? null;
      let value: number | null = null;
      try {
        const m = await read();
        value = m === null || m === undefined ? null : toMultiplierMilli(m);
      } catch (err) {
        this.log.warn(
          { mode: 'dry_run', key, err: { message: (err as Error).message } },
          `Fee multiplier of ${key} could not be read`,
        );
      }
      this.multipliers.set(key, value);
      return value;
    };
    const event = await lookup(
      `event:${eventTicker}`,
      async () => (await kalshi.getEvent(eventTicker)).fee_multiplier,
    );
    if (event !== null) return event;
    if (series) {
      const s = await lookup(`series:${series}`, async () => (await kalshi.getSeries(series)).fee_multiplier);
      if (s !== null) return s;
    }
    return 1000;
  }

  /**
   * Start-up recovery (§4), before the scheduler starts. First every `pending` **live** attempt is resolved
   * against Kalshi by its `client_order_id` (`resolvePendingLive`): a fill is applied, no order →
   * `unfilled/restart_no_order`; an attempt whose lookup fails stays `pending` (retried by the settler loop).
   * Then `pending` dry-run attempts become `unfilled` (`restart`); their trades — and trades left `signalled` /
   * `pending` without a pending live attempt — return to `waiting` while the window is still open, else
   * `skipped` (`window_expired = 1`).
   */
  async recoverOnStart(): Promise<{
    attempts: number;
    waiting: number;
    skipped: number;
    live: { filled: number; unfilled: number; unresolved: number };
  }> {
    const live = await this.resolvePendingLive('restart_no_order');
    const repos = this.options.repos();
    const nowMs = this.now();
    const at = iso(nowMs);
    const out = { attempts: 0, waiting: 0, skipped: 0, live };
    const touched = new Set<string>();
    this.options.transaction(() => {
      const unresolvedLive = new Set<string>();
      for (const a of repos.tradeAttempts.listByStatus('pending')) {
        if (a.effective_mode === 'live') {
          unresolvedLive.add(a.trade_id);
          continue;
        }
        updateAttempt(repos, at, a, { status: 'unfilled', reason: 'restart' });
        touched.add(a.trade_id);
        out.attempts++;
      }
      for (const t of repos.trades.listByStatus(['signalled', 'pending', 'waiting'])) {
        if (unresolvedLive.has(t.id)) continue;
        if (t.status === 'waiting' && !touched.has(t.id) && Date.parse(t.window_ends_at) > nowMs) continue;
        const open = Date.parse(t.window_ends_at) > nowMs;
        const updated = open
          ? t.status === 'waiting'
            ? t
            : transitionTrade(
                repos,
                at,
                t,
                'waiting',
                { skip_reason: t.skip_reason ?? 'restart' },
                { restart: true },
              )
          : transitionTrade(
              repos,
              at,
              t,
              'skipped',
              { window_expired: 1, skip_reason: t.skip_reason ?? 'restart' },
              { restart: true },
            );
        if (open) out.waiting++;
        else out.skipped++;
        this.changed(updated);
      }
    });
    if (out.attempts + out.waiting + out.skipped > 0) {
      this.log.info(
        { mode: 'dry_run', attempts: out.attempts, waiting: out.waiting, skipped: out.skipped },
        'Recovered open trades after a restart',
      );
    }
    return out;
  }
}
