import { sql, type SQL } from 'drizzle-orm';
import type { Orm } from './connection.js';

/**
 * SQL aggregation behind `GET /api/stats` (SPEC.md §6 Metrics, §8 Chart inventory). Every query runs for
 * **one** mode at a time (`trades.effective_mode`, or the attempt's own `effective_mode` for per-attempt
 * skips), so no row ever mixes live and dry-run trades. Only aggregates leave this class, never trade rows.
 */

export type StatsMode = 'live' | 'dry_run';

export interface StatsFilter {
  mode: StatsMode;
  kalshiEnv: string;
  sport?: 'soccer' | 'hockey' | undefined;
  leagueIds?: readonly string[];
  strategyIds?: readonly string[];
  /** Trades triggered at or after this time; snapshots taken at or after it. */
  sinceIso?: string | undefined;
}

export interface TileAggregate {
  settled: number;
  won: number;
  lost: number;
  void: number;
  pnlMicros: number;
  investedMicros: number;
  filled: number;
  priceSumBp: number;
  feeSumMicros: number;
  decidedPriceSumBp: number;
  configuredLive: number;
  total: number;
}

export interface EquityRow {
  settled_at: string;
  strategy_id: string;
  total_micros: number;
  strategy_micros: number;
}

export interface DailyRow {
  day: string;
  strategy_id: string;
  pnl_micros: number;
}

export interface ImpliedRow {
  strategy_id: string;
  league_id: string;
  n: number;
  won: number;
  price_sum_bp: number;
}

export interface CountRow<K extends string | number> {
  key: K;
  n: number;
}

export interface MinuteRow {
  minute: number;
  status: string;
  n: number;
}

const SETTLED = sql`t.status IN ('settled_won', 'settled_lost', 'settled_void')`;
const HAS_FILL = sql`t.fill_cc > 0 AND t.status IN ('filled', 'settled_won', 'settled_lost', 'settled_void')`;

export class StatsRepository {
  constructor(private readonly orm: Orm) {}

