import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import { DiscoveryService, runDiscovery, type DiscoveryDeps } from '../../../src/feeds/kalshi/discovery.js';
import { NetworkPaused } from '../../../src/feeds/network.js';
import { fixture } from '../../helpers/kalshiFixtures.js';
import { captureLogger, kalshiMockServer, testClient, TEST_BASE, must } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';

const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  mock.server.resetHandlers();
  mock.requests.length = 0;
});
afterAll(() => mock.server.close());

const T = {
  UTA: '00000000-0000-4000-8000-000000000001',
  VGK: '00000000-0000-4000-8000-000000000002',
  WOL: '00000000-0000-4000-8000-000000000003',
  CFC: '00000000-0000-4000-8000-000000000004',
};
const NHL = 'KXNHLGAME-26OCT10UTAVGK';
const NHL_PRE = 'KXNHLGAME-26SEP24UTAVGK';
const EPL = 'KXEPLGAME-26FEB07WOLCFC';

let db: TempDb;
let repos: Repositories;
let logs: ReturnType<typeof captureLogger>;
let clock: number;
let deps: DiscoveryDeps;

beforeEach(() => {
  db = tempDb();
  clock = Date.parse('2026-10-01T12:00:00Z');
  repos = createRepositories(db.db.orm);
  logs = captureLogger('debug');
  deps = {
    client: testClient({ log: logs.log }),
    repos,
    log: logs.log,
    now: () => clock,
    transaction: (fn) => db.db.sqlite.transaction(fn)(),
  };
});
afterEach(() => db.cleanup());

const lines = () =>
  logs
    .text()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { level: number; msg: string; [k: string]: unknown });
const withoutUpdatedAt = <T extends { updated_at?: string | null }>(rows: T[]) =>
  rows.map(({ updated_at: _u, ...rest }) => rest);

describe('discovery against fixtures (one NHL regular-season, one NHL preseason, one EPL event)', () => {
  it('adds 2 games and 2 + 3 markets; skips preseason (info); a second run changes only updated_at', async () => {
    const result = await runDiscovery(deps);
    expect(repos.games.count()).toBe(2);
    const nhl = must(repos.games.get({ id: NHL }));
    expect(nhl).toMatchObject({
      league_id: 'nhl',
      competition: 'Pro Hockey',
      milestone_id: 'b3f0c1d2-0001-4000-8000-000000000001',
      scheduled_at: '2026-10-11T02:00:00.000Z',
      home_team_id: `nhl:${T.VGK}`,
      away_team_id: `nhl:${T.UTA}`,
      phase: 'scheduled',
    });
    expect(JSON.parse(must(nhl.feed_game_ids))).toMatchObject({ sportradar: 'sr:sport_event:61000001' });
    const epl = must(repos.games.get({ id: EPL }));
    expect(epl).toMatchObject({
      league_id: 'epl',
      competition: 'English Premier League',
      scheduled_at: '2027-02-07T15:00:00.000Z',
      home_team_id: `epl:${T.WOL}`,
      away_team_id: `epl:${T.CFC}`,
    });
    expect(repos.games.get({ id: NHL_PRE })).toBeUndefined();

    expect(repos.markets.listByGame(NHL).map((m) => [m.ticker, m.outcome])).toEqual([
      [`${NHL}-UTA`, 'away'],
      [`${NHL}-VGK`, 'home'],
    ]);
    expect(repos.markets.listByGame(EPL).map((m) => [m.ticker, m.outcome])).toEqual([
      [`${EPL}-CFC`, 'away'],
      [`${EPL}-TIE`, 'tie'],
      [`${EPL}-WOL`, 'home'],
    ]);
    expect(repos.markets.count()).toBe(5);
    for (const m of repos.markets.list()) {
      expect(JSON.parse(must(m.price_ranges)).length).toBeGreaterThan(0);
      expect(m.status).toBe('active');
    }
    expect(repos.markets.get({ ticker: `${EPL}-CFC` })).toMatchObject({ yes_bid_bp: 4900, yes_ask_bp: 5100 });

    const skip = lines().find((l) => l.msg === 'Discovery: preseason event skipped');
    expect(skip).toMatchObject({ level: 30, event: NHL_PRE });
    expect(result.leagues.find((l) => l.leagueId === 'nhl')).toMatchObject({
      events: 2,
      skippedPreseason: 1,
      games: 1,
      markets: 2,
    });
    expect(result.leagues).toHaveLength(6);

    // Second run: identical rows apart from updated_at.
    const before = {
      games: withoutUpdatedAt(repos.games.list()),
      markets: withoutUpdatedAt(repos.markets.list()),
      teams: repos.teams.list(),
    };
    clock += 60_000;
    await runDiscovery(deps);
    expect(withoutUpdatedAt(repos.games.list())).toEqual(before.games);
    expect(withoutUpdatedAt(repos.markets.list())).toEqual(before.markets);
    expect(repos.teams.list()).toEqual(before.teams);
    expect(must(repos.games.get({ id: NHL })).updated_at).toBe(new Date(clock).toISOString());
  });

  it('with include_preseason=1 the preseason event is added', async () => {
    repos.leagues.update({ id: 'nhl' }, { include_preseason: 1 });
    await runDiscovery(deps);
    expect(repos.games.count()).toBe(3);
    expect(repos.games.get({ id: NHL_PRE })).toMatchObject({ competition: 'Pro Hockey Preseason' });
    expect(repos.markets.count()).toBe(7);
  });

  it('only enabled leagues are walked', async () => {
    repos.leagues.update({ id: 'epl' }, { enabled: 0 });
    const result = await runDiscovery(deps);
    expect(result.leagues.map((l) => l.leagueId)).not.toContain('epl');
    expect(repos.games.get({ id: EPL })).toBeUndefined();
    expect(mock.requests.some((r) => r.url.searchParams.get('series_ticker') === 'KXEPLGAME')).toBe(false);
  });
});

