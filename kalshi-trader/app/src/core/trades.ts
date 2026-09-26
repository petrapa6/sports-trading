import { and, eq, gte, inArray, type SQL } from 'drizzle-orm';
import type { Repositories } from '../db/repositories.js';
import { trades as tradesTable, type Trade, type TradeAttempt } from '../db/schema.js';

/**
 * Trades in the database (SPEC.md §6, §7 `trades` / `trade_attempts` / `bankroll_snapshots`): the status
 * transitions shared by the executor, the settler and start-up recovery — each one writes an `audit_log` row
 * (`entity = 'trade'`, `entity_id` = the trade id, `mode`) — the shared dry-run bankroll, and the read models
 * of the Trades page (`GET /api/trades`).
 */

export const TRADE_STATUSES = [
  'signalled',
  'waiting',
  'pending',
  'filled',
  'skipped',
  'settled_won',
  'settled_lost',
  'settled_void',
] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** Trades an attempt may still be made for. */
export const OPEN_STATUSES: readonly TradeStatus[] = ['signalled', 'waiting'];
export const SETTLED_STATUSES: readonly TradeStatus[] = ['settled_won', 'settled_lost', 'settled_void'];

export type AttemptStatus = 'pending' | 'filled' | 'unfilled' | 'soft_skip' | 'hard_skip' | 'error';

export type TradeMode = 'live' | 'dry_run';

const modeOf = (t: Pick<Trade, 'effective_mode'>): TradeMode =>
  t.effective_mode === 'live' ? 'live' : 'dry_run';

/** Appends a trade audit row (`actor = 'system'`). */
export function auditTrade(
  repos: Repositories,
  atIso: string,
  tradeId: string,
  mode: TradeMode,
  action: string,
  detail?: Record<string, unknown>,
): void {
  repos.auditLog.insert({
    at: atIso,
    actor: 'system',
    ip: null,
    channel: null,
    mode,
    action,
    entity: 'trade',
    entity_id: tradeId,
    detail: detail ? JSON.stringify(detail) : null,
  });
}

/**
 * Moves a trade to `status` (plus `patch`) and writes the `trade_<status>` audit row with the trade's
 * (possibly updated) effective mode. Returns the updated row.
 */
export function transitionTrade(
  repos: Repositories,
  atIso: string,
  trade: Trade,
  status: TradeStatus,
  patch: Partial<Omit<Trade, 'id' | 'status'>> = {},
  detail: Record<string, unknown> = {},
): Trade {
  const updated = repos.trades.update({ id: trade.id }, { ...patch, status });
  if (!updated) throw new Error(`trade ${trade.id} vanished`);
  auditTrade(repos, atIso, trade.id, modeOf(updated), `trade_${status}`, {
    from: trade.status,
    ...(updated.skip_reason && (status === 'waiting' || status === 'skipped')
      ? { reason: updated.skip_reason }
      : {}),
    ...detail,
  });
  return updated;
}

/** Updates an attempt row and writes the `attempt_<status>` audit row. */
export function updateAttempt(
  repos: Repositories,
  atIso: string,
  attempt: TradeAttempt,
  patch: Partial<Omit<TradeAttempt, 'id'>>,
): TradeAttempt {
  const updated = repos.tradeAttempts.update({ id: attempt.id }, patch);
  if (!updated) throw new Error(`attempt ${attempt.id} vanished`);
  auditTrade(
    repos,
    atIso,
    attempt.trade_id,
    updated.effective_mode === 'live' ? 'live' : 'dry_run',
    `attempt_${updated.status}`,
    {
      attemptNo: updated.attempt_no,
      clientOrderId: updated.client_order_id,
      ...(updated.reason ? { reason: updated.reason } : {}),
    },
  );
  return updated;
}

/**
 * Adds `deltaMicros` to the shared dry-run bankroll and writes a `bankroll_snapshots` row. Must run inside
 * the same SQLite transaction as the trade state change (§4: no lost update). Returns the new bankroll.
 */
export function adjustBankroll(
  repos: Repositories,
  atIso: string,
  deltaMicros: number,
  reason: 'fill' | 'settlement',
  tradeId: string,
): number {
  const next = repos.settings.get('dry_run_bankroll_micros') + deltaMicros;
  repos.settings.set('dry_run_bankroll_micros', next);
  repos.bankrollSnapshots.insert({ at: atIso, trade_id: tradeId, reason, bankroll_micros: next });
  return next;
}

/** Resets the dry-run bankroll to its initial value and writes a `bankroll_snapshots` row (`reset`). */
export function resetBankroll(repos: Repositories, atIso: string): { from: number; to: number } {
  const from = repos.settings.get('dry_run_bankroll_micros');
  const to = repos.settings.get('dry_run_initial_bankroll_micros');
  repos.settings.set('dry_run_bankroll_micros', to);
  repos.bankrollSnapshots.insert({ at: atIso, trade_id: null, reason: 'reset', bankroll_micros: to });
  return { from, to };
}

