import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  getTableColumns,
  getTableName,
  inArray,
  isNull,
  lt,
  ne,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Orm } from './connection.js';
import * as s from './schema.js';
import { SettingsRepository } from './settings.js';
import { StatsRepository } from './stats.js';

/** A value that failed repository validation; `column` names the offending column. */
export class ValidationError extends Error {
  override name = 'ValidationError';
  constructor(
    message: string,
    readonly table: string,
    readonly column: string,
  ) {
    super(message);
  }
}

/**
 * Checks a row (or a patch) against the table definition before it reaches SQLite, which would
 * otherwise store `12.5` in an INTEGER column or `"200"` as text. Every INTEGER column (all money
 * `*_micros`, price `*_bp` and count `*_cc` columns among them) must be a safe integer; every TEXT
 * column a string; unknown keys are rejected. `null` / `undefined` are left to SQLite's NOT NULL.
 */
export function validateRow(table: SQLiteTable, row: Record<string, unknown>): void {
  const name = getTableName(table);
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  for (const [key, value] of Object.entries(row)) {
    const column = columns[key];
    if (!column) throw new ValidationError(`${name}.${key} is not a column`, name, key);
    if (value === null || value === undefined) continue;
    if (column.columnType === 'SQLiteInteger') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new ValidationError(
          `${name}.${key} must be a safe integer, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`,
          name,
          key,
        );
      }
    } else if (column.columnType === 'SQLiteText') {
      if (typeof value !== 'string') {
        throw new ValidationError(`${name}.${key} must be a string, got ${typeof value}`, name, key);
      }
    }
  }
}

/**
 * Typed CRUD for one table. `keys` are the primary-key columns; `get` / `update` / `delete`
 * take an object with exactly those columns, e.g. `leagues.get({ id: 'epl' })`.
 */
export class Repository<T extends SQLiteTable, K extends keyof InferSelectModel<T> & string> {
  readonly name: string;

  constructor(
    protected readonly orm: Orm,
    readonly table: T,
    readonly keys: readonly K[],
  ) {
    this.name = getTableName(table);
  }

  protected column(name: string): SQLiteColumn {
    const col = (getTableColumns(this.table) as Record<string, SQLiteColumn>)[name];
    if (!col) throw new Error(`${this.name}.${name} is not a column`);
    return col;
  }

  protected whereKey(key: Pick<InferSelectModel<T>, K>): SQL {
    const parts = this.keys.map((k) => {
      const v = (key as Record<string, unknown>)[k];
      if (v === undefined || v === null)
        throw new ValidationError(`${this.name}: key ${k} is required`, this.name, k);
      return eq(this.column(k), v);
    });
    const where = and(...parts);
    if (!where) throw new Error(`${this.name}: no key columns`);
    return where;
  }

  insert(row: InferInsertModel<T>): InferSelectModel<T> {
    validateRow(this.table, row as Record<string, unknown>);
    return this.orm
      .insert(this.table)
      .values(row as never)
      .returning()
      .get() as InferSelectModel<T>;
  }

  /** Inserts every row in one transaction (all or nothing). */
  insertMany(rows: readonly InferInsertModel<T>[]): number {
    for (const row of rows) validateRow(this.table, row as Record<string, unknown>);
    if (rows.length === 0) return 0;
    return this.orm.transaction((tx) => {
      let n = 0;
      for (const row of rows)
        n += tx
          .insert(this.table)
          .values(row as never)
          .run().changes;
      return n;
    });
  }

  get(key: Pick<InferSelectModel<T>, K>): InferSelectModel<T> | undefined {
    return this.orm
      .select()
      .from(this.table as SQLiteTable)
      .where(this.whereKey(key))
      .get() as InferSelectModel<T> | undefined;
  }

  /** Applies a partial update; returns the updated row, or `undefined` if the key does not exist. */
  update(
    key: Pick<InferSelectModel<T>, K>,
    patch: Partial<InferInsertModel<T>>,
  ): InferSelectModel<T> | undefined {
    validateRow(this.table, patch as Record<string, unknown>);
    if (Object.keys(patch).length === 0) return this.get(key);
    return this.orm
      .update(this.table)
      .set(patch as never)
      .where(this.whereKey(key))
      .returning()
      .get() as InferSelectModel<T> | undefined;
  }

