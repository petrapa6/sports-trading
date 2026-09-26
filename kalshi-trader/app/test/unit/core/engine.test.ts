import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateLeadAtTime, StrategyEngine, type Signal } from '../../../src/core/engine.js';
import { StrategyDefinitionSchema, type StrategyDefinitionInput } from '../../../src/core/strategy.js';
import { createStrategy } from '../../../src/core/strategyStore.js';
import type { TrackedState } from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { OnceSet, type GameState } from '../../../src/feeds/gameState.js';
import { liveDataToState } from '../../../src/feeds/kalshi/live.js';
import type { LiveData } from '../../../src/feeds/kalshi/schemas.js';
import { logLines, seedGame, trackedGame } from '../../helpers/feeds.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';

const SOCCER_GAME = 'KXEPLGAME-26OCT17ARSCHE';
const HOCKEY_GAME = 'KXNHLGAME-26OCT14SEAVGK';
const NOW = Date.parse('2026-10-17T15:30:00Z');

let tdb: TempDb;
let repos: Repositories;

beforeEach(() => {
  tdb = tempDb();
  repos = createRepositories(tdb.db.orm);
  seedGame(repos, {
    id: SOCCER_GAME,
    leagueId: 'epl',
    scheduledAt: '2026-10-17T14:00:00Z',
    home: 'ARS',
    away: 'CHE',
  });
  seedGame(repos, {
    id: HOCKEY_GAME,
    leagueId: 'nhl',
    scheduledAt: '2026-10-15T02:00:00Z',
    home: 'VGK',
    away: 'SEA',
  });
  const at = new Date(NOW).toISOString();
  for (const [ticker, game, outcome] of [
    [`${SOCCER_GAME}-ARS`, SOCCER_GAME, 'home'],
    [`${SOCCER_GAME}-TIE`, SOCCER_GAME, 'tie'],
    [`${SOCCER_GAME}-CHE`, SOCCER_GAME, 'away'],
    [`${HOCKEY_GAME}-VGK`, HOCKEY_GAME, 'home'],
    [`${HOCKEY_GAME}-SEA`, HOCKEY_GAME, 'away'],
  ] as const)
    repos.markets.insert({ ticker, game_id: game, outcome, status: 'open', updated_at: at });
});
afterEach(() => tdb.cleanup());

const BASE = {
  sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
  execution: { maxPrice: 0.97 },
};

/** Creates a strategy (kill switch off unless `killSwitch`), returns its id. */
function addStrategy(
  def: Partial<StrategyDefinitionInput> & Pick<StrategyDefinitionInput, 'sport' | 'rule'>,
  opts: { killSwitch?: boolean; mode?: 'live' | 'dry_run' } = {},
): string {
  const parsed = StrategyDefinitionSchema.parse({
    name: `${def.sport} strategy`,
    leagueIds: def.sport === 'soccer' ? ['epl', 'laliga'] : ['nhl'],
    ...BASE,
    ...def,
  });
  const s = createStrategy(repos, parsed, new Date(NOW).toISOString());
  repos.strategies.update(
    { id: s.id },
    { kill_switch: opts.killSwitch ? 1 : 0, mode: opts.mode ?? 'dry_run' },
  );
  return s.id;
}

function engine(opts: { allowLiveOrders?: boolean; level?: string } = {}) {
  const logs = captureLogger(opts.level ?? 'debug');
  const evaluate = vi.fn(evaluateLeadAtTime);
  const e = new StrategyEngine({
    repos: () => repos,
    log: logs.log,
    allowLiveOrders: opts.allowLiveOrders ?? false,
    now: () => NOW,
    evaluate,
  });
  return { e, evaluate, logs };
}

const ctx = () => ({ now: NOW, log: captureLogger().log, unknownText: new OnceSet() });
const tracked = (s: GameState, blocked = false): TrackedState => ({ ...s, blocked });

