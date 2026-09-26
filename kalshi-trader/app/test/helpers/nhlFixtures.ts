/**
 * The recorded-fixture stand-in for the NHL Web API (`api-web.nhle.com/v1`), shared by the unit tests
 * and the Playwright stand-in server (`test/e2e/fake-kalshi.ts`, under `/nhl/v1`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const NHL_FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/nhl');
export const NHL_PREFIX = '/nhl/v1';

export function nhlFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(resolve(NHL_FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
}

/** Maps a path relative to `/v1` to its fixture. */
export function routeNhl(path: string): { status: number; body: unknown } {
  if (path === '/score/now') return { status: 200, body: nhlFixture('score_now') };
  const m = /^\/gamecenter\/(\d+)\/landing$/.exec(path);
  if (m?.[1] === '2026020045') return { status: 200, body: nhlFixture('landing_2026020045') };
  return { status: 404, body: { message: 'not found' } };
}
