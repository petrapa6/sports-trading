import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrategyEngine, type Signal } from '../../../src/core/engine.js';
import { parseReplayFile } from '../../../src/core/replay.js';
import { Scheduler } from '../../../src/core/scheduler.js';
import { StrategyDefinitionSchema } from '../../../src/core/strategy.js';
import { createStrategy } from '../../../src/core/strategyStore.js';
import { GameTracker } from '../../../src/core/tracker.js';
import type { FeedObservation, ScoreFeed, TrackedGame } from '../../../src/feeds/gameState.js';
import { NetworkPaused } from '../../../src/feeds/network.js';
import { isFeedEnabled } from '../../../src/server/routes/feeds.js';
import { Client, createTestApp, PASSWORD, setupUser, USER, type TestApp } from '../../helpers/app.js';
import { seedGame } from '../../helpers/feeds.js';
import { captureLogger, must } from '../../helpers/kalshiMsw.js';
import { sseReader } from '../../helpers/sse.js';

const SAMPLE = resolve(import.meta.dirname, '../../fixtures/replay/nhl-sample.jsonl');
const GAME = 'KXNHLGAME-26OCT14SEAVGK';
const DEV = { remoteAddress: '127.0.0.1', headers: {} };

let t: TestApp | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
  t = undefined;
});

/** An app with a real tracker, scheduler (not started) and engine. */
async function liveApp(feeds: ScoreFeed[], extra: Parameters<typeof createTestApp>[0] = {}) {
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'app').manager.repositories;
  const logs = captureLogger('info');
  const tracker = new GameTracker({ repos, log: logs.log });
  const engine = new StrategyEngine({ repos, log: logs.log, allowLiveOrders: false }).attach(tracker);
  const scheduler = new Scheduler({
    tracker,
    feeds,
    isFeedEnabled: (id) => isFeedEnabled(repos().settings.get('feeds'), id),
    isPaused: () => repos().settings.get('global_kill_switch'),
    log: logs.log,
  });
  box.app = await createTestApp({ live: { tracker, scheduler, feeds, engine }, ...extra });
  return { app: box.app, tracker, scheduler, engine, logs };
}

