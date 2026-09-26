import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Repositories } from '../db/repositories.js';
import { games as gamesTable, hist_games, hist_prices, type Game } from '../db/schema.js';
import type { KalshiClient } from '../feeds/kalshi/client.js';
import type { Candle } from '../feeds/kalshi/schemas.js';
import { NetworkPaused } from '../feeds/network.js';
import type { JobContext } from './jobs.js';

/**
 * Candle collector (SPEC.md §3 / §9, T11): for every finished (or backfilled) game with markets, the
 * 1-minute candles of each market → `hist_prices` (ask OHLC, bid close, trade close — `NULL` for a
 * minute without trades — and volume).
 *
 * - Endpoint: a market that closed before the historical cutoff (`GET /historical/cutoff` →
 *   `market_settled_ts`) is read from `/historical/markets/{ticker}/candlesticks`, every other one from
 *   `/series/{series}/markets/{ticker}/candlesticks`.
 * - Window: from 60 minutes before the scheduled start to the markets' close time (or 6 h after the
 *   start when no close time is known).
 * - `minute_ts` is the candle's `end_period_ts` (ISO): the ask close is the ask at that instant. Kalshi
 *   omits minutes in which nothing changed, so the series can have gaps.
 * - Idempotent: a market that already has candles is skipped (`force` fetches it again, and identical
 *   rows are rewritten with the same values).
 * - Sets `hist_games.kalshi_event_ticker` on the game's goal timeline when it has none yet: an NHL or CSV
 *   row of the same league played within 12 h whose home / away match the Kalshi teams (tricode,
 *   aliases or name). Live and play-by-play rows carry the ticker from the start.
 */

export interface CandleOptions {
  gameIds?: readonly string[];
  force?: boolean;
}

export interface CandleResult {
  games: number;
  markets: number;
  historicalMarkets: number;
  skippedExisting: number;
  candles: number;
  linked: number;
  failed: number;
}

export interface CandleDeps {
  client: Pick<KalshiClient, 'getHistoricalCutoff' | 'getCandlesticks' | 'getHistoricalCandlesticks'>;
  repos: Repositories;
  log: Logger;
  transaction?: (fn: () => void) => void;
  ctx?: Pick<JobContext, 'request' | 'progress' | 'checkpoint'>;
}

const DIRECT: Pick<JobContext, 'request' | 'progress' | 'checkpoint'> = {
  request: (fn) => fn(new AbortController().signal),
  progress: () => undefined,
  checkpoint: async () => undefined,
};

const PREGAME_MS = 60 * 60 * 1000;
const DEFAULT_LENGTH_MS = 6 * 60 * 60 * 1000;
const LINK_WINDOW_MS = 12 * 60 * 60 * 1000;

const isJobStop = (err: unknown): boolean =>
  err instanceof NetworkPaused ||
  (err instanceof Error && (err.name === 'JobCancelled' || err.name === 'AbortError'));

export function candleRow(ticker: string, c: Candle) {
  return {
    market_ticker: ticker,
    minute_ts: new Date(c.end_period_ms).toISOString(),
    ask_open_bp: c.ask_open_bp,
    ask_high_bp: c.ask_high_bp,
    ask_low_bp: c.ask_low_bp,
    ask_close_bp: c.ask_close_bp,
    bid_close_bp: c.bid_close_bp,
    trade_close_bp: c.trade_close_bp,
    volume_cc: c.volume_cc,
  };
}

