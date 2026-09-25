import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appDir = new URL('../..', import.meta.url).pathname;

function gitRoot(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: appDir, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

const root = gitRoot();

describe.skipIf(!root)('secrets never reach git', () => {
  it.each([
    'config.local.json',
    'kalshi-trader/app/config.local.json',
    'foo.db',
    'kalshi-trader/app/.local/trader.db',
    'trader.db-wal',
    'trader.db-shm',
    'kalshi.key',
    'kalshi-trader/app/demo.pem',
    '.local/share/x',
    'kalshi-trader/app/node_modules/x',
    'kalshi-trader/app/dist/server/main.js',
    '.env',
    'kalshi-trader/app/.env.local',
  ])('%s is git-ignored', (path) => {
    // check-ignore exits 0 when the path is ignored.
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root }),
    ).not.toThrow();
  });

  it('config.local.example.json is NOT ignored', () => {
    expect(() =>
      execFileSync(
        'git',
        ['check-ignore', '-q', '--no-index', 'kalshi-trader/app/config.local.example.json'],
        {
          cwd: root,
        },
      ),
    ).toThrow();
  });

  it('.dockerignore excludes the same secret paths', () => {
    const lines = readFileSync(`${root}/.dockerignore`, 'utf8').split('\n');
    for (const p of ['*.key', '*.pem', 'config.local.json', '*.db*', '.local/', 'node_modules', 'dist']) {
      expect(lines.some((l) => l.trim() === `**/${p}` || l.trim() === p)).toBe(true);
    }
  });

  it('gitleaks config flags a bare private-key header', () => {
    const toml = readFileSync(`${root}/.gitleaks.toml`, 'utf8');
    expect(toml).toContain('useDefault = true');
    expect(toml).toContain('private-key-header');
  });
});
