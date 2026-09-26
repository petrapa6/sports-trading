import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import type { GameClock, Phase, Sport } from '../feeds/gameState.js';
import type { ConfiguredMode, DryRunReason } from './modes.js';
import type { LeadAtTimeRule } from './strategy.js';
import { loadStrategies, readGlobalSwitches, strategyMode, type StrategyRecord } from './strategyStore.js';
import type { GameTracker, TrackedState } from './tracker.js';

/**
 * StrategyEngine (SPEC.md §4, §5, T08): on every `stateUpdated` of the tracker, evaluates every strategy
 * whose effective mode is not `paused`, whose `leagueIds` include the game's league and whose sport matches,
 * and emits a `Signal` labelled with the configured and effective mode the first time its rule matches a
 * game. Switches are read from the database on every state (never cached). Nothing acts on signals yet
 * (the executor, T09, turns them into trades and retries within the window).
 *
 * Once per game per strategy: no signal when a `trades` row exists for (strategy, game), and at most one
 * signal per (strategy, game) while the process runs.
 */

export type Side = 'home' | 'away';

/** Why `lead_at_time` did not match (the engine logs `blocked` at `debug`). */
export type NoMatchReason =
  | 'not_live'
  | 'break'
  | 'regulation_over'
  | 'overtime'
  | 'no_minute'
  | 'lead'
  | 'side'
  | 'window'
  | 'blocked';

export type RuleResult =
  { match: true; side: Side; minute: number } | { match: false; reason: NoMatchReason };

/** What the rule needs from a game state. */
export interface RuleState {
  phase: Phase;
  homeScore: number;
  awayScore: number;
  clock: GameClock;
  blocked: boolean;
}

/**
 * The clock minute the rule compares with `atMinute` (§5): soccer match minute (stoppage already counts as
 * 45 / 90); hockey elapsed minute `(period − 1) × 20 + (20 − time left)`, floored, from the period and the
 * seconds left when both are known.
 */
export function ruleMinute(sport: Sport, clock: GameClock): number | undefined {
  if (sport === 'hockey' && clock.period !== undefined && clock.secondsLeftInPeriod !== undefined) {
    return Math.floor(((clock.period - 1) * 1200 + (1200 - clock.secondsLeftInPeriod)) / 60);
  }
  return clock.minute;
}

/**
 * `lead_at_time` (§5): matches when the game is `live`, not in a break, regulation is not over (hockey OT
 * excluded), the leader's margin is ≥ `minLead` on an allowed side, `atMinute ≤ minute ≤ atMinute +
 * windowMinutes`, and the game is not `blocked` by a feed disagreement.
 */
export function evaluateLeadAtTime(rule: LeadAtTimeRule, sport: Sport, state: RuleState): RuleResult {
  if (state.phase === 'halftime' || state.phase === 'intermission') return { match: false, reason: 'break' };
  if (state.phase !== 'live') return { match: false, reason: 'not_live' };
  if (state.clock.regulationOver) return { match: false, reason: 'regulation_over' };
  if (sport === 'hockey' && (state.clock.period ?? 1) >= 4) return { match: false, reason: 'overtime' };
  const minute = ruleMinute(sport, state.clock);
  if (minute === undefined) return { match: false, reason: 'no_minute' };
  const lead = state.homeScore - state.awayScore;
  if (Math.abs(lead) < rule.minLead) return { match: false, reason: 'lead' };
  const side: Side = lead > 0 ? 'home' : 'away';
  if (rule.leaderSide !== 'any' && rule.leaderSide !== side) return { match: false, reason: 'side' };
  const window = rule.windowMinutes ?? 0;
  if (minute < rule.atMinute || minute > rule.atMinute + window) return { match: false, reason: 'window' };
  if (state.blocked) return { match: false, reason: 'blocked' };
  return { match: true, side, minute };
}

/** The game state that triggered a signal, as JSON (times as ISO strings). */
export interface SignalSnapshot {
  gameId: string;
  leagueId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  phase: Phase;
  clock: GameClock;
  blocked: boolean;
  source: string;
  observedAt: string;
  feedUpdatedAt: string | null;
}

export interface Signal {
  strategyId: string;
  strategyName: string;
  /** The strategy version the rule matched under. */
  version: number;
  gameId: string;
  leagueId: string;
  sport: Sport;
  side: Side;
  /** The leader's market (`markets.outcome` = side); `null` if discovery has not mapped one. */
  marketTicker: string | null;
  /** The minute the rule matched at. */
  minute: number;
  snapshot: SignalSnapshot;
  configuredMode: ConfiguredMode;
  effectiveMode: 'live' | 'dry_run';
  modeReason: DryRunReason | null;
  at: string;
}

export const RECENT_SIGNALS = 20;

export interface EngineOptions {
  repos: () => Repositories;
  log: Logger;
  /** `allow_live_orders` from the process configuration (changing it restarts the app). */
  allowLiveOrders: boolean;
  now?: () => number;
  /** The rule evaluator (tests spy on it). */
  evaluate?: typeof evaluateLeadAtTime;
}