export async function collectCandles(deps: CandleDeps, options: CandleOptions = {}): Promise<CandleResult> {
  const { client, repos, log } = deps;
  const ctx = deps.ctx ?? DIRECT;
  const tx = deps.transaction ?? ((fn: () => void) => fn());
  const result: CandleResult = {
    games: 0,
    markets: 0,
    historicalMarkets: 0,
    skippedExisting: 0,
    candles: 0,
    linked: 0,
    failed: 0,
  };
  const leagues = new Map(repos.leagues.list().map((l) => [l.id, l]));
  const games = repos.games
    .list(eq(gamesTable.phase, 'finished'))
    .filter((g) => options.gameIds === undefined || options.gameIds.includes(g.id))
    .filter((g) => repos.markets.listByGame(g.id).length > 0);
  if (games.length === 0) return result;

  const cutoff = await ctx.request(() => client.getHistoricalCutoff());
  const cutoffMs = cutoff.market_settled_ms;

  let n = 0;
  for (const game of games) {
    n++;
    ctx.progress(n, games.length, `Candles ${game.id}`);
    const series = leagues.get(game.league_id ?? '')?.kalshi_series;
    if (!series) continue;
    result.games++;
    const markets = repos.markets.listByGame(game.id);
    const start = Date.parse(game.scheduled_at) - PREGAME_MS;
    const closes = markets
      .map((m) => (m.close_time ? Date.parse(m.close_time) : Number.NaN))
      .filter((t) => !Number.isNaN(t));
    const end = closes.length > 0 ? Math.max(...closes) : Date.parse(game.scheduled_at) + DEFAULT_LENGTH_MS;
    for (const market of markets) {
      if (!options.force && repos.histPrices.count(eq(hist_prices.market_ticker, market.ticker)) > 0) {
        result.skippedExisting++;
        continue;
      }
      const closed = market.close_time ? Date.parse(market.close_time) : Number.NaN;
      const historical = cutoffMs !== null && !Number.isNaN(closed) && closed < cutoffMs;
      let candles: Candle[];
      try {
        candles = await ctx.request(() =>
          historical
            ? client.getHistoricalCandlesticks(market.ticker, { startMs: start, endMs: end })
            : client.getCandlesticks(series, market.ticker, { startMs: start, endMs: end }),
        );
      } catch (err) {
        if (isJobStop(err)) throw err;
        result.failed++;
        log.warn(
          { market: market.ticker, err: { message: (err as Error).message } },
          'Candles request failed',
        );
        continue;
      }
      result.markets++;
      if (historical) result.historicalMarkets++;
      tx(() => {
        for (const c of candles) {
          const row = candleRow(market.ticker, c);
          const key = { market_ticker: row.market_ticker, minute_ts: row.minute_ts };
          if (repos.histPrices.get(key)) repos.histPrices.update(key, row);
          else repos.histPrices.insert(row);
        }
      });
      result.candles += candles.length;
    }
    if (linkHistGame(repos, game)) result.linked++;
  }
  log.info({ ...result }, 'Candle collection finished');
  return result;
}

/** Codes a Kalshi team is known by (abbreviation, aliases, name), upper case. */
function teamCodes(repos: Repositories, teamId: string | null): Set<string> {
  if (!teamId) return new Set();
  const team = repos.teams.get({ id: teamId });
  if (!team) return new Set();
  let aliases: unknown[];
  try {
    aliases = team.aliases ? (JSON.parse(team.aliases) as unknown[]) : [];
  } catch {
    aliases = [];
  }
  return new Set(
    [team.abbreviation, team.name, ...aliases]
      .filter((s): s is string => typeof s === 'string' && s !== '')
      .map((s) => s.toUpperCase()),
  );
}

/** Sets `kalshi_event_ticker` on the goal timeline of `game`; returns whether a row was linked. */
export function linkHistGame(repos: Repositories, game: Game): boolean {
  if (repos.histGames.count(eq(hist_games.kalshi_event_ticker, game.id)) > 0) return false;
  const at = Date.parse(game.scheduled_at);
  const home = teamCodes(repos, game.home_team_id);
  const away = teamCodes(repos, game.away_team_id);
  if (home.size === 0 || away.size === 0 || game.league_id === null) return false;
  const candidates = repos.histGames.list(
    and(
      eq(hist_games.league_id, game.league_id),
      isNull(hist_games.kalshi_event_ticker),
      gte(hist_games.played_at, new Date(at - LINK_WINDOW_MS).toISOString()),
      lte(hist_games.played_at, new Date(at + LINK_WINDOW_MS).toISOString()),
    ),
  );
  const match = candidates.find(
    (h) => home.has((h.home ?? '').toUpperCase()) && away.has((h.away ?? '').toUpperCase()),
  );
  if (!match) return false;
  repos.histGames.update({ id: match.id }, { kalshi_event_ticker: game.id });
  return true;
}
