import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { candleMinuteMs } from '../../../src/backtest/clock.js';
import { loadSimInput, type ResolvedRequest } from '../../../src/backtest/data.js';
import { simulate } from '../../../src/backtest/simulator.js';
import { bpToDollars } from '../../../src/core/decimal.js';
import { StrategyEngine } from '../../../src/core/engine.js';
import { Executor } from '../../../src/core/executor.js';
import { Settler } from '../../../src/core/settler.js';
import { StrategyDefinitionSchema } from '../../../src/core/strategy.js';
import { createStrategy } from '../../../src/core/strategyStore.js';
import { GameTracker, type GoalEvent } from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import type { GameState } from '../../../src/feeds/gameState.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { seedGame } from '../../helpers/feeds.js';
import { captureLogger, kalshiMockServer, must, testClient } from '../../helpers/kalshiMsw.js';
import { Clock, KalshiScript, marketJson } from '../../helpers/trading.js';

/**
 * T12 parity (SPEC.md §14 T12): the synthetic game `test/fixtures/parity/game-a.json` is (a) replayed minute by
 * minute through the real GameTracker → StrategyEngine → Executor (dry run) → Settler, with the orderbook at
 * each minute mocked from the fixture's candle series, and (b) run through the simulator in exact mode over
 * the timeline the tracker archived and the same candles stored in `hist_prices`. Both must enter at the same
 * minute with the same limit price, contracts, fee and P&L.
 */

interface Fixture {
  leagueId: string;
  event: string;
  kickoff: string;
  home: { name: string; abbreviation: string };
  away: { name: string; abbreviation: string };
  goals: GoalEvent[];
  final: [number, number];
  strategy: unknown;
  candles: { home: Record<string, number>; away: Record<string, number> };
  retryCandles: { home: Record<string, number> };
}

const FX = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/parity/game-a.json'), 'utf8'),
) as Fixture;
const HOME = `${FX.event}-${FX.home.abbreviation}`;
const AWAY = `${FX.event}-${FX.away.abbreviation}`;
const KICKOFF = Date.parse(FX.kickoff);
const MIN = 60_000;

const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
let tdb: TempDb | undefined;
afterEach(() => {
  mock.server.resetHandlers();
  tdb?.cleanup();
  tdb = undefined;
});

/** The ask of the latest candle at or before `minute` (the orderbook the live replay sees). */
function askAt(series: Record<string, number>, minute: number): number | undefined {
  let best: number | undefined;
  for (const [m, ask] of Object.entries(series)) if (Number(m) <= minute) best = ask;
  return best;
}

interface LiveResult {
  repos: Repositories;
  minute: number;
  limitBp: number;
  fillCc: number;
  feeMicros: number;
  pnlMicros: number;
}

async function liveReplay(candles: Fixture['candles']): Promise<LiveResult> {
  tdb = tempDb();
  const db = tdb;
  const clock = new Clock(KICKOFF);
  const repos = createRepositories(db.db.orm, clock.now);
  seedGame(repos, {
    id: FX.event,
    leagueId: FX.leagueId,
    scheduledAt: FX.kickoff,
    home: FX.home.abbreviation,
    away: FX.away.abbreviation,
  });
  for (const [ticker, outcome] of [
    [HOME, 'home'],
    [AWAY, 'away'],
  ] as const) {
    repos.markets.insert({ ticker, game_id: FX.event, outcome, status: 'open', updated_at: FX.kickoff });
  }
  const script = new KalshiScript();
  mock.use(...script.handlers());
  for (const t of [HOME, AWAY])
    script.market.set(t, marketJson(t, { event_ticker: FX.event, close_time: '2099-01-01T00:00:00Z' }));

  const logs = captureLogger('info');
  const transaction = (fn: () => void) => db.db.sqlite.transaction(fn)();
  const client = testClient({ killSwitch: () => repos.settings.get('global_kill_switch') });
  const tracker = new GameTracker({ repos: () => repos, log: logs.log, transaction, now: clock.now });
  const engine = new StrategyEngine({
    repos: () => repos,
    log: logs.log,
    allowLiveOrders: false,
    now: clock.now,
  }).attach(tracker);
  const executor = new Executor({
    repos: () => repos,
    log: logs.log,
    kalshi: () => client,
    allowLiveOrders: false,
    kalshiEnv: 'demo',
    transaction,
    now: clock.now,
  }).attach(engine, tracker);
  const settler = new Settler({
    repos: () => repos,
    log: logs.log,
    kalshi: () => client,
    transaction,
    now: clock.now,
  });
  const s = createStrategy(repos, StrategyDefinitionSchema.parse(FX.strategy), clock.iso());
  repos.strategies.update({ id: s.id }, { kill_switch: 0 });

  const minuteAt = new Map<number, number>();
  const observe = async (minute: number, period: number, at: number, phase: GameState['phase'] = 'live') => {
    clock.ms = at;
    for (const [ticker, series] of [
      [HOME, candles.home],
      [AWAY, candles.away],
    ] as const) {
      const ask = askAt(series, minute);
      if (ask !== undefined) script.setAsk(ticker, bpToDollars(ask), '1000.00');
    }
    const home = FX.goals.filter((g) => g.side === 'home' && g.minute <= minute).length;
    const away = FX.goals.filter((g) => g.side === 'away' && g.minute <= minute).length;
    const state: GameState = {
      gameId: FX.event,
      leagueId: FX.leagueId,
      homeTeam: FX.home.name,
      awayTeam: FX.away.name,
      homeScore: home,
      awayScore: away,
      phase,
      clock: { minute, minuteSource: 'feed', period, regulationOver: phase === 'finished' },
      source: 'kalshi-live',
      observedAt: new Date(at),
    };
    minuteAt.set(at, minute);
    tracker.ingest('kalshi-live', [{ state, raw: {} }]);
    await executor.idle();
  };
  for (let m = 0; m <= 45; m++) await observe(m, 1, candleMinuteMs('soccer', KICKOFF, m));
  // Second-half kick-off at the nominal time the simulator assumes (45' + stoppage + break).
  await observe(45, 2, KICKOFF + (45 + 17) * MIN);
  for (let m = 46; m <= 90; m++) await observe(m, 2, candleMinuteMs('soccer', KICKOFF, m));
  await observe(90, 2, KICKOFF + 115 * MIN, 'finished');

  script.market.set(
    HOME,
    marketJson(HOME, {
      status: 'finalized',
      result: 'yes',
      settlement_value_dollars: '1.0000',
      close_time: '2099-01-01T00:00:00Z',
    }),
  );
  await settler.runOnce();

  const trades = repos.trades.list();
  expect(trades).toHaveLength(1);
  const trade = must(trades[0], 'trade');
  expect(trade.status).toBe('settled_won');
  const fill = must(
    repos.tradeAttempts.list().find((a) => a.status === 'filled'),
    'filled attempt',
  );
  return {
    repos,
    minute: must(minuteAt.get(Date.parse(fill.at)), 'fill minute'),
    limitBp: must(trade.limit_price_bp, 'limit'),
    fillCc: must(trade.fill_cc, 'fill'),
    feeMicros: must(trade.fee_micros, 'fee'),
    pnlMicros: must(trade.realized_pnl_micros, 'pnl'),
  };
}