const snapshotOf = (s: TrackedState): SignalSnapshot => ({
  gameId: s.gameId,
  leagueId: s.leagueId,
  homeTeam: s.homeTeam,
  awayTeam: s.awayTeam,
  homeScore: s.homeScore,
  awayScore: s.awayScore,
  phase: s.phase,
  clock: { ...s.clock },
  blocked: s.blocked,
  source: s.source,
  observedAt: s.observedAt.toISOString(),
  feedUpdatedAt: s.feedUpdatedAt ? s.feedUpdatedAt.toISOString() : null,
});

export class StrategyEngine extends EventEmitter<{ signal: [Signal] }> {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly signalled = new Set<string>();
  private readonly recentSignals: Signal[] = [];
  readonly evaluate: typeof evaluateLeadAtTime;

  constructor(private readonly options: EngineOptions) {
    super();
    this.setMaxListeners(0);
    this.log = options.log.child({ component: 'engine' });
    this.now = options.now ?? (() => Date.now());
    this.evaluate = options.evaluate ?? evaluateLeadAtTime;
  }

  /** Subscribes to the tracker: every `stateUpdated` is evaluated; a replay reset forgets the game. */
  attach(tracker: Pick<GameTracker, 'on'>): this {
    tracker.on('stateUpdated', (state) => this.onState(state));
    tracker.on('gameReset', (gameId) => this.forget(gameId));
    return this;
  }

  /** The last signals, newest last (SSE `signals`). */
  recent(): Signal[] {
    return [...this.recentSignals];
  }

  /** Forgets the in-memory once-per-game marks of a game (a replay starting the game over). */
  forget(gameId: string): void {
    for (const key of this.signalled) if (key.endsWith(`|${gameId}`)) this.signalled.delete(key);
  }

  /** Evaluates one merged game state against every running strategy; returns the signals emitted. */
  onState(state: TrackedState): Signal[] {
    let repos: Repositories;
    let strategies: StrategyRecord[];
    let switches: ReturnType<typeof readGlobalSwitches>;
    let sport: Sport | undefined;
    try {
      repos = this.options.repos();
      switches = readGlobalSwitches(repos, this.options.allowLiveOrders);
      if (switches.globalKill) return [];
      sport = repos.leagues.get({ id: state.leagueId })?.sport as Sport | undefined;
      if (!sport) return [];
      strategies = loadStrategies(repos);
    } catch (err) {
      // Fail closed: without the switches nothing is evaluated.
      this.log.error(
        { err: { message: (err as Error).message } },
        'Strategy evaluation skipped: database unavailable',
      );
      return [];
    }

    const out: Signal[] = [];
    for (const s of strategies) {
      const mode = strategyMode(s, switches);
      if (mode.mode === 'paused') continue;
      if (s.sport !== sport || !s.version || !s.version.leagueIds.includes(state.leagueId)) continue;
      const key = `${s.id}|${state.gameId}`;
      if (this.signalled.has(key)) continue;
      const result = this.evaluate(s.version.rule, sport, state);
      if (!result.match) {
        if (result.reason === 'blocked') {
          this.log.debug(
            { mode: mode.mode, strategyId: s.id, gameId: state.gameId },
            `Strategy "${s.name}" would match ${state.gameId}, but the game is blocked by a feed disagreement`,
          );
        }
        continue;
      }
      if (repos.trades.findByStrategyAndGame(s.id, state.gameId)) {
        this.signalled.add(key);
        continue;
      }
      const market = repos.markets.listByGame(state.gameId).find((m) => m.outcome === result.side);
      const signal: Signal = {
        strategyId: s.id,
        strategyName: s.name,
        version: s.currentVersion,
        gameId: state.gameId,
        leagueId: state.leagueId,
        sport,
        side: result.side,
        marketTicker: market?.ticker ?? null,
        minute: result.minute,
        snapshot: snapshotOf(state),
        configuredMode: s.mode,
        effectiveMode: mode.mode,
        modeReason: mode.reason,
        at: new Date(this.now()).toISOString(),
      };
      this.signalled.add(key);
      this.recentSignals.push(signal);
      if (this.recentSignals.length > RECENT_SIGNALS) this.recentSignals.shift();
      const team = result.side === 'home' ? state.homeTeam : state.awayTeam;
      const fields = {
        mode: signal.effectiveMode,
        configuredMode: signal.configuredMode,
        modeReason: signal.modeReason,
        strategyId: s.id,
        strategyVersion: s.currentVersion,
        gameId: state.gameId,
        marketTicker: signal.marketTicker,
        score: `${state.homeScore}-${state.awayScore}`,
        minute: result.minute,
      };
      this.log.info(
        fields,
        `Signal: "${s.name}" v${s.currentVersion} on ${state.gameId} — ${team} leads ${state.homeScore}-${state.awayScore} at minute ${result.minute}`,
      );
      if (signal.marketTicker === null) {
        this.log.warn(
          { mode: signal.effectiveMode, strategyId: s.id, gameId: state.gameId, side: result.side },
          `No ${result.side} market is known for ${state.gameId}; the signal has no market`,
        );
      }
      out.push(signal);
      this.emit('signal', signal);
    }
    return out;
  }
}
