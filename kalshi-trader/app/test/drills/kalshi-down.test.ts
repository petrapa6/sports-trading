import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEngine } from '../../src/core/engine.js';
import { Executor } from '../../src/core/executor.js';
import { OrderGroupManager } from '../../src/core/orderGroup.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { StrategyDefinitionSchema } from '../../src/core/strategy.js';
import { createStrategy } from '../../src/core/strategyStore.js';
import { GameTracker } from '../../src/core/tracker.js';
import type { FeedObservation, ScoreFeed, TrackedGame } from '../../src/feeds/gameState.js';
import { KalshiLiveFeed } from '../../src/feeds/kalshi/live.js';
import { NetworkPaused } from '../../src/feeds/network.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { logLines, seedGame } from '../helpers/feeds.js';
import { captureLogger, kalshiMockServer, must, TEST_BASE, testClient } from '../helpers/kalshiMsw.js';
import { AWAY_TICKER, GAME, hockeyState, HOME_TICKER, KalshiScript } from '../helpers/trading.js';

/**
 * Failure drill (c) (SPEC.md §14 T14, run by `scripts/drills/kalshi-down.ts`): Kalshi answers 503 to everything for
 * 10 minutes of fake time while an NHL game is live and a dry-run strategy's entry window is open. The real
 * scheduler, tracker, engine and executor run against the msw Kalshi stand-in and a stand-in for the NHL feed.
 *
 * Expected: the feeds keep being polled every 5 s (the NHL one keeps the game state fresh, the Kalshi one fails and
 * reports `error`), every entry attempt ends `error` with the trade `waiting`, the loop stays healthy, and once
 * Kalshi answers again the first successful call is logged ("Kalshi reachable again") and the entry fills.
 */

const MIN = 60_000;
const START = Date.parse('2026-10-15T03:30:00Z');
const OUTAGE_MS = 10 * MIN;

/** Stand-in for the NHL feed: the game at minute 50 (window of 20 minutes), home leads 3-1, observed now. */
class NhlStandIn implements ScoreFeed {
  readonly id = 'nhl-official' as const;
  readonly sports = ['hockey'] as const;
  polls: number[] = [];
  constructor(private readonly paused: () => boolean) {}
  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    if (this.paused()) throw new NetworkPaused();
    this.polls.push(Date.now());
    return games.map(() => ({
      raw: {},
      state: { ...hockeyState(50, 3, 1, { observedAt: Date.now() }), source: 'nhl-official' },
    }));
  }
  listLive = async () => [];
  get = async () => {
    throw new Error('unused');
  };
  test = async () => 'ok';
}

/**
 * Advances fake time in 500 ms steps, letting real I/O (msw answers a real `fetch`) complete between steps: a
 * single `advanceTimersByTimeAsync(10 min)` would run every timer before the first response arrived.
 */
const realSetTimeout = globalThis.setTimeout;
async function advance(ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 500) {
    await vi.advanceTimersByTimeAsync(Math.min(500, ms - done));
    await new Promise((r) => realSetTimeout(r, 1));
  }
}

const mock = kalshiMockServer();
let script: KalshiScript;
let down = false;
let t: TestApp;
let scheduler: Scheduler;
let nhl: NhlStandIn;
let logs: ReturnType<typeof captureLogger>;

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START });
  down = false;
  script = new KalshiScript();
  script.setAsk(HOME_TICKER, '0.9300');
  // While `down`, every Kalshi path answers 503 (before the per-path handlers of the script).
  mock.use(
    http.all(`${TEST_BASE}/*`, () => (down ? HttpResponse.json({}, { status: 503 }) : undefined)),
    ...script.handlers(),
  );
  logs = captureLogger('info');
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const killSwitch = () => repos().settings.get('global_kill_switch');
  const log = logs.log;
  const client = testClient({ killSwitch, log });
  const transaction = (fn: () => void) => fn();
  const tracker = new GameTracker({ repos, log });
  const engine = new StrategyEngine({ repos, log, allowLiveOrders: false }).attach(tracker);
  const orderGroups = new OrderGroupManager({ repos, log, kalshi: () => client, allowLiveOrders: false });
  const executor = new Executor({
    repos,
    log,
    kalshi: () => client,
    allowLiveOrders: false,
    kalshiEnv: 'demo',
    transaction,
    orderGroups,
  }).attach(engine, tracker);
  nhl = new NhlStandIn(killSwitch);
  const feeds: ScoreFeed[] = [new KalshiLiveFeed({ client, log, games: () => tracker.pollTargets() }), nhl];
  scheduler = new Scheduler({ tracker, feeds, isFeedEnabled: () => true, isPaused: killSwitch, log });
  t = await createTestApp({ live: { tracker, scheduler, feeds, engine, executor } });
  box.app = t;

  const r = t.manager.repositories;
  seedGame(r, {
    id: GAME,
    leagueId: 'nhl',
    scheduledAt: new Date(START - 90 * MIN).toISOString(),
    home: 'VGK',
    away: 'SEA',
    phase: 'live',
  });
  for (const [ticker, outcome] of [
    [HOME_TICKER, 'home'],
    [AWAY_TICKER, 'away'],
  ] as const)
    r.markets.insert({
      ticker,
      game_id: GAME,
      outcome,
      status: 'open',
      close_time: '2026-10-16T05:00:00Z',
      updated_at: new Date(START).toISOString(),
    });
  const def = StrategyDefinitionSchema.parse({
    name: 'Drill: NHL 2-goal lead at 50',
    sport: 'hockey',
    leagueIds: ['nhl'],
    rule: { type: 'lead_at_time', minLead: 2, atMinute: 50, windowMinutes: 20 },
    sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
    execution: { maxPrice: 0.97, maxSlippage: 0.01, minDepthContracts: 20, maxFeedAgeSec: 15 },
  });
  const s = createStrategy(r, def, new Date(START).toISOString());
  r.strategies.update({ id: s.id }, { kill_switch: 0, mode: 'dry_run' });
});
afterEach(async () => {
  scheduler.stop();
  await t.close();
  mock.server.resetHandlers();
  vi.useRealTimers();
});

