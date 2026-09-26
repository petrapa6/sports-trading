import type { Repositories } from '../db/repositories.js';
import type { StatsFilter, StatsMode } from '../db/stats.js';
import { loadStrategies } from './strategyStore.js';

/**
 * `GET /api/stats` (SPEC.md §6 Metrics, §8 Chart inventory, T10): every tile and chart series of the
 * Dashboard, computed **per mode** from the SQL aggregates in `db/stats.ts`. The response is keyed by mode —
 * `{ live: {tiles, series}, dry_run: {tiles, series} }` — and nothing in it is a sum over both modes; a mode
 * the filter leaves out is absent. The browser never receives trade rows for charts.
 *
 * Units follow the conventions table: `*Micros` money, `*Bp` prices. Ratios (win rate, ROI, shares and the
 * implied-vs-actual coordinates) are fractions rounded to 4 decimals; a ratio without a denominator is 0.
 */

export interface EquityPoint {
  /** Settlement time of the trade that moved the curve. */
  t: string;
  /** Cumulative realized P&L after it. */
  cumMicros: number;
}

export interface ModeTiles {
  /** Settled trades (won + lost + void). */
  trades: number;
  won: number;
  lost: number;
  void: number;
  /** `won / (won + lost)`; void, skipped, waiting and open trades are excluded. */
  winRate: number;
  netPnlMicros: number;
  /** Σ (cost + fee) of the settled trades: the ROI denominator. */
  investedMicros: number;
  roi: number;
  /** Largest peak-to-trough drop of the equity curve (which starts at $0). */
  maxDrawdownMicros: number;
  /** Trades with a fill (open or settled): the base of the two averages below. */
  filled: number;
  avgPriceBp: number;
  avgFeeMicros: number;
  /** Mean fill price of the won + lost trades against their win rate. */
  impliedVsActual: { impliedBp: number; actualWinRate: number; n: number };
  /** Dry run only: trades whose strategy was configured `live` (forced by global dry run or the add-on lock). */
  forcedDryRun?: { forced: number; total: number; share: number };
}

export interface ModeSeries {
  /** Cumulative realized P&L by settlement time, over all filtered strategies and per strategy. */
  equity: {
    total: EquityPoint[];
    byStrategy: { strategyId: string; strategyName: string; points: EquityPoint[] }[];
  };
  /** Dry run only: the shared virtual bankroll after each change (one point per `bankroll_snapshots` row). */
  bankroll?: { t: string; micros: number }[];
  /** Live only: the Kalshi balance (one point per `balance_snapshots` row of the environment). */
  balance?: { t: string; cashMicros: number | null; portfolioMicros: number | null }[];
  /** Realized P&L per settlement day (UTC), stacked by strategy. */
  dailyPnl: { day: string; pnlMicros: number; byStrategy: { strategyId: string; pnlMicros: number }[] }[];
  /** Drop from the running peak of the equity curve, one point per equity point. */
  drawdown: { t: string; drawdownMicros: number }[];
  /** One point per (strategy, league): x = mean price paid (probability), y = win rate, n = won + lost. */
  impliedVsActual: {
    strategyId: string;
    strategyName: string;
    leagueId: string;
    x: number;
    y: number;
    n: number;
  }[];
  /** Fill prices in 1¢ bins from `maxPrice − 15¢` to `maxPrice`; `below` / `above` count the rest. */
  priceHistogram: {
    minBp: number;
    maxBp: number;
    below: number;
    above: number;
    bins: { bp: number; count: number }[];
  };
  /** Trades with a fill per clock minute at entry, by outcome (`open` = filled, not yet settled). */
  tradesPerMinute: { minute: number; won: number; lost: number; void: number; open: number }[];
  /** Final skips (skipped trades) and per-attempt skips, per reason. */
  skipReasons: {
    final: { reason: string; count: number }[];
    perAttempt: { reason: string; count: number }[];
  };
}

