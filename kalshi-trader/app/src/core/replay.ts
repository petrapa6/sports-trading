import type { Logger } from 'pino';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { OnceSet, type FeedObservation } from '../feeds/gameState.js';
import { liveDataToState } from '../feeds/kalshi/live.js';
import { LiveDataSchema } from '../feeds/kalshi/schemas.js';
import { nhlGameToState, NhlGameSchema } from '../feeds/nhl/feed.js';
import type { GameTracker, TrackedState } from './tracker.js';

/**
 * Recorded feed evenings (`test/fixtures/replay/*.jsonl`, written by `npm run fixtures:record:feeds`) and
 * their playback (`npm run replay`, T07). One JSON object per line, each self-contained:
 *
 * ```json
 * {"at":"2026-10-11T02:00:00.000Z","feed":"kalshi-live",
 *  "game":{"id":"KXNHLGAME-…","leagueId":"nhl","home":{"name":"…","abbreviation":"VGK"},"away":{…}},
 *  "payload":{…the feed's own record: a Kalshi live_data object or an NHL score/now game…}}
 * ```
 *
 * Playback runs every payload through the same adapter conversion and the same `GameTracker.ingest`
 * as live polling, so a replay exercises the real pipeline (snapshots, phases, archive, SSE). Replayed
 * games are marked `feed_game_ids.replay = true` and are never polled by the scheduler.
 */

const TeamSchema = z.object({ name: z.string().min(1), abbreviation: z.string().min(1) });

export const ReplayLineSchema = z.object({
  at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO time'),
  feed: z.enum(['kalshi-live', 'nhl-official']),
  game: z.object({
    id: z.string().min(1).max(100),
    leagueId: z.string().min(1).max(40),
    scheduledAt: z.string().optional(),
    milestoneId: z.string().optional(),
    competition: z.string().optional(),
    home: TeamSchema,
    away: TeamSchema,
  }),
  payload: z.record(z.string(), z.unknown()),
});
export type ReplayLine = z.output<typeof ReplayLineSchema>;

/** Parses a `.jsonl` replay file (blank lines ignored); errors name the line number. */
export function parseReplayFile(text: string): ReplayLine[] {
  const out: ReplayLine[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    const r = ReplayLineSchema.safeParse(json);
    if (!r.success)
      throw new Error(
        `line ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      );
    out.push(r.data);
  });
  return out;
}

export interface ReplayContext {
  repos: Repositories;
  tracker: Pick<GameTracker, 'ingest' | 'trackedGame' | 'forget'>;
  log: Pick<Logger, 'warn'>;
  unknownText: OnceSet;
  /** Runs `fn` in one database transaction; defaults to running it directly. */
  transaction?: (fn: () => void) => void;
}

export interface ApplyOptions {
  /** Observation time (epoch ms): the recorded `at` in tests, the server clock for live playback. */
  observedAt: number;
  /** Start over: the game row is reset and its snapshots and archived timeline are removed. */
  reset?: boolean;
  /** Overrides the game's scheduled start (live playback schedules it "now"). */
  scheduledAt?: number;
}

function ensureGame(ctx: ReplayContext, line: ReplayLine, opts: ApplyOptions): void {
  const { repos } = ctx;
  const g = line.game;
  if (!repos.leagues.get({ id: g.leagueId })) throw new Error(`unknown league ${g.leagueId}`);
  const nowIso = new Date(opts.observedAt).toISOString();
  const teamId = (t: { abbreviation: string }) => `${g.leagueId}:replay:${t.abbreviation.toUpperCase()}`;
  for (const t of [g.home, g.away]) {
    const id = teamId(t);
    const row = {
      league_id: g.leagueId,
      name: t.name,
      abbreviation: t.abbreviation.toUpperCase(),
      aliases: JSON.stringify([t.abbreviation.toUpperCase()]),
    };
    if (repos.teams.get({ id })) repos.teams.update({ id }, row);
    else repos.teams.insert({ id, ...row });
  }
  const existing = repos.games.get({ id: g.id });
  if (existing && !opts.reset) return;
  const scheduledAt =
    opts.scheduledAt !== undefined
      ? new Date(opts.scheduledAt).toISOString()
      : new Date(g.scheduledAt ?? line.at).toISOString();
  const fresh = {
    league_id: g.leagueId,
    competition: g.competition ?? null,
    home_team_id: teamId(g.home),
    away_team_id: teamId(g.away),
    scheduled_at: scheduledAt,
    milestone_id: g.milestoneId ?? null,
    feed_game_ids: JSON.stringify({ replay: true }),
    phase: 'scheduled',
    home_score: null,
    away_score: null,
    clock_minute: null,
    minute_source: null,
    kickoff_observed_at: null,
    second_half_observed_at: null,
    blocked: 0,
    final_home: null,
    final_away: null,
    finished_at: null,
    timeline_archived: 0,
    updated_at: nowIso,
  };
  repos.gameSnapshots.deleteByGame(g.id);
  repos.histGames.delete({ id: `live:${g.id}` });
  if (existing) repos.games.update({ id: g.id }, fresh);
  else repos.games.insert({ id: g.id, ...fresh });
  // Replayed games get their home / away (and soccer tie) markets like discovered ones, so strategies
  // matching a replayed game signal with a market ticker (`<event>-<ABBR>`, `<event>-TIE`, T08).
  const sport = repos.leagues.get({ id: g.leagueId })?.sport;
  const markets: [string, 'home' | 'away' | 'tie'][] = [
    [`${g.id}-${g.home.abbreviation.toUpperCase()}`, 'home'],
    [`${g.id}-${g.away.abbreviation.toUpperCase()}`, 'away'],
    ...(sport === 'soccer' ? [[`${g.id}-TIE`, 'tie'] as [string, 'tie']] : []),
  ];
  for (const [ticker, outcome] of markets) {
    if (!repos.markets.get({ ticker }))
      repos.markets.insert({ ticker, game_id: g.id, outcome, status: 'open', updated_at: nowIso });
  }
  ctx.tracker.forget(g.id);
}

/** Plays one line through the adapter conversion and the tracker; returns the merged state. */
export function applyReplayLine(
  ctx: ReplayContext,
  line: ReplayLine,
  opts: ApplyOptions,
): TrackedState | undefined {
  (ctx.transaction ?? ((fn) => fn()))(() => ensureGame(ctx, line, opts));
  const game = ctx.tracker.trackedGame(line.game.id);
  if (!game) throw new Error(`game ${line.game.id} missing after replay setup`);
  let obs: FeedObservation;
  if (line.feed === 'kalshi-live') {
    const live = LiveDataSchema.parse(line.payload);
    obs = {
      state: liveDataToState(live, game, {
        now: opts.observedAt,
        log: ctx.log,
        unknownText: ctx.unknownText,
      }),
      raw: line.payload,
    };
  } else {
    obs = {
      state: nhlGameToState(NhlGameSchema.parse(line.payload), game, opts.observedAt),
      raw: line.payload,
    };
  }
  return ctx.tracker.ingest(line.feed, [obs])[0];
}
