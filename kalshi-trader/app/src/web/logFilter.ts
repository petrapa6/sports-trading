import type { LogEntry } from './api';

export type LogModeFilter = 'all' | 'live' | 'dry_run';

/** Lines shown for a mode filter: `live` / `dry_run` keep only lines tagged with that mode. */
export const filterLogs = (logs: readonly LogEntry[], filter: LogModeFilter): LogEntry[] =>
  filter === 'all' ? [...logs] : logs.filter((l) => l.mode === filter);
