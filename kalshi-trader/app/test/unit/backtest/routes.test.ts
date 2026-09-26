import { afterEach, describe, expect, it } from 'vitest';
import { BacktestRunner } from '../../../src/backtest/runner.js';
import type { BacktestSummary } from '../../../src/backtest/simulator.js';
import type { Repositories } from '../../../src/db/repositories.js';
import { Client, createTestApp, PASSWORD, setupUser, USER, type TestApp } from '../../helpers/app.js';
import {
  goal,
  seedCandles,
  seedHistGame,
  SOCCER_DEF,
  syntheticGames,
  type GameSpec,
} from '../../helpers/backtest.js';
import { must } from '../../helpers/kalshiMsw.js';
import { sseReader } from '../../helpers/sse.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** An app whose backtest runner the test holds (to wait for runs). */
async function backtestApp() {
  const box: { app?: TestApp } = {};
  const runner = new BacktestRunner({
    repos: () => must(box.app, 'app').manager.repositories,
    dbPath: () => must(must(box.app, 'app').manager.current, 'db').path,
    log: { info: () => undefined, error: () => undefined },
  });
  box.app = await createTestApp({ backtests: runner });
  t = box.app;
  const c = await setupUser(box.app.app);
  return { app: box.app, runner, c, repos: box.app.manager.repositories };
}

async function run(c: Client, runner: BacktestRunner, body: Record<string, unknown>) {
  const res = await c.postWithCsrf('/api/backtests', body);
  expect(res.statusCode, res.body).toBe(202);
  const { id } = res.json() as { id: string };
  expect((await runner.wait(id))?.status).toBe('done');
  return id;
}

function seedSeason(repos: Repositories, games: GameSpec[], season = '2025-26'): void {
  repos.histGames.insertMany(
    games.map((g) => ({
      id: g.id,
      league_id: 'epl',
      season,
      played_at: g.playedAt,
      home: 'H',
      away: 'A',
      final_home: g.goals.filter((x) => x.side === 'home').length,
      final_away: g.goals.filter((x) => x.side === 'away').length,
      goal_events: JSON.stringify(g.goals),
      source: 'csv',
    })),
  );
}

const MODELLED = { definition: SOCCER_DEF, leagueIds: ['epl'], priceMode: 'modelled' } as const;

