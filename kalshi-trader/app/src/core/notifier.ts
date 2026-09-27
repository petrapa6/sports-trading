import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { NotificationEvent } from '../db/settings.js';
import type { Trade } from '../db/schema.js';
import { NetworkPaused, type NetworkGate } from '../feeds/network.js';
import type { TradeEvent } from './executor.js';
import { payoutMicros, realizedPnlMicros } from './pricing.js';
import type { BlockedChange, GameTracker } from './tracker.js';

/**
 * Home Assistant notifications (SPEC.md §1): a `persistent_notification.create` service call through
 * the Supervisor's Core API proxy (`http://supervisor/core/api`, `homeassistant_api: true`), authenticated
 * with `SUPERVISOR_TOKEN` from the environment.
 *
 * - Events: `trade_filled`, `trade_settled`, `kill_switch_changed`, `global_dry_run_changed`,
 *   `feed_disagreement`. Every message starts with the mode (`[LIVE]` / `[DRY RUN]`) and the Kalshi
 *   environment; trade messages name the strategy and the P&L.
 * - Settings → Notifications (`settings.notifications`): per-event and per-mode toggles; a notification is
 *   sent only when both are on.
 * - Without a token (outside Home Assistant) nothing is sent and each skipped notification logs one `debug`
 *   line. Requests pass the network gate: while the global kill switch is on nothing is sent (§1: no
 *   outgoing HTTP at all), so the switch turning **on** is never notified.
 * - Failures are logged at `warn` and never affect trading; the token is never logged.
 */

export const SUPERVISOR_CORE_URL = 'http://supervisor/core/api';
export const NOTIFICATION_TITLE = 'Kalshi Sports Trader';
const TIMEOUT_MS = 10_000;

export type NotifyMode = 'live' | 'dry_run';

export const MODE_TAG: Record<NotifyMode, string> = { live: '[LIVE]', dry_run: '[DRY RUN]' };

