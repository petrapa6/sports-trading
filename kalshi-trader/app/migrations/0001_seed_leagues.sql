-- Seed: the six leagues of SPEC.md §2/§7. feed_ids.apiFootball holds the API-Football league id (T15).
INSERT OR IGNORE INTO `leagues` (`id`, `sport`, `name`, `kalshi_series`, `feed_ids`, `include_preseason`, `enabled`) VALUES
	('nhl', 'hockey', 'NHL', 'KXNHLGAME', '{"apiFootball":null,"nhl":null}', 0, 1),
	('epl', 'soccer', 'English Premier League', 'KXEPLGAME', '{"apiFootball":39,"nhl":null}', 0, 1),
	('laliga', 'soccer', 'La Liga', 'KXLALIGAGAME', '{"apiFootball":140,"nhl":null}', 0, 1),
	('bundesliga', 'soccer', 'Bundesliga', 'KXBUNDESLIGAGAME', '{"apiFootball":78,"nhl":null}', 0, 1),
	('seriea', 'soccer', 'Serie A', 'KXSERIEAGAME', '{"apiFootball":135,"nhl":null}', 0, 1),
	('ligue1', 'soccer', 'Ligue 1', 'KXLIGUE1GAME', '{"apiFootball":61,"nhl":null}', 0, 1);
