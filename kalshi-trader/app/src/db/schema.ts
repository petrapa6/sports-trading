/**
 * Drizzle schema for every table in SPEC.md §7. Property names are the SQL column names
 * (snake_case), so rows read and written through the repositories look exactly like the spec.
 *
 * Units: `*_micros` money, `*_bp` prices, `*_cc` contract counts (all INTEGER), ISO-8601 UTC text times.
 * Integer flags (`enabled`, `kill_switch`, `blocked`, …) are 0/1 integers as in the spec.
 *
 * Changing this file means generating a new migration: `npm run db:generate` (drizzle-kit), plus a
 * hand-written down migration in `migrations/down/` (see src/db/migrate.ts).
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const leagues = sqliteTable('leagues', {
  id: text().primaryKey(), // 'nhl','epl','laliga','bundesliga','seriea','ligue1'
  sport: text().notNull(), // 'soccer' | 'hockey'
  name: text().notNull(),
  kalshi_series: text().notNull(), // 'KXEPLGAME'
  feed_ids: text().notNull(), // JSON {"apiFootball": 39, "nhl": null}
  include_preseason: integer().notNull().default(0),
  enabled: integer().notNull().default(1),
});

export const teams = sqliteTable('teams', {
  id: text().primaryKey(),
  league_id: text().references(() => leagues.id),
  name: text().notNull(),
  abbreviation: text(),
  kalshi_target_id: text(), // structured target uuid (market custom_strike)
  aliases: text(), // JSON array (NHL tricode, feed names)
});

export const games = sqliteTable('games', {
  id: text().primaryKey(), // Kalshi event ticker
  league_id: text().references(() => leagues.id),
  competition: text(), // product_metadata.competition
  home_team_id: text(),
  away_team_id: text(),
  scheduled_at: text().notNull(), // milestone start_date
  milestone_id: text(),
  feed_game_ids: text(), // JSON per feed (incl. milestone source_ids)
  phase: text().notNull().default('scheduled'),
  home_score: integer(),
  away_score: integer(),
  clock_minute: integer(),
  minute_source: text(), // 'feed' | 'derived'
  kickoff_observed_at: text(),
  second_half_observed_at: text(),
  blocked: integer().notNull().default(0), // feed disagreement > 20 s
  final_home: integer(),
  final_away: integer(),
  finished_at: text(),
  timeline_archived: integer().notNull().default(0), // goal timeline written to hist_games
  historical: integer().notNull().default(0), // 1 = backfilled settled event (T11): never tracked or traded
  pregame_home_bp: integer(), // YES ask at kick-off (T15 underdogOnly)
  pregame_away_bp: integer(),
  updated_at: text().notNull(),
});

export const markets = sqliteTable('markets', {
  ticker: text().primaryKey(),
  game_id: text().references(() => games.id),
  outcome: text().notNull(), // 'home' | 'away' | 'tie' | 'unknown'
  status: text(),
  result: text(),
  settlement_value_bp: integer(),
  close_time: text(),
  price_ranges: text(), // JSON [{start,end,step}] in dollars strings
  yes_bid_bp: integer(),
  yes_ask_bp: integer(),
  updated_at: text(),
});

/** Feed observations, for replay and debugging. */
export const game_snapshots = sqliteTable(
  'game_snapshots',
  {
    id: integer().primaryKey(),
    game_id: text(),
    observed_at: text(),
    feed_updated_at: text(),
    feed: text(),
    home_score: integer(),
    away_score: integer(),
    phase: text(),
    clock_minute: integer(),
    minute_source: text(),
    raw: text(),
  },
  (t) => [index('ix_snapshots_game').on(t.game_id, t.observed_at)],
);

export const strategies = sqliteTable(
  'strategies',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    sport: text().notNull(),
    mode: text().notNull().default('dry_run'),
    kill_switch: integer().notNull().default(1), // 1 = paused
    current_version: integer().notNull(),
    created_at: text(),
    updated_at: text(),
    deleted_at: text(),
  },
  (t) => [check('strategies_mode_check', sql`${t.mode} IN ('dry_run','live')`)],
);

