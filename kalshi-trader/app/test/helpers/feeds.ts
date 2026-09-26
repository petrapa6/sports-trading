import type { Repositories } from '../../src/db/repositories.js';
import type { Phase, TrackedGame } from '../../src/feeds/gameState.js';

/** A tracked game for adapter tests (no database). */
export function trackedGame(overrides: Partial<TrackedGame> = {}): TrackedGame {
  return {
    id: 'KXEPLGAME-26OCT17ARSCHE',
    leagueId: 'epl',
    sport: 'soccer',
    milestoneId: 'm-soccer-1',
    scheduledAt: Date.parse('2026-10-17T14:00:00Z'),
    phase: 'scheduled',
    home: { id: 'epl:ars', name: 'Arsenal', abbreviation: 'ARS', aliases: ['ARS'] },
    away: { id: 'epl:che', name: 'Chelsea', abbreviation: 'CHE', aliases: ['CHE'] },
    feedGameIds: {},
    kickoffObservedAt: null,
    secondHalfObservedAt: null,
    ...overrides,
  };
}

export interface SeedGame {
  id: string;
  leagueId: string;
  scheduledAt: string;
  milestoneId?: string | null;
  phase?: Phase;
  home: string;
  away: string;
  feedGameIds?: Record<string, unknown>;
}

/** Inserts a game and its two teams (ids `<league>:<abbr>`). */
export function seedGame(repos: Repositories, g: SeedGame): void {
  for (const abbr of [g.home, g.away]) {
    const id = `${g.leagueId}:${abbr}`;
    if (!repos.teams.get({ id }))
      repos.teams.insert({
        id,
        league_id: g.leagueId,
        name: `Team ${abbr}`,
        abbreviation: abbr,
        aliases: JSON.stringify([abbr]),
      });
  }
  repos.games.insert({
    id: g.id,
    league_id: g.leagueId,
    home_team_id: `${g.leagueId}:${g.home}`,
    away_team_id: `${g.leagueId}:${g.away}`,
    scheduled_at: g.scheduledAt,
    milestone_id: g.milestoneId === undefined ? `ms-${g.id}` : g.milestoneId,
    feed_game_ids: JSON.stringify(g.feedGameIds ?? {}),
    phase: g.phase ?? 'scheduled',
    updated_at: g.scheduledAt,
  });
}

/** Parses captured Pino output into objects. */
export function logLines(text: string): { level: number; msg: string; [k: string]: unknown }[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { level: number; msg: string; [k: string]: unknown });
}