export interface ModeStats {
  tiles: ModeTiles;
  series: ModeSeries;
}

export type StatsResponse = Partial<Record<StatsMode, ModeStats>>;

export interface StatsQuery {
  mode: 'live' | 'dry_run' | 'both';
  kalshiEnv: string;
  sport?: 'soccer' | 'hockey' | undefined;
  leagueIds?: readonly string[];
  strategyIds?: readonly string[];
  sinceIso?: string | undefined;
}

/** The default upper end of the price histogram when no filtered strategy has a `maxPrice` ($0.97). */
export const DEFAULT_MAX_PRICE_BP = 9700;
/** The histogram spans 15¢ below `maxPrice` (§8). */
export const HISTOGRAM_SPAN_BP = 1500;
export const BIN_BP = 100;

/** `a / b` rounded half away from zero to an integer (0 when `b` is 0); integers only. */
export function roundDiv(a: number, b: number): number {
  if (b === 0) return 0;
  const sign = a < 0 !== b < 0 ? -1 : 1;
  const x = Math.abs(a);
  const y = Math.abs(b);
  return sign * Math.floor((2 * x + y) / (2 * y));
}

/** `a / b` as a fraction rounded to 4 decimals (0 when `b` is 0). */
export function ratio(a: number, b: number): number {
  return b === 0 ? 0 : roundDiv(a * 10_000, b) / 10_000;
}

/** The histogram's upper end: the highest `maxPrice` among the strategies the filter covers. */
function histogramMaxBp(repos: Repositories, q: StatsQuery): number {
  let max = 0;
  for (const s of loadStrategies(repos, true)) {
    if (q.strategyIds && q.strategyIds.length > 0 && !q.strategyIds.includes(s.id)) continue;
    if (q.sport && s.sport !== q.sport) continue;
    const maxPrice = s.version?.execution.maxPrice;
    if (typeof maxPrice === 'number') max = Math.max(max, Math.round(maxPrice * 10_000));
  }
  return max > 0 ? max - (max % BIN_BP) : DEFAULT_MAX_PRICE_BP;
}