export const strategy_versions = sqliteTable(
  'strategy_versions',
  {
    strategy_id: text().references(() => strategies.id),
    version: integer(),
    league_ids: text().notNull(), // JSON
    rule: text().notNull(), // JSON
    sizing: text().notNull(), // JSON
    execution: text().notNull(), // JSON
    created_at: text(),
  },
  (t) => [primaryKey({ columns: [t.strategy_id, t.version] })],
);

export const trades = sqliteTable(
  'trades',
  {
    id: text().primaryKey(), // UUID
    strategy_id: text().notNull(),
    strategy_version: integer().notNull(),
    game_id: text().notNull(),
    market_ticker: text(),
    league_id: text().notNull(),
    kalshi_env: text().notNull(), // 'demo' | 'prod'
    configured_mode: text().notNull(), // strategy.mode at first signal
    effective_mode: text().notNull(), // 'live' | 'dry_run'
    mode_reason: text(), // null | 'strategy' | 'global_dry_run' | 'addon_lock'
    status: text().notNull(), // see §6
    skip_reason: text(),
    window_expired: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    trigger_snapshot: text().notNull(), // JSON GameState + orderbook top
    triggered_at: text().notNull(),
    window_ends_at: text().notNull(),
    balance_micros: integer(),
    stake_micros: integer(),
    limit_price_bp: integer(),
    requested_cc: integer(),
    fill_cc: integer(),
    avg_fill_price_bp: integer(),
    cost_micros: integer(),
    fee_micros: integer(),
    kalshi_order_id: text(),
    settled_at: text(),
    settlement_value_bp: integer(),
    payout_micros: integer(),
    realized_pnl_micros: integer(),
    reconcile_warning: text(),
  },
  (t) => [
    unique('trades_strategy_game_unique').on(t.strategy_id, t.game_id),
    index('ix_trades_filter').on(t.effective_mode, t.kalshi_env, t.strategy_id, t.league_id, t.triggered_at),
  ],
);

export const trade_attempts = sqliteTable(
  'trade_attempts',
  {
    id: integer().primaryKey(),
    trade_id: text()
      .notNull()
      .references(() => trades.id),
    attempt_no: integer().notNull(),
    at: text().notNull(),
    effective_mode: text().notNull(),
    mode_reason: text(),
    client_order_id: text().notNull().unique(), // '<trade.id>-<attempt_no>'
    status: text().notNull(), // 'pending','filled','unfilled','soft_skip','hard_skip','error'
    reason: text(),
    best_ask_bp: integer(),
    depth_cc: integer(),
    limit_price_bp: integer(),
    requested_cc: integer(),
    fill_cc: integer(),
    avg_fill_price_bp: integer(),
    fee_micros: integer(),
    kalshi_order_id: text(),
    response: text(), // JSON, never contains credentials
  },
  (t) => [unique('trade_attempts_trade_attempt_unique').on(t.trade_id, t.attempt_no)],
);

/** Live equity/balance line. */
export const balance_snapshots = sqliteTable('balance_snapshots', {
  id: integer().primaryKey(),
  at: text().notNull(),
  kalshi_env: text().notNull(),
  subaccount: integer().notNull(),
  cash_micros: integer(),
  portfolio_value_micros: integer(),
});

/** Shared dry-run bankroll after each change. */
export const bankroll_snapshots = sqliteTable('bankroll_snapshots', {
  id: integer().primaryKey(),
  at: text().notNull(),
  trade_id: text(),
  reason: text().notNull(), // 'fill' | 'settlement' | 'reset'
  bankroll_micros: integer().notNull(),
});

export const audit_log = sqliteTable('audit_log', {
  id: integer().primaryKey(),
  at: text().notNull(),
  actor: text().notNull(), // 'system' | 'user:<name>'
  ip: text(),
  channel: text(), // 'ingress' | 'tunnel' | 'dev' | null
  mode: text(), // 'live' | 'dry_run' | null (not trade-related)
  action: text().notNull(),
  entity: text(),
  entity_id: text(),
  detail: text(), // JSON
});

