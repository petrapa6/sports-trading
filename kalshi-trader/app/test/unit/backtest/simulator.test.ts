import { describe, expect, it } from 'vitest';
import { candleMinuteMs, stateAt } from '../../../src/backtest/clock.js';
import { loadSimInput, type ResolvedRequest } from '../../../src/backtest/data.js';
import { MIN_SAMPLE, PriceModelLookup, seedAskBp, seedTable } from '../../../src/backtest/priceModel.js';
import { settlementValueBp, simulate } from '../../../src/backtest/simulator.js';
import { ruleMinute } from '../../../src/core/engine.js';
import { feeMicros } from '../../../src/core/pricing.js';
import { createRepositories } from '../../../src/db/repositories.js';
import { tempDb, type TempDb } from '../../helpers/db.js';
import { goal, params, seedCandles, seedHistGame, simInput, syntheticGames } from '../../helpers/backtest.js';

const PLAYED = '2025-10-18T14:00:00.000Z';
const A = {
  id: 'g-a',
  playedAt: PLAYED,
  event: 'EV-A',
  goals: [goal('home', 12), goal('away', 55), goal('home', 78)],
};

describe('clock', () => {
  it('hockey ticks give the same rule minute as the live NHL clock; goals count from their minute', () => {
    for (const m of [1, 19, 20, 21, 39, 40, 41, 55, 59, 60]) {
      expect(ruleMinute('hockey', stateAt('hockey', [], m).clock)).toBe(m);
    }
    const s = stateAt('soccer', [goal('home', 12), goal('away', 55)], 55);
    expect([s.homeScore, s.awayScore, s.clock.period]).toEqual([1, 1, 2]);
    expect(stateAt('soccer', [goal('away', 55)], 54).awayScore).toBe(0);
  });

  it('candle minutes: soccer first half = kick-off + minute, second half after the break; hockey periods + intermissions', () => {
    const k = Date.parse(PLAYED);
    expect(candleMinuteMs('soccer', k, 30)).toBe(k + 30 * 60_000);
    expect(candleMinuteMs('soccer', k, 80)).toBe(k + 97 * 60_000);
    expect(candleMinuteMs('soccer', k, 80, k + 65 * 60_000)).toBe(k + 100 * 60_000);
    expect(candleMinuteMs('hockey', k, 10)).toBe(k + 18 * 60_000);
    expect(candleMinuteMs('hockey', k, 50)).toBe(k + (110 + 18) * 60_000);
  });
});

describe('settlement (§9 step 4)', () => {
  it('soccer 2-1 after 90 → won; NHL 3-2 in OT for the leader → won; lead lost in OT → lost; NHL tie → void at $0.50', () => {
    expect(settlementValueBp('soccer', 'home', 2, 1)).toBe(10_000);
    expect(settlementValueBp('soccer', 'home', 1, 1)).toBe(0);
    expect(settlementValueBp('hockey', 'home', 3, 2)).toBe(10_000);
    expect(settlementValueBp('hockey', 'home', 2, 3)).toBe(0);
    expect(settlementValueBp('hockey', 'away', 2, 2)).toBe(5000);
  });

  it('through the simulator: soccer won, NHL OT win and OT loss, NHL tie void', () => {
    const soccer = simulate(simInput('soccer', [A], { candles: { 'EV-A-H': { 80: 9000 } } }));
    expect(soccer.trades[0]).toMatchObject({ skip_reason: null, settlement_value_bp: 10_000 });
    expect(soccer.summary).toMatchObject({ won: 1, lost: 0, void: 0 });

    // Home leads 2-0 at 50', 2-2 after regulation; OT decides (final incl. OT stored in final_home/away).
    const goals = [goal('home', 10, 1), goal('home', 30, 2), goal('away', 55, 3), goal('away', 58, 3)];
    const run = (final: [number, number]) =>
      simulate(
        simInput('hockey', [{ id: 'h', playedAt: PLAYED, goals, final }], {
          priceMode: 'modelled',
          def: { rule: { type: 'lead_at_time', minLead: 2, atMinute: 50, windowMinutes: 3 } },
        }),
      ).trades[0];
    expect(run([3, 2])).toMatchObject({ side: 'home', minute: 50, settlement_value_bp: 10_000 });
    expect(run([2, 3])).toMatchObject({ side: 'home', settlement_value_bp: 0 });
    const tie = run([2, 2]);
    expect(tie).toMatchObject({ settlement_value_bp: 5000 });
    expect(tie?.pnl_micros).toBe(
      (tie?.contracts_cc ?? 0) * 5000 -
        (tie?.contracts_cc ?? 0) * (tie?.price_bp ?? 0) -
        (tie?.fee_micros ?? 0),
    );
  });
});

