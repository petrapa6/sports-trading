/**
 * Shared chart style tokens (SPEC.md §8): every Recharts chart draws live series solid and dry-run
 * series dashed (lines) or hatched (bars), and its legend says "Live" or "Dry run". Later tickets
 * spread these into `<Line>`, `<Bar>` and `<Area>` and put `<ChartDefs />` inside the chart.
 */
import type { Mode } from './ModeBadge';

export interface ModeSeriesStyle {
  /** Legend and tooltip name. */
  name: string;
  stroke: string;
  strokeWidth: number;
  /** `undefined` = solid. */
  strokeDasharray: string | undefined;
  /** Bar/area fill: solid colour for live, the hatch pattern for dry run. */
  fill: string;
  fillOpacity: number;
  /** Scatter markers: filled for live, hollow for dry run. */
  markerFill: string;
}

export const CHART_COLORS = {
  live: '#2563eb',
  dryRun: '#8b5cf6',
  positive: '#16a34a',
  negative: '#dc2626',
  grid: 'rgba(127, 127, 127, 0.25)',
} as const;

export const HATCH_ID = 'kst-hatch-dry-run';

export const MODE_SERIES_STYLE: Record<Mode, ModeSeriesStyle> = {
  live: {
    name: 'Live',
    stroke: CHART_COLORS.live,
    strokeWidth: 2,
    strokeDasharray: undefined,
    fill: CHART_COLORS.live,
    fillOpacity: 0.85,
    markerFill: CHART_COLORS.live,
  },
  dry_run: {
    name: 'Dry run',
    stroke: CHART_COLORS.dryRun,
    strokeWidth: 2,
    strokeDasharray: '6 4',
    fill: `url(#${HATCH_ID})`,
    fillOpacity: 1,
    markerFill: 'none',
  },
};

/** Line/area props for a mode's series. */
export const lineStyle = (mode: Mode) => {
  const s = MODE_SERIES_STYLE[mode];
  return {
    name: s.name,
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    ...(s.strokeDasharray ? { strokeDasharray: s.strokeDasharray } : {}),
  };
};

/** Bar props for a mode's series. */
export const barStyle = (mode: Mode) => {
  const s = MODE_SERIES_STYLE[mode];
  return { name: s.name, stroke: s.stroke, fill: s.fill, fillOpacity: s.fillOpacity };
};

/** SVG definitions every chart with dry-run bars includes (the diagonal hatch pattern). */
export function ChartDefs() {
  return (
    <defs>
      <pattern id={HATCH_ID} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <rect width="6" height="6" fill={CHART_COLORS.dryRun} fillOpacity="0.15" />
        <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.dryRun} strokeWidth="2" />
      </pattern>
    </defs>
  );
}