describe('backtests API', () => {
  it('determinism: the same backtest twice → byte-identical backtest_trades (excluding ids)', async () => {
    const { c, runner, repos } = await backtestApp();
    seedSeason(repos, syntheticGames(300));
    const a = await run(c, runner, MODELLED);
    const b = await run(c, runner, MODELLED);
    const rows = (id: string) =>
      JSON.stringify(repos.backtestTrades.listByBacktest(id).map(({ id: _id, backtest_id: _b, ...r }) => r));
    expect(repos.backtestTrades.listByBacktest(a).length).toBeGreaterThan(50);
    expect(rows(a)).toBe(rows(b));
    const detail = (await c.get(`/api/backtests/${a}`)).json() as {
      summary: BacktestSummary;
      trades: unknown[];
    };
    expect(detail.summary.priceMode).toBe('modelled');
    expect(detail.trades).toHaveLength(repos.backtestTrades.listByBacktest(a).length);
  });

  it('exact run over an existing strategy version; list, save, delete; unknown league → 400; ad-hoc validation', async () => {
    const { c, runner, repos } = await backtestApp();
    const game = {
      id: 'g1',
      playedAt: '2025-10-18T14:00:00.000Z',
      event: 'EV1',
      goals: [goal('home', 12), goal('away', 55), goal('home', 78)],
    };
    seedHistGame(repos, 'epl', '2025-26', game);
    seedCandles(repos, 'soccer', game.playedAt, 'EV1-H', { 80: [9000, 8950] });
    const created = await c.postWithCsrf('/api/strategies', SOCCER_DEF);
    const strategyId = (created.json() as { id: string }).id;

    const id = await run(c, runner, { strategyId, seasons: ['2025-26'] });
    const detail = (await c.get(`/api/backtests/${id}`)).json() as {
      status: string;
      strategy: { id: string; version: number };
      summary: BacktestSummary;
      trades: { priceSource: string; priceBp: number; home: string }[];
    };
    expect(detail).toMatchObject({ status: 'done', strategy: { id: strategyId, version: 1 } });
    expect(detail.trades).toEqual([
      expect.objectContaining({ priceSource: 'candle', priceBp: 9100, home: 'Home g1' }),
    ]);
    expect(detail.summary).toMatchObject({ priceMode: 'exact', minSampleSize: null, trades: 1, won: 1 });

    const list = (await c.get('/api/backtests')).json() as { id: string; saved: boolean; summary: unknown }[];
    expect(list.map((x) => x.id)).toEqual([id]);
    expect(JSON.stringify(list)).not.toContain('"equity"');

    const saved = await c.postWithCsrf(`/api/backtests/${id}/save`, { name: 'EPL 80 exact' });
    expect(saved.json()).toMatchObject({ name: 'EPL 80 exact', saved: true });

    expect((await c.postWithCsrf('/api/backtests', { strategyId, leagueIds: ['nope'] })).statusCode).toBe(
      400,
    );
    expect((await c.postWithCsrf('/api/backtests', { strategyId, leagueIds: ['nhl'] })).statusCode).toBe(400);
    const bad = await c.postWithCsrf('/api/backtests', {
      definition: { ...SOCCER_DEF, sizing: { percent: 500, minStakeUsd: 1, maxStakeUsd: 5 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('definition.sizing.percent');

    const options = (await c.get('/api/backtests/options')).json() as {
      leagues: { id: string; seasons: { season: string; games: number; withKalshi: number }[] }[];
    };
    expect(options.leagues.find((l) => l.id === 'epl')?.seasons).toEqual([
      { season: '2025-26', games: 1, withKalshi: 1 },
    ]);

    expect((await c.postWithCsrf(`/api/backtests/${id}/delete`)).statusCode).toBe(200);
    expect((await c.get(`/api/backtests/${id}`)).statusCode).toBe(404);
    expect(repos.backtestTrades.listByBacktest(id)).toEqual([]);
  });

  it('promote: POST /api/backtests/:id/promote creates a strategy with mode dry_run, kill switch on, version 1 = the backtest params', async () => {
    const { c, runner, repos } = await backtestApp();
    seedSeason(repos, syntheticGames(20));
    const def = { ...SOCCER_DEF, rule: { ...SOCCER_DEF.rule, atMinute: 75, minLead: 2 } };
    const id = await run(c, runner, { definition: def, priceMode: 'modelled', name: 'Ad-hoc 75' });
    const res = await c.postWithCsrf(`/api/backtests/${id}/promote`, {});
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json() as { id: string; mode: string; killSwitch: boolean; currentVersion: number };
    expect(s).toMatchObject({ mode: 'dry_run', killSwitch: true, currentVersion: 1 });
    const row = must(repos.strategies.get({ id: s.id }), 'strategy');
    expect(row).toMatchObject({ mode: 'dry_run', kill_switch: 1, current_version: 1 });
    const v1 = must(repos.strategyVersions.get({ strategy_id: s.id, version: 1 }), 'version 1');
    const params = JSON.parse(must(repos.backtests.get({ id }), 'backtest').params ?? '{}') as {
      definition: { leagueIds: string[]; rule: unknown; sizing: unknown; execution: unknown };
    };
    expect(JSON.parse(v1.league_ids)).toEqual(params.definition.leagueIds);
    expect(JSON.parse(v1.rule)).toEqual(params.definition.rule);
    expect(JSON.parse(v1.sizing)).toEqual(params.definition.sizing);
    expect(JSON.parse(v1.execution)).toEqual(params.definition.execution);
    expect(JSON.parse(v1.rule)).toMatchObject({ atMinute: 75, minLead: 2, windowMinutes: 5 });
    expect(repos.auditLog.list().map((a) => a.action)).toContain('strategy_created');
  });
});

describe('worker isolation and performance', () => {
  it('during a 5 000-game backtest GET /healthz answers in < 100 ms and SSE progress events arrive with increasing done/total', async () => {
    const { app, c, runner, repos } = await backtestApp();
    seedSeason(repos, syntheticGames(5000));
    const login = new Client(app.app, { remoteAddress: '10.0.0.9', headers: {} });
    expect((await login.login(USER, PASSWORD)).statusCode).toBe(200);
    const cookie = [...login.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const address = await app.app.listen({ port: 0, host: '127.0.0.1' });
    const live = await fetch(`${address}/api/live`, { headers: { cookie } });
    const sse = sseReader(must(live.body, 'body'));
    await sse.waitFor((e) => e.event === 'logs');

    const res = await c.postWithCsrf('/api/backtests', MODELLED);
    const { id } = res.json() as { id: string };
    const timings: number[] = [];
    let finished = false;
    const done = runner.wait(id).then(() => {
      finished = true;
    });
    while (!finished) {
      const t0 = performance.now();
      const h = await fetch(`${address}/healthz`);
      timings.push(performance.now() - t0);
      expect(h.status).toBe(200);
      await new Promise((r) => setTimeout(r, 5));
    }
    await done;
    await sse.waitFor(
      (e) => e.event === 'backtest' && (e.data as { status: string }).status === 'done',
      5000,
    );
    const progress = sse.events
      .filter((e) => e.event === 'backtest' && (e.data as { id: string }).id === id)
      .map((e) => e.data as { status: string; done: number; total: number });
    const running = progress.filter((p) => p.status === 'running' && p.total > 0);
    expect(running.length).toBeGreaterThan(5);
    expect(running.every((p) => p.total === 5000)).toBe(true);
    for (let i = 1; i < running.length; i++) {
      expect(must(running[i], 'p').done).toBeGreaterThan(must(running[i - 1], 'p').done);
    }
    expect(running.at(-1)?.done).toBe(5000);
    expect(timings.length).toBeGreaterThan(3);
    expect(Math.max(...timings)).toBeLessThan(100);
    console.log(
      `[T12 isolation] ${timings.length} /healthz calls during a 5000-game backtest: max ${Math.max(...timings).toFixed(1)} ms; ${running.length} progress events`,
    );
    await sse.cancel();
  }, 60_000);

  it('performance: 1 300 games (exact mode, with candles) complete in < 5 s', async () => {
    const { c, runner, repos } = await backtestApp();
    const games = syntheticGames(1300, 'perf').map((g, i) => ({ ...g, event: `PERF-${i}` }));
    for (const g of games) {
      repos.games.insert({
        id: must(g.event, 'event'),
        league_id: 'epl',
        scheduled_at: g.playedAt,
        phase: 'finished',
        updated_at: g.playedAt,
      });
    }
    repos.markets.insertMany(
      games.flatMap((g) => [
        { ticker: `${g.event}-H`, game_id: g.event, outcome: 'home', updated_at: g.playedAt },
        { ticker: `${g.event}-A`, game_id: g.event, outcome: 'away', updated_at: g.playedAt },
      ]),
    );
    repos.histGames.insertMany(
      games.map((g) => ({
        id: g.id,
        league_id: 'epl',
        season: '2025-26',
        played_at: g.playedAt,
        final_home: g.goals.filter((x) => x.side === 'home').length,
        final_away: g.goals.filter((x) => x.side === 'away').length,
        goal_events: JSON.stringify(g.goals),
        source: 'csv',
        kalshi_event_ticker: g.event,
      })),
    );
    for (const g of games) {
      const byMinute: Record<number, [number, number | null]> = {};
      for (let m = 70; m <= 90; m++) byMinute[m] = [9000 + (m % 7) * 50, null];
      seedCandles(repos, 'soccer', g.playedAt, `${g.event}-H`, byMinute);
      seedCandles(repos, 'soccer', g.playedAt, `${g.event}-A`, byMinute);
    }
    const t0 = performance.now();
    const id = await run(c, runner, {
      definition: { ...SOCCER_DEF, rule: { ...SOCCER_DEF.rule, minLead: 2 } },
      priceMode: 'exact',
    });
    const ms = performance.now() - t0;
    const summary = JSON.parse(
      must(repos.backtests.get({ id }), 'bt').result_summary ?? '{}',
    ) as BacktestSummary;
    expect(summary.games).toBe(1300);
    expect(summary.trades).toBeGreaterThan(100);
    expect(ms).toBeLessThan(5000);
    console.log(`[T12 perf] 1300 games (exact, ${summary.trades} trades) in ${ms.toFixed(0)} ms`);
  }, 60_000);
});
