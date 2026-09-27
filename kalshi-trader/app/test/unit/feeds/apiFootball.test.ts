import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../../src/core/scheduler.js';
import { createRepositories, type Repositories } from '../../../src/db/repositories.js';
import {
  ApiFootballClient,
  ApiFootballFeed,
  ApiFootballQuota,
  apiFootballPhase,
  fixtureToState,
  FixtureSchema,
  localDay,
  matchFixture,
  normaliseTeamName,
  teamMatches,
  type Fixture,
} from '../../../src/feeds/apiFootball/feed.js';
import { FeedQuotaExhausted, type TrackedGame } from '../../../src/feeds/gameState.js';
import { createNetworkGate, NetworkPaused } from '../../../src/feeds/network.js';
import { decryptSetting, encryptSetting } from '../../../src/server/secrets.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { logLines, trackedGame } from '../../helpers/feeds.js';

const BASE = 'https://af.test';
// Built at runtime so no key-like literal is committed (gitleaks generic-api-key).
const KEY = 'q'.repeat(28);
const SECRET = Buffer.alloc(32, 9);
const FIXTURES = resolve(import.meta.dirname, '../../fixtures/api-football');
const live = JSON.parse(readFileSync(resolve(FIXTURES, 'fixtures-live.json'), 'utf8')) as {
  response: unknown[];
};
const quotaBody = JSON.parse(readFileSync(resolve(FIXTURES, 'quota-exceeded.json'), 'utf8')) as object;

