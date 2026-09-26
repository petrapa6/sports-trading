/**
 * `npm run replay -- --live-mock [--file test/fixtures/replay/nhl-sample.jsonl]` (SPEC.md §14 T13): the live
 * path end to end without a Kalshi account. An in-process app (temporary database, the real tracker, engine,
 * executor, settler, order group and balance recorder, `allow_live_orders: true`) runs against the msw Kalshi
 * stand-in, which fills IOC orders at the best ask and keeps a balance. One live strategy (created, kill switch
 * off and switched to live through the API with step-up, global dry run turned off) sees the recorded game,
 * places a live order that fills, the market settles, the settler reconciles it, and `/api/stats` is read.
 *
 * Development tool only (it imports the test helpers and msw, both dev dependencies).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupServer } from 'msw/node';
import { pino } from 'pino';
import { BalanceRecorder } from '../src/core/balances.js';
import { dollarsToBp, dollarsToMicros, microsToDollars } from '../src/core/decimal.js';
import { StrategyEngine } from '../src/core/engine.js';
import { Executor, PENDING_LIVE_MIN_AGE_MS } from '../src/core/executor.js';
import { OrderGroupManager } from '../src/core/orderGroup.js';
import { parseReplayFile } from '../src/core/replay.js';
import { Scheduler } from '../src/core/scheduler.js';
import { Settler } from '../src/core/settler.js';
import { snapshotBalanceOnLiveChanges, startTrading } from '../src/core/startup.js';
import type { StatsResponse } from '../src/core/stats.js';
import { GameTracker } from '../src/core/tracker.js';
import type { TradeView } from '../src/core/trades.js';
import { Client, createTestApp, setupUser, type TestApp } from '../test/helpers/app.js';
import { testClient } from '../test/helpers/kalshiMsw.js';
import { KalshiScript, marketJson, orderbookJson } from '../test/helpers/trading.js';

export const DEFAULT_REPLAY = resolve(import.meta.dirname, '../test/fixtures/replay/nhl-sample.jsonl');
const DEV = { remoteAddress: '127.0.0.1', headers: {} };

export interface LiveMockResult {
  trades: TradeView[];
  orderBodies: Record<string, unknown>[];
  balanceSnapshots: { before: number; afterFill: number; afterSettlement: number };
  stats: StatsResponse;
}

export async function runLiveMockReplay(
  opts: { file?: string; print?: (line: string) => void } = {},
): Promise<LiveMockResult> {
  const print = opts.print ?? (() => undefined);
  const lines = parseReplayFile(readFileSync(opts.file ?? DEFAULT_REPLAY, 'utf8'));
  const gameId = lines[0]?.game.id;
  if (!gameId) throw new Error('the replay file is empty');

  // The Kalshi stand-in: every market of the game open with 50 contracts at 0.93; IOC orders fill at the best
  // ask; the balance ($100) is debited by cost + fee and credited with the revenue at settlement.
  const script = new KalshiScript();
  let balanceMicros = 100_000_000;
  const setBalance = (m: number) => {
    balanceMicros = m;
    script.balanceDollars = microsToDollars(m);
  };
  setBalance(balanceMicros);
  const askFor = new Map<string, string>();
  const tickers = [
    `${gameId}-${lines[0]?.game.home.abbreviation}`,
    `${gameId}-${lines[0]?.game.away.abbreviation}`,
  ];
  for (const ticker of tickers) {
    script.market.set(
      ticker,
      marketJson(ticker, { event_ticker: gameId, close_time: '2099-01-01T00:00:00Z' }),
    );
    script.book.set(ticker, orderbookJson([['0.9300', '50.00']]));
    askFor.set(ticker, '0.9300');
  }
  const filledCc = new Map<string, number>();
  script.orderAnswer = (body) => {
    const ticker = String(body['ticker']);
    const ask = askFor.get(ticker) ?? '0.9300';
    const count = Number.parseInt(String(body['count']), 10);
    const fillCc = count * 100;
    const costMicros = fillCc * dollarsToBp(ask);
    const feeMicros = count * dollarsToMicros('0.0046');
    setBalance(balanceMicros - costMicros - feeMicros);
    filledCc.set(ticker, (filledCc.get(ticker) ?? 0) + fillCc);
    return {
      status: 201,
      json: {
        order_id: `mock-order-${script.orderBodies.length}`,
        client_order_id: body['client_order_id'],
        fill_count: `${count}.00`,
        remaining_count: '0.00',
        average_fill_price: ask,
        average_fee_paid: '0.0046',
        ts_ms: Date.now(),
      },
    };
  };
  const server = setupServer(...script.handlers());
  server.listen({ onUnhandledRequest: 'error' });

  let app: TestApp | undefined;
  try {
    const box: { app?: TestApp } = {};
    const current = () => {
      if (!box.app) throw new Error('app not ready');
      return box.app.manager;
    };
    const repos = () => current().repositories;
    const transaction = (fn: () => void) => {
      const db = current().current;
      if (db) db.sqlite.transaction(fn)();
      else fn();
    };
    const log = pino({ level: 'silent' });
    const client = testClient({ killSwitch: () => repos().settings.get('global_kill_switch') });
    const tracker = new GameTracker({ repos, log, transaction });
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
    const scheduler = new Scheduler({
      tracker,
      feeds: [],
      isFeedEnabled: () => true,
      isPaused: () => repos().settings.get('global_kill_switch'),
      log,
    });
    app = await createTestApp({
      nodeEnv: 'development',
      runtime: { allowLiveOrders: true, kalshiEnv: 'demo', kalshiSubaccount: 0 },
      live: { tracker, scheduler, feeds: [], engine, executor, settler, orderGroups },
      replay: { allowLoopback: false, transaction },
    });
    box.app = app;
    const db = app.manager.repositories;
    await startTrading({ log, orderGroups, recover: () => executor.recoverOnStart(), loops: [] });
    print(`order group: ${db.settings.get('kalshi_order_group_id') ?? '(none)'}`);

    // The owner's steps, through the API: a live strategy, kill switch off, global dry run off (step-up: the
    // set-up session has just authenticated).
    const c = await setupUser(app.app);
    const created = await c.postWithCsrf('/api/strategies', {
      name: 'Live mock: NHL lead at 55',
      sport: 'hockey',
      leagueIds: ['nhl'],
      rule: { type: 'lead_at_time', minLead: 1, atMinute: 55, windowMinutes: 5 },
      sizing: { percent: 2, minStakeUsd: 1, maxStakeUsd: 50 },
      execution: { maxPrice: 0.97 },
    });
    if (created.statusCode !== 201) throw new Error(`create strategy: ${created.statusCode} ${created.body}`);
    const id = (created.json() as { id: string }).id;
    for (const [url, body] of [
      [`/api/strategies/${id}/kill-switch`, { killSwitch: false }],
      [`/api/strategies/${id}/mode`, { mode: 'live' }],
      ['/api/settings', { global_dry_run: false }],
    ] as const) {
      const r = await c.postWithCsrf(url, body);
      if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body}`);
    }
    const before = db.balanceSnapshots.list().length;

    // The recorded game, line by line, into the tracker.
    const dev = new Client(app.app, DEV);
    for (const [i, line] of lines.entries()) {
      const r = await dev.post('/api/dev/replay', { line, reset: i === 0 });
      if (r.statusCode !== 200) throw new Error(`replay line ${i + 1}: ${r.statusCode} ${r.body}`);
      await executor.idle();
    }
    const waitRows = async (n: number) => {
      for (let i = 0; i < 40 && db.balanceSnapshots.list().length < n; i++)
        await new Promise((r) => setTimeout(r, 50));
      return db.balanceSnapshots.list().length;
    };
    const afterFill = await waitRows(before + 1);
    for (const tr of db.trades.list())
      print(
        `trade ${tr.id}: ${tr.status} ${tr.effective_mode} ${tr.kalshi_env} fill ${tr.fill_cc ?? 0} cc at ${tr.avg_fill_price_bp ?? '-'} bp, fee ${tr.fee_micros ?? '-'} micros`,
      );

    // The market settles YES; Kalshi lists the settlement with the matching revenue.
    for (const ticker of tickers) {
      const winner = ticker === tickers[0];
      script.market.set(
        ticker,
        marketJson(ticker, {
          event_ticker: gameId,
          status: 'finalized',
          result: winner ? 'yes' : 'no',
          settlement_value_dollars: winner ? '1.0000' : '0.0000',
        }),
      );
      const cc = filledCc.get(ticker) ?? 0;
      if (cc > 0) {
        const revenue = winner ? cc * 10_000 : 0;
        script.settlements.push({
          ticker,
          revenue_dollars: microsToDollars(revenue),
          value_dollars: winner ? '1.0000' : '0.0000',
        });
        setBalance(balanceMicros + revenue);
      }
    }
    const settled = await settler.runOnce();
    const afterSettlement = await waitRows(afterFill + 1);
    print(`settler: ${settled.settled} trade(s) settled`);

    const trades = ((await c.get('/api/trades?mode=both')).json() as { trades: TradeView[] }).trades;
    for (const tr of trades)
      print(
        `trade ${tr.id}: ${tr.status} (${tr.effectiveMode}, ${tr.kalshiEnv}) payout ${tr.payoutMicros ?? '-'} P&L ${tr.realizedPnlMicros ?? '-'} reconcile ${tr.reconcileWarning ?? 'ok'}`,
      );
    print(
      `balance_snapshots: ${before} → ${afterFill} (after the fill) → ${afterSettlement} (after settlement)`,
    );
    const stats = (await c.get('/api/stats?mode=both')).json() as StatsResponse;
    print(
      `/api/stats: live trades ${stats.live?.tiles.trades ?? '-'} (net P&L ${stats.live?.tiles.netPnlMicros ?? '-'}), dry run trades ${stats.dry_run?.tiles.trades ?? '-'}`,
    );
    return {
      trades,
      orderBodies: [...script.orderBodies],
      balanceSnapshots: { before, afterFill, afterSettlement },
      stats,
    };
  } finally {
    await app?.close();
    server.close();
  }
}
