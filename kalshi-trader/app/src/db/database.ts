import type { Logger } from 'pino';
import { openDatabase, type Db } from './connection.js';
import { migrateUp } from './migrate.js';
import { createRepositories, type Repositories } from './repositories.js';

/** The database file could not be opened (missing permissions, not a directory, …). */
export class DatabaseUnavailableError extends Error {
  override name = 'DatabaseUnavailableError';
  constructor(
    readonly code: string,
    options: { cause: unknown },
  ) {
    super(`database unavailable (${code})`, options);
  }
}

/** A migration failed on an open database; the app must not start on a half-migrated DB. */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

export type DbHealth = { ok: true } | { ok: false; db: string };

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'error';
}

/**
 * Owns the process's single database connection. `open()` opens the file and applies pending
 * migrations; if the file cannot be opened the server still starts, `/healthz` reports 503 and
 * each health check retries the open, so the app recovers once the directory becomes writable.
 */
export class DatabaseManager {
  private db: Db | undefined;
  private repos: Repositories | undefined;
  private lastFailure: string | undefined;

  constructor(
    readonly path: string,
    private readonly log: Logger,
  ) {}

  /** The open database, if any. */
  get current(): Db | undefined {
    return this.db;
  }

  /** Repositories on the open database; throws when the database is unavailable. */
  get repositories(): Repositories {
    if (!this.repos) throw new DatabaseUnavailableError('closed', { cause: undefined });
    return this.repos;
  }

  /**
   * Opens the database and runs pending migrations. Throws `DatabaseUnavailableError` when the
   * file cannot be opened and `MigrationError` when a migration fails (the connection is closed).
   */
  open(): Db {
    if (this.db) return this.db;
    let db: Db;
    try {
      db = openDatabase(this.path);
    } catch (err) {
      throw new DatabaseUnavailableError(errorCode(err), { cause: err });
    }
    try {
      const applied = migrateUp(db);
      this.log.info({ dbPath: db.path, applied }, `Database ready (${applied.length} migration(s) applied)`);
    } catch (err) {
      db.close();
      throw new MigrationError(`migration failed: ${(err as Error).message}`, { cause: err });
    }
    this.db = db;
    this.repos = createRepositories(db.orm);
    return db;
  }

  /** Opens the database if needed and runs `SELECT 1`. Never throws. */
  health(): DbHealth {
    try {
      const db = this.open();
      db.sqlite.prepare('SELECT 1').get();
      if (this.lastFailure !== undefined) this.log.info({ dbPath: this.path }, 'Database available again');
      this.lastFailure = undefined;
      return { ok: true };
    } catch (err) {
      const code = err instanceof DatabaseUnavailableError ? err.code : errorCode(err);
      const reason = err instanceof MigrationError ? 'migration_failed' : code;
      // Log once per distinct failure, not on every health probe.
      if (reason !== this.lastFailure)
        this.log.error({ err, dbPath: this.path }, 'Database health check failed');
      this.lastFailure = reason;
      return { ok: false, db: reason };
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.repos = undefined;
  }
}