describe('replay → signal over SSE', () => {
  it('nhl-sample.jsonl with a matching strategy whose kill switch is off → exactly one signal event for the game', async () => {
    const setup = await liveApp([], { nodeEnv: 'development' });
    t = setup.app;
    await setupUser(t.app);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const dev = new Client(t.app, DEV);
    await dev.login(USER, PASSWORD);

    // Home leads by 1 from minute 55 (P3 05:00) to the end: the window 55–60 matches on two lines.
    const created = await dev.postWithCsrf('/api/strategies', {
      name: 'NHL lead at 55',
      sport: 'hockey',
      leagueIds: ['nhl'],
      rule: { type: 'lead_at_time', minLead: 1, atMinute: 55, windowMinutes: 5 },
      sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: { maxPrice: 0.97 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    // A second strategy with its kill switch on never signals.
    await dev.postWithCsrf('/api/strategies', {
      name: 'paused',
      sport: 'hockey',
      leagueIds: ['nhl'],
      rule: { type: 'lead_at_time', minLead: 1, atMinute: 1, windowMinutes: 58 },
      sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: { maxPrice: 0.97 },
    });
    expect(
      (await dev.postWithCsrf(`/api/strategies/${id}/kill-switch`, { killSwitch: false })).statusCode,
    ).toBe(200);

    const cookie = [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const stream = await fetch(`${address}/api/live`, { headers: { cookie } });
    const sse = sseReader(must(stream.body, 'body'));
    expect((await sse.waitFor((e) => e.event === 'signals')).data).toEqual({ signals: [] });
    const strategies = (await sse.waitFor((e) => e.event === 'strategies')).data as {
      strategies: { id: string; effectiveMode: string; modeReason: string | null }[];
    };
    expect(strategies.strategies.find((s) => s.id === id)).toMatchObject({
      effectiveMode: 'dry_run',
      modeReason: 'addon_lock',
    });

    for (const [i, line] of parseReplayFile(readFileSync(SAMPLE, 'utf8')).entries()) {
      const r = await fetch(`${address}/api/dev/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line, reset: i === 0 }),
      });
      expect(r.status).toBe(200);
    }
    await sse.waitFor(
      (e) =>
        e.event === 'games' &&
        (e.data as { games: { id: string; phase: string }[] }).games.some(
          (g) => g.id === GAME && g.phase === 'finished',
        ),
    );

    const signals = sse.events.filter((e) => e.event === 'signal').map((e) => e.data as Signal);
    expect(signals.filter((s) => s.gameId === GAME)).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      strategyId: id,
      gameId: GAME,
      marketTicker: `${GAME}-VGK`,
      side: 'home',
      configuredMode: 'dry_run',
      effectiveMode: 'dry_run',
      modeReason: 'addon_lock',
      snapshot: { homeScore: 2, awayScore: 1, clock: { minute: 55, period: 3 } },
    });

    // Game cards list the armed strategy with its effective mode while the game is on.
    const armed = sse.events
      .filter((e) => e.event === 'games')
      .flatMap(
        (e) =>
          (e.data as { games: { id: string; strategies: { id: string; effectiveMode: string }[] }[] }).games,
      )
      .find((g) => g.id === GAME && g.strategies.length > 0);
    expect(armed?.strategies).toEqual([
      {
        id,
        name: 'NHL lead at 55',
        configuredMode: 'dry_run',
        effectiveMode: 'dry_run',
        modeReason: 'addon_lock',
      },
    ]);
    // The signal log line carries its mode.
    const line = setup.logs
      .text()
      .split('\n')
      .find((l) => l.includes('"msg":"Signal:'));
    expect(line).toContain('"mode":"dry_run"');
    await sse.cancel();
  });
});

/** A fake adapter reporting every tracked game live at 3-1, minute 50. */
class FakeFeed implements ScoreFeed {
  readonly sports = ['soccer', 'hockey'] as const;
  calls = 0;
  constructor(
    readonly id: 'kalshi-live' | 'nhl-official',
    private readonly gate: () => boolean,
  ) {}
  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    if (this.gate()) throw new NetworkPaused();
    this.calls++;
    return games.map((g) => ({
      raw: {},
      state: {
        gameId: g.id,
        leagueId: g.leagueId,
        homeTeam: 'H',
        awayTeam: 'A',
        homeScore: 3,
        awayScore: 1,
        phase: 'live',
        clock: {
          minute: 50,
          minuteSource: 'feed',
          period: 3,
          secondsLeftInPeriod: 600,
          regulationOver: false,
        },
        source: this.id,
        observedAt: new Date(),
      },
    }));
  }
  listLive = async () => [];
  get = async () => {
    throw new Error('unused');
  };
  test = async () => 'ok';
}

describe('global kill switch', () => {
  it('on → the engine receives no states at all over 10 min; off → states and a signal within one interval', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
      now: Date.parse('2026-10-15T02:30:00Z'),
    });
    const box: { app?: TestApp } = {};
    const repos = () => must(box.app, 'app').manager.repositories;
    const kill = () => repos().settings.get('global_kill_switch');
    const feed = new FakeFeed('kalshi-live', kill);
    const setup = await liveApp([feed]);
    box.app = t = setup.app;
    const r = repos();
    seedGame(r, {
      id: GAME,
      leagueId: 'nhl',
      scheduledAt: '2026-10-15T02:00:00Z',
      home: 'VGK',
      away: 'SEA',
      phase: 'live',
    });
    r.markets.insert({
      ticker: `${GAME}-VGK`,
      game_id: GAME,
      outcome: 'home',
      status: 'open',
      updated_at: '2026-10-15T02:00:00Z',
    });
    const def = StrategyDefinitionSchema.parse({
      name: 'h',
      sport: 'hockey',
      leagueIds: ['nhl'],
      rule: { type: 'lead_at_time', minLead: 2, atMinute: 50 },
      sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: { maxPrice: 0.97 },
    });
    const s = createStrategy(r, def, new Date().toISOString());
    r.strategies.update({ id: s.id }, { kill_switch: 0 });
    r.settings.set('global_kill_switch', true);

    const onState = vi.spyOn(setup.engine, 'onState');
    const signals: Signal[] = [];
    setup.engine.on('signal', (x) => signals.push(x));
    setup.scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feed.calls).toBe(0);
    expect(onState).not.toHaveBeenCalled();
    expect(signals).toEqual([]);

    r.settings.set('global_kill_switch', false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(feed.calls).toBeGreaterThan(0);
    expect(onState).toHaveBeenCalled();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ strategyId: s.id, marketTicker: `${GAME}-VGK`, minute: 50 });
    setup.scheduler.stop();
  });
});