describe('exact mode', () => {
  it('candle at 80 → used (candle); absent at 80, present at 82 → next_candle; none within 3 min → skipped_no_price', () => {
    const at80 = simulate(simInput('soccer', [A], { candles: { 'EV-A-H': { 80: 9000, 82: 8000 } } }));
    expect(at80.trades[0]).toMatchObject({ minute: 80, price_source: 'candle', price_bp: 9100 });

    const next = simulate(simInput('soccer', [A], { candles: { 'EV-A-H': { 82: 9200 } } }));
    expect(next.trades[0]).toMatchObject({ minute: 80, price_source: 'next_candle', price_bp: 9300 });

    const none = simulate(
      simInput('soccer', [A], {
        candles: { 'EV-A-H': { 84: 9200 } },
        def: { rule: { type: 'lead_at_time', minLead: 1, atMinute: 80, windowMinutes: 0 } },
      }),
    );
    expect(none.trades[0]).toMatchObject({ minute: 80, skip_reason: 'skipped_no_price', contracts_cc: null });
    expect(none.summary.skips).toEqual([{ reason: 'skipped_no_price', count: 1 }]);
  });

  it('reads the ask close (not the trade close) from hist_prices, via the database loader', () => {
    const tdb: TempDb = tempDb();
    try {
      const repos = createRepositories(tdb.db.orm);
      seedHistGame(repos, 'epl', '2025-26', A);
      seedCandles(repos, 'soccer', PLAYED, 'EV-A-H', { 80: [9000, 7000], 81: [9100, null] });
      const p = params();
      const req: ResolvedRequest = {
        name: null,
        saved: false,
        quick: false,
        sport: 'soccer',
        leagueIds: ['epl'],
        seasons: [],
        sinceIso: null,
        strategy: null,
        definition: {
          name: p.name,
          leagueIds: p.leagueIds,
          rule: p.rule,
          sizing: p.sizing,
          execution: p.execution,
        },
        priceMode: 'exact',
        initialBankrollMicros: 100_000_000,
      };
      const input = loadSimInput(tdb.db.sqlite, req);
      expect(input.games).toHaveLength(1);
      const r = simulate(input);
      expect(r.trades[0]).toMatchObject({ price_source: 'candle', price_bp: 9100 }); // 0.90 ask + 1¢ slippage
      // A candle minute without trades is stored with trade_close_bp NULL and still prices the entry.
      expect(repos.histPrices.list().find((c) => c.trade_close_bp === null)?.ask_close_bp).toBe(9100);
    } finally {
      tdb.cleanup();
    }
  });

  it('retry: ask above maxPrice at 80 and below at 82 → entry at 82; window closing → skipped with the last soft reason', () => {
    const retry = simulate(
      simInput('soccer', [A], { candles: { 'EV-A-H': { 80: 9800, 81: 9800, 82: 9400 } } }),
    );
    expect(retry.trades[0]).toMatchObject({ minute: 82, price_source: 'candle', price_bp: 9500 });

    const never = simulate(
      simInput('soccer', [A], {
        candles: { 'EV-A-H': { 80: 9800, 81: 9800, 82: 9800, 83: 9800, 84: 9800, 85: 9800 } },
      }),
    );
    expect(never.trades[0]).toMatchObject({ minute: 85, skip_reason: 'price', price_bp: 9800 });
  });

  it('a game without a Kalshi market → skipped_no_price', () => {
    const r = simulate(simInput('soccer', [{ id: A.id, playedAt: A.playedAt, goals: A.goals }]));
    expect(r.trades[0]?.skip_reason).toBe('skipped_no_price');
  });
});

