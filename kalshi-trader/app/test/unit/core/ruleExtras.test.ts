import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kickoffAsks, simulate, type SimGame, type SimInput } from '../../../src/backtest/simulator.js';
import { evaluateLeadAtTime, StrategyEngine, type RuleState, type Signal } from '../../../src/core/engine.js';
import { PregameRecorder } from '../../../src/core/pregame.js';
import {
  LeadAtTimeRuleSchema,
  StrategyDefinitionSchema,
  type LeadAtTimeRule,
} from '../../../src/core/strategy.js';
import { createStrategy } from '../../../src/core/strategyStore.js';
import { GameTracker, type TrackedState } from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { seedGame } from '../../helpers/feeds.js';

/** `maxOpponentGoals` and `underdogOnly` of `lead_at_time`. */

const rule = (extra: Partial<LeadAtTimeRule> = {}): LeadAtTimeRule => ({
  type: 'lead_at_time',
  version: 1,
  minLead: 1,
  atMinute: 70,
  windowMinutes: 10,
  leaderSide: 'any',
  ...extra,
});
const at = (home: number, away: number, pregame?: RuleState['pregame']): RuleState => ({
  phase: 'live',
  homeScore: home,
  awayScore: away,
  blocked: false,
  clock: { minute: 75, minuteSource: 'feed', period: 2, regulationOver: false },
  ...(pregame ? { pregame } : {}),
});

describe('lead_at_time extra parameters', () => {
  it('maxOpponentGoals: 0 with 2-1 → no signal, 2-0 → signal (either leader)', () => {
    const r = rule({ maxOpponentGoals: 0 });
    expect(evaluateLeadAtTime(r, 'soccer', at(2, 1))).toEqual({ match: false, reason: 'opponent_goals' });
    expect(evaluateLeadAtTime(r, 'soccer', at(2, 0))).toEqual({ match: true, side: 'home', minute: 75 });
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 3))).toEqual({ match: false, reason: 'opponent_goals' });
    expect(evaluateLeadAtTime(r, 'soccer', at(0, 2))).toMatchObject({ match: true, side: 'away' });
    expect(evaluateLeadAtTime(rule({ maxOpponentGoals: 1 }), 'soccer', at(2, 1))).toMatchObject({
      match: true,
    });
    expect(evaluateLeadAtTime(rule(), 'soccer', at(5, 4))).toMatchObject({ match: true });
  });

  it("underdogOnly: fires only when the leader's kick-off YES ask was below the opponent's", () => {
    const r = rule({ underdogOnly: true });
    // Home was the underdog (0.30 vs 0.45) and leads → signal.
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 0, { homeBp: 3000, awayBp: 4500 }))).toMatchObject({
      match: true,
      side: 'home',
    });
    // Home was the favourite and leads → none; the away underdog leading → signal.
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 0, { homeBp: 6000, awayBp: 1800 }))).toEqual({
      match: false,
      reason: 'underdog',
    });
    expect(evaluateLeadAtTime(r, 'soccer', at(0, 1, { homeBp: 6000, awayBp: 1800 }))).toMatchObject({
      match: true,
      side: 'away',
    });
    // Equal asks, or unknown asks → none.
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 0, { homeBp: 4000, awayBp: 4000 }))).toMatchObject({
      match: false,
    });
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 0))).toEqual({ match: false, reason: 'underdog' });
    expect(evaluateLeadAtTime(r, 'soccer', at(1, 0, { homeBp: 3000, awayBp: null }))).toMatchObject({
      match: false,
    });
    // Without underdogOnly the pre-game prices do not matter.
    expect(evaluateLeadAtTime(rule(), 'soccer', at(1, 0, { homeBp: 6000, awayBp: 1800 }))).toMatchObject({
      match: true,
    });
  });

  it('schema: both are optional; maxOpponentGoals is a whole number ≥ 0; old rules parse unchanged', () => {
    expect(LeadAtTimeRuleSchema.parse({ type: 'lead_at_time', minLead: 2, atMinute: 80 })).toEqual({
      type: 'lead_at_time',
      version: 1,
      minLead: 2,
      atMinute: 80,
      leaderSide: 'any',
    });
    expect(() =>
      LeadAtTimeRuleSchema.parse({ type: 'lead_at_time', minLead: 2, atMinute: 80, maxOpponentGoals: -1 }),
    ).toThrow(/must not be negative/);
    expect(() =>
      LeadAtTimeRuleSchema.parse({ type: 'lead_at_time', minLead: 2, atMinute: 80, maxOpponentGoals: 1.5 }),
    ).toThrow(/whole number/);
    expect(
      LeadAtTimeRuleSchema.parse({
        type: 'lead_at_time',
        minLead: 2,
        atMinute: 80,
        maxOpponentGoals: 0,
        underdogOnly: true,
      }),
    ).toMatchObject({ maxOpponentGoals: 0, underdogOnly: true });
  });
});