  /** Deletes by key; returns whether a row was deleted. */
  delete(key: Pick<InferSelectModel<T>, K>): boolean {
    return this.orm.delete(this.table).where(this.whereKey(key)).run().changes > 0;
  }

  /** Rows matching `where` (all rows when omitted), ordered by the key columns. */
  list(where?: SQL, limit?: number): InferSelectModel<T>[] {
    const order = this.keys.map((k) => asc(this.column(k)));
    const q = this.orm
      .select()
      .from(this.table as SQLiteTable)
      .where(where)
      .orderBy(...order);
    return (limit === undefined ? q.all() : q.limit(limit).all()) as InferSelectModel<T>[];
  }

  count(where?: SQL): number {
    const row = this.orm
      .select({ n: count() })
      .from(this.table as SQLiteTable)
      .where(where)
      .get();
    return row?.n ?? 0;
  }
}

export class LeaguesRepository extends Repository<typeof s.leagues, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.leagues, ['id']);
  }
  listEnabled(): s.League[] {
    return this.list(eq(s.leagues.enabled, 1));
  }
}

export class TeamsRepository extends Repository<typeof s.teams, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.teams, ['id']);
  }
  listByLeague(leagueId: string): s.Team[] {
    return this.list(eq(s.teams.league_id, leagueId));
  }
}

export class GamesRepository extends Repository<typeof s.games, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.games, ['id']);
  }
  listByLeague(leagueId: string): s.Game[] {
    return this.list(eq(s.games.league_id, leagueId));
  }
}

export class MarketsRepository extends Repository<typeof s.markets, 'ticker'> {
  constructor(orm: Orm) {
    super(orm, s.markets, ['ticker']);
  }
  listByGame(gameId: string): s.Market[] {
    return this.list(eq(s.markets.game_id, gameId));
  }
}

export class GameSnapshotsRepository extends Repository<typeof s.game_snapshots, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.game_snapshots, ['id']);
  }
  listByGame(gameId: string): s.GameSnapshot[] {
    return this.orm
      .select()
      .from(s.game_snapshots)
      .where(eq(s.game_snapshots.game_id, gameId))
      .orderBy(asc(s.game_snapshots.observed_at), asc(s.game_snapshots.id))
      .all();
  }
  /** When the newest observation of a game was received (`observed_at`), or `null` without any. */
  latestObservedAt(gameId: string): string | null {
    const row = this.orm
      .select({ at: s.game_snapshots.observed_at })
      .from(s.game_snapshots)
      .where(eq(s.game_snapshots.game_id, gameId))
      .orderBy(desc(s.game_snapshots.observed_at))
      .limit(1)
      .get();
    return row?.at ?? null;
  }
  /** Deletes every snapshot of a game (replay reset); returns the number deleted. */
  deleteByGame(gameId: string): number {
    return this.orm.delete(s.game_snapshots).where(eq(s.game_snapshots.game_id, gameId)).run().changes;
  }
  /**
   * Deletes snapshots observed before `cutoffIso`, but only for games whose timeline is archived
   * (`timeline_archived = 1`); everything else is kept (§7 Retention). Returns the number deleted.
   */
  pruneArchivedBefore(cutoffIso: string): number {
    const archived = this.orm
      .select({ id: s.games.id })
      .from(s.games)
      .where(eq(s.games.timeline_archived, 1));
    return this.orm
      .delete(s.game_snapshots)
      .where(and(lt(s.game_snapshots.observed_at, cutoffIso), inArray(s.game_snapshots.game_id, archived)))
      .run().changes;
  }
}

