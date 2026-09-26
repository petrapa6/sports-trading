import { describe, expect, it } from 'vitest';
import { runLiveMockReplay } from '../../../scripts/live-mock-lib.js';

/** `npm run replay -- --live-mock` (T13): one live trade that fills and settles, balance history, stats by mode. */
describe('replay --live-mock', () => {
  it('a live strategy against the msw Kalshi mock → one live trade that fills and settles; balance_snapshots grows; /api/stats shows it only under live', async () => {
    const r = await runLiveMockReplay();
    expect(r.orderBodies).toHaveLength(1);
    expect(r.orderBodies[0]).toMatchObject({
      side: 'bid',
      count: '2',
      price: '0.9400',
      time_in_force: 'immediate_or_cancel',
      order_group_id: 'grp-new',
    });
    const live = r.trades.filter((t) => t.effectiveMode === 'live');
    expect(r.trades).toHaveLength(1);
    expect(live).toMatchObject([
      {
        status: 'settled_won',
        configuredMode: 'live',
        kalshiEnv: 'demo',
        fillCc: 200,
        avgFillPriceBp: 9300,
        costMicros: 1_860_000,
        feeMicros: 9200,
        payoutMicros: 2_000_000,
        realizedPnlMicros: 130_800,
        reconcileWarning: null,
      },
    ]);
    expect(r.balanceSnapshots.afterFill).toBeGreaterThan(r.balanceSnapshots.before);
    expect(r.balanceSnapshots.afterSettlement).toBeGreaterThan(r.balanceSnapshots.afterFill);
    expect(r.stats.live?.tiles).toMatchObject({ trades: 1, won: 1, netPnlMicros: 130_800 });
    expect(r.stats.dry_run?.tiles).toMatchObject({ trades: 0, netPnlMicros: 0 });
    expect(r.stats.live?.series.balance?.length).toBe(r.balanceSnapshots.afterSettlement);
  });
});
