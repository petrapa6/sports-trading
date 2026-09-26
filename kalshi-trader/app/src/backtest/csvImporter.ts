import type { Repositories } from '../db/repositories.js';
import type { GoalEvent } from '../core/tracker.js';

/**
 * Generic CSV importer (SPEC.md §3 Historical, T11). Columns, in any order, with a header row:
 *
 *   league_code, season, date, home, away, home_goals_final, away_goals_final, goal_events
 *
 * `goal_events` is `home:23;away:67;home:90+2` (empty for 0-0). Stoppage time counts as the minute it
 * extends (`90+2` → minute 90, `45+1` → 45). Soccer events get period 1 up to minute 45, else 2; hockey
 * events period `floor(minute / 20) + 1` for regulation minutes 0–59 and 4 for overtime (≥ 60).
 * Seconds are 0. The number of `home` / `away` events must equal `home_goals_final` / `away_goals_final`.
 *
 * Every row is validated before anything is written; the first invalid row fails the whole import with
 * its row number (1 = the first data row, i.e. line 2 of the file) and column. Rows are upserted by id
 * `csv:<league>:<date>:<home>:<away>`, so importing the same file twice changes nothing.
 */

export const CSV_COLUMNS = [
  'league_code',
  'season',
  'date',
  'home',
  'away',
  'home_goals_final',
  'away_goals_final',
  'goal_events',
] as const;
type Column = (typeof CSV_COLUMNS)[number];

export const CSV_MAX_BYTES = 20 * 1024 * 1024;

export class CsvImportError extends Error {
  override name = 'CsvImportError';
  constructor(
    readonly row: number | null,
    readonly column: string | null,
    message: string,
  ) {
    super(row !== null ? `row ${row}${column ? `, column ${column}` : ''}: ${message}` : message);
  }
}

/** RFC 4180 records: quoted fields may hold commas, quotes (`""`) and line breaks; CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new CsvImportError(null, null, 'unterminated quoted field');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Blank lines are ignored.
  return records.filter((r) => !(r.length === 1 && r[0]?.trim() === ''));
}

const GOAL = /^(home|away):(\d{1,3})(?:\+(\d{1,2}))?$/i;

/** `home:23;away:67;home:90+2` → goal events (throws `Error` with a readable message). */
export function parseGoalEvents(text: string, sport: 'soccer' | 'hockey'): GoalEvent[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed.split(';').map((part) => {
    const m = GOAL.exec(part.trim());
    if (!m) throw new Error(`"${part.trim()}" is not side:minute (e.g. home:23 or away:90+2)`);
    const side = (m[1] as string).toLowerCase() as 'home' | 'away';
    const minute = Number.parseInt(m[2] as string, 10);
    const max = sport === 'soccer' ? 120 : 80;
    if (minute < 0 || minute > max) throw new Error(`minute ${minute} is out of range 0–${max}`);
    const period =
      sport === 'soccer' ? (minute <= 45 ? 1 : 2) : minute >= 60 ? 4 : Math.floor(minute / 20) + 1;
    return { side, period, minute, second: 0 };
  });
}

export interface CsvImportResult {
  rows: number;
  inserted: number;
  updated: number;
}

interface ParsedRow {
  id: string;
  row: Parameters<Repositories['histGames']['insert']>[0];
}

/** Validates every row, then upserts them in one transaction (via `transaction`). */
export function importCsv(
  repos: Repositories,
  text: string,
  transaction: (fn: () => void) => void = (fn) => fn(),
): CsvImportResult {
  const records = parseCsv(text);
  const header = records.shift();
  if (!header) throw new CsvImportError(null, null, 'the file is empty');
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const missing = CSV_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0)
    throw new CsvImportError(
      null,
      null,
      `missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
    );
  if (records.length === 0) throw new CsvImportError(null, null, 'the file has no data rows');

  const leagues = new Map(repos.leagues.list().map((l) => [l.id, l.sport as 'soccer' | 'hockey']));
  const parsed: ParsedRow[] = [];
  const ids = new Set<string>();
  records.forEach((record, n) => {
    const rowNo = n + 1;
    const get = (c: Column): string => (record[index.get(c) as number] ?? '').trim();
    const fail = (c: Column, message: string): never => {
      throw new CsvImportError(rowNo, c, message);
    };
    const league = get('league_code').toLowerCase();
    const sport = leagues.get(league);
    if (!sport)
      fail(
        'league_code',
        `unknown league "${get('league_code')}" (use one of ${[...leagues.keys()].join(', ')})`,
      );
    const season = get('season');
    if (season === '' || season.length > 20) fail('season', 'must be 1–20 characters (e.g. 2015-16)');
    const date = get('date');
    const dateMatch = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?Z?)?$/.exec(date);
    const playedMs = dateMatch ? Date.parse(`${dateMatch[1]}T${dateMatch[2] ?? '00:00'}:00Z`) : Number.NaN;
    if (
      !dateMatch ||
      Number.isNaN(playedMs) ||
      new Date(playedMs).toISOString().slice(0, 10) !== dateMatch[1]
    )
      fail('date', `"${date}" is not a date (YYYY-MM-DD)`);
    const home = get('home');
    const away = get('away');
    if (home === '' || home.length > 100) fail('home', 'must be 1–100 characters');
    if (away === '' || away.length > 100) fail('away', 'must be 1–100 characters');
    const goals = (c: Column): number => {
      const v = get(c);
      if (!/^\d{1,2}$/.test(v)) fail(c, `"${v}" is not a goal count`);
      return Number.parseInt(v, 10);
    };
    const finalHome = goals('home_goals_final');
    const finalAway = goals('away_goals_final');
    let events: GoalEvent[] = [];
    try {
      events = parseGoalEvents(get('goal_events'), sport as 'soccer' | 'hockey');
    } catch (err) {
      fail('goal_events', (err as Error).message);
    }
    const homeEvents = events.filter((e) => e.side === 'home').length;
    const awayEvents = events.length - homeEvents;
    if (homeEvents !== finalHome)
      fail('home_goals_final', `${finalHome} does not match the ${homeEvents} home goal event(s)`);
    if (awayEvents !== finalAway)
      fail('away_goals_final', `${finalAway} does not match the ${awayEvents} away goal event(s)`);
    const id = `csv:${league}:${dateMatch?.[1] ?? date}:${home}:${away}`;
    if (ids.has(id)) fail('home', `duplicate game (${league} ${date} ${home} – ${away})`);
    ids.add(id);
    events.sort((a, b) => a.minute - b.minute || a.second - b.second);
    parsed.push({
      id,
      row: {
        id,
        league_id: league,
        season,
        competition: null,
        played_at: new Date(playedMs).toISOString(),
        home,
        away,
        final_home: finalHome,
        final_away: finalAway,
        goal_events: JSON.stringify(events),
        source: 'csv',
        kalshi_event_ticker: null,
      },
    });
  });

  const result: CsvImportResult = { rows: parsed.length, inserted: 0, updated: 0 };
  transaction(() => {
    for (const { id, row } of parsed) {
      if (repos.histGames.get({ id })) {
        const patch: Partial<typeof row> = { ...row };
        delete patch.id;
        repos.histGames.update({ id }, patch);
        result.updated++;
      } else {
        repos.histGames.insert(row);
        result.inserted++;
      }
    }
  });
  return result;
}
