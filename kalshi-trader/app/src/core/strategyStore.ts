import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import type { Repositories } from '../db/repositories.js';
import { trades, type Strategy } from '../db/schema.js';
import { effectiveMode, runningMode, type ConfiguredMode, type ModeResult } from './modes.js';
import {
  parseVersionPayload,
  versionedPartsDiffer,
  type StrategyDefinition,
  type StrategySport,
  type VersionPayload,
} from './strategy.js';

/**
 * Strategies in the database (SPEC.md §5 Modes and lifecycle, §7 `strategies` / `strategy_versions`): a
 * `strategies` row (name, sport, mode, kill switch, `current_version`) plus one immutable
 * `strategy_versions` row per edit of the leagues, rule, sizing or execution. Trades reference the version
 * they fired under, so an edit never rewrites history.
 */

/** Global switches as read from the database / process for one evaluation (never cached). */
export interface GlobalSwitches {
  globalKill: boolean;
  globalDryRun: boolean;
  allowLiveOrders: boolean;
}

/** A strategy with its current version parsed (`version` is `null` if the stored JSON is invalid). */
export interface StrategyRecord {
  id: string;
  name: string;
  sport: StrategySport;
  mode: ConfiguredMode;
  killSwitch: boolean;
  currentVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  version: VersionPayload | null;
}

function toRecord(row: Strategy, version: VersionPayload | null): StrategyRecord {
  return {
    id: row.id,
    name: row.name,
    sport: row.sport as StrategySport,
    mode: row.mode as ConfiguredMode,
    killSwitch: row.kill_switch === 1,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version,
  };
}

function currentVersion(repos: Repositories, row: Strategy): VersionPayload | null {
  const v = repos.strategyVersions.get({ strategy_id: row.id, version: row.current_version });
  if (!v) return null;
  try {
    return parseVersionPayload(v);
  } catch {
    return null;
  }
}

export function loadStrategy(repos: Repositories, id: string): StrategyRecord | undefined {
  const row = repos.strategies.get({ id });
  return row ? toRecord(row, currentVersion(repos, row)) : undefined;
}

/** Every strategy (soft-deleted ones only with `includeDeleted`), oldest first. */
export function loadStrategies(repos: Repositories, includeDeleted = false): StrategyRecord[] {
  return repos.strategies.listOrdered(includeDeleted).map((row) => toRecord(row, currentVersion(repos, row)));
}

export interface VersionView extends VersionPayload {
  version: number;
  createdAt: string | null;
}

/** Every version of a strategy, oldest first (rows with invalid JSON are skipped). */
export function loadVersions(repos: Repositories, id: string): VersionView[] {
  return repos.strategyVersions.listForStrategy(id).flatMap((v) => {
    try {
      return [{ version: v.version ?? 0, createdAt: v.created_at, ...parseVersionPayload(v) }];
    } catch {
      return [];
    }
  });
}

const payloadOf = (d: VersionPayload): VersionPayload => ({
  leagueIds: d.leagueIds,
  rule: d.rule,
  sizing: d.sizing,
  execution: d.execution,
});

const payloadColumns = (d: VersionPayload) => ({
  league_ids: JSON.stringify(d.leagueIds),
  rule: JSON.stringify(d.rule),
  sizing: JSON.stringify(d.sizing),
  execution: JSON.stringify(d.execution),
});

/** Creates a strategy with version 1: kill switch on, `dry_run` (§5). */
export function createStrategy(repos: Repositories, def: StrategyDefinition, nowIso: string): StrategyRecord {
  const row = repos.strategies.createWithVersion(
    {
      id: randomUUID(),
      name: def.name,
      sport: def.sport,
      mode: 'dry_run',
      kill_switch: 1,
      current_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
    },
    { ...payloadColumns(def), created_at: nowIso },
  );
  return toRecord(row, payloadOf(def));
}

/**
 * Applies an edit: a changed name updates the row; changed leagues / rule / sizing / execution add a new
 * version. Returns the strategy and whether a version was created.
 */
export function editStrategy(
  repos: Repositories,
  existing: StrategyRecord,
  def: StrategyDefinition,
  nowIso: string,
): { record: StrategyRecord; versionCreated: boolean } {
  const changed = existing.version === null || versionedPartsDiffer(existing.version, def);
  if (changed) {
    const row = repos.strategies.addVersion(
      existing.id,
      { name: def.name, updated_at: nowIso },
      { ...payloadColumns(def), created_at: nowIso },
    );
    if (!row) throw new Error(`strategy ${existing.id} vanished during the edit`);
    return { record: toRecord(row, payloadOf(def)), versionCreated: true };
  }
  if (def.name === existing.name) return { record: existing, versionCreated: false };
  const row = repos.strategies.update({ id: existing.id }, { name: def.name, updated_at: nowIso });
  if (!row) throw new Error(`strategy ${existing.id} vanished during the edit`);
  return { record: toRecord(row, existing.version), versionCreated: false };
}