export const users = sqliteTable('users', {
  id: integer().primaryKey(),
  username: text().unique().notNull(),
  password_hash: text().notNull(), // argon2id
  totp_secret_enc: text(), // AES-256-GCM, null = TOTP off
  recovery_codes_hash: text(), // JSON array of argon2id hashes; used codes removed
  created_at: text(),
  last_login_at: text(),
});

export const sessions = sqliteTable('sessions', {
  id_hash: text().primaryKey(), // SHA-256 of the opaque session id
  user_id: integer().notNull(),
  channel: text().notNull(),
  created_at: text().notNull(),
  last_seen_at: text().notNull(),
  last_auth_at: text().notNull(),
  expires_at: text().notNull(),
  ip: text(),
  ua: text(),
});

export const login_attempts = sqliteTable('login_attempts', {
  id: integer().primaryKey(),
  at: text().notNull(),
  ip: text(),
  username: text(),
  channel: text(),
  ok: integer(),
});

/** Key/value settings; `value` is JSON. Keys and defaults live in src/db/settings.ts. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updated_at: text(),
});

// Backtesting

export const hist_games = sqliteTable(
  'hist_games',
  {
    id: text().primaryKey(),
    league_id: text(),
    season: text(),
    competition: text(),
    played_at: text(),
    home: text(),
    away: text(),
    final_home: integer(),
    final_away: integer(),
    goal_events: text().notNull(), // JSON [{side:'home', period:1, minute:23, second:10}]
    source: text().notNull(), // 'nhl' | 'kalshi_pbp' | 'live' | 'csv' | 'api_football'
    kalshi_event_ticker: text(),
  },
  (t) => [index('ix_hist_league_season').on(t.league_id, t.season)],
);

/** Kalshi 1-minute candles. */
export const hist_prices = sqliteTable(
  'hist_prices',
  {
    market_ticker: text(),
    minute_ts: text(),
    ask_open_bp: integer(),
    ask_high_bp: integer(),
    ask_low_bp: integer(),
    ask_close_bp: integer(),
    bid_close_bp: integer(),
    trade_close_bp: integer(), // nullable (no trade that minute)
    volume_cc: integer(),
  },
  (t) => [primaryKey({ columns: [t.market_ticker, t.minute_ts] })],
);

export const backtests = sqliteTable('backtests', {
  id: text().primaryKey(),
  created_at: text(),
  league_id: text(),
  season: text(),
  strategy_version_ref: text(),
  params: text(),
  price_mode: text(), // 'exact' | 'modelled'
  initial_bankroll_micros: integer(),
  result_summary: text(), // JSON metrics
});

export const backtest_trades = sqliteTable('backtest_trades', {
  id: integer().primaryKey(),
  backtest_id: text(),
  hist_game_id: text(),
  minute: integer(),
  side: text(),
  price_source: text(), // 'candle' | 'next_candle' | 'model'
  price_bp: integer(),
  contracts_cc: integer(),
  stake_micros: integer(),
  fee_micros: integer(),
  settlement_value_bp: integer(),
  pnl_micros: integer(),
  bankroll_after_micros: integer(),
  skip_reason: text(),
});

/** Every table, keyed by SQL name. */
export const tables = {
  leagues,
  teams,
  games,
  markets,
  game_snapshots,
  strategies,
  strategy_versions,
  trades,
  trade_attempts,
  balance_snapshots,
  bankroll_snapshots,
  audit_log,
  users,
  sessions,
  login_attempts,
  settings,
  hist_games,
  hist_prices,
  backtests,
  backtest_trades,
} as const;

export type TableName = keyof typeof tables;

export type League = typeof leagues.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Game = typeof games.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type GameSnapshot = typeof game_snapshots.$inferSelect;
export type Strategy = typeof strategies.$inferSelect;
export type StrategyVersion = typeof strategy_versions.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type TradeAttempt = typeof trade_attempts.$inferSelect;
export type NewTradeAttempt = typeof trade_attempts.$inferInsert;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginAttempt = typeof login_attempts.$inferSelect;
export type AuditLogEntry = typeof audit_log.$inferSelect;
export type NewAuditLogEntry = typeof audit_log.$inferInsert;
export type HistGame = typeof hist_games.$inferSelect;
export type HistPrice = typeof hist_prices.$inferSelect;