const calls: { path: string; query: string; key: string | null }[] = [];
let answer: (path: string, query: URLSearchParams) => object = () => live;
const server = setupServer(
  http.get(`${BASE}/*`, ({ request }) => {
    const url = new URL(request.url);
    calls.push({ path: url.pathname, query: url.search, key: request.headers.get('x-apisports-key') });
    return HttpResponse.json(answer(url.pathname, url.searchParams));
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  calls.length = 0;
  answer = () => live;
  vi.useRealTimers();
});
afterAll(() => server.close());

let db: TempDb;
let repos: Repositories;
let killSwitch: boolean;
beforeEach(() => {
  db = tempDb();
  repos = createRepositories(db.db.orm);
  killSwitch = false;
  repos.settings.set('api_football_key_enc', encryptSetting(KEY, SECRET));
});
afterEach(() => db.cleanup());

const arsChe = trackedGame({ phase: 'live' });
const LEAGUE_IDS: Record<string, number> = { epl: 39, laliga: 140 };

function build(log = captureLogger('debug')) {
  const quota = new ApiFootballQuota(() => repos.settings, log.log);
  const client = new ApiFootballClient({
    gate: createNetworkGate(() => killSwitch),
    log: log.log,
    key: () => {
      const enc = repos.settings.get('api_football_key_enc');
      return enc === null ? null : decryptSetting(enc, SECRET);
    },
    quota,
    baseUrl: BASE,
  });
  const feed = new ApiFootballFeed({
    client,
    games: () => [arsChe],
    leagueFeedId: (id) => LEAGUE_IDS[id] ?? null,
  });
  return { log, quota, client, feed };
}

const fixture = (short: string, elapsed: number | null, home = 2, away = 0): Fixture =>
  FixtureSchema.parse({
    fixture: { id: 1, date: '2026-10-17T14:00:00+00:00', status: { short, elapsed, extra: null } },
    league: { id: 39, season: 2026 },
    teams: { home: { id: 42, name: 'Arsenal' }, away: { id: 49, name: 'Chelsea' } },
    goals: { home, away },
  });

describe('API-Football mapping', () => {
  const now = Date.parse('2026-10-17T15:30:00Z');

  it("status.short '2H', elapsed 78, goals 2-0 → live, minute 78 from the feed, homeScore 2", () => {
    const s = fixtureToState(fixture('2H', 78), arsChe, now);
    expect(s).toMatchObject({
      gameId: arsChe.id,
      phase: 'live',
      clock: { minute: 78, minuteSource: 'feed', period: 2, regulationOver: false },
      homeScore: 2,
      awayScore: 0,
      source: 'api-football',
    });
  });

  it("'HT' → halftime, 'FT' → finished, 'PST' → postponed", () => {
    expect(fixtureToState(fixture('HT', 45), arsChe, now).phase).toBe('halftime');
    expect(fixtureToState(fixture('FT', 90), arsChe, now)).toMatchObject({
      phase: 'finished',
      clock: { regulationOver: true },
    });
    expect(fixtureToState(fixture('PST', null), arsChe, now).phase).toBe('postponed');
  });

  it('maps every documented status code; stoppage counts as 45 / 90', () => {
    const table: Record<string, string> = {
      TBD: 'scheduled',
      NS: 'scheduled',
      '1H': 'live',
      '2H': 'live',
      ET: 'live',
      P: 'live',
      LIVE: 'live',
      HT: 'halftime',
      BT: 'halftime',
      INT: 'halftime',
      FT: 'finished',
      AET: 'finished',
      PEN: 'finished',
      AWD: 'finished',
      WO: 'finished',
      PST: 'postponed',
      CANC: 'postponed',
      ABD: 'postponed',
      SUSP: 'postponed',
    };
    for (const [code, phase] of Object.entries(table)) expect(apiFootballPhase(code), code).toBe(phase);
    expect(fixtureToState(fixture('1H', 47), arsChe, now).clock).toMatchObject({ minute: 45, period: 1 });
    expect(fixtureToState(fixture('2H', 94), arsChe, now).clock).toMatchObject({ minute: 90, period: 2 });
    expect(fixtureToState(fixture('ET', 97), arsChe, now).clock).toMatchObject({ regulationOver: true });
    expect(fixtureToState(fixture('NS', null), arsChe, now).clock.minute).toBeUndefined();
  });

  it('matches fixtures to tracked games by id, league + names + time, never across leagues', () => {
    const fixtures = live.response.map((f) => FixtureSchema.parse(f));
    const [ars, city, madrid] = fixtures as [Fixture, Fixture, Fixture];
    const league = (id: string) => LEAGUE_IDS[id] ?? null;
    expect(matchFixture(ars, [arsChe], league)?.id).toBe(arsChe.id);
    expect(matchFixture(city, [arsChe], league)).toBeUndefined();
    // Same names in another league: no match.
    const wrongLeague = trackedGame({ leagueId: 'laliga' });
    expect(matchFixture(ars, [wrongLeague], league)).toBeUndefined();
    // A known fixture id wins over names.
    const byId = trackedGame({
      id: 'KXLALIGAGAME-X',
      leagueId: 'laliga',
      feedGameIds: { apiFootball: 1390555 },
    });
    expect(matchFixture(madrid, [byId], league)?.id).toBe('KXLALIGAGAME-X');
    // Kick-off more than 12 h away: no match.
    expect(
      matchFixture(ars, [trackedGame({ scheduledAt: Date.parse('2026-10-18T14:00:00Z') })], league),
    ).toBeUndefined();
    expect(normaliseTeamName('Borussia Mönchengladbach')).toBe('borussia monchengladbach');
    expect(normaliseTeamName('1. FC Köln')).toBe('koln');
    const team = (name: string): TrackedGame['home'] => ({ id: 'x', name, abbreviation: null, aliases: [] });
    expect(teamMatches(team('Manchester United'), 'Manchester United FC')).toBe(true);
    expect(teamMatches(team('Brighton'), 'Brighton & Hove Albion')).toBe(true);
    expect(teamMatches(team('Manchester United'), 'Manchester City')).toBe(false);
  });

  it('poll: one live=all request with the key header, the fixture id remembered', async () => {
    const { feed } = build();
    const obs = await feed.poll([arsChe]);
    expect(calls).toEqual([{ path: '/fixtures', query: '?live=all', key: KEY }]);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.feedGameId).toEqual({ key: 'apiFootball', value: 1379001 });
    expect(obs[0]?.state).toMatchObject({ phase: 'live', clock: { minute: 78 }, homeScore: 2, awayScore: 0 });
  });

  it('poll: a game in progress that left live=all is read with one ids= request', async () => {
    const { feed } = build();
    const known = trackedGame({ phase: 'live', feedGameIds: { apiFootball: 777 } });
    answer = (path, q) =>
      q.get('ids') === '777'
        ? {
            errors: [],
            response: [
              {
                ...fixture('FT', 90, 3, 1),
                fixture: { id: 777, status: { short: 'FT', elapsed: 90 }, date: '2026-10-17T14:00:00Z' },
              },
            ],
          }
        : { errors: [], response: path === '/fixtures' ? [] : [] };
    const obs = await feed.poll([known]);
    expect(calls.map((c) => c.query)).toEqual(['?live=all', '?ids=777']);
    expect(obs[0]?.state).toMatchObject({ phase: 'finished', homeScore: 3, awayScore: 1 });
  });

  it('not available (and never polled by the scheduler) without a stored key', () => {
    const { feed } = build();
    expect(feed.isAvailable()).toBe(true);
    repos.settings.set('api_football_key_enc', null);
    expect(feed.isAvailable()).toBe(false);
  });
});