const soccerGame = trackedGame({ id: SOCCER_GAME, leagueId: 'epl', sport: 'soccer' });
/** A soccer state through the Kalshi adapter (`widgetLiveText` such as `80'` or `90+3'`). */
function soccer(home: number, away: number, text: string, details: Record<string, unknown> = {}) {
  const live: LiveData = {
    type: 'soccer_game',
    milestone_id: 'm-soccer-1',
    details: { status: 'live', home_points: home, away_points: away, widgetLiveText: text, ...details },
  };
  return liveDataToState(live, soccerGame, ctx());
}

const hockeyGame = trackedGame({ id: HOCKEY_GAME, leagueId: 'nhl', sport: 'hockey', milestoneId: 'm-nhl-1' });
/** A hockey state through the Kalshi adapter (`round`, `final_round_time_left`). */
function hockey(home: number, away: number, details: Record<string, unknown>) {
  const live: LiveData = {
    type: 'hockey_game',
    milestone_id: 'm-nhl-1',
    details: { status: 'live', home_points: home, away_points: away, ...details },
  };
  return liveDataToState(live, hockeyGame, ctx());
}

const SOCCER_RULE = {
  type: 'lead_at_time',
  minLead: 2,
  atMinute: 80,
  windowMinutes: 5,
  leaderSide: 'any',
} as const;

/** Signals of a fresh engine for one state against one soccer strategy. */
function soccerSignals(state: TrackedState, rule: Partial<typeof SOCCER_RULE> & { atMinute?: number } = {}) {
  addStrategy({ sport: 'soccer', rule: { ...SOCCER_RULE, ...rule } });
  const { e, logs } = engine();
  return { signals: e.onState(state), logs };
}

describe('lead_at_time — soccer {minLead:2, atMinute:80, windowMinutes:5, leaderSide:any}', () => {
  it("2-0 at 80' → signal for the home market", () => {
    const { signals } = soccerSignals(tracked(soccer(2, 0, "80'")));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'home', marketTicker: `${SOCCER_GAME}-ARS`, minute: 80 });
  });
  it("2-0 at 79' → none", () => {
    expect(soccerSignals(tracked(soccer(2, 0, "79'"))).signals).toEqual([]);
  });
  it("2-0 first seen at 84' → signal", () => {
    expect(soccerSignals(tracked(soccer(2, 0, "84'"))).signals).toHaveLength(1);
  });
  it("2-0 at 86' → none", () => {
    expect(soccerSignals(tracked(soccer(2, 0, "86'"))).signals).toEqual([]);
  });
  it("1-0 at 80' → none", () => {
    expect(soccerSignals(tracked(soccer(1, 0, "80'"))).signals).toEqual([]);
  });
  it("0-2 at 80' → signal for the away market", () => {
    const { signals } = soccerSignals(tracked(soccer(0, 2, "80'")));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'away', marketTicker: `${SOCCER_GAME}-CHE` });
  });
  it("leaderSide:'home' with 0-2 → none", () => {
    expect(soccerSignals(tracked(soccer(0, 2, "80'")), { leaderSide: 'home' } as never).signals).toEqual([]);
  });
  it('halftime → none', () => {
    const s = tracked(soccer(2, 0, 'HT'));
    expect(s.phase).toBe('halftime');
    // Even with a window that would cover any minute: never during a break.
    expect(soccerSignals(s, { atMinute: 1, windowMinutes: 90 } as never).signals).toEqual([]);
  });
  it('regulationOver → none', () => {
    const s = tracked({
      ...soccer(2, 0, "82'"),
      clock: { minute: 82, minuteSource: 'feed', regulationOver: true },
    });
    expect(soccerSignals(s).signals).toEqual([]);
    const ft = tracked(soccer(2, 0, 'FT'));
    expect(ft.clock.regulationOver).toBe(true);
    expect(soccerSignals(ft, { atMinute: 85, windowMinutes: 5 } as never).signals).toEqual([]);
  });
  it('blocked → none, with a debug line', () => {
    const { signals, logs } = soccerSignals(tracked(soccer(2, 0, "80'"), true));
    expect(signals).toEqual([]);
    const debug = logLines(logs.text()).filter((l) => l.level === 20);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatchObject({ mode: 'dry_run', gameId: SOCCER_GAME });
    expect(debug[0]?.msg).toMatch(/blocked/);
  });
  it("stoppage 90+3' counts as 90 → signal only with a window covering 90", () => {
    const s = tracked(soccer(2, 0, "90+3'"));
    expect(s.clock.minute).toBe(90);
    expect(soccerSignals(s).signals).toEqual([]); // window 80–85
    expect(soccerSignals(s, { atMinute: 85, windowMinutes: 5 } as never).signals).toHaveLength(1); // 85–90
  });
});