export class StrategiesRepository extends Repository<typeof s.strategies, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.strategies, ['id']);
  }
  /** Strategies by creation time; soft-deleted ones only with `includeDeleted`. */
  listOrdered(includeDeleted = false): s.Strategy[] {
    return this.orm
      .select()
      .from(s.strategies)
      .where(includeDeleted ? undefined : isNull(s.strategies.deleted_at))
      .orderBy(asc(s.strategies.created_at), asc(s.strategies.id))
      .all();
  }
  /** Inserts a strategy and its version 1 in one transaction. */
  createWithVersion(
    row: InferInsertModel<typeof s.strategies>,
    version: Omit<InferInsertModel<typeof s.strategy_versions>, 'strategy_id' | 'version'>,
  ): s.Strategy {
    const v = { ...version, strategy_id: row.id, version: row.current_version };
    validateRow(s.strategies, row as Record<string, unknown>);
    validateRow(s.strategy_versions, v as Record<string, unknown>);
    return this.orm.transaction((tx) => {
      const created = tx.insert(s.strategies).values(row).returning().get();
      tx.insert(s.strategy_versions).values(v).run();
      return created;
    });
  }
  /**
   * Adds version `current_version + 1` and bumps `current_version` (plus `patch`) in one transaction;
   * earlier versions are never touched.
   */
  addVersion(
    id: string,
    patch: Partial<Pick<s.Strategy, 'name' | 'updated_at'>>,
    version: Omit<InferInsertModel<typeof s.strategy_versions>, 'strategy_id' | 'version'>,
  ): s.Strategy | undefined {
    return this.orm.transaction((tx) => {
      const current = tx.select().from(s.strategies).where(eq(s.strategies.id, id)).get();
      if (!current) return undefined;
      const next = current.current_version + 1;
      const v = { ...version, strategy_id: id, version: next };
      const p = { ...patch, current_version: next };
      validateRow(s.strategy_versions, v as Record<string, unknown>);
      validateRow(s.strategies, p as Record<string, unknown>);
      tx.insert(s.strategy_versions).values(v).run();
      return tx.update(s.strategies).set(p).where(eq(s.strategies.id, id)).returning().get();
    });
  }
}

export class StrategyVersionsRepository extends Repository<
  typeof s.strategy_versions,
  'strategy_id' | 'version'
> {
  constructor(orm: Orm) {
    super(orm, s.strategy_versions, ['strategy_id', 'version']);
  }
  listForStrategy(strategyId: string): s.StrategyVersion[] {
    return this.list(eq(s.strategy_versions.strategy_id, strategyId));
  }
}

export class TradesRepository extends Repository<typeof s.trades, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.trades, ['id']);
  }
  findByStrategyAndGame(strategyId: string, gameId: string): s.Trade | undefined {
    return this.orm
      .select()
      .from(s.trades)
      .where(and(eq(s.trades.strategy_id, strategyId), eq(s.trades.game_id, gameId)))
      .get();
  }
  /** Trades matching `where`, newest trigger first. */
  newestFirst(where: SQL | undefined, limit: number): s.Trade[] {
    return this.orm
      .select()
      .from(s.trades)
      .where(where)
      .orderBy(desc(s.trades.triggered_at), desc(s.trades.id))
      .limit(limit)
      .all();
  }
  /** Trades in any of `statuses`, oldest trigger first (optionally of one game). */
  listByStatus(statuses: readonly string[], gameId?: string): s.Trade[] {
    return this.orm
      .select()
      .from(s.trades)
      .where(
        and(
          inArray(s.trades.status, [...statuses]),
          gameId === undefined ? undefined : eq(s.trades.game_id, gameId),
        ),
      )
      .orderBy(asc(s.trades.triggered_at), asc(s.trades.id))
      .all();
  }
}

export class TradeAttemptsRepository extends Repository<typeof s.trade_attempts, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.trade_attempts, ['id']);
  }
  listForTrade(tradeId: string): s.TradeAttempt[] {
    return this.orm
      .select()
      .from(s.trade_attempts)
      .where(eq(s.trade_attempts.trade_id, tradeId))
      .orderBy(asc(s.trade_attempts.attempt_no))
      .all();
  }
  listByStatus(status: string): s.TradeAttempt[] {
    return this.orm
      .select()
      .from(s.trade_attempts)
      .where(eq(s.trade_attempts.status, status))
      .orderBy(asc(s.trade_attempts.id))
      .all();
  }
  findByClientOrderId(clientOrderId: string): s.TradeAttempt | undefined {
    return this.orm
      .select()
      .from(s.trade_attempts)
      .where(eq(s.trade_attempts.client_order_id, clientOrderId))
      .get();
  }
}

export class HistGamesRepository extends Repository<typeof s.hist_games, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.hist_games, ['id']);
  }
  /** Number of timelines per `source` (Settings → Data). */
  countBySource(): { source: string; n: number }[] {
    return this.orm
      .select({ source: s.hist_games.source, n: count() })
      .from(s.hist_games)
      .groupBy(s.hist_games.source)
      .orderBy(asc(s.hist_games.source))
      .all();
  }
}