// ---- read models ---------------------------------------------------------------------------------------

/** The orderbook top the first attempt saw, stored with the trigger snapshot. */
export interface OrderbookTop {
  at: string;
  bestAskBp: number | null;
  bestBidBp: number | null;
  askDepthCc: number;
}

/** The trigger snapshot of a trade (the signal's `GameState` plus the orderbook top of the first attempt). */
export interface TriggerSnapshot {
  gameId: string;
  leagueId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  phase: string;
  clock: {
    minute?: number;
    minuteSource?: 'feed' | 'derived';
    period?: number;
    secondsLeftInPeriod?: number;
    regulationOver: boolean;
  };
  blocked: boolean;
  source: string;
  observedAt: string;
  feedUpdatedAt: string | null;
  side?: 'home' | 'away';
  minute?: number;
  orderbook?: OrderbookTop;
}

/** The stored snapshot, or `null` when it is not valid JSON with a score and a clock. */
export function parseSnapshot(text: string): TriggerSnapshot | null {
  try {
    const v = JSON.parse(text) as Partial<TriggerSnapshot> | null;
    if (!v || typeof v !== 'object' || typeof v.clock !== 'object' || v.clock === null) return null;
    if (typeof v.homeScore !== 'number' || typeof v.awayScore !== 'number') return null;
    return v as TriggerSnapshot;
  } catch {
    return null;
  }
}

/** A trade as the API and the Trades page see it. */
export interface TradeView {
  id: string;
  strategyId: string;
  strategyName: string | null;
  strategyVersion: number;
  gameId: string;
  leagueId: string;
  sport: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  marketTicker: string | null;
  side: 'home' | 'away' | null;
  kalshiEnv: string;
  configuredMode: string;
  effectiveMode: string;
  modeReason: string | null;
  status: string;
  skipReason: string | null;
  windowExpired: boolean;
  attempts: number;
  triggeredAt: string;
  windowEndsAt: string;
  minute: number | null;
  score: string | null;
  askAtTriggerBp: number | null;
  balanceMicros: number | null;
  stakeMicros: number | null;
  limitPriceBp: number | null;
  requestedCc: number | null;
  fillCc: number | null;
  avgFillPriceBp: number | null;
  costMicros: number | null;
  feeMicros: number | null;
  settledAt: string | null;
  settlementValueBp: number | null;
  payoutMicros: number | null;
  realizedPnlMicros: number | null;
  reconcileWarning: string | null;
}

export interface AttemptView {
  attemptNo: number;
  at: string;
  effectiveMode: string;
  modeReason: string | null;
  clientOrderId: string;
  status: string;
  reason: string | null;
  bestAskBp: number | null;
  depthCc: number | null;
  limitPriceBp: number | null;
  requestedCc: number | null;
  fillCc: number | null;
  avgFillPriceBp: number | null;
  feeMicros: number | null;
}

export interface AuditView {
  at: string;
  actor: string;
  mode: string | null;
  action: string;
  detail: Record<string, unknown> | null;
}

export interface TradeDetail extends TradeView {
  snapshot: TriggerSnapshot | null;
  attemptsList: AttemptView[];
  audit: AuditView[];
}

interface Lookups {
  strategyName: (id: string) => string | null;
  league: (id: string) => { sport: string } | null;
  teams: (gameId: string) => { home: string | null; away: string | null };
}

function lookups(repos: Repositories): Lookups {
  const names = new Map<string, string | null>();
  const leagues = new Map<string, { sport: string } | null>();
  const games = new Map<string, { home: string | null; away: string | null }>();
  return {
    strategyName: (id) => {
      if (!names.has(id)) names.set(id, repos.strategies.get({ id })?.name ?? null);
      return names.get(id) ?? null;
    },
    league: (id) => {
      if (!leagues.has(id)) {
        const l = repos.leagues.get({ id });
        leagues.set(id, l ? { sport: l.sport } : null);
      }
      return leagues.get(id) ?? null;
    },
    teams: (gameId) => {
      let t = games.get(gameId);
      if (!t) {
        const g = repos.games.get({ id: gameId });
        const name = (teamId: string | null | undefined) =>
          teamId ? (repos.teams.get({ id: teamId })?.name ?? null) : null;
        t = { home: name(g?.home_team_id), away: name(g?.away_team_id) };
        games.set(gameId, t);
      }
      return t;
    },
  };
}