/** Reads the global switches from the database (never cached, SPEC.md §4). */
export function readGlobalSwitches(repos: Repositories, allowLiveOrders: boolean): GlobalSwitches {
  return {
    globalKill: repos.settings.get('global_kill_switch'),
    globalDryRun: repos.settings.get('global_dry_run'),
    allowLiveOrders,
  };
}

export function strategyMode(s: Pick<StrategyRecord, 'killSwitch' | 'mode'>, g: GlobalSwitches): ModeResult {
  return effectiveMode({ ...g, strategyKill: s.killSwitch, strategyMode: s.mode });
}

/** The `mode` of a strategy's audit rows and log lines: what it trades as once running. */
export function strategyRunningMode(s: Pick<StrategyRecord, 'mode'>, g: GlobalSwitches): 'live' | 'dry_run' {
  return runningMode({
    allowLiveOrders: g.allowLiveOrders,
    globalDryRun: g.globalDryRun,
    strategyMode: s.mode,
  });
}

/** A strategy armed on a game card: running (not paused), with its configured and effective mode. */
export interface ArmedStrategy {
  id: string;
  name: string;
  configuredMode: ConfiguredMode;
  effectiveMode: 'live' | 'dry_run';
  modeReason: ModeResult['reason'];
}

/**
 * Strategies that would be evaluated for a game of `leagueId` / `sport` right now (effective mode not
 * `paused`, league and sport match), for the dashboard's live game cards.
 */
export function armedStrategies(
  strategies: readonly StrategyRecord[],
  g: GlobalSwitches,
  leagueId: string,
  sport: string,
): ArmedStrategy[] {
  const out: ArmedStrategy[] = [];
  for (const s of strategies) {
    if (s.deletedAt !== null || s.version === null || s.sport !== sport) continue;
    if (!s.version.leagueIds.includes(leagueId)) continue;
    const m = strategyMode(s, g);
    if (m.mode === 'paused') continue;
    out.push({ id: s.id, name: s.name, configuredMode: s.mode, effectiveMode: m.mode, modeReason: m.reason });
  }
  return out;
}

/** Per-mode trade count and realized P&L (never summed across modes). */
export interface ModeStats {
  trades: number;
  pnlMicros: number;
}

/** A strategy as the API and the Strategies page see it. */
export interface StrategyView {
  id: string;
  name: string;
  sport: StrategySport;
  leagueIds: string[];
  mode: ConfiguredMode;
  killSwitch: boolean;
  effectiveMode: ModeResult['mode'];
  modeReason: ModeResult['reason'];
  /** What it trades as once running (both kill switches ignored). */
  runningMode: 'live' | 'dry_run';
  currentVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  rule: VersionPayload['rule'] | null;
  sizing: VersionPayload['sizing'] | null;
  execution: VersionPayload['execution'] | null;
  /** Trades triggered in the last 30 days, per effective mode. */
  last30d: { live: ModeStats; dry_run: ModeStats };
}

export const STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function last30d(repos: Repositories, strategyId: string, nowMs: number): StrategyView['last30d'] {
  const out = { live: { trades: 0, pnlMicros: 0 }, dry_run: { trades: 0, pnlMicros: 0 } };
  const since = new Date(nowMs - STATS_WINDOW_MS).toISOString();
  for (const t of repos.trades.list(
    and(eq(trades.strategy_id, strategyId), gte(trades.triggered_at, since)),
  )) {
    const bucket =
      t.effective_mode === 'live' ? out.live : t.effective_mode === 'dry_run' ? out.dry_run : null;
    if (!bucket) continue;
    bucket.trades += 1;
    bucket.pnlMicros += t.realized_pnl_micros ?? 0;
  }
  return out;
}

export function strategyView(
  repos: Repositories,
  s: StrategyRecord,
  g: GlobalSwitches,
  nowMs: number,
): StrategyView {
  const m = strategyMode(s, g);
  return {
    id: s.id,
    name: s.name,
    sport: s.sport,
    leagueIds: s.version?.leagueIds ?? [],
    mode: s.mode,
    killSwitch: s.killSwitch,
    effectiveMode: m.mode,
    modeReason: m.reason,
    runningMode: strategyRunningMode(s, g),
    currentVersion: s.currentVersion,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    deletedAt: s.deletedAt,
    rule: s.version?.rule ?? null,
    sizing: s.version?.sizing ?? null,
    execution: s.version?.execution ?? null,
    last30d: last30d(repos, s.id, nowMs),
  };
}

export function strategyViews(
  repos: Repositories,
  g: GlobalSwitches,
  nowMs: number,
  includeDeleted = false,
): StrategyView[] {
  return loadStrategies(repos, includeDeleted).map((s) => strategyView(repos, s, g, nowMs));
}