export class UsersRepository extends Repository<typeof s.users, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.users, ['id']);
  }
  findByUsername(username: string): s.User | undefined {
    return this.orm.select().from(s.users).where(eq(s.users.username, username)).get();
  }
}

export class SessionsRepository extends Repository<typeof s.sessions, 'id_hash'> {
  constructor(orm: Orm) {
    super(orm, s.sessions, ['id_hash']);
  }
  listForUser(userId: number): s.Session[] {
    return this.orm
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.user_id, userId))
      .orderBy(desc(s.sessions.last_seen_at))
      .all();
  }
  /** Deletes every session of a user except `keepIdHash`; returns the number deleted. */
  deleteForUser(userId: number, keepIdHash?: string): number {
    const where =
      keepIdHash === undefined
        ? eq(s.sessions.user_id, userId)
        : and(eq(s.sessions.user_id, userId), ne(s.sessions.id_hash, keepIdHash));
    return this.orm.delete(s.sessions).where(where).run().changes;
  }
  deleteAll(): number {
    return this.orm.delete(s.sessions).run().changes;
  }
}

export class LoginAttemptsRepository extends Repository<typeof s.login_attempts, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.login_attempts, ['id']);
  }
  /** Failed attempts (`ok = 0`) on the given channels at or after `sinceIso`, by client IP or username. */
  countFailures(
    by: { ip: string } | { username: string },
    channels: readonly string[],
    sinceIso: string,
  ): number {
    const match = 'ip' in by ? eq(s.login_attempts.ip, by.ip) : eq(s.login_attempts.username, by.username);
    return this.count(
      and(
        match,
        eq(s.login_attempts.ok, 0),
        inArray(s.login_attempts.channel, [...channels]),
        gte(s.login_attempts.at, sinceIso),
      ),
    );
  }
}

export class AuditLogRepository extends Repository<typeof s.audit_log, 'id'> {
  constructor(orm: Orm) {
    super(orm, s.audit_log, ['id']);
  }
  /** Every row of one entity, oldest first (a trade's audit trail). */
  listForEntity(entity: string, entityId: string): s.AuditLogEntry[] {
    return this.orm
      .select()
      .from(s.audit_log)
      .where(and(eq(s.audit_log.entity, entity), eq(s.audit_log.entity_id, entityId)))
      .orderBy(asc(s.audit_log.id))
      .all();
  }
  /** Rows for one action and entity, newest first. */
  listFor(action: string, entity: string, entityId: string, sinceIso?: string): s.AuditLogEntry[] {
    return this.orm
      .select()
      .from(s.audit_log)
      .where(
        and(
          eq(s.audit_log.action, action),
          eq(s.audit_log.entity, entity),
          eq(s.audit_log.entity_id, entityId),
          sinceIso === undefined ? undefined : gte(s.audit_log.at, sinceIso),
        ),
      )
      .orderBy(desc(s.audit_log.id))
      .all();
  }
}

/** Every repository, one per §7 table, plus typed settings. */
export function createRepositories(orm: Orm, now: () => number = Date.now) {
  return {
    leagues: new LeaguesRepository(orm),
    teams: new TeamsRepository(orm),
    games: new GamesRepository(orm),
    markets: new MarketsRepository(orm),
    gameSnapshots: new GameSnapshotsRepository(orm),
    strategies: new StrategiesRepository(orm),
    strategyVersions: new StrategyVersionsRepository(orm),
    trades: new TradesRepository(orm),
    tradeAttempts: new TradeAttemptsRepository(orm),
    balanceSnapshots: new Repository(orm, s.balance_snapshots, ['id']),
    bankrollSnapshots: new Repository(orm, s.bankroll_snapshots, ['id']),
    auditLog: new AuditLogRepository(orm),
    users: new UsersRepository(orm),
    sessions: new SessionsRepository(orm),
    loginAttempts: new LoginAttemptsRepository(orm),
    settings: new SettingsRepository(orm, now),
    histGames: new HistGamesRepository(orm),
    histPrices: new Repository(orm, s.hist_prices, ['market_ticker', 'minute_ts']),
    backtests: new Repository(orm, s.backtests, ['id']),
    backtestTrades: new Repository(orm, s.backtest_trades, ['id']),
    /** Read-only aggregates for `GET /api/stats` (T10). */
    stats: new StatsRepository(orm),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