export interface NotifierOptions {
  repos: () => Repositories;
  log: Logger;
  /** `SUPERVISOR_TOKEN`; without it every notification is a no-op. */
  token: string | undefined;
  kalshiEnv: string;
  gate: NetworkGate;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Micro-dollars as `$1,234.56` with a sign (`+$0.91`, `−$11.09`), integer arithmetic. */
export function signedUsd(micros: number): string {
  const cents = Math.floor((Math.abs(micros) + 5000) / 10_000);
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  const sign = micros < 0 ? '−' : '+';
  return `${sign}$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** Micro-dollars as `$11.04` (no sign). */
export const usd = (micros: number): string => signedUsd(Math.abs(micros)).slice(1);

/** A price in $0.0001 units as `$0.92` / `$0.925`. */
export function price(bp: number): string {
  const frac = String(bp % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `$${Math.floor(bp / 10_000)}.${frac}`;
}

/** Centi-contracts as contracts (`1200` → `12`, `150` → `1.5`). */
function contracts(cc: number): string {
  const frac = String(cc % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${Math.floor(cc / 100)}.${frac}` : String(Math.floor(cc / 100));
}

export class Notifier {
  private readonly log: Logger;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NotifierOptions) {
    this.log = options.log.child({ component: 'notifier' });
    this.baseUrl = (options.baseUrl ?? SUPERVISOR_CORE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Whether a Supervisor token is present (Settings → Notifications shows it). */
  get available(): boolean {
    return this.options.token !== undefined && this.options.token !== '';
  }

  /** Resolves once every notification started so far has been sent or dropped (tests, shutdown). */
  idle(): Promise<unknown> {
    return this.pending;
  }

  /**
   * Sends one notification when its event and mode are switched on. Returns whether a request was made
   * and answered 2xx. Never throws.
   */
  async send(event: NotificationEvent, mode: NotifyMode, text: string): Promise<boolean> {
    try {
      const settings = this.options.repos().settings.get('notifications');
      if (settings.events[event] === false || !settings.modes[mode]) return false;
    } catch (err) {
      this.log.warn(
        { event, mode, err: { message: (err as Error).message } },
        'Notification settings unreadable',
      );
      return false;
    }
    if (!this.available) {
      this.log.debug(
        { event, mode },
        'Home Assistant notification not sent: SUPERVISOR_TOKEN is not set (not running in Home Assistant)',
      );
      return false;
    }
    try {
      this.options.gate.assertNetworkAllowed();
    } catch (err) {
      if (err instanceof NetworkPaused) {
        this.log.debug({ event, mode }, 'Home Assistant notification not sent: the global kill switch is on');
        return false;
      }
      throw err;
    }
    const message = `${MODE_TAG[mode]} (${this.options.kalshiEnv}) ${text}`;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/services/persistent_notification/create`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: NOTIFICATION_TITLE, message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Not awaited: under msw the cancel never settles (same as in the Kalshi client).
      void res.body?.cancel().catch(() => undefined);
      if (!res.ok) {
        this.log.warn({ event, mode, status: res.status }, 'Home Assistant notification failed');
        return false;
      }
      this.log.debug({ event, mode }, 'Home Assistant notification sent');
      return true;
    } catch (err) {
      this.log.warn(
        { event, mode, err: { message: (err as Error).message } },
        'Home Assistant notification failed',
      );
      return false;
    }
  }

  private queue(event: NotificationEvent, mode: NotifyMode, text: () => string | null): void {
    let body: string | null;
    try {
      body = text();
    } catch (err) {
      this.log.warn({ event, err: { message: (err as Error).message } }, 'Notification could not be built');
      return;
    }
    if (body === null) return;
    const p = this.send(event, mode, body);
    this.pending = Promise.all([this.pending, p]);
  }

  private describe(trade: Trade): { strategy: string; game: string; team: string } {
    const repos = this.options.repos();
    const strategy = repos.strategies.get({ id: trade.strategy_id })?.name ?? trade.strategy_id;
    let team = trade.market_ticker ?? '';
    try {
      const snap = JSON.parse(trade.trigger_snapshot) as {
        side?: string;
        homeTeam?: string;
        awayTeam?: string;
      };
      const name = snap.side === 'home' ? snap.homeTeam : snap.side === 'away' ? snap.awayTeam : undefined;
      if (name) team = name;
    } catch {
      // keep the ticker
    }
    return { strategy, game: trade.game_id, team };
  }

  /** `trade_filled`: strategy, contracts, price, cost, fee and the P&L if it wins / loses. */
  tradeFilled(tradeId: string): void {
    const repos = this.options.repos();
    const trade = repos.trades.get({ id: tradeId });
    if (!trade) return;
    const mode: NotifyMode = trade.effective_mode === 'live' ? 'live' : 'dry_run';
    this.queue('trade_filled', mode, () => {
      const fillCc = trade.fill_cc ?? 0;
      const avgBp = trade.avg_fill_price_bp ?? 0;
      const fee = trade.fee_micros ?? 0;
      const cost = trade.cost_micros ?? fillCc * avgBp;
      const win = realizedPnlMicros({
        fillCc,
        avgBp,
        feeMicros: fee,
        payoutMicros: payoutMicros(fillCc, 10_000),
      });
      const lose = realizedPnlMicros({ fillCc, avgBp, feeMicros: fee, payoutMicros: 0 });
      const d = this.describe(trade);
      return (
        `Trade filled: "${d.strategy}" bought ${contracts(fillCc)} × ${d.team} YES at ${price(avgBp)} ` +
        `(${trade.market_ticker ?? d.game}); cost ${usd(cost)}, fee ${usd(fee)}; ` +
        `P&L ${signedUsd(win)} if it wins, ${signedUsd(lose)} if it loses.`
      );
    });
  }

  /** `trade_settled`: strategy, result and realized P&L. */
  tradeSettled(tradeId: string): void {
    const repos = this.options.repos();
    const trade = repos.trades.get({ id: tradeId });
    if (!trade || !trade.status.startsWith('settled_')) return;
    const mode: NotifyMode = trade.effective_mode === 'live' ? 'live' : 'dry_run';
    this.queue('trade_settled', mode, () => {
      const d = this.describe(trade);
      const result = trade.status.replace('settled_', '');
      return (
        `Trade settled (${result}): "${d.strategy}" on ${d.team} (${trade.market_ticker ?? d.game}); ` +
        `realized P&L ${signedUsd(trade.realized_pnl_micros ?? 0)}.`
      );
    });
  }

  /** `kill_switch_changed` / `global_dry_run_changed`; `mode` is the global mode after the change. */
  switchChanged(key: 'global_kill_switch' | 'global_dry_run', on: boolean, mode: NotifyMode): void {
    const event = key === 'global_kill_switch' ? 'kill_switch_changed' : 'global_dry_run_changed';
    const name = key === 'global_kill_switch' ? 'Global kill switch' : 'Global dry run';
    this.queue(event, mode, () => `${name} turned ${on ? 'on' : 'off'}.`);
  }

  /** `feed_disagreement`: a game blocked (or unblocked) because the feeds disagree on the score. */
  blockedChanged(change: BlockedChange, mode: NotifyMode): void {
    this.queue('feed_disagreement', mode, () => {
      const scores = Object.entries(change.scores)
        .map(([feed, score]) => `${feed} ${score}`)
        .join(', ');
      return change.blocked
        ? `Feeds disagree on the score of ${change.gameId} for more than 20 s (${scores}); entries blocked.`
        : `Feeds agree again on ${change.gameId} (${scores}); entries unblocked.`;
    });
  }

  /** Subscribes to trade changes (executor fills, settler settlements) and feed disagreements. */
  attach(o: {
    executor?: { on(event: 'trade', l: (t: TradeEvent) => void): unknown };
    settler?: { on(event: 'trade', l: (t: TradeEvent) => void): unknown };
    tracker?: Pick<GameTracker, 'on'>;
    /** The global mode now (switch-independent events: `feed_disagreement`). */
    globalMode: () => NotifyMode;
  }): this {
    o.executor?.on('trade', (t) => {
      if (t.status === 'filled') this.tradeFilled(t.id);
    });
    o.settler?.on('trade', (t) => {
      if (t.status.startsWith('settled_')) this.tradeSettled(t.id);
    });
    o.tracker?.on('blockedChanged', (c) => {
      let mode: NotifyMode = 'dry_run';
      try {
        mode = o.globalMode();
      } catch {
        // database unavailable: label it dry run
      }
      this.blockedChanged(c, mode);
    });
    return this;
  }
}