describe('drill: Kalshi 503 for 10 minutes', () => {
  it('feeds keep polling, attempts end error / waiting, the first successful call after recovery is logged', async () => {
    const r = t.manager.repositories;
    down = true;
    mock.requests.length = 0;
    const seenBefore = mock.seen.length;
    scheduler.start();
    await advance(OUTAGE_MS);

    // Feeds: the NHL stand-in kept being polled for the whole outage. A tick waits for every feed, and each failing
    // Kalshi call backs off (0.5 + 1 + 2 + 4 s) before it gives up, so during the outage a tick takes ~12.5 s
    // instead of 5 s; the NHL state still never gets older than `maxFeedAgeSec` (15 s).
    const gaps = nhl.polls.slice(1).map((at, i) => at - (nhl.polls[i] ?? at));
    const maxGap = Math.max(...gaps);
    expect(nhl.polls.length).toBeGreaterThanOrEqual(40);
    expect(maxGap).toBeLessThanOrEqual(15_000);
    // The Kalshi feed tried on every tick and reports `error`.
    const kalshiLive = mock.seen.slice(seenBefore).filter((u) => u.includes('/live_data/batch'));
    expect(kalshiLive.length).toBeGreaterThanOrEqual(10);
    const status = scheduler.status();
    expect(status.state).toBe('running');
    expect(status.feeds.find((f) => f.id === 'kalshi-live')?.status).toBe('error');
    expect(status.feeds.find((f) => f.id === 'nhl-official')?.status).toBe('ok');
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).body).toBe(
      '{"ok":true,"loop":"running"}',
    );

    // Attempts: each one ended `error`, the trade waits for the next tick (the window is still open). An attempt
    // in flight at the 10-minute mark is let finish first (still during the outage).
    const inFlight = () => r.tradeAttempts.listByStatus('pending').length > 0;
    for (let i = 0; i < 60 && inFlight(); i++) await advance(500);
    const [trade] = r.trades.list();
    expect(trade).toMatchObject({ status: 'waiting', skip_reason: 'error', effective_mode: 'dry_run' });
    const attempts = r.tradeAttempts.listForTrade(must(trade, 'trade').id);
    expect(attempts.length).toBeGreaterThanOrEqual(5);
    expect(new Set(attempts.map((a) => a.status))).toEqual(new Set(['error']));
    expect(logLines(logs.text()).some((l) => l.msg === 'Kalshi reachable again')).toBe(false);

    // Recovery: Kalshi answers again → one "Kalshi reachable again" line; the entry fills on the next tick.
    down = false;
    await advance(30_000);
    const back = logLines(logs.text()).filter((l) => l.msg === 'Kalshi reachable again');
    expect(back).toHaveLength(1);
    expect(back[0]?.['downForMs']).toBeGreaterThanOrEqual(OUTAGE_MS - 30_000);
    expect(back[0]?.['failedCalls']).toBeGreaterThan(10);
    expect(must(r.trades.get({ id: must(trade, 'trade').id }), 'trade')).toMatchObject({
      status: 'filled',
      effective_mode: 'dry_run',
    });
    expect(scheduler.status().feeds.find((f) => f.id === 'kalshi-live')?.status).toBe('ok');

    // What the drill script prints.
    const outage = attempts.map((a) => a.status);
    console.log(
      [
        `outage ${OUTAGE_MS / MIN} min: NHL feed polled ${nhl.polls.length}× (largest gap ${maxGap / 1000} s), ${kalshiLive.length} Kalshi live-data requests incl. backoff retries (feed status error)`,
        `attempts during the outage: ${outage.length}, all ${[...new Set(outage)].join('/')}; trade waiting (${trade?.skip_reason})`,
        `recovery: "${String(back[0]?.msg)}" downForMs=${String(back[0]?.['downForMs'])} failedCalls=${String(back[0]?.['failedCalls'])}; trade filled`,
      ].join('\n'),
    );
  });
});
