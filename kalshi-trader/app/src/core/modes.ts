/**
 * Effective mode from the five switches (SPEC.md §1 "Switches and effective mode"). Pure and table-tested;
 * callers read the switches from the database on every evaluation and before every order attempt
 * (`allowLiveOrders` comes from the process configuration).
 *
 * ```
 * if global_kill_switch            → paused
 * else if strategy.kill_switch     → paused
 * else if !allow_live_orders       → dry_run  (addon_lock)
 * else if global_dry_run           → dry_run  (global_dry_run)
 * else if strategy.mode == dry_run → dry_run  (strategy)
 * else                             → live     (null)
 * ```
 */

export type ConfiguredMode = 'dry_run' | 'live';
export type EffectiveMode = 'paused' | 'dry_run' | 'live';
/** Why a strategy runs as dry run (`trades.mode_reason`); `null` when it runs live. */
export type DryRunReason = 'addon_lock' | 'global_dry_run' | 'strategy';
/** Why a strategy is paused. */
export type PauseReason = 'global_kill_switch' | 'strategy_kill_switch';

export type ModeResult =
  | { mode: 'paused'; reason: PauseReason }
  | { mode: 'dry_run'; reason: DryRunReason }
  | { mode: 'live'; reason: null };

export interface ModeSwitches {
  globalKill: boolean;
  strategyKill: boolean;
  allowLiveOrders: boolean;
  globalDryRun: boolean;
  strategyMode: ConfiguredMode;
}

export function effectiveMode(s: ModeSwitches): ModeResult {
  if (s.globalKill) return { mode: 'paused', reason: 'global_kill_switch' };
  if (s.strategyKill) return { mode: 'paused', reason: 'strategy_kill_switch' };
  if (!s.allowLiveOrders) return { mode: 'dry_run', reason: 'addon_lock' };
  if (s.globalDryRun) return { mode: 'dry_run', reason: 'global_dry_run' };
  if (s.strategyMode === 'dry_run') return { mode: 'dry_run', reason: 'strategy' };
  return { mode: 'live', reason: null };
}

/**
 * The mode a strategy trades in once it runs (both kill switches ignored): the `mode` of its audit rows and
 * log lines, which must be `live` or `dry_run` even while it is paused.
 */
export function runningMode(s: Omit<ModeSwitches, 'globalKill' | 'strategyKill'>): 'live' | 'dry_run' {
  return effectiveMode({ ...s, globalKill: false, strategyKill: false }).mode === 'live' ? 'live' : 'dry_run';
}
