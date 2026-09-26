import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cadenceFor, Scheduler } from '../../../src/core/scheduler.js';
import { GameTracker } from '../../../src/core/tracker.js';
import type { FeedObservation, Phase, ScoreFeed, TrackedGame } from '../../../src/feeds/gameState.js';
import { NetworkPaused } from '../../../src/feeds/network.js';
import { isFeedEnabled } from '../../../src/server/routes/feeds.js';
import { captureLogger, must } from '../../helpers/kalshiMsw.js';
import { createTestApp, type TestApp } from '../../helpers/app.js';
import { seedGame } from '../../helpers/feeds.js';

const MIN = 60_000;
const START = Date.parse('2026-10-15T00:00:00Z');

/** A fake adapter: records every poll and answers with the phase/score it is told. */
class FakeFeed implements ScoreFeed {
  readonly sports = ['soccer', 'hockey'] as const;
  calls: number[] = [];
  phase: Phase = 'live';
  fail = false;
  constructor(
    readonly id: 'kalshi-live' | 'nhl-official',
    private readonly gate: () => boolean = () => false,
  ) {}
  async poll(games: readonly TrackedGame[]): Promise<FeedObservation[]> {
    if (this.gate()) throw new NetworkPaused();
    this.calls.push(Date.now() - START);
    if (this.fail) throw new Error('feed exploded');
    return games.map((g) => ({
      raw: {},
      state: {
        gameId: g.id,
        leagueId: g.leagueId,
        homeTeam: 'H',
        awayTeam: 'A',
        homeScore: 1,
        awayScore: 0,
        phase: this.phase,
        clock: { minute: 50, minuteSource: 'feed', period: 3, regulationOver: this.phase === 'finished' },
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

let t: TestApp;
let tracker: GameTracker;
let scheduler: Scheduler;
let kalshi: FakeFeed;
let nhl: FakeFeed;

const killSwitch = () => t.manager.repositories.settings.get('global_kill_switch');

async function setup(): Promise<void> {
  const logs = captureLogger('info');
  // Only setTimeout / Date are faked: Fastify's inject needs the real setImmediate.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START });
  const box: { app?: TestApp } = {};
  const repos = () => must(box.app, 'test app').manager.repositories;
  tracker = new GameTracker({ repos, log: logs.log });
  kalshi = new FakeFeed('kalshi-live', killSwitch);
  nhl = new FakeFeed('nhl-official', killSwitch);
  scheduler = new Scheduler({
    tracker,
    feeds: [kalshi, nhl],
    isFeedEnabled: (id) => isFeedEnabled(repos().settings.get('feeds'), id),
    isPaused: killSwitch,
    log: logs.log,
  });
  t = await createTestApp({ live: { tracker, scheduler, feeds: [kalshi, nhl] } });
  box.app = t;
}

beforeEach(setup);
afterEach(async () => {
  scheduler.stop();
  await t.close();
  vi.useRealTimers();
});

const seed = (offsetMs: number, phase: Phase = 'scheduled', id = 'KXNHLGAME-26OCT15AAABBB') =>
  seedGame(t.manager.repositories, {
    id,
    leagueId: 'nhl',
    scheduledAt: new Date(START + offsetMs).toISOString(),
    home: 'BBB',
    away: 'AAA',
    phase,
  });
const healthz = async () => {
  const r = await t.app.inject({ method: 'GET', url: '/healthz' });
  return { status: r.statusCode, body: r.json() as unknown };
};

describe('scheduler cadence (fake timers)', () => {
  it('no games → zero feed calls in 10 min (idle)', async () => {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(kalshi.calls).toEqual([]);
    expect(nhl.calls).toEqual([]);
    expect(await healthz()).toEqual({ status: 200, body: { ok: true, loop: 'idle' } });
  });

  it('game in 30 min → a call every 60 s', async () => {
    seed(30 * MIN);
    kalshi.phase = 'scheduled';
    nhl.phase = 'scheduled';
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(kalshi.calls).toEqual(Array.from({ length: 10 }, (_, i) => i * MIN));
    expect(nhl.calls).toEqual(kalshi.calls);
    expect(await healthz()).toEqual({ status: 200, body: { ok: true, loop: 'running' } });
  });

  it('a game 2 h away is not polled until the hour before it', async () => {
    seed(120 * MIN);
    kalshi.phase = 'scheduled';
    scheduler.start();
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(kalshi.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(kalshi.calls.length).toBeGreaterThanOrEqual(1);
    expect(kalshi.calls[0]).toBeLessThanOrEqual(61 * MIN);
  });

  it('live game → every 5 s; after finished → idle within one interval', async () => {
    seed(-30 * MIN, 'live');
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(kalshi.calls).toEqual(Array.from({ length: 12 }, (_, i) => i * 5000));
    kalshi.phase = 'finished';
    nhl.phase = 'finished';
    await vi.advanceTimersByTimeAsync(5000);
    const at = kalshi.calls.length;
    expect(scheduler.status().state).toBe('idle');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(kalshi.calls).toHaveLength(at);
    expect(t.manager.repositories.games.get({ id: 'KXNHLGAME-26OCT15AAABBB' })?.phase).toBe('finished');
  });

  it('global kill switch on → zero requests over 10 min and /healthz 200 paused; off → resumes within one interval', async () => {
    seed(-30 * MIN, 'live');
    t.manager.repositories.settings.set('global_kill_switch', true);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(kalshi.calls).toEqual([]);
    expect(nhl.calls).toEqual([]);
    const h = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(h.body).toBe('{"ok":true,"loop":"paused"}');
    expect(scheduler.status().feeds.map((f) => f.status)).toEqual(['paused', 'paused']);

    t.manager.repositories.settings.set('global_kill_switch', false);
    const off = Date.now() - START;
    await vi.advanceTimersByTimeAsync(5000);
    expect(kalshi.calls.length).toBeGreaterThanOrEqual(1);
    expect((kalshi.calls[0] ?? Infinity) - off).toBeLessThanOrEqual(5000);
    expect(await healthz()).toEqual({ status: 200, body: { ok: true, loop: 'running' } });
  });

  it('wake() after a switch change leaves paused at once', async () => {
    seed(-30 * MIN, 'live');
    t.manager.repositories.settings.set('global_kill_switch', true);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2000);
    t.manager.repositories.settings.set('global_kill_switch', false);
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(kalshi.calls).toEqual([2000]);
  });

  it('stopped scheduler while running → /healthz 503 {"ok":false,"loop":"stale"} after 2 min', async () => {
    seed(-30 * MIN, 'live');
    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(2 * MIN - 20_000);
    expect((await healthz()).status).toBe(200);
    await vi.advanceTimersByTimeAsync(25_000);
    const h = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(503);
    expect(h.body).toBe('{"ok":false,"loop":"stale"}');
  });

  it('a feed throwing on every call does not stop the other feed or the loop; its status is error', async () => {
    seed(-30 * MIN, 'live');
    nhl.fail = true;
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(kalshi.calls).toHaveLength(6);
    expect(nhl.calls).toHaveLength(6);
    const status = scheduler.status();
    expect(status.state).toBe('running');
    expect(status.feeds.find((f) => f.id === 'kalshi-live')).toMatchObject({ status: 'ok', lastError: null });
    expect(status.feeds.find((f) => f.id === 'nhl-official')).toMatchObject({
      status: 'error',
      lastError: 'feed exploded',
    });
    expect(t.manager.repositories.gameSnapshots.count()).toBe(6);
    nhl.fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(scheduler.status().feeds.find((f) => f.id === 'nhl-official')?.status).toBe('ok');
  });

  it('a disabled feed is not polled', async () => {
    seed(-30 * MIN, 'live');
    t.manager.repositories.settings.set('feeds', { 'nhl-official': false });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000 - 1);
    expect(kalshi.calls).toHaveLength(4);
    expect(nhl.calls).toHaveLength(0);
    expect(scheduler.status().feeds.find((f) => f.id === 'nhl-official')).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
  });
});

describe('cadenceFor', () => {
  it('5 s with a game in progress, 60 s before a game, null without games', () => {
    const g = (phase: Phase) => ({ phase }) as TrackedGame;
    expect(cadenceFor([])).toBeNull();
    expect(cadenceFor([g('scheduled')])).toBe(60_000);
    expect(cadenceFor([g('scheduled'), g('intermission')])).toBe(5_000);
  });
});