describe('modelled mode', () => {
  it('every trade has price_source=model; summary has priceMode=modelled and minSampleSize', () => {
    const games = syntheticGames(30);
    const r = simulate(
      simInput('soccer', games, {
        priceMode: 'modelled',
        def: { rule: { type: 'lead_at_time', minLead: 2, atMinute: 80, windowMinutes: 5 } },
      }),
    );
    const filled = r.trades.filter((t) => t.skip_reason === null);
    expect(filled.length).toBeGreaterThan(0);
    expect(r.trades.every((t) => t.price_source === 'model')).toBe(true);
    expect(r.summary.priceMode).toBe('modelled');
    expect(r.summary.minSampleSize).toBe(0); // seed table only
    // Lead 2, 10 minutes left → seed $0.96 → limit $0.97.
    expect(filled[0]?.price_bp).toBe(9700);
  });

  it('a model cell with ≥ 20 observations is used; smaller cells fall back to the seed and report their sample size', () => {
    const model = {
      cells: [
        { sport: 'soccer' as const, lead: 1, remaining: 10, askBp: 9000, sampleSize: 60 },
        { sport: 'soccer' as const, lead: 2, remaining: 10, askBp: 9100, sampleSize: 5 },
      ],
    };
    const lookup = new PriceModelLookup(model);
    expect(lookup.price('soccer', 1, 10)).toEqual({ askBp: 9000, sampleSize: 60, seeded: false });
    expect(lookup.price('soccer', 2, 12)).toEqual({ askBp: 9600, sampleSize: 5, seeded: true });
    expect(lookup.price('hockey', 2, 5)).toEqual({ askBp: 9700, sampleSize: 0, seeded: true });
    expect(seedAskBp('soccer', 1, 10)).toBe(8500);
    expect(seedTable().length).toBe(3 * 18 + 3 * 12);
    expect(MIN_SAMPLE).toBe(20);

    const r = simulate(simInput('soccer', [A], { priceMode: 'modelled', priceModel: model }));
    expect(r.trades[0]).toMatchObject({ price_source: 'model', price_bp: 9100 });
    expect(r.summary.minSampleSize).toBe(60);
  });
});

describe('compounding and determinism', () => {
  it('bankroll $100, 2 %: the second stake is 2 % of the post-first-trade bankroll (micros)', () => {
    const B = { ...A, id: 'g-b', event: 'EV-B', playedAt: '2025-10-25T14:00:00.000Z' };
    const r = simulate(
      simInput('soccer', [A, B], { candles: { 'EV-A-H': { 80: 9000 }, 'EV-B-H': { 80: 9000 } } }),
    );
    const [first, second] = r.trades;
    // $2 stake at $0.91 → 2 contracts; fee on 2 at $0.91.
    expect(first).toMatchObject({ stake_micros: 2_000_000, contracts_cc: 200, price_bp: 9100 });
    const fee1 = feeMicros({ cc: 200, bp: 9100 });
    expect(first?.fee_micros).toBe(fee1);
    const after1 = 100_000_000 - 200 * 9100 - fee1 + 200 * 10_000;
    expect(first?.bankroll_after_micros).toBe(after1);
    expect(second?.stake_micros).toBe(Math.floor((after1 * 200) / 10_000));
    expect(r.summary).toMatchObject({
      trades: 2,
      won: 2,
      winRate: 1,
      finalBankrollMicros: second?.bankroll_after_micros,
    });
  });

  it('the same input twice → identical trades and summary', () => {
    const input = simInput('soccer', syntheticGames(200), { priceMode: 'modelled' });
    expect(JSON.stringify(simulate(input))).toBe(JSON.stringify(simulate(input)));
  });

  it('metrics: equity, drawdown and monthly P&L follow the trades', () => {
    const lost = {
      ...A,
      id: 'g-l',
      event: 'EV-L',
      playedAt: '2025-11-02T14:00:00.000Z',
      final: [2, 3] as [number, number],
    };
    const r = simulate(
      simInput('soccer', [A, lost], { candles: { 'EV-A-H': { 80: 9000 }, 'EV-L-H': { 80: 9000 } } }),
    );
    const [w, l] = r.trades;
    expect(r.summary.series.equity.map((p) => p.cumMicros)).toEqual([
      w?.pnl_micros,
      (w?.pnl_micros ?? 0) + (l?.pnl_micros ?? 0),
    ]);
    expect(r.summary.maxDrawdownMicros).toBe(-(l?.pnl_micros ?? 0));
    expect(r.summary.series.monthly).toEqual([
      { month: '2025-10', pnlMicros: w?.pnl_micros },
      { month: '2025-11', pnlMicros: l?.pnl_micros },
    ]);
    expect(r.summary.netPnlMicros).toBe((w?.pnl_micros ?? 0) + (l?.pnl_micros ?? 0));
    expect(r.summary.winRate).toBe(0.5);
  });
});
