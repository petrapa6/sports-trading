import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OnceSet } from '../../../src/feeds/gameState.js';
import { KalshiLiveFeed, liveDataToState } from '../../../src/feeds/kalshi/live.js';
import type { LiveData } from '../../../src/feeds/kalshi/schemas.js';
import { captureLogger, kalshiMockServer, testClient, TEST_BASE } from '../../helpers/kalshiMsw.js';
import { fixture } from '../../helpers/kalshiFixtures.js';
import { trackedGame } from '../../helpers/feeds.js';

const mock = kalshiMockServer();
beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  mock.server.resetHandlers();
  mock.requests.length = 0;
});
afterAll(() => mock.server.close());

const nhlGame = trackedGame({
  id: 'KXNHLGAME-26OCT10UTAVGK',
  leagueId: 'nhl',
  sport: 'hockey',
  milestoneId: 'b3f0c1d2-0001-4000-8000-000000000001',
});
const ctx = () => ({
  now: Date.parse('2026-10-11T02:40:00Z'),
  log: captureLogger().log,
  unknownText: new OnceSet(),
});
const hockey = (details: Record<string, unknown>): LiveData => ({
  type: 'hockey_game',
  milestone_id: nhlGame.milestoneId ?? '',
  details: { home_points: 1, away_points: 1, ...details },
});

describe('Kalshi live data → GameState (NHL)', () => {
  it('round 2, final_round_time_left 12:34 → live, period 2, 754 s left, minute 27', () => {
    const s = liveDataToState(
      hockey({ status: 'live', round: 2, final_round_time_left: '12:34' }),
      nhlGame,
      ctx(),
    );
    expect(s).toMatchObject({
      phase: 'live',
      homeScore: 1,
      awayScore: 1,
      source: 'kalshi-live',
      clock: { period: 2, secondsLeftInPeriod: 754, minute: 27, minuteSource: 'feed', regulationOver: false },
    });
  });

  it('round 1 with 00:00 → intermission (also round 2); round 3 with 00:00 → regulation over', () => {
    expect(
      liveDataToState(hockey({ status: 'live', round: 1, final_round_time_left: '00:00' }), nhlGame, ctx())
        .phase,
    ).toBe('intermission');
    expect(
      liveDataToState(hockey({ status: 'live', round: 2, final_round_time_left: '00:00' }), nhlGame, ctx())
        .phase,
    ).toBe('intermission');
    const r3 = liveDataToState(
      hockey({ status: 'live', round: 3, final_round_time_left: '00:00' }),
      nhlGame,
      ctx(),
    );
    expect(r3).toMatchObject({ phase: 'live', clock: { minute: 60, regulationOver: true } });
    const ot = liveDataToState(
      hockey({ status: 'live', round: 4, final_round_time_left: '03:10' }),
      nhlGame,
      ctx(),
    );
    expect(ot.clock).toMatchObject({ period: 4, minute: 60, regulationOver: true });
  });

  it("status 'finished' → finished, regulationOver true; 'none' → scheduled", () => {
    expect(liveDataToState(hockey({ status: 'finished', round: 3 }), nhlGame, ctx())).toMatchObject({
      phase: 'finished',
      clock: { regulationOver: true },
    });
    expect(liveDataToState(hockey({ status: 'none' }), nhlGame, ctx()).phase).toBe('scheduled');
  });

  it('the recorded fixture live_data.json (round 3, 05:12) → minute 54', () => {
    const live = (fixture('live_data') as { live_data: LiveData }).live_data;
    expect(liveDataToState(live, nhlGame, ctx())).toMatchObject({
      homeScore: 2,
      awayScore: 1,
      phase: 'live',
      clock: { period: 3, secondsLeftInPeriod: 312, minute: 54 },
    });
  });
});

describe('batch', () => {
  it('8 live milestones → exactly one live-data request per tick', async () => {
    const games = Array.from({ length: 8 }, (_, i) =>
      trackedGame({
        id: `KXNHLGAME-G${i}`,
        leagueId: i < 4 ? 'nhl' : 'epl',
        sport: i < 4 ? 'hockey' : 'soccer',
        milestoneId: `ms-${i}`,
        phase: 'live',
        kickoffObservedAt: Date.parse('2026-10-11T02:00:00Z'),
      }),
    );
    mock.use(
      http.get(`${TEST_BASE}/live_data/batch`, ({ request }) => {
        const ids = (new URL(request.url).searchParams.get('milestone_ids') ?? '').split(',');
        mock.requests.push({ method: 'GET', url: new URL(request.url), headers: request.headers, body: '' });
        return HttpResponse.json({
          live_datas: ids.map((id, i) => ({
            type: i < 4 ? 'hockey_game' : 'soccer_game',
            milestone_id: id,
            details:
              i < 4
                ? { status: 'live', home_points: i, away_points: 0, round: 2, final_round_time_left: '10:00' }
                : { status: 'live', home_points: 0, away_points: i, tileLiveText: `${60 + i}'` },
          })),
        });
      }),
    );
    const feed = new KalshiLiveFeed({ client: testClient(), log: captureLogger().log, games: () => games });
    for (let tick = 1; tick <= 3; tick++) {
      const obs = await feed.poll(games);
      expect(obs).toHaveLength(8);
      expect(mock.requests.filter((r) => r.url.pathname.endsWith('/live_data/batch'))).toHaveLength(tick);
    }
    expect(mock.requests).toHaveLength(3);
    const ids = mock.requests[0]?.url.searchParams.get('milestone_ids')?.split(',');
    expect(ids).toEqual(games.map((g) => g.milestoneId));
    const obs = await feed.poll(games);
    expect(obs[0]?.state.clock).toMatchObject({ period: 2, minute: 30 });
    expect(obs[7]?.state.clock).toMatchObject({ minute: 67, minuteSource: 'feed' });
  });

  it('no tracked milestones → no request; listLive and get use the same batch call', async () => {
    const feed = new KalshiLiveFeed({
      client: testClient(),
      log: captureLogger().log,
      games: () => [nhlGame],
    });
    expect(await feed.poll([trackedGame({ milestoneId: null })])).toEqual([]);
    expect(mock.requests).toHaveLength(0);
    const live = await feed.listLive('nhl');
    expect(live).toHaveLength(1);
    expect((await feed.get(nhlGame.id)).clock).toMatchObject({ period: 3 });
    expect(mock.requests.map((r) => r.url.pathname)).toEqual([
      '/trade-api/v2/live_data/batch',
      '/trade-api/v2/live_data/batch',
    ]);
  });
});
