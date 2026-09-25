/**
 * The shared filter bar state (SPEC.md §8). It lives only in the URL, so views can be bookmarked and
 * back/forward restore earlier states. Defaults are left out of the query string.
 */

export const SPORTS = ['all', 'soccer', 'hockey'] as const;
export const MODES = ['live', 'dry_run', 'both'] as const;
export const ENVS = ['demo', 'prod'] as const;
export const RANGES = ['7d', '30d', 'season', 'all'] as const;

export type Sport = (typeof SPORTS)[number];
export type ModeFilter = (typeof MODES)[number];
export type EnvFilter = (typeof ENVS)[number];
export type Range = (typeof RANGES)[number];

export interface Filters {
  sport: Sport;
  leagues: string[];
  strategies: string[];
  /** Default `both`: each mode shown separately, never summed. */
  mode: ModeFilter;
  /** `null` = the Kalshi environment the app currently runs against. */
  env: EnvFilter | null;
  range: Range;
}

export const DEFAULT_FILTERS: Filters = {
  sport: 'all',
  leagues: [],
  strategies: [],
  mode: 'both',
  env: null,
  range: 'all',
};

const ID = /^[A-Za-z0-9_.-]{1,64}$/;

const oneOf = <T extends string>(values: readonly T[], v: string | null, fallback: T): T =>
  v !== null && (values as readonly string[]).includes(v) ? (v as T) : fallback;

const list = (v: string | null): string[] =>
  v === null ? [] : [...new Set(v.split(',').filter((x) => ID.test(x)))];

/** Parses a query string; unknown or malformed values fall back to the defaults. */
export function parseFilters(search: string): Filters {
  const q = new URLSearchParams(search);
  const env = q.get('env');
  return {
    sport: oneOf(SPORTS, q.get('sport'), DEFAULT_FILTERS.sport),
    leagues: list(q.get('leagues')),
    strategies: list(q.get('strategies')),
    mode: oneOf(MODES, q.get('mode'), DEFAULT_FILTERS.mode),
    env: env !== null && (ENVS as readonly string[]).includes(env) ? (env as EnvFilter) : null,
    range: oneOf(RANGES, q.get('range'), DEFAULT_FILTERS.range),
  };
}

/** The query string for a filter state (`?leagues=epl&mode=live&range=30d`), in a fixed key order. */
export function serializeFilters(f: Filters): string {
  const parts: string[] = [];
  if (f.sport !== DEFAULT_FILTERS.sport) parts.push(`sport=${f.sport}`);
  if (f.leagues.length > 0) parts.push(`leagues=${f.leagues.map(encodeURIComponent).join(',')}`);
  if (f.strategies.length > 0) parts.push(`strategies=${f.strategies.map(encodeURIComponent).join(',')}`);
  if (f.mode !== DEFAULT_FILTERS.mode) parts.push(`mode=${f.mode}`);
  if (f.env !== null) parts.push(`env=${f.env}`);
  if (f.range !== DEFAULT_FILTERS.range) parts.push(`range=${f.range}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