describe('API-Football quota guard', () => {
  it('counter at 100 → no call, one warn, feed status quota; resets at local midnight (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const evening = new Date(2026, 9, 17, 23, 58, 0).getTime(); // local time
    vi.setSystemTime(evening);
    repos.settings.set('api_football_quota', { day: localDay(evening), used: 100 });
    const { feed, log } = build();

    await expect(feed.poll([arsChe])).rejects.toBeInstanceOf(FeedQuotaExhausted);
    await expect(feed.poll([arsChe])).rejects.toBeInstanceOf(FeedQuotaExhausted);
    expect(calls).toEqual([]);
    const warns = logLines(log.text()).filter((l) => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/quota used up \(100\/100\)/);
    expect(repos.settings.get('api_football_quota')).toEqual({ day: localDay(evening), used: 100 });

    // The scheduler shows the feed as `quota` (not `error`) and keeps running.
    let tick: (() => void) | undefined;
    const scheduler = new Scheduler({
      tracker: { pollTargets: () => [arsChe], ingest: () => [] },
      feeds: [feed],
      isFeedEnabled: () => true,
      isPaused: () => false,
      log: log.log,
      clock: {
        now: () => Date.now(),
        setTimeout: (fn) => {
          tick = fn;
          return 1;
        },
        clearTimeout: () => undefined,
      },
    });
    scheduler.start();
    tick?.();
    await vi.waitFor(() =>
      expect(scheduler.status().feeds.find((f) => f.id === 'api-football')?.status).toBe('quota'),
    );
    expect(calls).toEqual([]);
    scheduler.stop();

    // Local midnight: the counter starts over.
    vi.setSystemTime(new Date(2026, 9, 18, 0, 0, 5).getTime());
    const obs = await feed.poll([arsChe]);
    expect(obs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(repos.settings.get('api_football_quota')).toEqual({ day: '2026-10-18', used: 1 });
  });

  it('counts every request and stops exactly at the configured limit', async () => {
    repos.settings.set('api_football_daily_limit', 3);
    const { feed, quota } = build();
    for (let i = 0; i < 3; i++) await feed.poll([arsChe]);
    await expect(feed.poll([arsChe])).rejects.toBeInstanceOf(FeedQuotaExhausted);
    expect(calls).toHaveLength(3);
    expect(quota.usage()).toMatchObject({ used: 3, limit: 3 });
  });

  it("the provider's own quota error counts as quota too", async () => {
    answer = () => quotaBody;
    const { feed } = build();
    await expect(feed.poll([arsChe])).rejects.toBeInstanceOf(FeedQuotaExhausted);
  });

  it('global kill switch → zero calls (and nothing counted)', async () => {
    killSwitch = true;
    const { feed } = build();
    await expect(feed.poll([arsChe])).rejects.toBeInstanceOf(NetworkPaused);
    await expect(feed.test([arsChe])).rejects.toBeInstanceOf(NetworkPaused);
    expect(calls).toEqual([]);
    expect(repos.settings.get('api_football_quota')).toBeNull();
  });
});

describe('API-Football key', () => {
  it('stored encrypted: DB value ≠ plaintext, decryptSetting returns it, never logged', async () => {
    const raw = (
      db.db.sqlite.prepare("SELECT value FROM settings WHERE key = 'api_football_key_enc'").get() as {
        value: string;
      }
    ).value;
    expect(raw).not.toContain(KEY);
    const stored = repos.settings.get('api_football_key_enc');
    expect(stored).not.toBe(KEY);
    expect(stored?.startsWith('v1:')).toBe(true);
    expect(decryptSetting(stored ?? '', SECRET)).toBe(KEY);

    const { feed, log } = build();
    await feed.poll([arsChe]);
    answer = () => ({ errors: { token: 'Error/Missing application key.' }, response: [] });
    await expect(feed.poll([arsChe])).rejects.toThrow(/refused/);
    expect(calls[0]?.key).toBe(KEY);
    expect(log.text()).toContain('API-Football request');
    expect(log.text()).not.toContain(KEY);
  });
});
