/**
 * Shared chart style tokens (SPEC.md §8): every Recharts chart draws live series solid and dry-run
 * series dashed (lines) or hatched (bars), and its legend says "Live" or "Dry run". The palette is read
 * from the design tokens (the `--chart-*` CSS variables in public/assets/tokens.css), so it follows the
 * colour scheme (light / dark); charts take it from `useChartPalette()` and put `<ChartDefs />` (the hatch
 * patterns) inside the chart.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { Mode } from './ModeBadge';

export interface ChartPalette {
  scheme: 'light' | 'dark';
  live: string;
  dryRun: string;
  positive: string;
  negative: string;
  /** Void settlements (trades-per-minute outcome colours). */
  neutral: string;
  /** Filled, not yet settled. */
  open: string;
  grid: string;
  axis: string;
  /** Tooltip / reference line text. */
  text: string;
  tooltipBg: string;
  /** One colour per compared backtest run (Backtest page only). */
  backtest: readonly string[];
  /** Tick and legend text size in px. */
  fontSize: number;
}

/** Legend / tooltip name of each mode; every series name starts with one of these. */
export const MODE_LABEL: Record<Mode, string> = { live: 'Live', dry_run: 'Dry run' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeScheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

const isDark = () => typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;

/** The chart palette from the current values of the design tokens. */
export function readChartPalette(scheme: ChartPalette['scheme']): ChartPalette {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  // Outside a browser (server rendering, unit tests) the marks fall back to the text colour.
  const token = (name: string) => style?.getPropertyValue(`--chart-${name}`).trim() || 'currentColor';
  return {
    scheme,
    live: token('live'),
    dryRun: token('dry-run'),
    positive: token('positive'),
    negative: token('negative'),
    neutral: token('neutral'),
    open: token('open'),
    grid: token('grid'),
    axis: token('axis'),
    text: token('text'),
    tooltipBg: token('tooltip-bg'),
    backtest: [token('backtest-1'), token('backtest-2'), token('backtest-3')],
    fontSize: Number.parseFloat(token('font-size')) || 12,
  };
}

/** The palette for the current colour scheme; re-renders when the scheme changes. */
export function useChartPalette(): ChartPalette {
  const dark = useSyncExternalStore(subscribeScheme, isDark, () => false);
  return useMemo(() => readChartPalette(dark ? 'dark' : 'light'), [dark]);
}

/** Axis props: a quiet axis line, readable tick labels. */
export const axisProps = (p: ChartPalette) => ({
  stroke: p.grid,
  tick: { fill: p.axis, fontSize: p.fontSize },
  tickLine: { stroke: p.grid },
});

export const legendProps = (p: ChartPalette) => ({ wrapperStyle: { fontSize: p.fontSize } });

/** Style of Recharts' default tooltip box. */
export const tooltipContentStyle = (p: ChartPalette) => ({
  background: p.tooltipBg,
  border: 'none',
  color: p.text,
  fontSize: p.fontSize + 2,
});

/** Hatch pattern id for a palette colour key (dry-run bars). */
export const hatchId = (key: HatchKey) => `kst-hatch-${key}`;
export type HatchKey = 'dryRun' | 'positive' | 'negative' | 'neutral' | 'open';
const HATCH_KEYS: readonly HatchKey[] = ['dryRun', 'positive', 'negative', 'neutral', 'open'];

/** A bar fill: solid colour for live, the matching hatch pattern for dry run. */
export function barFill(mode: Mode, key: HatchKey | 'live', palette: ChartPalette): string {
  if (mode === 'live') return key === 'dryRun' || key === 'live' ? palette.live : palette[key];
  return `url(#${hatchId(key === 'live' ? 'dryRun' : key)})`;
}

/** Line/area props for a mode's series. */
export const lineStyle = (mode: Mode, palette: ChartPalette) => ({
  stroke: mode === 'live' ? palette.live : palette.dryRun,
  strokeWidth: 2,
  ...(mode === 'dry_run' ? { strokeDasharray: '6 4' } : {}),
});

/** Bar props for a mode's series. */
export const barStyle = (mode: Mode, palette: ChartPalette) => ({
  stroke: mode === 'live' ? palette.live : palette.dryRun,
  fill: barFill(mode, 'live', palette),
});

/** SVG definitions every chart with dry-run bars includes (one diagonal hatch per colour). */
export function ChartDefs({ palette }: { palette: ChartPalette }) {
  return (
    <defs>
      {HATCH_KEYS.map((key) => (
        <pattern
          key={key}
          id={hatchId(key)}
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill={palette[key]} fillOpacity="0.18" />
          <line x1="0" y1="0" x2="0" y2="6" stroke={palette[key]} strokeWidth="2" />
        </pattern>
      ))}
    </defs>
  );
}
