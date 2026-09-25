import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Orm = BetterSQLite3Database<typeof schema>;

/** An open SQLite database: the raw `better-sqlite3` handle plus the Drizzle wrapper. */
export interface Db {
  /** Absolute path of the database file (or `:memory:`). */
  readonly path: string;
  readonly sqlite: Database.Database;
  readonly orm: Orm;
  close(): void;
}

/**
 * Opens (creating if needed) the SQLite database at `path` with the §7 connection settings:
 * WAL journal, `foreign_keys=ON`, `busy_timeout=5000`. Creates the parent directory itself,
 * because `better-sqlite3` does not and local runs have no `run.sh` to do it.
 */
export function openDatabase(path: string): Db {
  const memory = path === ':memory:';
  const file = memory ? path : resolve(path);
  if (!memory) mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  try {
    sqlite.pragma('busy_timeout = 5000');
    const mode = sqlite.pragma('journal_mode = WAL', { simple: true });
    if (!memory && String(mode).toLowerCase() !== 'wal') {
      throw Object.assign(new Error(`could not switch ${file} to WAL (journal_mode is ${String(mode)})`), {
        code: 'SQLITE_WAL',
      });
    }
    sqlite.pragma('foreign_keys = ON');
  } catch (err) {
    sqlite.close();
    throw err;
  }

  return {
    path: file,
    sqlite,
    orm: drizzle(sqlite, { schema }),
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
