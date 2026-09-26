/**
 * `GET /api/stats` response types (mirrors `src/core/stats.ts`, T10). The response is keyed by mode and a
 * mode filtered out is absent; nothing in it is a sum over both modes.
 */
import type { Mode } from './components/ModeBadge';

export interface EquityPoint {
  t: string;
  cumMicros: number;
}

export interface ModeTiles {
  trades: number;
  won: number;
  lost: number;
  void: number;
  winRate: number;
  netPnlMicros: number;
  investedMicros: number;
  roi: number;
  maxDrawdownMicros: number;
  filled: number;
  avgPriceBp: number;
  avgFeeMicros: number;
  impliedVsActual: { impliedBp: number; actualWinRate: number; n: number };
  forcedDryRun?: { forced: number; total: number; share: number };
}

export interface ModeSeries {
  equity: {
    total: EquityPoint[];
    byStrategy: { strategyId: string; strategyName: string; points: EquityPoint[] }[];
  };
  bankroll?: { t: string; micros: number }[];
  balance?: { t: string; cashMicros: number | null; portfolioMicros: number | null }[];
  dailyPnl: { day: string; pnlMicros: number; byStrategy: { strategyId: string; pnlMicros: number }[] }[];
  drawdown: { t: string; drawdownMicros: number }[];
  impliedVsActual: {
    strategyId: string;
    strategyName: string;
    leagueId: string;
    x: number;
    y: number;
    n: number;
  }[];
  priceHistogram: {
    minBp: number;
    maxBp: number;
    below: number;
    above: number;
    bins: { bp: number; count: number }[];
  };
  tradesPerMinute: { minute: number; won: number; lost: number; void: number; open: number }[];
  skipReasons: {
    final: { reason: string; count: number }[];
    perAttempt: { reason: string; count: number }[];
  };
}

export interface ModeData {
  tiles: ModeTiles;
  series: ModeSeries;
}

export type StatsResponse = Partial<Record<Mode, ModeData>>;

/** The modes present in a response, live first. */
export const modesOf = (s: StatsResponse): Mode[] => (['live', 'dry_run'] as const).filter((m) => s[m]);
