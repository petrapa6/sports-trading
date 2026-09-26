-- Reverts 0002_games_historical (backfilled settled events, T11).
ALTER TABLE `games` DROP COLUMN `historical`;