describe('lead_at_time — hockey {minLead:2, atMinute:50}', () => {
  const rule = { type: 'lead_at_time', minLead: 2, atMinute: 50 } as const;
  const hockeySignals = (state: TrackedState) => {
    addStrategy({ sport: 'hockey', rule });
    return engine().e.onState(state);
  };

  it('the default hockey window is 3 minutes', () => {
    expect(
      StrategyDefinitionSchema.parse({ name: 'h', sport: 'hockey', leagueIds: ['nhl'], rule, ...BASE }).rule,
    ).toMatchObject({ windowMinutes: 3, leaderSide: 'any', version: 1 });
  });
  it('period 3 with 10:00 left (minute 50) and 3-1 → signal', () => {
    const s = tracked(hockey(3, 1, { round: 3, final_round_time_left: '10:00' }));
    const signals = hockeySignals(s);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ side: 'home', minute: 50, marketTicker: `${HOCKEY_GAME}-VGK` });
  });
  it('10:01 left (minute 49) → none', () => {
    expect(hockeySignals(tracked(hockey(3, 1, { round: 3, final_round_time_left: '10:01' })))).toEqual([]);
  });
  it('period 2 → none', () => {
    expect(hockeySignals(tracked(hockey(3, 1, { round: 2, final_round_time_left: '10:00' })))).toEqual([]);
  });
  it('intermission → none', () => {
    const s = tracked(hockey(3, 1, { round: 2, final_round_time_left: '00:00' }));
    expect(s.phase).toBe('intermission');
    expect(hockeySignals(s)).toEqual([]);
  });
  it('OT → none', () => {
    const s = tracked(hockey(3, 1, { round: 4, final_round_time_left: '03:10' }));
    expect(s.clock.period).toBe(4);
    expect(hockeySignals(s)).toEqual([]);
    // Also with a state that claims minute 50 in period 4.
    expect(
      evaluateLeadAtTime(
        { type: 'lead_at_time', version: 1, minLead: 2, atMinute: 50, windowMinutes: 30, leaderSide: 'any' },
        'hockey',
        { ...s, phase: 'live', clock: { minute: 50, period: 4, regulationOver: false } },
      ),
    ).toEqual({ match: false, reason: 'overtime' });
  });
});

