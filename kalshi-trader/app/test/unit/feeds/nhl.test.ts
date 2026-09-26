import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNetworkGate, NetworkPaused } from '../../../src/feeds/network.js';
import {
  matchNhlGame,
  NhlFeed,
  nhlGameToState,
  nhlPhase,
  type NhlGame,
} from '../../../src/feeds/nhl/feed.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { trackedGame } from '../../helpers/feeds.js';
import { nhlFixture, routeNhl } from '../../helpers/nhlFixtures.js';

const BASE = 'https://nhl.test/v1';
const seen: string[] = [];
const server = setupServer(
  http.get(`${BASE}/*`, ({ request }) => {
    const path = new URL(request.url).pathname.slice('/v1'.length);
    seen.push(path);
    const r = routeNhl(path);
    return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

const game = trackedGame({
  id: 'KXNHLGAME-26OCT10UTAVGK',
  leagueId: 'nhl',
  sport: 'hockey',
  scheduledAt: Date.parse('2026-10-11T02:00:00Z'),
  home: { id: 'nhl:vgk', name: 'Vegas', abbreviation: 'VGK', aliases: ['VGK'] },
  away: { id: 'nhl:uta', name: 'Utah', abbreviation: 'UTA', aliases: ['UTA'] },
});
const now = Date.parse('2026-10-11T04:00:00Z');
const nhl = (over: Partial<NhlGame>): NhlGame => ({
  id: 1,
  gameState: 'LIVE',
  homeTeam: { abbrev: 'VGK', score: 2 },
  awayTeam: { abbrev: 'UTA', score: 1 },
  ...over,
});

describe('NHL adapter', () => {
  it('LIVE, period 3, "05:00" → minute 55', () => {
    const s = nhlGameToState(nhl({ period: 3, clock: { timeRemaining: '05:00' } }), game, now);
    expect(s).toMatchObject({
      phase: 'live',
      homeScore: 2,
      awayScore: 1,
      source: 'nhl-official',
      clock: { period: 3, secondsLeftInPeriod: 300, minute: 55, minuteSource: 'feed', regulationOver: false },
    });
  });

  it('OFF / FINAL → finished; FUT (and PRE) → scheduled; CRIT → live; inIntermission → intermission', () => {
    expect(nhlPhase('OFF', false)).toBe('finished');
    expect(nhlPhase('FINAL', false)).toBe('finished');
    expect(nhlPhase('FUT', false)).toBe('scheduled');
    expect(nhlPhase('PRE', false)).toBe('scheduled');
    expect(nhlPhase('CRIT', false)).toBe('live');
    expect(nhlPhase('LIVE', true)).toBe('intermission');
    expect(nhlGameToState(nhl({ gameState: 'FINAL', period: 3 }), game, now)).toMatchObject({
      phase: 'finished',
      clock: { regulationOver: true },
    });
    expect(
      nhlGameToState(nhl({ gameState: 'CRIT', period: 3, clock: { timeRemaining: '01:30' } }), game, now)
        .clock,
    ).toMatchObject({
      minute: 58,
    });
    expect(
      nhlGameToState(nhl({ period: 4, clock: { timeRemaining: '04:00' } }), game, now).clock,
    ).toMatchObject({
      minute: 60,
      regulationOver: true,
    });
  });

  it('matches through tricodes (teams.aliases) and the start time, or a known / source id', () => {
    const g = nhlFixture<{ games: NhlGame[] }>('score_now').games[0] as NhlGame;
    expect(matchNhlGame(g, [game])?.id).toBe(game.id);
    // Wrong day → no match; swapped home/away → no match.
    expect(matchNhlGame(g, [{ ...game, scheduledAt: game.scheduledAt + 2 * 86_400_000 }])).toBeUndefined();
    expect(matchNhlGame(g, [{ ...game, home: game.away, away: game.home }])).toBeUndefined();
    // Milestone source id carrying the NHL id matches without tricodes.
    const bySource = {
      ...game,
      home: null,
      away: null,
      feedGameIds: { sportradar: 'x', nhl_game_id: '2026020045' },
    };
    expect(matchNhlGame(g, [bySource])?.id).toBe(game.id);
  });

  it('polls score/now once and returns the matched game; remembers its NHL id', async () => {
    const feed = new NhlFeed({
      gate: createNetworkGate(() => false),
      log: captureLogger().log,
      games: () => [game],
      baseUrl: BASE,
      now: () => now,
    });
    const obs = await feed.poll([game]);
    expect(seen).toEqual(['/score/now']);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.feedGameId).toEqual({ key: 'nhl', value: 2026020045 });
    expect(obs[0]?.state).toMatchObject({
      gameId: game.id,
      homeScore: 2,
      awayScore: 1,
      clock: { minute: 55 },
    });
  });

  it('a tracked game missing from score/now but with a known NHL id is read from the landing endpoint', async () => {
    const known = {
      ...game,
      id: 'KXNHLGAME-OTHER',
      home: null,
      away: null,
      feedGameIds: { nhl: 2026020045 },
    };
    server.use(http.get(`${BASE}/score/now`, () => HttpResponse.json({ games: [] })));
    const feed = new NhlFeed({
      gate: createNetworkGate(() => false),
      log: captureLogger().log,
      games: () => [known],
      baseUrl: BASE,
      now: () => now,
    });
    const obs = await feed.poll([known]);
    expect(seen).toEqual(['/gamecenter/2026020045/landing']);
    expect(obs[0]?.state).toMatchObject({ gameId: 'KXNHLGAME-OTHER', phase: 'live', clock: { minute: 58 } });
    expect((await feed.get('KXNHLGAME-OTHER')).clock.minute).toBe(58);
  });

  it('the network gate rejects before any request; errors name the path only', async () => {
    const paused = new NhlFeed({
      gate: createNetworkGate(() => true),
      log: captureLogger().log,
      games: () => [game],
      baseUrl: BASE,
    });
    await expect(paused.poll([game])).rejects.toBeInstanceOf(NetworkPaused);
    expect(seen).toEqual([]);
    server.use(http.get(`${BASE}/score/now`, () => new HttpResponse(null, { status: 502 })));
    const feed = new NhlFeed({
      gate: createNetworkGate(() => false),
      log: captureLogger().log,
      games: () => [game],
      baseUrl: BASE,
    });
    await expect(feed.poll([game])).rejects.toThrow('NHL API answered 502 for GET /score/now');
    expect(await feed.test([]).catch((e: Error) => e.message)).toMatch(/502/);
    server.resetHandlers();
    expect(await feed.test([game])).toBe('3 NHL game(s) today, 1 matched to tracked games');
  });
});
