import { inArray, isNotNull } from 'drizzle-orm';
import type { Repositories } from '../db/repositories.js';
import { hist_games, hist_prices, type HistGame } from '../db/schema.js';
import type { GoalEvent } from '../core/tracker.js';

/**
 * Price model (SPEC.md §9 Price providers, T11): the **median ask close** by (sport, lead bucket 1 / 2 /
 * 3+, remaining-minute bucket of 5), built from `hist_prices` joined to `hist_games` goal timelines
 * (never to `game_snapshots`, which are pruned). Stored in `settings.price_model`. Cells with fewer than
 * `MIN_SAMPLES` observations report the conservative seed value (`seeded: true`) with their real
 * `sampleSize`.
 *
 * Joining a candle to the game state needs the match clock at the candle's wall time; the goal
 * timelines carry match minutes only, so the builder uses a fixed clock model from the scheduled start
 * (`games.scheduled_at`, the milestone start):
 *
 * - soccer: wall minutes 0–46 → minute `min(e, 45)`; 47–61 half-time (skipped); from 62 → `45 + (e − 62)`,
 *   capped at 90; after 97 skipped. Goals with `minute ≤ m` have happened.
 * - hockey: three periods of 36 wall minutes separated by 18-minute intermissions (skipped); inside
 *   period p (1–3) at wall minute w → minute `(p − 1) × 20 + floor(w × 20 / 36)`. Goals with
 *   `minute < m` have happened. Overtime is not modelled.
 *
 * `e` is whole wall minutes from the scheduled start to the candle's `minute_ts` (its end). One
 * observation = one candle of the **leader's** market (lead ≥ 1) with an ask close. Remaining minutes
 * = 90 (soccer) / 60 (hockey) − m; bucket `floor(remaining / 5)`. One timeline per Kalshi event: when
 * several sources describe the same event, `live` wins over `kalshi_pbp`, then `nhl`, then `csv`.
 */

export const MIN_SAMPLES = 20;
export const BUCKET_MINUTES = 5;
export type ModelSport = 'soccer' | 'hockey';
export const MODEL_SPORTS: readonly ModelSport[] = ['soccer', 'hockey'];
export const REGULATION_MINUTES: Record<ModelSport, number> = { soccer: 90, hockey: 60 };
export const LEADS = [1, 2, 3] as const;
export type LeadBucket = (typeof LEADS)[number];

export interface PriceModelCell {
  sport: ModelSport;
  /** 1, 2 or 3 (= 3 or more). */
  lead: LeadBucket;
  /** Remaining regulation minutes `[remainingFrom, remainingTo)`. */
  remainingFrom: number;
  remainingTo: number;
  /** Median ask close, or the seed value when `seeded`. */
  askBp: number;
  /** Observations behind the cell (also when seeded). */
  sampleSize: number;
  seeded: boolean;
}

export interface PriceModel {
  version: 1;
  builtAt: string;
  minSamples: number;
  bucketMinutes: number;
  sports: Record<ModelSport, { games: number; observations: number; modelledCells: number }>;
  cells: PriceModelCell[];
}

/**
 * The conservative seed table (SPEC.md §9): the chance the leader does **not** win, taken as linear in
 * the remaining minutes `r` (the bucket's lower bound) per lead, priced high on purpose (a modelled
 * backtest should not flatter a strategy). Anchors: soccer lead 2 / 10 min → $0.96, lead 1 / 10 min →
 * $0.85; hockey lead 2 / 5 min → $0.97. Clamped to $0.50 – $0.99, whole cents.
 */
const SEED_SLOPE_BP: Record<ModelSport, Record<LeadBucket, number>> = {
  soccer: { 1: 150, 2: 40, 3: 15 },
  hockey: { 1: 200, 2: 60, 3: 20 },
};

export function seedAskBp(sport: ModelSport, lead: LeadBucket, remainingFrom: number): number {
  const notWinBp = SEED_SLOPE_BP[sport][lead] * remainingFrom;
  return Math.max(5000, Math.min(9900, 10_000 - notWinBp));
}

export function bucketCount(sport: ModelSport): number {
  return Math.floor(REGULATION_MINUTES[sport] / BUCKET_MINUTES) + 1;
}

/** The full seed table (every cell seeded, sample size 0). */
export function seedModel(builtAt: string): PriceModel {
  return buildFromObservations(new Map(), builtAt, {
    soccer: { games: 0, observations: 0 },
    hockey: { games: 0, observations: 0 },
  });
}

/** Integer median; an even count takes the mean of the two middle values, rounded half up. */
export function medianBp(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  const sum = (sorted[mid - 1] as number) + (sorted[mid] as number);
  return sum % 2 === 0 ? sum / 2 : (sum + 1) / 2;
}

const cellKey = (sport: ModelSport, lead: LeadBucket, bucket: number) => `${sport}|${lead}|${bucket}`;