function toView(t: Trade, l: Lookups): TradeView {
  const snap = parseSnapshot(t.trigger_snapshot);
  const teams = l.teams(t.game_id);
  return {
    id: t.id,
    strategyId: t.strategy_id,
    strategyName: l.strategyName(t.strategy_id),
    strategyVersion: t.strategy_version,
    gameId: t.game_id,
    leagueId: t.league_id,
    sport: l.league(t.league_id)?.sport ?? null,
    homeTeam: teams.home ?? snap?.homeTeam ?? null,
    awayTeam: teams.away ?? snap?.awayTeam ?? null,
    marketTicker: t.market_ticker,
    side: snap?.side ?? null,
    kalshiEnv: t.kalshi_env,
    configuredMode: t.configured_mode,
    effectiveMode: t.effective_mode,
    modeReason: t.mode_reason,
    status: t.status,
    skipReason: t.skip_reason,
    windowExpired: t.window_expired === 1,
    attempts: t.attempts,
    triggeredAt: t.triggered_at,
    windowEndsAt: t.window_ends_at,
    minute: snap?.minute ?? snap?.clock.minute ?? null,
    score: snap ? `${snap.homeScore}-${snap.awayScore}` : null,
    askAtTriggerBp: snap?.orderbook?.bestAskBp ?? null,
    balanceMicros: t.balance_micros,
    stakeMicros: t.stake_micros,
    limitPriceBp: t.limit_price_bp,
    requestedCc: t.requested_cc,
    fillCc: t.fill_cc,
    avgFillPriceBp: t.avg_fill_price_bp,
    costMicros: t.cost_micros,
    feeMicros: t.fee_micros,
    settledAt: t.settled_at,
    settlementValueBp: t.settlement_value_bp,
    payoutMicros: t.payout_micros,
    realizedPnlMicros: t.realized_pnl_micros,
    reconcileWarning: t.reconcile_warning,
  };
}

/** Status filter of the Trades page: a status group, optionally one skip reason. */
export type StatusFilter = 'all' | 'open' | 'waiting' | 'filled' | 'settled' | 'skipped';

export interface TradeFilter {
  sport?: string | undefined;
  leagueIds?: readonly string[];
  strategyIds?: readonly string[];
  /** `live`, `dry_run` or `both` (each trade keeps its own mode; nothing is aggregated). */
  mode?: 'live' | 'dry_run' | 'both';
  kalshiEnv?: string | undefined;
  /** Only trades triggered at or after this time. */
  sinceIso?: string | undefined;
  status?: StatusFilter;
  /** With `status = 'skipped'` (or `waiting`): only this skip reason. */
  reason?: string | undefined;
  limit?: number;
}

const STATUS_GROUPS: Record<Exclude<StatusFilter, 'all'>, readonly TradeStatus[]> = {
  open: ['signalled', 'pending'],
  waiting: ['waiting'],
  filled: ['filled'],
  settled: SETTLED_STATUSES,
  skipped: ['skipped'],
};

export const MAX_TRADES = 5000;

/** Trades matching the filter, newest trigger first. */
export function listTrades(repos: Repositories, f: TradeFilter = {}): TradeView[] {
  const where: (SQL | undefined)[] = [];
  if (f.mode && f.mode !== 'both') where.push(eq(tradesTable.effective_mode, f.mode));
  if (f.kalshiEnv) where.push(eq(tradesTable.kalshi_env, f.kalshiEnv));
  if (f.leagueIds && f.leagueIds.length > 0) where.push(inArray(tradesTable.league_id, [...f.leagueIds]));
  if (f.strategyIds && f.strategyIds.length > 0)
    where.push(inArray(tradesTable.strategy_id, [...f.strategyIds]));
  if (f.sinceIso) where.push(gte(tradesTable.triggered_at, f.sinceIso));
  if (f.status && f.status !== 'all') where.push(inArray(tradesTable.status, [...STATUS_GROUPS[f.status]]));
  if (f.reason) where.push(eq(tradesTable.skip_reason, f.reason));
  const rows = repos.trades.newestFirst(and(...where), f.limit ?? MAX_TRADES);
  const l = lookups(repos);
  const views = rows.map((t) => toView(t, l));
  return f.sport && f.sport !== 'all' ? views.filter((v) => v.sport === f.sport) : views;
}

export function tradeDetail(repos: Repositories, id: string): TradeDetail | undefined {
  const t = repos.trades.get({ id });
  if (!t) return undefined;
  const view = toView(t, lookups(repos));
  return {
    ...view,
    snapshot: parseSnapshot(t.trigger_snapshot),
    attemptsList: repos.tradeAttempts.listForTrade(id).map((a) => ({
      attemptNo: a.attempt_no,
      at: a.at,
      effectiveMode: a.effective_mode,
      modeReason: a.mode_reason,
      clientOrderId: a.client_order_id,
      status: a.status,
      reason: a.reason,
      bestAskBp: a.best_ask_bp,
      depthCc: a.depth_cc,
      limitPriceBp: a.limit_price_bp,
      requestedCc: a.requested_cc,
      fillCc: a.fill_cc,
      avgFillPriceBp: a.avg_fill_price_bp,
      feeMicros: a.fee_micros,
    })),
    audit: repos.auditLog.listForEntity('trade', id).map((r) => {
      let detail: Record<string, unknown> | null;
      try {
        detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null;
      } catch {
        detail = null;
      }
      return { at: r.at, actor: r.actor, mode: r.mode, action: r.action, detail };
    }),
  };
}
