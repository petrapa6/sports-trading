import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, parseFilters, serializeFilters } from '../../../src/web/filters';
import { filterLogs } from '../../../src/web/logFilter';

describe('filter bar URL state', () => {
  it('defaults: mode both, nothing in the URL', () => {
    expect(parseFilters('')).toEqual(DEFAULT_FILTERS);
    expect(DEFAULT_FILTERS.mode).toBe('both');
    expect(serializeFilters(DEFAULT_FILTERS)).toBe('');
  });

  it('league epl, mode live, preset 30d → ?leagues=epl&mode=live&range=30d, and back', () => {
    const f = { ...DEFAULT_FILTERS, leagues: ['epl'], mode: 'live' as const, range: '30d' as const };
    expect(serializeFilters(f)).toBe('?leagues=epl&mode=live&range=30d');
    expect(parseFilters('?leagues=epl&mode=live&range=30d')).toEqual(f);
  });

  it('round-trips every field in a fixed order; bad values fall back to defaults', () => {
    const f = {
      sport: 'soccer' as const,
      leagues: ['epl', 'laliga'],
      strategies: ['s1'],
      mode: 'dry_run' as const,
      env: 'prod' as const,
      range: 'season' as const,
    };
    const q = serializeFilters(f);
    expect(q).toBe('?sport=soccer&leagues=epl,laliga&strategies=s1&mode=dry_run&env=prod&range=season');
    expect(parseFilters(q)).toEqual(f);
    expect(parseFilters('?mode=all&range=1y&sport=curling&env=x&leagues=<script>,epl,epl')).toEqual({
      ...DEFAULT_FILTERS,
      leagues: ['epl'],
    });
  });
});

describe('log mode filter', () => {
  const line = (seq: number, mode: 'live' | 'dry_run' | null) => ({
    seq,
    time: '',
    level: 'info',
    msg: '',
    mode,
  });
  const logs = [line(1, null), line(2, 'dry_run'), line(3, 'live'), line(4, 'dry_run')];
  it('dry_run hides every line whose mode is not dry_run', () => {
    expect(filterLogs(logs, 'dry_run').map((l) => l.seq)).toEqual([2, 4]);
    expect(filterLogs(logs, 'live').map((l) => l.seq)).toEqual([3]);
    expect(filterLogs(logs, 'all')).toHaveLength(4);
  });
});
