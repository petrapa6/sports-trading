import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { PriceRange } from '../core/pricing.js';
import type { VersionPayload } from '../core/strategy.js';
import type { GoalEvent } from '../core/tracker.js';
import type { Sport } from '../feeds/gameState.js';
import { wallMinuteAt } from './clock.js';
import { SOURCE_RANK, type PriceModel } from './priceModel.js';
import type { BacktestSummary, PriceMode, SimGame, SimInput, SimMarket, SimResult } from './simulator.js';

/**
 * Backtest data access (SPEC.md §7 `hist_games`, `hist_prices`, `backtests`, `backtest_trades`; §9): loads
 * the simulator input from the database and stores a result. Plain prepared statements on the raw
 * `better-sqlite3` handle, so the worker thread can read thousands of games and candles quickly on its own
 * connection.
 */

/** A backtest request after validation and strategy resolution (stored as `backtests.params`). */
export interface ResolvedRequest {
  /** Display name (saved runs); `null` until saved. */
  name: string | null;
  /** Kept in the list of saved runs (unsaved runs are pruned). */
  saved: boolean;
  /** "Test against last 30 days" from the Strategies page. */
  quick: boolean;
  sport: Sport;
  /** Leagues whose `hist_games` are replayed. */
  leagueIds: string[];
  /** Seasons replayed (`hist_games.season`); empty = every season. */
  seasons: string[];
  /** Games played at or after this time (quick test), else `null`. */
  sinceIso: string | null;
  /** The strategy version replayed, `null` for ad-hoc parameters. */
  strategy: { id: string; name: string; version: number } | null;
  /** The replayed definition: exactly what "Promote to strategy" creates as version 1. */
  definition: { name: string } & VersionPayload;
  priceMode: PriceMode;
  initialBankrollMicros: number;
}

const GoalEventSchema = z.object({
  side: z.enum(['home', 'away']),
  period: z.number().int().optional(),
  minute: z.number().int().min(0),
  second: z.number().int().optional(),
});

interface HistGameRow {
  id: string;
  played_at: string | null;
  final_home: number | null;
  final_away: number | null;
  goal_events: string;
  source: string;
  kalshi_event_ticker: string | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v;
};

function parseGoals(text: string): GoalEvent[] | null {
  try {
    const r = z.array(GoalEventSchema).safeParse(JSON.parse(text));
    if (!r.success) return null;
    return r.data.map((g) => ({
      side: g.side,
      period: g.period ?? 0,
      minute: g.minute,
      second: g.second ?? 0,
    }));
  } catch {
    return null;
  }
}