  /**
   * The `WHERE` conditions of the filter on `trades t`. `modeColumn` is the column the mode is matched on
   * (the trade's effective mode, or an attempt's).
   */
  private where(f: StatsFilter, modeColumn: SQL = sql`t.effective_mode`): SQL {
    const parts: SQL[] = [sql`${modeColumn} = ${f.mode}`, sql`t.kalshi_env = ${f.kalshiEnv}`];
    if (f.leagueIds && f.leagueIds.length > 0) {
      parts.push(
        sql`t.league_id IN (${sql.join(
          [...f.leagueIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    if (f.strategyIds && f.strategyIds.length > 0) {
      parts.push(
        sql`t.strategy_id IN (${sql.join(
          [...f.strategyIds].map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    if (f.sport) parts.push(sql`t.league_id IN (SELECT id FROM leagues WHERE sport = ${f.sport})`);
    if (f.sinceIso) parts.push(sql`t.triggered_at >= ${f.sinceIso}`);
    return sql.join(parts, sql` AND `);
  }

  tiles(f: StatsFilter): TileAggregate {
    const row = this.orm.get<Record<keyof TileAggregate, number | null>>(sql`
      SELECT
        SUM(CASE WHEN ${SETTLED} THEN 1 ELSE 0 END) AS settled,
        SUM(CASE WHEN t.status = 'settled_won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN t.status = 'settled_lost' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN t.status = 'settled_void' THEN 1 ELSE 0 END) AS void,
        SUM(CASE WHEN ${SETTLED} THEN COALESCE(t.realized_pnl_micros, 0) ELSE 0 END) AS pnlMicros,
        SUM(CASE WHEN ${SETTLED} THEN COALESCE(t.cost_micros, 0) + COALESCE(t.fee_micros, 0) ELSE 0 END)
          AS investedMicros,
        SUM(CASE WHEN ${HAS_FILL} THEN 1 ELSE 0 END) AS filled,
        SUM(CASE WHEN ${HAS_FILL} THEN COALESCE(t.avg_fill_price_bp, 0) ELSE 0 END) AS priceSumBp,
        SUM(CASE WHEN ${HAS_FILL} THEN COALESCE(t.fee_micros, 0) ELSE 0 END) AS feeSumMicros,
        SUM(CASE WHEN t.status IN ('settled_won', 'settled_lost') THEN COALESCE(t.avg_fill_price_bp, 0) ELSE 0 END)
          AS decidedPriceSumBp,
        SUM(CASE WHEN t.configured_mode = 'live' THEN 1 ELSE 0 END) AS configuredLive,
        COUNT(*) AS total
      FROM trades t
      WHERE ${this.where(f)}
    `);
    const n = (v: number | null | undefined) => v ?? 0;
    return {
      settled: n(row?.settled),
      won: n(row?.won),
      lost: n(row?.lost),
      void: n(row?.void),
      pnlMicros: n(row?.pnlMicros),
      investedMicros: n(row?.investedMicros),
      filled: n(row?.filled),
      priceSumBp: n(row?.priceSumBp),
      feeSumMicros: n(row?.feeSumMicros),
      decidedPriceSumBp: n(row?.decidedPriceSumBp),
      configuredLive: n(row?.configuredLive),
      total: n(row?.total),
    };
  }

  /**
   * Cumulative realized P&L after each settled trade, ordered by `settled_at` (ties by id): the running total
   * over every strategy and the running total of the trade's own strategy (window functions).
   */
  equity(f: StatsFilter): EquityRow[] {
    return this.orm.all<EquityRow>(sql`
      SELECT
        t.settled_at AS settled_at,
        t.strategy_id AS strategy_id,
        SUM(COALESCE(t.realized_pnl_micros, 0)) OVER (ORDER BY t.settled_at, t.id ROWS UNBOUNDED PRECEDING)
          AS total_micros,
        SUM(COALESCE(t.realized_pnl_micros, 0)) OVER (
          PARTITION BY t.strategy_id ORDER BY t.settled_at, t.id ROWS UNBOUNDED PRECEDING
        ) AS strategy_micros
      FROM trades t
      WHERE ${this.where(f)} AND ${SETTLED} AND t.settled_at IS NOT NULL
      ORDER BY t.settled_at, t.id
    `);
  }

  /** Realized P&L per settlement day (UTC) and strategy. */
  daily(f: StatsFilter): DailyRow[] {
    return this.orm.all<DailyRow>(sql`
      SELECT substr(t.settled_at, 1, 10) AS day, t.strategy_id AS strategy_id,
             SUM(COALESCE(t.realized_pnl_micros, 0)) AS pnl_micros
      FROM trades t
      WHERE ${this.where(f)} AND ${SETTLED} AND t.settled_at IS NOT NULL
      GROUP BY day, t.strategy_id
      ORDER BY day, t.strategy_id
    `);
  }

  /** Won + lost trades (void excluded) per (strategy, league): count, wins and the sum of fill prices. */
  implied(f: StatsFilter): ImpliedRow[] {
    return this.orm.all<ImpliedRow>(sql`
      SELECT t.strategy_id AS strategy_id, t.league_id AS league_id, COUNT(*) AS n,
             SUM(CASE WHEN t.status = 'settled_won' THEN 1 ELSE 0 END) AS won,
             SUM(COALESCE(t.avg_fill_price_bp, 0)) AS price_sum_bp
      FROM trades t
      WHERE ${this.where(f)} AND t.status IN ('settled_won', 'settled_lost')
      GROUP BY t.strategy_id, t.league_id
      ORDER BY t.strategy_id, t.league_id
    `);
  }

  /** Trades with a fill per 1¢ price bin (`key` = the bin's lower bound in bp). */
  priceBins(f: StatsFilter): CountRow<number>[] {
    return this.orm.all<CountRow<number>>(sql`
      SELECT (t.avg_fill_price_bp / 100) * 100 AS key, COUNT(*) AS n
      FROM trades t
      WHERE ${this.where(f)} AND ${HAS_FILL} AND t.avg_fill_price_bp IS NOT NULL
      GROUP BY key
      ORDER BY key
    `);
  }

  /** Trades with a fill per clock minute at entry (from the trigger snapshot) and status. */
  minutes(f: StatsFilter): MinuteRow[] {
    return this.orm.all<MinuteRow>(sql`
      SELECT m.minute AS minute, m.status AS status, COUNT(*) AS n
      FROM (
        SELECT CAST(COALESCE(json_extract(t.trigger_snapshot, '$.minute'),
                             json_extract(t.trigger_snapshot, '$.clock.minute')) AS INTEGER) AS minute,
               t.status AS status
        FROM trades t
        WHERE ${this.where(f)} AND ${HAS_FILL} AND json_valid(t.trigger_snapshot)
      ) m
      WHERE m.minute IS NOT NULL
      GROUP BY m.minute, m.status
      ORDER BY m.minute, m.status
    `);
  }

  /** Final skips: skipped trades per `skip_reason`. */
  finalSkips(f: StatsFilter): CountRow<string>[] {
    return this.orm.all<CountRow<string>>(sql`
      SELECT COALESCE(t.skip_reason, 'unknown') AS key, COUNT(*) AS n
      FROM trades t
      WHERE ${this.where(f)} AND t.status = 'skipped'
      GROUP BY key
      ORDER BY n DESC, key
    `);
  }

  /** Per-attempt skips: attempts that did not fill, per reason, in the attempt's own mode. */
  attemptSkips(f: StatsFilter): CountRow<string>[] {
    return this.orm.all<CountRow<string>>(sql`
      SELECT COALESCE(a.reason, a.status) AS key, COUNT(*) AS n
      FROM trade_attempts a JOIN trades t ON t.id = a.trade_id
      WHERE ${this.where(f, sql`a.effective_mode`)}
        AND a.status IN ('soft_skip', 'hard_skip', 'unfilled', 'error')
      GROUP BY key
      ORDER BY n DESC, key
    `);
  }

  /** The shared dry-run bankroll after each change (`bankroll_snapshots`), oldest first. */
  bankroll(sinceIso: string | undefined): { at: string; bankroll_micros: number }[] {
    return this.orm.all(sql`
      SELECT at, bankroll_micros FROM bankroll_snapshots
      WHERE ${sinceIso ? sql`at >= ${sinceIso}` : sql`1 = 1`}
      ORDER BY at, id
    `);
  }

  /** Live Kalshi balance snapshots of one environment (`balance_snapshots`), oldest first. */
  balance(
    kalshiEnv: string,
    sinceIso: string | undefined,
  ): { at: string; cash_micros: number | null; portfolio_value_micros: number | null }[] {
    return this.orm.all(sql`
      SELECT at, cash_micros, portfolio_value_micros FROM balance_snapshots
      WHERE kalshi_env = ${kalshiEnv} ${sinceIso ? sql`AND at >= ${sinceIso}` : sql``}
      ORDER BY at, id
    `);
  }

  /** Every strategy name by id (deleted ones included). */
  strategyNames(): Map<string, string> {
    const rows = this.orm.all<{ id: string; name: string }>(sql`SELECT id, name FROM strategies`);
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