function simulatorRun(repos: Repositories, candles: Fixture['candles']) {
  const archived = must(repos.histGames.get({ id: `live:${FX.event}` }), 'archived timeline');
  expect(JSON.parse(archived.goal_events)).toEqual(FX.goals);
  expect([archived.final_home, archived.final_away]).toEqual(FX.final);
  for (const [ticker, series] of [
    [HOME, candles.home],
    [AWAY, candles.away],
  ] as const) {
    repos.histPrices.insertMany(
      Object.entries(series).map(([m, ask]) => ({
        market_ticker: ticker,
        minute_ts: new Date(candleMinuteMs('soccer', KICKOFF, Number(m))).toISOString(),
        ask_close_bp: ask,
        bid_close_bp: ask - 100,
        trade_close_bp: null,
      })),
    );
  }
  const def = StrategyDefinitionSchema.parse(FX.strategy);
  const req: ResolvedRequest = {
    name: null,
    saved: false,
    quick: false,
    sport: 'soccer',
    leagueIds: [FX.leagueId],
    seasons: [],
    sinceIso: null,
    strategy: null,
    definition: {
      name: def.name,
      leagueIds: def.leagueIds,
      rule: def.rule,
      sizing: def.sizing,
      execution: def.execution,
    },
    priceMode: 'exact',
    initialBankrollMicros: 100_000_000,
  };
  const result = simulate(loadSimInput(must(tdb, 'db').db.sqlite, req));
  expect(result.trades).toHaveLength(1);
  return must(result.trades[0], 'simulated trade');
}

describe('parity: live replay (dry run) vs simulator (exact)', () => {
  it('game-a: same entry minute, limit price, contracts, fee and P&L', async () => {
    const live = await liveReplay(FX.candles);
    const sim = simulatorRun(live.repos, FX.candles);
    expect(sim.price_source).toBe('candle');
    expect({
      minute: sim.minute,
      limitBp: sim.price_bp,
      fillCc: sim.contracts_cc,
      feeMicros: sim.fee_micros,
      pnlMicros: sim.pnl_micros,
    }).toEqual({
      minute: live.minute,
      limitBp: live.limitBp,
      fillCc: live.fillCc,
      feeMicros: live.feeMicros,
      pnlMicros: live.pnlMicros,
    });
    expect(live.minute).toBe(80);
    expect(live.limitBp).toBe(8900);
  });

  it('retry parity: ask above maxPrice at 80 and 81, below at 82 → entry at 82 in both', async () => {
    const candles = { home: FX.retryCandles.home, away: FX.candles.away };
    const live = await liveReplay(candles);
    const sim = simulatorRun(live.repos, candles);
    expect(live.minute).toBe(82);
    expect(sim.minute).toBe(82);
    expect([sim.price_bp, sim.contracts_cc, sim.fee_micros, sim.pnl_micros]).toEqual([
      live.limitBp,
      live.fillCc,
      live.feeMicros,
      live.pnlMicros,
    ]);
    // The live trade went through soft `price` skips before the fill.
    const reasons = live.repos.tradeAttempts.list().map((a) => a.reason ?? a.status);
    expect(reasons.slice(0, 2)).toEqual(['price', 'price']);
  });
});
