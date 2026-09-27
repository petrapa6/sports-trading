import { EventEmitter } from 'node:events';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TradeEvent } from '../../../src/core/executor.js';
import { Notifier, price, signedUsd, SUPERVISOR_CORE_URL } from '../../../src/core/notifier.js';
import { GameTracker } from '../../../src/core/tracker.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { createNetworkGate } from '../../../src/feeds/network.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { logLines, seedGame } from '../../helpers/feeds.js';

/** Home Assistant notifications through the Supervisor proxy. */

const TOKEN = 'supervisor-token-abc123';
const URL_CREATE = `${SUPERVISOR_CORE_URL}/services/persistent_notification/create`;
const GAME = 'KXEPLGAME-26OCT17ARSCHE';

const received: { auth: string | null; body: { title: string; message: string } }[] = [];
const server = setupServer(
  http.post(URL_CREATE, async ({ request }) => {
    received.push({
      auth: request.headers.get('authorization'),
      body: (await request.json()) as { title: string; message: string },
    });
    return HttpResponse.json([]);
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  received.length = 0;
});
afterAll(() => server.close());

let db: TempDb;
let repos: Repositories;
let killSwitch: boolean;
beforeEach(() => {
  db = tempDb();
  repos = createRepositories(db.db.orm);
  killSwitch = false;
  seedGame(repos, {
    id: GAME,
    leagueId: 'epl',
    scheduledAt: '2026-10-17T14:00:00Z',
    home: 'ARS',
    away: 'CHE',
  });
  repos.strategies.insert({
    id: 's-1',
    name: 'EPL two-goal lead at 75',
    sport: 'soccer',
    mode: 'dry_run',
    kill_switch: 0,
    current_version: 1,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  repos.strategies.insert({
    id: 's-2',
    name: 'Live EPL lead',
    sport: 'soccer',
    mode: 'live',
    kill_switch: 0,
    current_version: 1,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
});
afterEach(() => db.cleanup());

function insertTrade(
  id: string,
  strategyId: string,
  mode: 'live' | 'dry_run',
  extra: Record<string, unknown> = {},
) {
  repos.trades.insert({
    id,
    strategy_id: strategyId,
    strategy_version: 1,
    game_id: GAME,
    market_ticker: `${GAME}-ARS`,
    league_id: 'epl',
    kalshi_env: 'demo',
    configured_mode: mode,
    effective_mode: mode,
    mode_reason: mode === 'live' ? null : 'global_dry_run',
    status: 'filled',
    attempts: 1,
    trigger_snapshot: JSON.stringify({ side: 'home', homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
    triggered_at: '2026-10-17T15:20:00Z',
    window_ends_at: '2026-10-17T15:26:00Z',
    fill_cc: 1200,
    avg_fill_price_bp: 9200,
    cost_micros: 11_040_000,
    fee_micros: 50_000,
    ...extra,
  });
}

function notifier(token: string | undefined = TOKEN) {
  const logs = captureLogger('debug');
  const n = new Notifier({
    repos: () => repos,
    log: logs.log,
    token,
    kalshiEnv: 'demo',
    gate: createNetworkGate(() => killSwitch),
  });
  return { n, logs };
}

describe('Home Assistant notifications', () => {
  it('a dry-run fill → POST with the bearer token; message has [DRY RUN], the strategy name and P&L', async () => {
    insertTrade('t-dry', 's-1', 'dry_run');
    const { n } = notifier();
    const executor = new EventEmitter<{ trade: [TradeEvent] }>();
    n.attach({ executor, globalMode: () => 'dry_run' });
    executor.emit('trade', { id: 't-dry', status: 'filled', mode: 'dry_run' });
    await n.idle();
    expect(received).toHaveLength(1);
    expect(received[0]?.auth).toBe(`Bearer ${TOKEN}`);
    const message = received[0]?.body.message ?? '';
    expect(received[0]?.body.title).toBe('Kalshi Sports Trader');
    expect(message.startsWith('[DRY RUN] (demo) ')).toBe(true);
    expect(message).toContain('"EPL two-goal lead at 75"');
    expect(message).toContain('12 × Arsenal YES at $0.92');
    // win: 12 × $1 − $11.04 − $0.05 = +$0.91; lose: −$11.09
    expect(message).toContain('P&L +$0.91 if it wins, −$11.09 if it loses');
    expect(message).not.toContain('[LIVE]');
  });

  it('a live fill → [LIVE]; a settlement → realized P&L', async () => {
    insertTrade('t-live', 's-2', 'live');
    const { n } = notifier();
    const executor = new EventEmitter<{ trade: [TradeEvent] }>();
    const settler = new EventEmitter<{ trade: [TradeEvent] }>();
    n.attach({ executor, settler, globalMode: () => 'live' });
    executor.emit('trade', { id: 't-live', status: 'filled', mode: 'live' });
    // Non-fill changes send nothing.
    executor.emit('trade', { id: 't-live', status: 'waiting', mode: 'live' });
    await n.idle();
    expect(received.map((r) => r.body.message)).toHaveLength(1);
    expect(received[0]?.body.message).toMatch(/^\[LIVE\] \(demo\) Trade filled: "Live EPL lead"/);

    repos.trades.update(
      { id: 't-live' },
      { status: 'settled_won', payout_micros: 12_000_000, realized_pnl_micros: 910_000 },
    );
    settler.emit('trade', { id: 't-live', status: 'settled_won', mode: 'live' });
    await n.idle();
    expect(received[1]?.body.message).toBe(
      `[LIVE] (demo) Trade settled (won): "Live EPL lead" on Arsenal (${GAME}-ARS); realized P&L +$0.91.`,
    );
  });

  it('toggles off → no request (per event and per mode)', async () => {
    insertTrade('t-dry', 's-1', 'dry_run');
    insertTrade('t-live', 's-2', 'live', { id: 't-live' });
    const { n } = notifier();
    repos.settings.set('notifications', {
      events: { trade_filled: false },
      modes: { live: true, dry_run: true },
    });
    n.tradeFilled('t-dry');
    n.tradeFilled('t-live');
    await n.idle();
    expect(received).toEqual([]);

    repos.settings.set('notifications', { events: {}, modes: { live: true, dry_run: false } });
    n.tradeFilled('t-dry');
    await n.idle();
    expect(received).toEqual([]);
    n.tradeFilled('t-live');
    await n.idle();
    expect(received).toHaveLength(1);
    expect(received[0]?.body.message).toMatch(/^\[LIVE\]/);
  });

  it('no token → no request and one debug line', async () => {
    insertTrade('t-dry', 's-1', 'dry_run');
    const logs = captureLogger('debug');
    const n = new Notifier({
      repos: () => repos,
      log: logs.log,
      token: undefined, // SUPERVISOR_TOKEN absent (outside Home Assistant)
      kalshiEnv: 'demo',
      gate: createNetworkGate(() => false),
    });
    expect(n.available).toBe(false);
    expect(notifier('').n.available).toBe(false);
    n.tradeFilled('t-dry');
    await n.idle();
    expect(received).toEqual([]);
    const lines = logLines(logs.text());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 20, event: 'trade_filled', mode: 'dry_run' });
    expect(lines[0]?.msg).toMatch(/SUPERVISOR_TOKEN is not set/);
  });

  it('switch changes and feed disagreements state the mode; nothing is sent under the kill switch', async () => {
    const { n, logs } = notifier();
    n.switchChanged('global_dry_run', false, 'live');
    n.switchChanged('global_kill_switch', false, 'dry_run');
    const tracker = new GameTracker({ repos: () => repos, log: logs.log });
    n.attach({ tracker, globalMode: () => 'dry_run' });
    tracker.emit('blockedChanged', {
      gameId: GAME,
      leagueId: 'epl',
      blocked: true,
      scores: { 'kalshi-live': '2-0', 'api-football': '2-1' },
      at: new Date(),
    });
    await n.idle();
    expect(received.map((r) => r.body.message)).toEqual([
      '[LIVE] (demo) Global dry run turned off.',
      '[DRY RUN] (demo) Global kill switch turned off.',
      `[DRY RUN] (demo) Feeds disagree on the score of ${GAME} for more than 20 s (kalshi-live 2-0, api-football 2-1); entries blocked.`,
    ]);

    killSwitch = true;
    n.switchChanged('global_kill_switch', true, 'dry_run');
    await n.idle();
    expect(received).toHaveLength(3);
    expect(logs.text()).not.toContain(TOKEN);
  });

  it('formats money and prices with integer arithmetic', () => {
    expect(signedUsd(910_000)).toBe('+$0.91');
    expect(signedUsd(-11_090_000)).toBe('−$11.09');
    expect(signedUsd(1_234_567_890)).toBe('+$1,234.57');
    expect(price(9200)).toBe('$0.92');
    expect(price(9250)).toBe('$0.925');
  });
});