describe('once per game per strategy', () => {
  it('after a trades row exists for (strategy, game), re-evaluation emits nothing; another strategy on the same game still signals', () => {
    const first = addStrategy({ sport: 'soccer', name: 'first', rule: SOCCER_RULE });
    repos.trades.insert({
      id: 'trade-1',
      strategy_id: first,
      strategy_version: 1,
      game_id: SOCCER_GAME,
      market_ticker: `${SOCCER_GAME}-ARS`,
      league_id: 'epl',
      kalshi_env: 'demo',
      configured_mode: 'dry_run',
      effective_mode: 'dry_run',
      mode_reason: 'addon_lock',
      status: 'signalled',
      trigger_snapshot: '{}',
      triggered_at: new Date(NOW).toISOString(),
      window_ends_at: new Date(NOW + 5 * 60_000).toISOString(),
    });
    const { e } = engine();
    expect(e.onState(tracked(soccer(2, 0, "80'")))).toEqual([]);
    expect(e.onState(tracked(soccer(2, 0, "81'")))).toEqual([]);

    const second = addStrategy({ sport: 'soccer', name: 'second', rule: SOCCER_RULE });
    const signals = e.onState(tracked(soccer(2, 0, "82'")));
    expect(signals.map((s) => s.strategyId)).toEqual([second]);
  });

  it('a strategy signals at most once per game while the process runs', () => {
    addStrategy({ sport: 'soccer', rule: SOCCER_RULE });
    const { e } = engine();
    expect(e.onState(tracked(soccer(2, 0, "80'")))).toHaveLength(1);
    expect(e.onState(tracked(soccer(2, 0, "81'")))).toEqual([]);
    expect(e.onState(tracked(soccer(3, 0, "83'")))).toEqual([]);
    e.forget(SOCCER_GAME); // a replay starting the game over
    expect(e.onState(tracked(soccer(2, 0, "84'")))).toHaveLength(1);
  });

  it('strategies of another sport or without the league are not evaluated', () => {
    addStrategy({ sport: 'soccer', leagueIds: ['laliga'], rule: SOCCER_RULE });
    addStrategy({
      sport: 'hockey',
      rule: { type: 'lead_at_time', minLead: 1, atMinute: 1, windowMinutes: 59 },
    });
    const { e, evaluate } = engine();
    expect(e.onState(tracked(soccer(2, 0, "80'")))).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('paused strategies are not evaluated', () => {
  it('strategy kill switch on → zero evaluations (spy)', () => {
    addStrategy({ sport: 'soccer', rule: SOCCER_RULE }, { killSwitch: true });
    const { e, evaluate } = engine();
    for (const m of [80, 81, 82]) expect(e.onState(tracked(soccer(2, 0, `${m}'`)))).toEqual([]);
    expect(evaluate).toHaveBeenCalledTimes(0);
  });

  it('global kill switch on → nothing is evaluated even when a state arrives', () => {
    addStrategy({ sport: 'soccer', rule: SOCCER_RULE });
    repos.settings.set('global_kill_switch', true);
    const { e, evaluate } = engine();
    expect(e.onState(tracked(soccer(2, 0, "80'")))).toEqual([]);
    expect(evaluate).toHaveBeenCalledTimes(0);
    repos.settings.set('global_kill_switch', false);
    expect(e.onState(tracked(soccer(2, 0, "80'")))).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('signal labelling', () => {
  it("allowLiveOrders=false and a strategy in live → configuredMode 'live', effectiveMode 'dry_run', modeReason 'addon_lock'; log line mode dry_run", () => {
    const id = addStrategy({ sport: 'soccer', rule: SOCCER_RULE }, { mode: 'live' });
    repos.settings.set('global_dry_run', false);
    const { e, logs } = engine({ allowLiveOrders: false, level: 'info' });
    const emitted: Signal[] = [];
    e.on('signal', (s) => emitted.push(s));
    const signals = e.onState(tracked(soccer(2, 0, "80'")));
    expect(emitted).toEqual(signals);
    expect(signals[0]).toMatchObject({
      strategyId: id,
      version: 1,
      gameId: SOCCER_GAME,
      configuredMode: 'live',
      effectiveMode: 'dry_run',
      modeReason: 'addon_lock',
      snapshot: { homeScore: 2, awayScore: 0, clock: { minute: 80, minuteSource: 'feed' } },
    });
    const line = logLines(logs.text()).find((l) => l.msg.startsWith('Signal'));
    expect(line).toMatchObject({ mode: 'dry_run', configuredMode: 'live', modeReason: 'addon_lock' });
    expect(logs.text()).toContain('"mode":"dry_run"');
  });

  it('global dry run → global_dry_run; strategy dry_run → strategy; everything open → live', () => {
    const cases = [
      { globalDryRun: true, mode: 'live' as const, expected: ['dry_run', 'global_dry_run'] },
      { globalDryRun: false, mode: 'dry_run' as const, expected: ['dry_run', 'strategy'] },
      { globalDryRun: false, mode: 'live' as const, expected: ['live', null] },
    ];
    for (const [i, c] of cases.entries()) {
      repos.settings.set('global_dry_run', c.globalDryRun);
      const id = addStrategy({ sport: 'soccer', name: `case ${i}`, rule: SOCCER_RULE }, { mode: c.mode });
      const { e } = engine({ allowLiveOrders: true });
      const s = e.onState(tracked(soccer(2, 0, "80'"))).find((x) => x.strategyId === id);
      expect([s?.effectiveMode, s?.modeReason]).toEqual(c.expected);
      repos.strategies.update({ id }, { kill_switch: 1 });
    }
  });
});