function buildFromObservations(
  obs: Map<string, number[]>,
  builtAt: string,
  totals: Record<ModelSport, { games: number; observations: number }>,
): PriceModel {
  const cells: PriceModelCell[] = [];
  const sports = {} as PriceModel['sports'];
  for (const sport of MODEL_SPORTS) {
    let modelled = 0;
    for (const lead of LEADS) {
      for (let b = 0; b < bucketCount(sport); b++) {
        const values = obs.get(cellKey(sport, lead, b)) ?? [];
        const seeded = values.length < MIN_SAMPLES;
        if (!seeded) modelled++;
        cells.push({
          sport,
          lead,
          remainingFrom: b * BUCKET_MINUTES,
          remainingTo: (b + 1) * BUCKET_MINUTES,
          askBp: seeded ? seedAskBp(sport, lead, b * BUCKET_MINUTES) : medianBp(values),
          sampleSize: values.length,
          seeded,
        });
      }
    }
    sports[sport] = { ...totals[sport], modelledCells: modelled };
  }
  return { version: 1, builtAt, minSamples: MIN_SAMPLES, bucketMinutes: BUCKET_MINUTES, sports, cells };
}

/** Match minute at `e` wall minutes after the scheduled start, or `null` outside play (see module comment). */
export function matchMinute(sport: ModelSport, e: number): number | null {
  if (e < 0) return null;
  if (sport === 'soccer') {
    if (e < 47) return Math.min(e, 45);
    if (e < 62) return null;
    const m = 45 + (e - 62);
    return m > 97 ? null : Math.min(m, 90);
  }
  const period = Math.floor(e / 54);
  if (period > 2) return null;
  const w = e - period * 54;
  if (w >= 36) return null;
  return period * 20 + Math.floor((w * 20) / 36);
}

/** Which timeline describes a Kalshi event when several sources do (lower wins); also used by the backtest (T12). */
export const SOURCE_RANK: Record<string, number> = { live: 0, kalshi_pbp: 1, nhl: 2, csv: 3 };

/** Builds the model from the database (reads `hist_games`, `games`, `markets`, `hist_prices`). */
export function buildPriceModel(repos: Repositories, builtAt: string): PriceModel {
  const byEvent = new Map<string, HistGame>();
  for (const h of repos.histGames.list(isNotNull(hist_games.kalshi_event_ticker))) {
    const ticker = h.kalshi_event_ticker as string;
    const current = byEvent.get(ticker);
    const rank = (x: HistGame) => SOURCE_RANK[x.source] ?? 9;
    if (!current || rank(h) < rank(current)) byEvent.set(ticker, h);
  }
  const sportOf = new Map(repos.leagues.list().map((l) => [l.id, l.sport]));
  const obs = new Map<string, number[]>();
  const totals: Record<ModelSport, { games: number; observations: number }> = {
    soccer: { games: 0, observations: 0 },
    hockey: { games: 0, observations: 0 },
  };

  for (const [ticker, hist] of byEvent) {
    const game = repos.games.get({ id: ticker });
    if (!game) continue;
    const sport = sportOf.get(game.league_id ?? hist.league_id ?? '');
    if (sport !== 'soccer' && sport !== 'hockey') continue;
    const start = Date.parse(game.scheduled_at);
    if (Number.isNaN(start)) continue;
    let goals: GoalEvent[];
    try {
      goals = JSON.parse(hist.goal_events) as GoalEvent[];
    } catch {
      continue;
    }
    const markets = repos.markets
      .listByGame(game.id)
      .filter((m) => m.outcome === 'home' || m.outcome === 'away');
    if (markets.length === 0) continue;
    const prices = repos.histPrices.list(
      inArray(
        hist_prices.market_ticker,
        markets.map((m) => m.ticker),
      ),
    );
    const outcomeOf = new Map(markets.map((m) => [m.ticker, m.outcome]));
    let used = false;
    for (const p of prices) {
      if (p.ask_close_bp === null || p.minute_ts === null || p.market_ticker === null) continue;
      const e = Math.floor((Date.parse(p.minute_ts) - start) / 60_000);
      const m = matchMinute(sport, e);
      if (m === null) continue;
      let home = 0;
      let away = 0;
      for (const g of goals) {
        const happened = sport === 'soccer' ? g.minute <= m : g.minute < m;
        if (!happened) continue;
        if (g.side === 'home') home++;
        else away++;
      }
      const diff = home - away;
      if (diff === 0) continue;
      const leader = diff > 0 ? 'home' : 'away';
      if (outcomeOf.get(p.market_ticker) !== leader) continue;
      const lead = Math.min(Math.abs(diff), 3) as LeadBucket;
      const remaining = REGULATION_MINUTES[sport] - m;
      const bucket = Math.floor(remaining / BUCKET_MINUTES);
      const key = cellKey(sport, lead, bucket);
      const list = obs.get(key) ?? [];
      list.push(p.ask_close_bp);
      obs.set(key, list);
      totals[sport].observations++;
      used = true;
    }
    if (used) totals[sport].games++;
  }
  return buildFromObservations(obs, builtAt, totals);
}

/**
 * `priceModel(sport, lead, minutesRemaining)` for the modelled backtest (T12): the cell's ask and
 * sample size. `lead` ≥ 3 uses the 3+ bucket; remaining minutes are clamped to the regulation length.
 */
export function priceModelLookup(
  model: PriceModel,
  sport: ModelSport,
  lead: number,
  minutesRemaining: number,
): PriceModelCell | undefined {
  const l = Math.max(1, Math.min(3, Math.trunc(lead))) as LeadBucket;
  const r = Math.max(0, Math.min(REGULATION_MINUTES[sport], Math.trunc(minutesRemaining)));
  return model.cells.find(
    (c) => c.sport === sport && c.lead === l && r >= c.remainingFrom && r < c.remainingTo,
  );
}