describe('engine + kick-off prices (games.pregame_*_bp)', () => {
  const GAME = 'KXEPLGAME-26OCT17ARSCHE';
  const NOW = Date.parse('2026-10-17T15:30:00Z');
  let tdb: TempDb;
  let repos: Repositories;
  beforeEach(() => {
    tdb = tempDb();
    repos = createRepositories(tdb.db.orm);
    seedGame(repos, {
      id: GAME,
      leagueId: 'epl',
      scheduledAt: '2026-10-17T14:00:00Z',
      home: 'ARS',
      away: 'CHE',
    });
    const iso = new Date(NOW).toISOString();
    repos.markets.insert({
      ticker: `${GAME}-ARS`,
      game_id: GAME,
      outcome: 'home',
      yes_ask_bp: 3100,
      updated_at: iso,
    });
    repos.markets.insert({
      ticker: `${GAME}-CHE`,
      game_id: GAME,
      outcome: 'away',
      yes_ask_bp: 4600,
      updated_at: iso,
    });
  });
  afterEach(() => tdb.cleanup());

  function addStrategy(extra: Partial<LeadAtTimeRule>): string {
    const def = StrategyDefinitionSchema.parse({
      name: 'underdog',
      sport: 'soccer',
      leagueIds: ['epl'],
      rule: { type: 'lead_at_time', minLead: 1, atMinute: 70, windowMinutes: 10, ...extra },
      sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: { maxPrice: 0.97 },
    });
    const id = createStrategy(repos, def, new Date(NOW).toISOString()).id;
    repos.strategies.update({ id }, { kill_switch: 0 });
    return id;
  }

  it('the recorder stores the kick-off asks on scheduled → live (Kalshi first, stored ask as fallback)', async () => {
    const logs = captureLogger('debug');
    const tracker = new GameTracker({ repos: () => repos, log: logs.log, now: () => NOW });
    const asked: string[] = [];
    const recorder = new PregameRecorder({
      repos: () => repos,
      log: logs.log,
      now: () => NOW,
      kalshi: () => ({
        getMarket: async (ticker: string) => {
          asked.push(ticker);
          if (ticker.endsWith('-CHE')) throw new Error('Kalshi 503');
          return { yes_ask_bp: 2900 };
        },
      }),
    }).attach(tracker);
    tracker.ingest('kalshi-live', [
      {
        raw: {},
        state: {
          gameId: GAME,
          leagueId: 'epl',
          homeTeam: 'Team ARS',
          awayTeam: 'Team CHE',
          homeScore: 0,
          awayScore: 0,
          phase: 'live',
          clock: { minute: 0, minuteSource: 'feed', period: 1, regulationOver: false },
          source: 'kalshi-live',
          observedAt: new Date(NOW),
        },
      },
    ]);
    await recorder.idle();
    expect(asked.sort()).toEqual([`${GAME}-ARS`, `${GAME}-CHE`]);
    expect(repos.games.get({ id: GAME })).toMatchObject({ pregame_home_bp: 2900, pregame_away_bp: 4600 });
    // Written once.
    expect(await recorder.record(GAME)).toBeNull();
  });

  it('an underdogOnly strategy signals only for the pre-game underdog', () => {
    addStrategy({ underdogOnly: true });
    const engine = new StrategyEngine({
      repos: () => repos,
      log: captureLogger().log,
      allowLiveOrders: false,
      now: () => NOW,
    });
    const signals: Signal[] = [];
    engine.on('signal', (s) => signals.push(s));
    const state = (
      home: number,
      away: number,
      pregame: NonNullable<TrackedState['pregame']>,
    ): TrackedState => ({
      gameId: GAME,
      leagueId: 'epl',
      homeTeam: 'Team ARS',
      awayTeam: 'Team CHE',
      homeScore: home,
      awayScore: away,
      phase: 'live',
      clock: { minute: 72, minuteSource: 'feed', period: 2, regulationOver: false },
      source: 'kalshi-live',
      observedAt: new Date(NOW),
      blocked: false,
      pregame,
    });
    // Home (ARS) was the favourite: its lead does not fire.
    expect(engine.onState(state(1, 0, { homeBp: 6100, awayBp: 1900 }))).toEqual([]);
    // Pre-game prices not known yet: nothing.
    expect(engine.onState(state(1, 0, { homeBp: null, awayBp: null }))).toEqual([]);
    // Home was the underdog: fires.
    expect(engine.onState(state(1, 0, { homeBp: 3100, awayBp: 4600 }))).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'home', marketTicker: `${GAME}-ARS` });
  });
});

