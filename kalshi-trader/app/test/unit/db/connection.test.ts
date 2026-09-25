import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../src/db/connection.js';

describe('openDatabase', () => {
  let dir: string | undefined;
  let db: Db | undefined;
  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = undefined;
    dir = undefined;
  });

  it('creates missing directories, the file and its WAL', () => {
    dir = mkdtempSync(join(tmpdir(), 'kst-conn-'));
    const path = join(dir, 'data', 'db', 'trader.db');
    db = openDatabase(path);
    db.sqlite.exec('CREATE TABLE t (x INTEGER)');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(true);
  });

  it('uses WAL, foreign_keys=ON and busy_timeout=5000 on the app connection', () => {
    dir = mkdtempSync(join(tmpdir(), 'kst-conn-'));
    db = openDatabase(join(dir, 'trader.db'));
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('enforces foreign keys', () => {
    dir = mkdtempSync(join(tmpdir(), 'kst-conn-'));
    db = openDatabase(join(dir, 'trader.db'));
    db.sqlite.exec('CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (p TEXT REFERENCES p(id))');
    expect(() => db?.sqlite.prepare("INSERT INTO c VALUES ('nope')").run()).toThrow(/FOREIGN KEY/);
  });
});
