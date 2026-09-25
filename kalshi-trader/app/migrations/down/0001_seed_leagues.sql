-- Reverts 0001_seed_leagues. Fails (and changes nothing) while teams or games still reference a seeded league.
DELETE FROM `leagues` WHERE `id` IN ('nhl', 'epl', 'laliga', 'bundesliga', 'seriea', 'ligue1');
