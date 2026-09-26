import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BalanceRecorder } from '../../src/core/balances.js';
import { StrategyEngine } from '../../src/core/engine.js';
import { Executor, PENDING_LIVE_MIN_AGE_MS } from '../../src/core/executor.js';
import { OrderGroupManager } from '../../src/core/orderGroup.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { Settler } from '../../src/core/settler.js';
import { snapshotBalanceOnLiveChanges, startTrading } from '../../src/core/startup.js';
import { StrategyDefinitionSchema } from '../../src/core/strategy.js';
import { createStrategy } from '../../src/core/strategyStore.js';
import { GameTracker } from '../../src/core/tracker.js';
import type { ScoreFeed } from '../../src/feeds/gameState.js';
import { DiscoveryService } from '../../src/feeds/kalshi/discovery.js';
import { KalshiLiveFeed } from '../../src/feeds/kalshi/live.js';
import { createNetworkGate } from '../../src/feeds/network.js';
import { NhlFeed } from '../../src/feeds/nhl/feed.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { seedGame } from '../helpers/feeds.js';
import { captureLogger, kalshiMockServer, must, testClient } from '../helpers/kalshiMsw.js';
import { routeNhl } from '../helpers/nhlFixtures.js';
import { AWAY_TICKER, GAME, HOME_TICKER, KalshiScript } from '../helpers/trading.js';

/**
 * Failure drill (d) (SPEC.md §14 T14, run by `scripts/drills/kill-switch.ts`): the global kill switch is on while
 * an NHL game is live and a live strategy is enabled with the add-on lock open. Everything that can talk to the
 * outside is wired as in `main.ts` — the Kalshi client (msw stand-in), the Kalshi live-data and NHL feeds (the NHL
 * one against msw with the recorded fixtures), discovery, order group, restart recovery, executor, settler and
 * balance recorder — and 10 minutes of fake time pass.
 *
 * Expected: zero outgoing requests (msw sees none, on any host) and `/healthz` 200 `{"ok":true,"loop":"paused"}`.
 * Control: the switch off → requests start within one interval, so the wiring really would have called out.
 */

const MIN = 60_000;
const START = Date.parse('2026-10-15T03:30:00Z');
const NHL_BASE = 'https://nhl.test/v1';

const realSetTimeout = globalThis.setTimeout;
/** Fake time in 500 ms steps, with real I/O between steps (see kalshi-down.test.ts). */
async function advance(ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 500) {
    await vi.advanceTimersByTimeAsync(Math.min(500, ms - done));
    await new Promise((r) => realSetTimeout(r, 1));
  }
}

const mock = kalshiMockServer();
let t: TestApp;
let stops: (() => void)[] = [];

beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mock.server.close());
afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  await t.close();
  mock.server.resetHandlers();
  vi.useRealTimers();
});

