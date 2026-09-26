import type { Mode } from './ModeBadge';
import { MODE_LABEL } from './chartStyle';
import { formatPrice, formatUsd, formatUsdExact } from '../format';
import { modesOf, type ModeTiles, type StatsResponse } from '../stats';

/** A fraction as a percentage with one decimal (`0.1149` → `11.5 %`). */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)} %`;
}

interface TileDef {
  id: string;
  label: string;
  value: (t: ModeTiles, mode: Mode) => string;
  hint?: (t: ModeTiles, mode: Mode) => string;
}

const decided = (t: ModeTiles) => t.won + t.lost;

/** §6 Metrics as Dashboard tiles; every tile shows one value per mode, never a sum of both. */
export const TILES: TileDef[] = [
  {
    id: 'trades',
    label: 'Trades (settled)',
    value: (t) => String(t.trades),
    hint: (t) => `${t.filled} with a fill`,
  },
  {
    id: 'win-rate',
    label: 'Win rate',
    value: (t) => (decided(t) === 0 ? '—' : formatPct(t.winRate)),
    hint: (t) => `${t.won} won · ${t.lost} lost · ${t.void} void`,
  },
  {
    id: 'net-pnl',
    label: 'Net P&L',
    value: (t) => formatUsd(t.netPnlMicros),
    hint: (t) => `on ${formatUsd(t.investedMicros)} invested`,
  },
  { id: 'roi', label: 'ROI', value: (t) => (t.investedMicros === 0 ? '—' : formatPct(t.roi)) },
  { id: 'max-drawdown', label: 'Max drawdown', value: (t) => formatUsd(t.maxDrawdownMicros) },
  { id: 'avg-price', label: 'Avg price', value: (t) => (t.filled === 0 ? '—' : formatPrice(t.avgPriceBp)) },
  { id: 'avg-fee', label: 'Avg fee', value: (t) => (t.filled === 0 ? '—' : formatUsdExact(t.avgFeeMicros)) },
  {
    id: 'implied-vs-actual',
    label: 'Implied vs actual',
    value: (t) =>
      t.impliedVsActual.n === 0
        ? '—'
        : `${formatPct(t.impliedVsActual.impliedBp / 10_000)} / ${formatPct(t.impliedVsActual.actualWinRate)}`,
    hint: (t) => `mean price paid / win rate, n = ${t.impliedVsActual.n}`,
  },
  {
    id: 'forced-dry-run',
    label: 'Forced dry run',
    value: (t, mode) =>
      mode === 'live' || !t.forcedDryRun
        ? 'n/a'
        : t.forcedDryRun.total === 0
          ? '—'
          : formatPct(t.forcedDryRun.share),
    hint: (t, mode) =>
      mode === 'live' || !t.forcedDryRun
        ? 'dry run only'
        : `${t.forcedDryRun.forced} of ${t.forcedDryRun.total} configured live`,
  },
];

/** The Dashboard tiles: with mode = both, two values side by side (Live | Dry run). */
export function StatsTiles({ stats, loading }: { stats: StatsResponse | undefined; loading: boolean }) {
  if (!stats) {
    return (
      <section className="card" aria-label="Metrics">
        <p className="muted">{loading ? 'Loading metrics…' : 'Could not load the metrics.'}</p>
      </section>
    );
  }
  const modes = modesOf(stats);
  return (
    <section className="stats-tiles" aria-label="Metrics" data-testid="stats-tiles">
      {TILES.map((def) => (
        <div key={def.id} className="stat-tile" data-testid={`tile-${def.id}`}>
          <div className="stat-label">{def.label}</div>
          <div className={`stat-values stat-values--${modes.length}`}>
            {modes.map((mode) => {
              const t = stats[mode];
              if (!t) return null;
              return (
                <div key={mode} className={`stat-value stat-value--${mode}`} data-mode={mode}>
                  <span className="stat-mode">{MODE_LABEL[mode]}</span>
                  <strong className="stat-number">{def.value(t.tiles, mode)}</strong>
                  {def.hint && <span className="stat-hint muted">{def.hint(t.tiles, mode)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
