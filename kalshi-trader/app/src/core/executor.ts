import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { KalshiEnv } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { Trade, TradeAttempt } from '../db/schema.js';
import type { Sport } from '../feeds/gameState.js';
import type { KalshiClient } from '../feeds/kalshi/client.js';
import type { Orderbook } from '../feeds/kalshi/schemas.js';
import { evaluateLeadAtTime, type Signal, type StrategyEngine } from './engine.js';
import { evaluateEntry, depthAtOrBelow, type EntryFacts, type GuardReason } from './guards.js';
import { effectiveMode as computeMode, type ModeResult } from './modes.js';
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
 *   `bankroll_snapshots` row in the same transaction as the fill. Live orders arrive in T13: a live
 *   effective mode ends the attempt as `hard_skip` / `live_not_implemented`.
 * - Nothing is ever thrown to the tracker or the scheduler: failures become attempt `error` rows.
 */

/** The Kalshi reads the executor makes. */
export type ExecutorKalshi = Pick<
  KalshiClient,
  'getMarket' | 'getOrderbook' | 'getExchangeStatus' | 'getSeries' | 'getEvent'
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
  now?: () => number;
}

/** Why an attempt ended, beyond the §5 guards. */
export type AttemptReason = GuardReason | 'live_not_implemented' | 'restart' | 'no_market';

export interface TradeEvent {
  id: string;
  status: string;
}

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

  private changed(t: Pick<Trade, 'id' | 'status'>): void {
    this.emit('trade', { id: t.id, status: t.status });
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
    if (mode.mode === 'live') return finish('hard_skip', 'live_not_implemented');

    const kalshi = this.options.kalshi();
    if (!kalshi) return finish('error', 'error', {}, { error: 'Kalshi is not configured' });

    try {
      // 3. Market, exchange status, orderbook.
      const market = await kalshi.getMarket(ticker);
      const exchange = await kalshi.getExchangeStatus();
      const book = await kalshi.getOrderbook(ticker);
      const nowMs = this.now();
      this.recordMarket(repos, ticker, market, book, nowMs);

      const latest = repos.gameSnapshots.latestObservedAt(trade.game_id);
      const observed = [latest ? Date.parse(latest) : null, state.observedAtMs].filter(
        (v): v is number => v !== null && !Number.isNaN(v),
      );
      const game = repos.games.get({ id: trade.game_id });
      const exec = payload.execution;
      const sizing = payload.sizing;
      const priceRanges: PriceRange[] = market.price_ranges;
      const balance = repos.settings.get('dry_run_bankroll_micros');
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
      finish(
        'error',
        'error',
        {},
        { error: (err as Error).message.slice(0, 300), name: (err as Error).name },
      );
    }
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
   * Start-up recovery (§4), before the scheduler starts: `pending` dry-run attempts become `unfilled`
   * (`restart`); their trades — and trades left `signalled` / `pending` — return to `waiting` while the
   * window is still open, else `skipped` (`window_expired = 1`). Live attempts are recovered in T13.
   */
  recoverOnStart(): { attempts: number; waiting: number; skipped: number } {
    const repos = this.options.repos();
    const nowMs = this.now();
    const at = iso(nowMs);
    const out = { attempts: 0, waiting: 0, skipped: 0 };
    const touched = new Set<string>();
    this.options.transaction(() => {
      for (const a of repos.tradeAttempts.listByStatus('pending')) {
        if (a.effective_mode === 'live') {
          this.log.warn(
            { mode: 'live', tradeId: a.trade_id, clientOrderId: a.client_order_id },
            'A pending live attempt was found at start-up; live recovery arrives with live trading (T13)',
          );
          continue;
        }
        updateAttempt(repos, at, a, { status: 'unfilled', reason: 'restart' });
        touched.add(a.trade_id);
        out.attempts++;
      }
      for (const t of repos.trades.listByStatus(['signalled', 'pending', 'waiting'])) {
        if (t.effective_mode === 'live' && t.status === 'pending') continue;
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
      this.log.info({ mode: 'dry_run', ...out }, 'Recovered dry-run trades after a restart');
    }
    return out;
  }
}