describe('drill: global kill switch', () => {
  it('zero outgoing requests for 10 minutes and /healthz 200 paused; switched off → requests resume', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      now: START,
    });
    const script = new KalshiScript();
    script.setAsk(HOME_TICKER, '0.9300');
    mock.use(
      ...script.handlers(),
      http.get(`${NHL_BASE}/*`, ({ request }) => {
        const r = routeNhl(new URL(request.url).pathname.slice('/v1'.length));
        return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
      }),
    );
    const logs = captureLogger('info');
    const log = logs.log;
    const box: { app?: TestApp } = {};
    const repos = () => must(box.app, 'app').manager.repositories;
    const killSwitch = () => repos().settings.get('global_kill_switch');
    const gate = createNetworkGate(killSwitch);
    const client = testClient({ killSwitch, log });
    const transaction = (fn: () => void) => fn();
    const tracker = new GameTracker({ repos, log });
    const engine = new StrategyEngine({ repos, log, allowLiveOrders: true }).attach(tracker);
    const orderGroups = new OrderGroupManager({ repos, log, kalshi: () => client, allowLiveOrders: true });
    const executor = new Executor({
      repos,
      log,
      kalshi: () => client,
      allowLiveOrders: true,
      kalshiEnv: 'demo',
      transaction,
      orderGroups,
    }).attach(engine, tracker);
    const settler = new Settler({
      repos,
      log,
      kalshi: () => client,
      transaction,
      beforeRun: async () => {
        executor.sweep();
        await executor.resolvePendingLive('order_not_found', PENDING_LIVE_MIN_AGE_MS);
      },
    });
    const balances = new BalanceRecorder({
      repos,
      log,
      kalshi: () => client,
      kalshiEnv: 'demo',
      subaccount: 0,
    });
    snapshotBalanceOnLiveChanges(balances, executor, settler);
    const discovery = new DiscoveryService({
      deps: () => ({ client, repos: repos(), log, transaction }),
      log,
    });
    const games = () => tracker.pollTargets();
    const feeds: ScoreFeed[] = [
      new KalshiLiveFeed({ client, log, games }),
      new NhlFeed({ gate, log, games, baseUrl: NHL_BASE }),
    ];
    const scheduler = new Scheduler({
      tracker,
      feeds,
      isFeedEnabled: () => true,
      isPaused: killSwitch,
      log,
      balance: async () => (await client.getBalance()).cash_micros,
    });
    t = await createTestApp({
      runtime: { allowLiveOrders: true },
      live: { tracker, scheduler, feeds, engine, executor, settler, orderGroups },
    });
    box.app = t;
    stops = [() => discovery.stop(), () => scheduler.stop(), () => settler.stop(), () => balances.stop()];

    // A live NHL game with its markets, a live strategy, global dry run off, the add-on lock open, and a live
    // attempt left `pending` by a "crash" (restart recovery would look it up on Kalshi).
    const r = t.manager.repositories;
    seedGame(r, {
      id: GAME,
      leagueId: 'nhl',
      scheduledAt: new Date(START - 90 * MIN).toISOString(),
      home: 'VGK',
      away: 'SEA',
      phase: 'live',
      feedGameIds: { 'nhl-official': 2026020045 },
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
    const s = createStrategy(
      r,
      StrategyDefinitionSchema.parse({
        name: 'Drill: live NHL lead',
        sport: 'hockey',
        leagueIds: ['nhl'],
        rule: { type: 'lead_at_time', minLead: 1, atMinute: 1, windowMinutes: 60 },
        sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 5 },
        execution: { maxPrice: 0.97 },
      }),
      new Date(START).toISOString(),
    );
    r.strategies.update({ id: s.id }, { kill_switch: 0, mode: 'live' });
    r.settings.set('global_dry_run', false);
    r.settings.set('global_kill_switch', true);

    const seenBefore = mock.seen.length;
    discovery.start();
    await startTrading({
      log,
      orderGroups,
      recover: () => executor.recoverOnStart(),
      loops: [scheduler, settler, balances],
    });
    await advance(10 * MIN);

    const during = mock.seen.slice(seenBefore);
    expect(during).toEqual([]);
    const h = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(h.body).toBe('{"ok":true,"loop":"paused"}');
    expect(scheduler.status().feeds.map((f) => f.status)).toEqual(['paused', 'paused']);
    expect(r.trades.list()).toEqual([]);
    expect(r.balanceSnapshots.list()).toEqual([]);

    // Control: the same wiring calls out as soon as the switch is off.
    r.settings.set('global_kill_switch', false);
    scheduler.wake();
    await advance(10_000);
    const after = mock.seen.slice(seenBefore);
    const hosts = [...new Set(after.map((u) => new URL(u.split(' ')[1] ?? '').host))].sort();
    expect(after.length).toBeGreaterThan(0);
    expect(hosts).toEqual(['kalshi.test', 'nhl.test']);

    console.log(
      [
        `kill switch on, 10 min of fake time: ${during.length} outgoing requests; /healthz ${h.statusCode} ${h.body}; feeds ${scheduler
          .status()
          .feeds.map((f) => f.id)
          .join(', ')} paused`,
        `control (switch off, 10 s): ${after.length} requests to ${hosts.join(', ')}`,
      ].join('\n'),
    );
  });
});
