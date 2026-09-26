import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivedSoccerMinute, OnceSet } from '../../../src/feeds/gameState.js';
import { liveDataToState, parseSoccerLiveText } from '../../../src/feeds/kalshi/live.js';
import type { LiveData } from '../../../src/feeds/kalshi/schemas.js';
import { captureLogger } from '../../helpers/kalshiMsw.js';
import { logLines, trackedGame } from '../../helpers/feeds.js';

afterEach(() => vi.useRealTimers());

const soccer = (text: string, extra: Record<string, unknown> = {}): LiveData => ({
  type: 'soccer_game',
  milestone_id: 'm-soccer-1',
  details: { status: 'live', home_points: 1, away_points: 0, tileLiveText: text, ...extra },
});

describe('soccer minute parser (Kalshi tileLiveText / widgetLiveText)', () => {
  it.each([
    ["78'", { kind: 'minute', minute: 78, half: 2 }],
    ["45+2'", { kind: 'minute', minute: 45, half: 1 }],
    ["90+4'", { kind: 'minute', minute: 90, half: 2 }],
    ["12'", { kind: 'minute', minute: 12, half: 1 }],
    ['HT', { kind: 'halftime' }],
    ['FT', { kind: 'finished' }],
    ['1st Half', { kind: 'half', half: 1 }],
    ['2nd Half', { kind: 'half', half: 2 }],
    ['Postponed', { kind: 'postponed' }],
    ['Kick-off soon', { kind: 'unknown' }],
  ])('%s → %o', (text, expected) => {
    expect(parseSoccerLiveText(text)).toEqual(expected);
  });

  it('table through the adapter: minute, halftime, finished, no minute, postponed', () => {
    const { log } = captureLogger();
    const ctx = { now: Date.parse('2026-10-17T15:00:00Z'), log, unknownText: new OnceSet() };
    const game = trackedGame({ kickoffObservedAt: Date.parse('2026-10-17T14:00:00Z') });
    const s = (text: string) => liveDataToState(soccer(text), game, ctx);

    expect(s("78'").clock).toMatchObject({ minute: 78, minuteSource: 'feed' });
    expect(s("45+2'").clock).toMatchObject({ minute: 45, minuteSource: 'feed' });
    expect(s("90+4'").clock).toMatchObject({ minute: 90, minuteSource: 'feed' });
    expect(s('HT').phase).toBe('halftime');
    expect(s('FT')).toMatchObject({ phase: 'finished', clock: { regulationOver: true } });
    expect(parseSoccerLiveText('1st Half')).not.toHaveProperty('minute');
    expect(s('1st Half')).toMatchObject({ phase: 'live', clock: { minuteSource: 'derived', period: 1 } });
    expect(s('Postponed').phase).toBe('postponed');
    expect(liveDataToState(soccer('Postponed', { status: 'none' }), game, ctx).phase).toBe('postponed');
  });

  it("an unseen string yields a derived minute (minuteSource 'derived') and exactly one warn per game id", () => {
    const logs = captureLogger();
    const unknownText = new OnceSet();
    const kickoff = Date.parse('2026-10-17T14:00:00Z');
    const a = trackedGame({ kickoffObservedAt: kickoff });
    const b = trackedGame({ id: 'KXEPLGAME-26OCT17LIVMCI', kickoffObservedAt: kickoff });
    for (let i = 0; i < 3; i++) {
      const now = kickoff + (20 + i) * 60_000 + 5_000;
      const state = liveDataToState(soccer('Weird text'), a, { now, log: logs.log, unknownText });
      expect(state.clock).toMatchObject({ minute: 20 + i, minuteSource: 'derived' });
      liveDataToState(soccer('Weird text'), b, { now, log: logs.log, unknownText });
    }
    const warns = logLines(logs.text()).filter((l) => l.level === 40);
    expect(warns.map((w) => w['gameId'])).toEqual([a.id, b.id]);
  });
});

describe('derived soccer minute (fake timers)', () => {
  it('kick-off at T → minute 30 at T+30 min 10 s; second half at S → 65 at S+20 min; capped at 45 / 90', () => {
    vi.useFakeTimers();
    const T = Date.parse('2026-10-17T14:00:00Z');
    vi.setSystemTime(T);
    const kickoff = Date.now();
    vi.advanceTimersByTime(30 * 60_000 + 10_000);
    expect(derivedSoccerMinute(kickoff, null, Date.now())).toBe(30);
    vi.advanceTimersByTime(40 * 60_000);
    expect(derivedSoccerMinute(kickoff, null, Date.now())).toBe(45); // capped in the first half

    const S = Date.now();
    vi.advanceTimersByTime(20 * 60_000);
    expect(derivedSoccerMinute(kickoff, S, Date.now())).toBe(65);
    vi.advanceTimersByTime(60 * 60_000);
    expect(derivedSoccerMinute(kickoff, S, Date.now())).toBe(90); // capped in the second half
    expect(derivedSoccerMinute(null, null, Date.now())).toBeUndefined();
  });

  it('the adapter derives from the observed kick-off / second half with a fake clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-17T14:00:00Z'));
    const { log } = captureLogger();
    const unknownText = new OnceSet();
    const kickoff = Date.now();
    vi.advanceTimersByTime(30 * 60_000 + 10_000);
    const first = liveDataToState(soccer('1st Half'), trackedGame({ kickoffObservedAt: kickoff }), {
      now: Date.now(),
      log,
      unknownText,
    });
    expect(first.clock).toEqual({ minute: 30, minuteSource: 'derived', period: 1, regulationOver: false });
    const S = Date.now();
    vi.advanceTimersByTime(20 * 60_000);
    const second = liveDataToState(
      soccer('2nd Half'),
      trackedGame({ kickoffObservedAt: kickoff, secondHalfObservedAt: S }),
      { now: Date.now(), log, unknownText },
    );
    expect(second.clock).toEqual({ minute: 65, minuteSource: 'derived', period: 2, regulationOver: false });
  });
});
