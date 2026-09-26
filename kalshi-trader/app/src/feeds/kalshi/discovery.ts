import type { Logger } from 'pino';
import { localTimeZone, nextRunAt, systemClock, type Clock } from '../../core/maintenance.js';
import type { Repositories } from '../../db/repositories.js';
import type { League } from '../../db/schema.js';
import { NetworkPaused } from '../network.js';
import type { KalshiClient } from './client.js';
import type { KalshiEvent, Market, Milestone } from './schemas.js';

/**
 * Kalshi market discovery (SPEC.md §3 "Kalshi market discovery", T06). For each enabled league:
 *
 *   1. `GET /events?series_ticker={series}&status=open&with_nested_markets=true` (all pages);
 *   2. skip events whose `product_metadata.competition` contains `Preseason` unless the league has
 *      `include_preseason = 1` (logged at `info`);
 *   3. `GET /milestones?related_event_ticker={event}` → milestone id, `start_date` (scheduled kick-off),
 *      home/away team ids, `source_ids`;
 *   4. upsert `teams` (structured targets from the markets' `custom_strike`), `games` and `markets`
 *      (outcome `home` / `away` / `tie`, or `unknown` with one `warn`; `price_ranges`).
 *
 * Idempotent: a second run over the same payloads changes nothing except `updated_at`. Runs at
 * start-up and daily at 05:00 local time (`DiscoveryService`).
 */

export const DISCOVERY_HOUR = 5;
export const DISCOVERY_MINUTE = 0;

export interface LeagueDiscovery {
  leagueId: string;
  series: string;
  events: number;
  skippedPreseason: number;
  skippedNoMilestone: number;
  games: number;
  markets: number;
  unknownMarkets: number;
  error?: string;
}

export interface DiscoveryResult {
  startedAt: string;
  finishedAt: string;
  leagues: LeagueDiscovery[];
}

export interface DiscoveryDeps {
  client: Pick<KalshiClient, 'listAllEvents' | 'listMilestones'>;
  repos: Repositories;
  log: Logger;
  now?: () => number;
  /** Runs `fn` in one database transaction (per event); defaults to running it directly. */
  transaction?: (fn: () => void) => void;
}

const HOME_KEYS = ['home_team_id', 'home_id', 'home_team', 'home_structured_target_id', 'home_target_id'];
const AWAY_KEYS = ['away_team_id', 'away_id', 'away_team', 'away_structured_target_id', 'away_target_id'];

