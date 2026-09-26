import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GameView, LoopStatus, SwitchStates } from '../../../src/web/api';
import { GameCard, phaseLabel } from '../../../src/web/components/GameCard';
import { StatusStripView } from '../../../src/web/components/StatusStripView';

const switches: SwitchStates = {
  globalKillSwitch: false,
  globalDryRun: true,
  allowLiveOrders: false,
  kalshiEnv: 'demo',
  kalshiSubaccount: 0,
};
const loop = (over: Partial<LoopStatus> = {}): LoopStatus => ({
  state: 'running',
  lastTickAt: '2026-10-15T02:00:05.000Z',
  lastPollAt: '2026-10-15T02:00:05.000Z',
  cadenceMs: 5000,
  trackedGames: 1,
  feeds: [
    {
      id: 'kalshi-live',
      name: 'Kalshi live data',
      enabled: true,
      available: true,
      status: 'ok',
      lastPollAt: null,
      lastOkAt: null,
      lastError: null,
    },
    {
      id: 'nhl-official',
      name: 'NHL official API',
      enabled: true,
      available: true,
      status: 'error',
      lastPollAt: null,
      lastOkAt: null,
      lastError: 'boom',
    },
  ],
  balance: { cashMicros: 123_450_000, at: '2026-10-15T02:00:00.000Z', error: null },
  ...over,
});

describe('StatusStripView', () => {
  it('shows loop state, feeds (a failing feed as error), Kalshi env + balance and the switches', () => {
    const html = renderToStaticMarkup(<StatusStripView switches={switches} loop={loop()} />);
    expect(html).toContain('running');
    expect(html).toContain('1 failing');
    expect(html).toContain('NHL official API: error');
    expect(html).toContain('Kalshi live data: ok');
    expect(html).toContain('demo · $123.45');
    expect(html).toContain('locked (no live orders)');
  });

  it('paused by the kill switch; stale; idle', () => {
    expect(
      renderToStaticMarkup(
        <StatusStripView
          switches={{ ...switches, globalKillSwitch: true }}
          loop={loop({ state: 'paused' })}
        />,
      ),
    ).toContain('paused by kill switch');
    expect(
      renderToStaticMarkup(<StatusStripView switches={switches} loop={loop({ state: 'stale' })} />),
    ).toContain('stale');
    expect(
      renderToStaticMarkup(<StatusStripView switches={switches} loop={loop({ state: 'idle' })} />),
    ).toContain('idle (no games)');
  });
});

describe('GameCard', () => {
  const game = (over: Partial<GameView>): GameView => ({
    id: 'g1',
    leagueId: 'nhl',
    sport: 'hockey',
    competition: null,
    homeTeam: 'Vegas',
    awayTeam: 'Seattle',
    homeAbbr: 'VGK',
    awayAbbr: 'SEA',
    homeScore: 1,
    awayScore: 1,
    phase: 'live',
    clock: { period: 2, secondsLeftInPeriod: 754, minute: 27, minuteSource: 'feed', regulationOver: false },
    blocked: false,
    scheduledAt: '2026-10-15T02:00:00.000Z',
    observedAt: null,
    source: 'kalshi-live',
    strategies: [],
    ...over,
  });

  it("phase labels: P2 12:34, 78', HT, Intermission, Final", () => {
    expect(phaseLabel(game({}))).toBe('P2 12:34');
    expect(phaseLabel(game({ sport: 'soccer', clock: { minute: 78, regulationOver: false } }))).toBe("78'");
    expect(phaseLabel(game({ phase: 'halftime' }))).toBe('HT');
    expect(phaseLabel(game({ phase: 'intermission', clock: { period: 1, regulationOver: false } }))).toBe(
      'Intermission after P1',
    );
    expect(phaseLabel(game({ phase: 'finished' }))).toBe('Final');
  });

  it('marks a derived minute and a blocked game', () => {
    const html = renderToStaticMarkup(
      <GameCard
        game={game({
          sport: 'soccer',
          clock: { minute: 30, minuteSource: 'derived', regulationOver: false },
          blocked: true,
        })}
      />,
    );
    expect(html).toContain('Minute 30');
    expect(html).toContain('derived');
    expect(html).toContain('feeds disagree');
    expect(html).toContain('No strategies armed');
  });
});
