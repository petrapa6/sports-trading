export type Mode = 'live' | 'dry_run';
/** Why a strategy configured `live` runs as dry run (`trades.mode_reason`); `null` when it does not. */
export type ModeReason = 'global_dry_run' | 'addon_lock' | 'strategy' | null;

export interface ModeBadgeProps {
  effective: Mode;
  /** The strategy's own setting; defaults to `effective`. */
  configured?: Mode;
  reason?: ModeReason;
}

const REASON_LABEL: Partial<Record<Exclude<ModeReason, null>, string>> = {
  global_dry_run: 'global',
  addon_lock: 'add-on lock',
};

/** `LIVE`, `DRY RUN`, `LIVE → DRY RUN (global)` or `LIVE → DRY RUN (add-on lock)` (SPEC.md §8). */
export function modeBadgeLabel({ effective, configured = effective, reason = null }: ModeBadgeProps): string {
  if (effective === 'live') return 'LIVE';
  const why = reason ? REASON_LABEL[reason] : undefined;
  if (configured === 'live' && why) return `LIVE → DRY RUN (${why})`;
  return 'DRY RUN';
}

/** The mode badge on every trade row, game-card entry, strategy row and log line. */
export function ModeBadge(props: ModeBadgeProps) {
  const label = modeBadgeLabel(props);
  const downgraded = label.includes('→');
  return (
    <span
      className={`mode-badge mode-badge--${props.effective}${downgraded ? ' mode-badge--downgraded' : ''}`}
      data-mode={props.effective}
      title={downgraded ? 'Configured live, running as dry run' : undefined}
    >
      {label}
    </span>
  );
}
