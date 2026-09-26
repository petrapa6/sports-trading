/**
 * Shared chart style tokens (SPEC.md §8): every Recharts chart draws live series solid and dry-run
 * series dashed (lines) or hatched (bars), and its legend says "Live" or "Dry run". The palette follows
 * the colour scheme (light / dark); charts take it from `useChartPalette()` and put `<ChartDefs />`
 * (the hatch patterns) inside the chart.
 */
import { useSyncExternalStore } from 'react';
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
}

export const LIGHT_PALETTE: ChartPalette = {
  scheme: 'light',
  live: '#2563eb',
  dryRun: '#8b5cf6',
  positive: '#16a34a',
  negative: '#dc2626',
  neutral: '#6b7280',
  open: '#d97706',
  grid: 'rgba(127, 127, 127, 0.25)',
  axis: '#5f6673',
  text: '#16181d',
};

export const DARK_PALETTE: ChartPalette = {
  scheme: 'dark',
  live: '#60a5fa',
  dryRun: '#c4b5fd',
  positive: '#4ade80',
  negative: '#f87171',
  neutral: '#9ca3af',
  open: '#fbbf24',
  grid: 'rgba(160, 160, 160, 0.2)',
  axis: '#9aa2b1',
  text: '#e7e9ee',
};

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

/** The palette for the current colour scheme; re-renders when the scheme changes. */
export function useChartPalette(): ChartPalette {
  const dark = useSyncExternalStore(subscribeScheme, isDark, () => false);
  return dark ? DARK_PALETTE : LIGHT_PALETTE;
}

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
export const lineStyle = (mode: Mode, palette: ChartPalette = LIGHT_PALETTE) => ({
  stroke: mode === 'live' ? palette.live : palette.dryRun,
  strokeWidth: 2,
  ...(mode === 'dry_run' ? { strokeDasharray: '6 4' } : {}),
});

/** Bar props for a mode's series. */
export const barStyle = (mode: Mode, palette: ChartPalette = LIGHT_PALETTE) => ({
  stroke: mode === 'live' ? palette.live : palette.dryRun,
  fill: barFill(mode, 'live', palette),
});

/** SVG definitions every chart with dry-run bars includes (one diagonal hatch per colour). */
export function ChartDefs({ palette = LIGHT_PALETTE }: { palette?: ChartPalette }) {
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
