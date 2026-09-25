CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`ip` text,
	`channel` text,
	`mode` text,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `backtest_trades` (
	`id` integer PRIMARY KEY NOT NULL,
	`backtest_id` text,
	`hist_game_id` text,
	`minute` integer,
	`side` text,
	`price_source` text,
	`price_bp` integer,
	`contracts_cc` integer,
	`stake_micros` integer,
	`fee_micros` integer,
	`settlement_value_bp` integer,
	`pnl_micros` integer,
	`bankroll_after_micros` integer,
	`skip_reason` text
);
--> statement-breakpoint
CREATE TABLE `backtests` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text,
	`league_id` text,
	`season` text,
	`strategy_version_ref` text,
	`params` text,
	`price_mode` text,
	`initial_bankroll_micros` integer,
	`result_summary` text
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`kalshi_env` text NOT NULL,
	`subaccount` integer NOT NULL,
	`cash_micros` integer,
	`portfolio_value_micros` integer
);
--> statement-breakpoint
CREATE TABLE `bankroll_snapshots` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`trade_id` text,
	`reason` text NOT NULL,
	`bankroll_micros` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_snapshots` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` text,
	`observed_at` text,
	`feed_updated_at` text,
	`feed` text,
	`home_score` integer,
	`away_score` integer,
	`phase` text,
	`clock_minute` integer,
	`minute_source` text,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `ix_snapshots_game` ON `game_snapshots` (`game_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text,
	`competition` text,
	`home_team_id` text,
	`away_team_id` text,
	`scheduled_at` text NOT NULL,
	`milestone_id` text,
	`feed_game_ids` text,
	`phase` text DEFAULT 'scheduled' NOT NULL,
	`home_score` integer,
	`away_score` integer,
	`clock_minute` integer,
	`minute_source` text,
	`kickoff_observed_at` text,
	`second_half_observed_at` text,
	`blocked` integer DEFAULT 0 NOT NULL,
	`final_home` integer,
	`final_away` integer,
	`finished_at` text,
	`timeline_archived` integer DEFAULT 0 NOT NULL,
	`pregame_home_bp` integer,
	`pregame_away_bp` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hist_games` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text,
	`season` text,
	`competition` text,
	`played_at` text,
	`home` text,
	`away` text,
	`final_home` integer,
	`final_away` integer,
	`goal_events` text NOT NULL,
	`source` text NOT NULL,
	`kalshi_event_ticker` text
);
--> statement-breakpoint
CREATE INDEX `ix_hist_league_season` ON `hist_games` (`league_id`,`season`);--> statement-breakpoint
CREATE TABLE `hist_prices` (
	`market_ticker` text,
	`minute_ts` text,
	`ask_open_bp` integer,
	`ask_high_bp` integer,
	`ask_low_bp` integer,
	`ask_close_bp` integer,
	`bid_close_bp` integer,
	`trade_close_bp` integer,
	`volume_cc` integer,
	PRIMARY KEY(`market_ticker`, `minute_ts`)
);
--> statement-breakpoint
CREATE TABLE `leagues` (
	`id` text PRIMARY KEY NOT NULL,
	`sport` text NOT NULL,
	`name` text NOT NULL,
	`kalshi_series` text NOT NULL,
	`feed_ids` text NOT NULL,
	`include_preseason` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`ip` text,
	`username` text,
	`channel` text,
	`ok` integer
);
--> statement-breakpoint
CREATE TABLE `markets` (
	`ticker` text PRIMARY KEY NOT NULL,
	`game_id` text,
	`outcome` text NOT NULL,
	`status` text,
	`result` text,
	`settlement_value_bp` integer,
	`close_time` text,
	`price_ranges` text,
	`yes_bid_bp` integer,
	`yes_ask_bp` integer,
	`updated_at` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`channel` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_auth_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`ip` text,
	`ua` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sport` text NOT NULL,
	`mode` text DEFAULT 'dry_run' NOT NULL,
	`kill_switch` integer DEFAULT 1 NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` text,
	`updated_at` text,
	`deleted_at` text,
	CONSTRAINT "strategies_mode_check" CHECK("strategies"."mode" IN ('dry_run','live'))
);
--> statement-breakpoint
CREATE TABLE `strategy_versions` (
	`strategy_id` text,
	`version` integer,
	`league_ids` text NOT NULL,
	`rule` text NOT NULL,
	`sizing` text NOT NULL,
	`execution` text NOT NULL,
	`created_at` text,
	PRIMARY KEY(`strategy_id`, `version`),
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text,
	`name` text NOT NULL,
	`abbreviation` text,
	`kalshi_target_id` text,
	`aliases` text,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trade_attempts` (
	`id` integer PRIMARY KEY NOT NULL,
	`trade_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`at` text NOT NULL,
	`effective_mode` text NOT NULL,
	`mode_reason` text,
	`client_order_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`best_ask_bp` integer,
	`depth_cc` integer,
	`limit_price_bp` integer,
	`requested_cc` integer,
	`fill_cc` integer,
	`avg_fill_price_bp` integer,
	`fee_micros` integer,
	`kalshi_order_id` text,
	`response` text,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_attempts_client_order_id_unique` ON `trade_attempts` (`client_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trade_attempts_trade_attempt_unique` ON `trade_attempts` (`trade_id`,`attempt_no`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_version` integer NOT NULL,
	`game_id` text NOT NULL,
	`market_ticker` text,
	`league_id` text NOT NULL,
	`kalshi_env` text NOT NULL,
	`configured_mode` text NOT NULL,
	`effective_mode` text NOT NULL,
	`mode_reason` text,
	`status` text NOT NULL,
	`skip_reason` text,
	`window_expired` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`trigger_snapshot` text NOT NULL,
	`triggered_at` text NOT NULL,
	`window_ends_at` text NOT NULL,
	`balance_micros` integer,
	`stake_micros` integer,
	`limit_price_bp` integer,
	`requested_cc` integer,
	`fill_cc` integer,
	`avg_fill_price_bp` integer,
	`cost_micros` integer,
	`fee_micros` integer,
	`kalshi_order_id` text,
	`settled_at` text,
	`settlement_value_bp` integer,
	`payout_micros` integer,
	`realized_pnl_micros` integer,
	`reconcile_warning` text
);
--> statement-breakpoint
CREATE INDEX `ix_trades_filter` ON `trades` (`effective_mode`,`kalshi_env`,`strategy_id`,`league_id`,`triggered_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `trades_strategy_game_unique` ON `trades` (`strategy_id`,`game_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_enc` text,
	`recovery_codes_hash` text,
	`created_at` text,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);