function parseRanges(text: string | null): PriceRange[] | undefined {
  if (!text) return undefined;
  try {
    const r = z
      .array(z.object({ start: z.string(), end: z.string(), step: z.string() }))
      .safeParse(JSON.parse(text));
    return r.success && r.data.length > 0 ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function settingValue(sqlite: Database.Database, key: string): unknown {
  const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

/** `settings.price_model` as T11's builder stores it, or `null` (none yet, or an unknown shape → seed table). */
function storedPriceModel(value: unknown): PriceModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<PriceModel>;
  return v.version === 1 && Array.isArray(v.cells) ? (value as PriceModel) : null;
}

/** `hist_games` rows of the request, in date order (`played_at`, then id). */
function selectAllGames(sqlite: Database.Database, req: ResolvedRequest): HistGameRow[] {
  const where: string[] = [`league_id IN (${req.leagueIds.map(() => '?').join(',')})`];
  const args: unknown[] = [...req.leagueIds];
  if (req.seasons.length > 0) {
    where.push(`season IN (${req.seasons.map(() => '?').join(',')})`);
    args.push(...req.seasons);
  }
  if (req.sinceIso) {
    where.push('played_at >= ?');
    args.push(req.sinceIso);
  }
  return sqlite
    .prepare(
      `SELECT id, played_at, final_home, final_away, goal_events, source, kalshi_event_ticker FROM hist_games
       WHERE ${where.join(' AND ')} AND played_at IS NOT NULL ORDER BY played_at, id`,
    )
    .all(...args) as HistGameRow[];
}

/**
 * The request's games, one timeline per Kalshi event: when several sources describe the same event (the app's
 * own `live` archive, Kalshi play-by-play, the NHL API, a CSV), the one the price-model builder trusts most wins.
 */
function selectGames(sqlite: Database.Database, req: ResolvedRequest): HistGameRow[] {
  const rows = selectAllGames(sqlite, req);
  const best = new Map<string, HistGameRow>();
  const rank = (r: HistGameRow) => SOURCE_RANK[r.source] ?? 9;
  for (const r of rows) {
    if (!r.kalshi_event_ticker) continue;
    const current = best.get(r.kalshi_event_ticker);
    if (!current || rank(r) < rank(current) || (rank(r) === rank(current) && r.id < current.id)) {
      best.set(r.kalshi_event_ticker, r);
    }
  }
  return rows.filter((r) => !r.kalshi_event_ticker || best.get(r.kalshi_event_ticker) === r);
}

/** Number of games a request replays (for the progress total before the worker starts). */
export function countGames(sqlite: Database.Database, req: ResolvedRequest): number {
  return selectGames(sqlite, req).length;
}

/**
 * The simulator input: games with goal timelines (rows whose `goal_events` do not parse are left out), their
 * leader markets and — in exact mode — the YES ask close of every candle of those markets.
 */
export function loadSimInput(sqlite: Database.Database, req: ResolvedRequest): SimInput {
  const marketsOf = sqlite.prepare('SELECT ticker, outcome, price_ranges FROM markets WHERE game_id = ?');
  const gameRow = sqlite.prepare('SELECT scheduled_at FROM games WHERE id = ?');
  const candlesOf = sqlite.prepare(
    'SELECT minute_ts, ask_close_bp FROM hist_prices WHERE market_ticker = ? AND ask_close_bp IS NOT NULL',
  );
  const candles = new Map<string, Map<number, number>>();
  const games: SimGame[] = [];
  for (const row of selectGames(sqlite, req)) {
    const goals = parseGoals(row.goal_events);
    const playedMs = ms(row.played_at);
    if (!goals || playedMs === null || row.played_at === null) continue;
    const markets: SimGame['markets'] = {};
    if (row.kalshi_event_ticker) {
      // Candles are placed on the match clock from the event's scheduled start, like the price-model builder.
      const event = gameRow.get(row.kalshi_event_ticker) as { scheduled_at: string | null } | undefined;
      const startMs = ms(event?.scheduled_at) ?? playedMs;
      if (req.priceMode === 'exact') {
        for (const m of marketsOf.all(row.kalshi_event_ticker) as {
          ticker: string;
          outcome: string;
          price_ranges: string | null;
        }[]) {
          if (m.outcome !== 'home' && m.outcome !== 'away') continue;
          const ranges = parseRanges(m.price_ranges);
          const market: SimMarket = { ticker: m.ticker, ...(ranges ? { priceRanges: ranges } : {}) };
          markets[m.outcome] = market;
          if (!candles.has(m.ticker)) {
            const series = new Map<number, number>();
            for (const c of candlesOf.all(m.ticker) as { minute_ts: string; ask_close_bp: number }[]) {
              const at = ms(c.minute_ts);
              if (at !== null) series.set(wallMinuteAt(startMs, at), c.ask_close_bp);
            }
            candles.set(m.ticker, series);
          }
        }
      }
    }
    games.push({
      id: row.id,
      playedAt: row.played_at,
      finalHome: row.final_home ?? goals.filter((g) => g.side === 'home').length,
      finalAway: row.final_away ?? goals.filter((g) => g.side === 'away').length,
      goals,
      markets,
    });
  }
  const precision = settingValue(sqlite, 'fee_balance_precision_micros');
  return {
    sport: req.sport,
    params: { rule: req.definition.rule, sizing: req.definition.sizing, execution: req.definition.execution },
    priceMode: req.priceMode,
    initialBankrollMicros: req.initialBankrollMicros,
    precisionMicros:
      typeof precision === 'number' && Number.isSafeInteger(precision) && precision > 0 ? precision : 100,
    priceModel: storedPriceModel(settingValue(sqlite, 'price_model')),
    candles,
    games,
  };
}

/** A stored result (`backtests.result_summary`): the summary, or the error of a failed run. */
export type StoredSummary = BacktestSummary | { error: string };

/** Writes the trades and the summary of a finished run in one transaction (replacing earlier rows). */
export function saveResult(sqlite: Database.Database, backtestId: string, result: SimResult): void {
  const insert = sqlite.prepare(
    `INSERT INTO backtest_trades (backtest_id, hist_game_id, minute, side, price_source, price_bp, contracts_cc,
       stake_micros, fee_micros, settlement_value_bp, pnl_micros, bankroll_after_micros, skip_reason)
     VALUES (@backtest_id, @hist_game_id, @minute, @side, @price_source, @price_bp, @contracts_cc,
       @stake_micros, @fee_micros, @settlement_value_bp, @pnl_micros, @bankroll_after_micros, @skip_reason)`,
  );
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM backtest_trades WHERE backtest_id = ?').run(backtestId);
    for (const t of result.trades) insert.run({ backtest_id: backtestId, ...t });
    sqlite
      .prepare('UPDATE backtests SET result_summary = ? WHERE id = ?')
      .run(JSON.stringify(result.summary), backtestId);
  })();
}

/** Marks a run as failed. */
export function saveFailure(sqlite: Database.Database, backtestId: string, message: string): void {
  sqlite
    .prepare('UPDATE backtests SET result_summary = ? WHERE id = ?')
    .run(JSON.stringify({ error: message.slice(0, 300) }), backtestId);
}