function modeStats(repos: Repositories, f: StatsFilter, maxBp: number): ModeStats {
  const db = repos.stats;
  const names = db.strategyNames();
  const nameOf = (id: string) => names.get(id) ?? id;

  // Equity curve (total and per strategy) and its drawdown.
  const total: EquityPoint[] = [];
  const perStrategy = new Map<string, EquityPoint[]>();
  const drawdown: ModeSeries['drawdown'] = [];
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of db.equity(f)) {
    total.push({ t: r.settled_at, cumMicros: r.total_micros });
    const points = perStrategy.get(r.strategy_id) ?? [];
    points.push({ t: r.settled_at, cumMicros: r.strategy_micros });
    perStrategy.set(r.strategy_id, points);
    peak = Math.max(peak, r.total_micros);
    const dd = peak - r.total_micros;
    maxDrawdown = Math.max(maxDrawdown, dd);
    drawdown.push({ t: r.settled_at, drawdownMicros: dd });
  }

  const dailyPnl: ModeSeries['dailyPnl'] = [];
  for (const r of db.daily(f)) {
    let day = dailyPnl[dailyPnl.length - 1];
    if (!day || day.day !== r.day) {
      day = { day: r.day, pnlMicros: 0, byStrategy: [] };
      dailyPnl.push(day);
    }
    day.pnlMicros += r.pnl_micros;
    day.byStrategy.push({ strategyId: r.strategy_id, pnlMicros: r.pnl_micros });
  }

  const minBp = maxBp - HISTOGRAM_SPAN_BP;
  const counts = new Map<number, number>();
  let below = 0;
  let above = 0;
  for (const r of db.priceBins(f)) {
    if (r.key < minBp) below += r.n;
    else if (r.key > maxBp) above += r.n;
    else counts.set(r.key, r.n);
  }
  const bins: { bp: number; count: number }[] = [];
  if (counts.size > 0 || below > 0 || above > 0) {
    for (let bp = minBp; bp <= maxBp; bp += BIN_BP) bins.push({ bp, count: counts.get(bp) ?? 0 });
  }

  const minutes = new Map<number, ModeSeries['tradesPerMinute'][number]>();
  for (const r of db.minutes(f)) {
    const m = minutes.get(r.minute) ?? { minute: r.minute, won: 0, lost: 0, void: 0, open: 0 };
    if (r.status === 'settled_won') m.won += r.n;
    else if (r.status === 'settled_lost') m.lost += r.n;
    else if (r.status === 'settled_void') m.void += r.n;
    else m.open += r.n;
    minutes.set(r.minute, m);
  }

  const agg = db.tiles(f);
  const decided = agg.won + agg.lost;
  const tiles: ModeTiles = {
    trades: agg.settled,
    won: agg.won,
    lost: agg.lost,
    void: agg.void,
    winRate: ratio(agg.won, decided),
    netPnlMicros: agg.pnlMicros,
    investedMicros: agg.investedMicros,
    roi: ratio(agg.pnlMicros, agg.investedMicros),
    maxDrawdownMicros: maxDrawdown,
    filled: agg.filled,
    avgPriceBp: roundDiv(agg.priceSumBp, agg.filled),
    avgFeeMicros: roundDiv(agg.feeSumMicros, agg.filled),
    impliedVsActual: {
      impliedBp: roundDiv(agg.decidedPriceSumBp, decided),
      actualWinRate: ratio(agg.won, decided),
      n: decided,
    },
    ...(f.mode === 'dry_run'
      ? {
          forcedDryRun: {
            forced: agg.configuredLive,
            total: agg.total,
            share: ratio(agg.configuredLive, agg.total),
          },
        }
      : {}),
  };

  const series: ModeSeries = {
    equity: {
      total,
      byStrategy: [...perStrategy]
        .map(([strategyId, points]) => ({ strategyId, strategyName: nameOf(strategyId), points }))
        .sort((a, b) => (a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : 0)),
    },
    ...(f.mode === 'dry_run'
      ? { bankroll: db.bankroll(f.sinceIso).map((r) => ({ t: r.at, micros: r.bankroll_micros })) }
      : {
          balance: db.balance(f.kalshiEnv, f.sinceIso).map((r) => ({
            t: r.at,
            cashMicros: r.cash_micros,
            portfolioMicros: r.portfolio_value_micros,
          })),
        }),
    dailyPnl,
    drawdown,
    impliedVsActual: db.implied(f).map((r) => ({
      strategyId: r.strategy_id,
      strategyName: nameOf(r.strategy_id),
      leagueId: r.league_id,
      x: roundDiv(r.price_sum_bp, r.n) / 10_000,
      y: ratio(r.won, r.n),
      n: r.n,
    })),
    priceHistogram: { minBp, maxBp, below, above, bins },
    tradesPerMinute: [...minutes.values()],
    skipReasons: {
      final: db.finalSkips(f).map((r) => ({ reason: r.key, count: r.n })),
      perAttempt: db.attemptSkips(f).map((r) => ({ reason: r.key, count: r.n })),
    },
  };
  return { tiles, series };
}

/** Tiles and series for every mode the query selects, computed separately per mode. */
export function computeStats(repos: Repositories, q: StatsQuery): StatsResponse {
  const modes: StatsMode[] = q.mode === 'both' ? ['live', 'dry_run'] : [q.mode];
  const maxBp = histogramMaxBp(repos, q);
  const out: StatsResponse = {};
  for (const mode of modes) {
    out[mode] = modeStats(
      repos,
      {
        mode,
        kalshiEnv: q.kalshiEnv,
        sport: q.sport,
        leagueIds: q.leagueIds ?? [],
        strategyIds: q.strategyIds ?? [],
        sinceIso: q.sinceIso,
      },
      maxBp,
    );
  }
  return out;
}
