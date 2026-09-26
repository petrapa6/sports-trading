import { describe, expect, it } from 'vitest';
import { effectiveMode, runningMode, type ModeResult, type ModeSwitches } from '../../../src/core/modes.js';

/** Every combination of the five switches (2^5 = 32), in a fixed order. */
function combinations(): ModeSwitches[] {
  const out: ModeSwitches[] = [];
  for (const globalKill of [false, true])
    for (const strategyKill of [false, true])
      for (const allowLiveOrders of [false, true])
        for (const globalDryRun of [false, true])
          for (const strategyMode of ['dry_run', 'live'] as const)
            out.push({ globalKill, strategyKill, allowLiveOrders, globalDryRun, strategyMode });
  return out;
}

/** SPEC.md §1, written out independently of the implementation. */
function expected(s: ModeSwitches): ModeResult {
  if (s.globalKill) return { mode: 'paused', reason: 'global_kill_switch' };
  if (s.strategyKill) return { mode: 'paused', reason: 'strategy_kill_switch' };
  if (!s.allowLiveOrders) return { mode: 'dry_run', reason: 'addon_lock' };
  if (s.globalDryRun) return { mode: 'dry_run', reason: 'global_dry_run' };
  if (s.strategyMode === 'dry_run') return { mode: 'dry_run', reason: 'strategy' };
  return { mode: 'live', reason: null };
}

describe('effectiveMode (SPEC.md §1)', () => {
  const all = combinations();

  it('covers all 32 combinations of the five switches', () => {
    expect(all).toHaveLength(32);
    expect(new Set(all.map((s) => JSON.stringify(s))).size).toBe(32);
  });

  it.each(all.map((s) => [JSON.stringify(s), s] as const))('%s', (_label, s) => {
    expect(effectiveMode(s)).toEqual(expected(s));
  });

  it('distribution: 16 paused by the global kill switch, 8 by the strategy kill switch, 4 add-on lock, 2 global dry run, 1 strategy, 1 live', () => {
    const counts: Record<string, number> = {};
    for (const s of all) {
      const r = effectiveMode(s);
      const key = `${r.mode}/${r.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      'paused/global_kill_switch': 16,
      'paused/strategy_kill_switch': 8,
      'dry_run/addon_lock': 4,
      'dry_run/global_dry_run': 2,
      'dry_run/strategy': 1,
      'live/null': 1,
    });
  });

  it('runningMode ignores both kill switches', () => {
    expect(runningMode({ allowLiveOrders: true, globalDryRun: false, strategyMode: 'live' })).toBe('live');
    expect(runningMode({ allowLiveOrders: false, globalDryRun: false, strategyMode: 'live' })).toBe(
      'dry_run',
    );
    expect(runningMode({ allowLiveOrders: true, globalDryRun: true, strategyMode: 'live' })).toBe('dry_run');
    expect(runningMode({ allowLiveOrders: true, globalDryRun: false, strategyMode: 'dry_run' })).toBe(
      'dry_run',
    );
  });
});
