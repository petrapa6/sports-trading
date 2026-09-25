-- Reverts 0000_initial_schema: drops every table of SPEC.md §7 (children before parents).
DROP TABLE `trade_attempts`;
--> statement-breakpoint
DROP TABLE `trades`;
--> statement-breakpoint
DROP TABLE `strategy_versions`;
--> statement-breakpoint
DROP TABLE `strategies`;
--> statement-breakpoint
DROP TABLE `markets`;
--> statement-breakpoint
DROP TABLE `game_snapshots`;
--> statement-breakpoint
DROP TABLE `games`;
--> statement-breakpoint
DROP TABLE `teams`;
--> statement-breakpoint
DROP TABLE `leagues`;
--> statement-breakpoint
DROP TABLE `balance_snapshots`;
--> statement-breakpoint
DROP TABLE `bankroll_snapshots`;
--> statement-breakpoint
DROP TABLE `audit_log`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
DROP TABLE `login_attempts`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
DROP TABLE `settings`;
--> statement-breakpoint
DROP TABLE `backtest_trades`;
--> statement-breakpoint
DROP TABLE `backtests`;
--> statement-breakpoint
DROP TABLE `hist_prices`;
--> statement-breakpoint
DROP TABLE `hist_games`;