describe('team mapping', () => {
  it('-CFC maps via custom_strike to the team whose kalshi_target_id matches; TIE → tie', async () => {
    await runDiscovery(deps);
    const cfc = must(repos.markets.get({ ticker: `${EPL}-CFC` }));
    const team = must(repos.teams.listByLeague('epl').find((t) => t.kalshi_target_id === T.CFC));
    expect(team).toMatchObject({ name: 'Chelsea', abbreviation: 'CFC', aliases: '["CFC"]' });
    expect(cfc.outcome).toBe('away');
    expect(must(repos.games.get({ id: EPL })).away_team_id).toBe(team.id);
    expect(must(repos.markets.get({ ticker: `${EPL}-TIE` })).outcome).toBe('tie');
  });

  it('reuses an existing team with the same kalshi_target_id', async () => {
    repos.teams.insert({
      id: 'chelsea',
      league_id: 'epl',
      name: 'Chelsea FC',
      kalshi_target_id: T.CFC,
      aliases: '["CHE"]',
    });
    await runDiscovery(deps);
    expect(must(repos.games.get({ id: EPL })).away_team_id).toBe('chelsea');
    expect(must(repos.teams.get({ id: 'chelsea' })).aliases).toBe('["CFC","CHE"]');
  });

  it('an unknown target → outcome unknown and one warn; discovery continues', async () => {
    const page = fixture<{ events: { markets: Record<string, unknown>[] }[] }>('events_KXEPLGAME');
    const odd = {
      ...must(must(page.events[0]).markets[2]),
      ticker: `${EPL}-XYZ`,
      yes_sub_title: 'Someone',
      custom_strike: { soccer_team: 'ffffffff-0000-4000-8000-000000000000' },
    };
    must(page.events[0]).markets.push(odd);
    mock.use(
      http.get(`${TEST_BASE}/events`, ({ request }) =>
        new URL(request.url).searchParams.get('series_ticker') === 'KXEPLGAME'
          ? HttpResponse.json(page)
          : undefined,
      ),
    );
    const result = await runDiscovery(deps);
    expect(must(repos.markets.get({ ticker: `${EPL}-XYZ` })).outcome).toBe('unknown');
    const warns = lines().filter((l) => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ market: `${EPL}-XYZ` });
    expect(result.leagues.find((l) => l.leagueId === 'epl')).toMatchObject({ markets: 4, unknownMarkets: 1 });
    // Everything else is still discovered.
    expect(repos.markets.count()).toBe(6);
    expect(repos.teams.list().some((t) => t.name === 'Someone')).toBe(false);
  });
});

describe('failures', () => {
  it('a league that fails is reported and the others continue', async () => {
    mock.use(
      http.get(`${TEST_BASE}/events`, ({ request }) =>
        new URL(request.url).searchParams.get('series_ticker') === 'KXNHLGAME'
          ? HttpResponse.json({ error: { code: 'bad_request' } }, { status: 400 })
          : undefined,
      ),
    );
    const result = await runDiscovery(deps);
    expect(result.leagues.find((l) => l.leagueId === 'nhl')?.error).toMatch(/400/);
    expect(repos.games.get({ id: EPL })).toBeDefined();
  });

  it('the global kill switch aborts the run with NetworkPaused and no request', async () => {
    deps.client = testClient({ killSwitch: () => true });
    await expect(runDiscovery(deps)).rejects.toBeInstanceOf(NetworkPaused);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('DiscoveryService schedule', () => {
  it('runs at start-up and daily at 05:00 local time; never two runs at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
      const run = vi.fn();
      const svc = new DiscoveryService({
        deps: () => ({
          ...deps,
          client: { listAllEvents: async () => (run(), []), listMilestones: async () => [] },
        }),
        log: logs.log,
        timeZone: 'Europe/Prague',
      });
      svc.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(6); // start-up: one events walk per enabled league
      expect(new Date(must(svc.nextAt)).toISOString()).toBe('2026-10-02T03:00:00.000Z'); // 05:00 CEST
      await vi.advanceTimersByTimeAsync(Date.parse('2026-10-02T03:00:00Z') - Date.now() - 1);
      expect(run).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(12);
      expect(new Date(must(svc.nextAt)).toISOString()).toBe('2026-10-03T03:00:00.000Z');
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a second run while one is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = new DiscoveryService({
      deps: () => ({
        ...deps,
        client: { listAllEvents: async () => (await gate, []), listMilestones: async () => [] },
      }),
      log: logs.log,
    });
    const first = svc.run('manual');
    await expect(svc.run('manual')).rejects.toThrow(/already in progress/);
    release();
    await first;
    expect(svc.lastResult?.leagues).toHaveLength(6);
  });
});