function pick(details: Record<string, unknown> | null | undefined, keys: readonly string[]): string | null {
  if (!details) return null;
  for (const k of keys) {
    const v = details[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** The structured-target id of a market (`custom_strike`, e.g. `{"hockey_team": "<uuid>"}`). */
export function targetIdOf(market: Pick<Market, 'custom_strike'>): string | null {
  for (const v of Object.values(market.custom_strike ?? {})) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Market ticker suffix: `KXEPLGAME-26FEB07WOLCFC-CFC` → `CFC`. */
export function tickerSuffix(ticker: string): string {
  return ticker.slice(ticker.lastIndexOf('-') + 1);
}

export function isTieMarket(market: Pick<Market, 'ticker' | 'yes_sub_title'>): boolean {
  return (
    tickerSuffix(market.ticker).toUpperCase() === 'TIE' || /^(tie|draw)$/i.test(market.yes_sub_title ?? '')
  );
}

export type Outcome = 'home' | 'away' | 'tie' | 'unknown';

export function marketOutcome(market: Market, homeTarget: string | null, awayTarget: string | null): Outcome {
  if (isTieMarket(market)) return 'tie';
  const target = targetIdOf(market);
  if (target !== null && target === homeTarget) return 'home';
  if (target !== null && target === awayTarget) return 'away';
  return 'unknown';
}

export function isPreseason(competition: string | null): boolean {
  return competition !== null && /preseason/i.test(competition);
}

function chooseMilestone(event: string, milestones: Milestone[]): Milestone | undefined {
  return milestones.find((m) => m.primary_event_tickers?.includes(event)) ?? milestones[0];
}

function sourceIds(m: Milestone): Record<string, unknown> {
  return { ...(m.source_id ? { source_id: m.source_id } : {}), ...(m.source_ids ?? {}) };
}

/** Runs discovery for every enabled league (or the given ones). `NetworkPaused` aborts the run. */
export async function runDiscovery(
  deps: DiscoveryDeps,
  leagueIds?: readonly string[],
): Promise<DiscoveryResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const leagues = deps.repos.leagues
    .listEnabled()
    .filter((l) => leagueIds === undefined || leagueIds.includes(l.id));
  const results: LeagueDiscovery[] = [];
  for (const league of leagues) {
    try {
      results.push(await discoverLeague(deps, league, now));
    } catch (err) {
      if (err instanceof NetworkPaused) throw err;
      deps.log.warn(
        {
          leagueId: league.id,
          series: league.kalshi_series,
          err: { name: (err as Error).name, message: (err as Error).message },
        },
        'Discovery failed for a league',
      );
      results.push({
        leagueId: league.id,
        series: league.kalshi_series,
        events: 0,
        skippedPreseason: 0,
        skippedNoMilestone: 0,
        games: 0,
        markets: 0,
        unknownMarkets: 0,
        error: (err as Error).message,
      });
    }
  }
  return { startedAt, finishedAt: new Date(now()).toISOString(), leagues: results };
}

async function discoverLeague(
  deps: DiscoveryDeps,
  league: League,
  now: () => number,
): Promise<LeagueDiscovery> {
  const { client, log } = deps;
  const result: LeagueDiscovery = {
    leagueId: league.id,
    series: league.kalshi_series,
    events: 0,
    skippedPreseason: 0,
    skippedNoMilestone: 0,
    games: 0,
    markets: 0,
    unknownMarkets: 0,
  };
  const events = await client.listAllEvents(league.kalshi_series, 'open', true);
  result.events = events.length;
  for (const event of events) {
    if (isPreseason(event.competition) && league.include_preseason !== 1) {
      result.skippedPreseason++;
      log.info(
        { leagueId: league.id, event: event.event_ticker, competition: event.competition },
        'Discovery: preseason event skipped',
      );
      continue;
    }
    const milestone = chooseMilestone(
      event.event_ticker,
      await client.listMilestones({ relatedEventTicker: event.event_ticker }),
    );
    if (!milestone) {
      result.skippedNoMilestone++;
      log.warn(
        { leagueId: league.id, event: event.event_ticker },
        'Discovery: event has no milestone; skipped',
      );
      continue;
    }
    const counts = upsertEvent(deps, league, event, milestone, new Date(now()).toISOString());
    result.games++;
    result.markets += counts.markets;
    result.unknownMarkets += counts.unknown;
  }
  log.info(
    {
      leagueId: league.id,
      series: league.kalshi_series,
      events: result.events,
      games: result.games,
      markets: result.markets,
      skippedPreseason: result.skippedPreseason,
      unknownMarkets: result.unknownMarkets,
    },
    'Discovery done for league',
  );
  return result;
}

function upsertEvent(
  deps: DiscoveryDeps,
  league: League,
  event: KalshiEvent,
  milestone: Milestone,
  nowIso: string,
): { markets: number; unknown: number } {
  const { repos, log } = deps;
  const homeTarget = pick(milestone.details, HOME_KEYS);
  const awayTarget = pick(milestone.details, AWAY_KEYS);
  const outcomes = event.markets.map((m) => ({
    market: m,
    outcome: marketOutcome(m, homeTarget, awayTarget),
  }));
  const counts = { markets: 0, unknown: 0 };

  const apply = () => {
    const teamIds: { home: string | null; away: string | null } = { home: null, away: null };
    for (const { market, outcome } of outcomes) {
      if (outcome !== 'home' && outcome !== 'away') continue;
      teamIds[outcome] = upsertTeam(repos, league.id, market);
    }

    const game = {
      league_id: league.id,
      competition: event.competition,
      home_team_id: teamIds.home,
      away_team_id: teamIds.away,
      scheduled_at: new Date(milestone.start_date).toISOString(),
      milestone_id: milestone.id,
      feed_game_ids: JSON.stringify({ kalshi_milestone: milestone.id, ...sourceIds(milestone) }),
      updated_at: nowIso,
    };
    if (repos.games.get({ id: event.event_ticker })) repos.games.update({ id: event.event_ticker }, game);
    else repos.games.insert({ id: event.event_ticker, ...game });

    for (const { market, outcome } of outcomes) {
      const row = {
        game_id: event.event_ticker,
        outcome,
        status: market.status,
        result: market.result === '' ? null : market.result,
        settlement_value_bp: market.settlement_value_bp,
        close_time: market.close_time,
        price_ranges: JSON.stringify(market.price_ranges),
        yes_bid_bp: market.yes_bid_bp,
        yes_ask_bp: market.yes_ask_bp,
        updated_at: nowIso,
      };
      if (repos.markets.get({ ticker: market.ticker })) repos.markets.update({ ticker: market.ticker }, row);
      else repos.markets.insert({ ticker: market.ticker, ...row });
      counts.markets++;
    }
  };
  (deps.transaction ?? ((fn) => fn()))(apply);

  for (const { market, outcome } of outcomes) {
    if (outcome !== 'unknown') continue;
    counts.unknown++;
    log.warn(
      { leagueId: league.id, event: event.event_ticker, market: market.ticker, target: targetIdOf(market) },
      'Discovery: market target cannot be mapped to a team; stored as unknown and never traded',
    );
  }
  return counts;
}

/** Finds the team by (league, structured target) or creates it; refreshes its name and aliases. */
function upsertTeam(repos: Repositories, leagueId: string, market: Market): string {
  const target = targetIdOf(market) as string;
  const abbreviation = tickerSuffix(market.ticker);
  const existing = repos.teams.listByLeague(leagueId).find((t) => t.kalshi_target_id === target);
  const name = market.yes_sub_title ?? abbreviation;
  if (existing) {
    const aliases = new Set<string>(existing.aliases ? (JSON.parse(existing.aliases) as string[]) : []);
    aliases.add(abbreviation);
    repos.teams.update(
      { id: existing.id },
      { name, abbreviation, aliases: JSON.stringify([...aliases].sort()) },
    );
    return existing.id;
  }
  const id = `${leagueId}:${target}`;
  repos.teams.insert({
    id,
    league_id: leagueId,
    name,
    abbreviation,
    kalshi_target_id: target,
    aliases: JSON.stringify([abbreviation]),
  });
  return id;
}

// ---- schedule -------------------------------------------------------------------------------

export type DiscoveryTrigger = 'startup' | 'daily' | 'manual';

export class DiscoveryRunning extends Error {
  override name = 'DiscoveryRunning';
  constructor() {
    super('a discovery run is already in progress');
  }
}

export interface DiscoveryServiceOptions {
  /** Returns the dependencies, or `undefined` while the database is unavailable. */
  deps: () => DiscoveryDeps | undefined;
  log: Logger;
  timeZone?: string;
  clock?: Clock;
}

/** Runs discovery at start-up, daily at 05:00 local time and on demand; never two runs at once. */
export class DiscoveryService {
  private running: Promise<DiscoveryResult> | undefined;
  private handle: unknown;
  private stopped = false;
  private readonly clock: Clock;
  private readonly timeZone: string;
  nextAt: number | undefined;
  lastResult: DiscoveryResult | undefined;

  constructor(private readonly options: DiscoveryServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.timeZone = options.timeZone ?? localTimeZone();
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  /** Runs discovery now; throws `DiscoveryRunning` if a run is in progress. */
  async run(trigger: DiscoveryTrigger, leagueIds?: readonly string[]): Promise<DiscoveryResult> {
    if (this.running) throw new DiscoveryRunning();
    const deps = this.options.deps();
    if (!deps) throw new Error('database unavailable');
    this.options.log.info({ trigger }, 'Discovery started');
    this.running = runDiscovery(deps, leagueIds);
    try {
      this.lastResult = await this.running;
      return this.lastResult;
    } finally {
      this.running = undefined;
    }
  }

  /** A scheduled run: errors are logged, never thrown. */
  private async scheduledRun(trigger: DiscoveryTrigger): Promise<void> {
    try {
      await this.run(trigger);
    } catch (err) {
      if (err instanceof NetworkPaused)
        this.options.log.info({ trigger }, 'Discovery skipped: global kill switch is on');
      else if (err instanceof DiscoveryRunning)
        this.options.log.info({ trigger }, 'Discovery skipped: already running');
      else
        this.options.log.warn(
          { trigger, err: { name: (err as Error).name, message: (err as Error).message } },
          'Discovery failed',
        );
    }
  }

  /** Starts the daily schedule and (unless `runAtStart` is false) one run now. */
  start(runAtStart = true): void {
    const schedule = () => {
      if (this.stopped) return;
      // Never run twice for the same slot, even if the timer fired a little early.
      const from = Math.max(this.clock.now(), this.nextAt ?? 0);
      this.nextAt = nextRunAt(from, this.timeZone, DISCOVERY_HOUR, DISCOVERY_MINUTE);
      this.handle = this.clock.setTimeout(
        () => {
          void this.scheduledRun('daily').finally(schedule);
        },
        Math.max(0, this.nextAt - this.clock.now()),
      );
    };
    schedule();
    this.options.log.info(
      {
        nextAt: this.nextAt !== undefined ? new Date(this.nextAt).toISOString() : null,
        timeZone: this.timeZone,
      },
      'Discovery scheduled',
    );
    if (runAtStart) void this.scheduledRun('startup');
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.handle);
  }
}