describe('backtest: underdogOnly uses the kick-off asks', () => {
  const game = (pregame?: SimGame['pregame']): SimGame => ({
    id: 'g1',
    playedAt: '2026-01-01T15:00:00Z',
    finalHome: 1,
    finalAway: 0,
    goals: [{ side: 'home', period: 2, minute: 60, second: 0 }],
    markets: { home: { ticker: 'H' }, away: { ticker: 'A' } },
    ...(pregame ? { pregame } : {}),
  });
  const input = (g: SimGame, candles: SimInput['candles'] = new Map()): SimInput => ({
    sport: 'soccer',
    params: {
      rule: { ...rule({ underdogOnly: true }), windowMinutes: 10 },
      sizing: { type: 'percent_of_balance', percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: {
        orderType: 'ioc_limit',
        maxPrice: 0.97,
        minPrice: null,
        maxSlippage: 0.01,
        minDepthContracts: 0,
        maxFeedAgeSec: 15,
      },
    },
    priceMode: 'exact',
    initialBankrollMicros: 100_000_000,
    precisionMicros: 100,
    candles,
    games: [g],
  });
  const candles = (homeKick: number, awayKick: number) =>
    new Map([
      [
        'H',
        new Map([[0, homeKick], ...Array.from({ length: 30 }, (_, i) => [87 + i, 8000] as [number, number])]),
      ],
      ['A', new Map([[0, awayKick]])],
    ]);

  it('exact mode reads the candle at kick-off; a favourite leader never trades', () => {
    expect(kickoffAsks(input(game(), candles(3000, 4500)), game())).toEqual({ homeBp: 3000, awayBp: 4500 });
    expect(simulate(input(game(), candles(3000, 4500))).trades).toHaveLength(1);
    expect(simulate(input(game(), candles(6000, 2000))).trades).toHaveLength(0);
  });

  it('recorded kick-off asks win; modelled mode has none', () => {
    expect(
      kickoffAsks(
        input(game({ homeBp: 6000, awayBp: 2000 }), candles(3000, 4500)),
        game({ homeBp: 6000, awayBp: 2000 }),
      ),
    ).toEqual({
      homeBp: 6000,
      awayBp: 2000,
    });
    expect(kickoffAsks({ ...input(game()), priceMode: 'modelled' }, game())).toEqual({
      homeBp: null,
      awayBp: null,
    });
  });
});
