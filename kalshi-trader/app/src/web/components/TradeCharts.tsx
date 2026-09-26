/**
 * Trades page charts (SPEC.md §8, T10): the price-paid histogram and the P&L per trade, split by mode and
 * computed from the trades the page lists, so they follow its filter bar and status filter. Hovering a
 * per-trade bar shows the trade id and its mode.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TradeView } from '../api';
import type { Mode } from './ModeBadge';
import { barFill, ChartDefs, MODE_LABEL, useChartPalette } from './chartStyle';
import { ChartTooltip } from './StatsCharts';
import { formatPrice, formatUsdExact } from '../format';

const HEIGHT = 240;
const SPAN_BP = 1500;
const BIN_BP = 100;
const DEFAULT_MAX_BP = 9700;

const modeOf = (t: TradeView): Mode => (t.effectiveMode === 'live' ? 'live' : 'dry_run');
const hasFill = (t: TradeView) =>
  (t.fillCc ?? 0) > 0 &&
  t.avgFillPriceBp !== null &&
  (t.status === 'filled' || t.status.startsWith('settled_'));

/** 1¢ bins from `maxBp − 15¢` to `maxBp` with a count per mode (fills outside the range are left out). */
export function priceHistogram(rows: readonly TradeView[], maxBp: number): Record<string, number>[] {
  const top = maxBp - (maxBp % BIN_BP);
  const bins = new Map<number, Record<string, number>>();
  for (let bp = top - SPAN_BP; bp <= top; bp += BIN_BP) bins.set(bp, { bp, live: 0, dry_run: 0 });
  for (const t of rows) {
    if (!hasFill(t)) continue;
    const bin = bins.get(Math.floor((t.avgFillPriceBp ?? 0) / BIN_BP) * BIN_BP);
    if (bin) bin[modeOf(t)] = (bin[modeOf(t)] ?? 0) + 1;
  }
  return [...bins.values()];
}

export interface PnlBar {
  id: string;
  mode: Mode;
  live?: number;
  dry_run?: number;
}

/** One bar per settled trade (oldest settlement first), its realized P&L under its own mode. */
export function pnlPerTrade(rows: readonly TradeView[]): PnlBar[] {
  return rows
    .filter((t) => t.realizedPnlMicros !== null && t.settledAt !== null)
    .sort((a, b) => (a.settledAt ?? '').localeCompare(b.settledAt ?? '') || a.id.localeCompare(b.id))
    .map((t) => ({ id: t.id, mode: modeOf(t), [modeOf(t)]: t.realizedPnlMicros ?? 0 }));
}

export function TradeCharts({ rows, maxPriceBp }: { rows: readonly TradeView[]; maxPriceBp: number | null }) {
  const palette = useChartPalette();
  const modes = (['live', 'dry_run'] as const).filter((m) => rows.some((t) => modeOf(t) === m));
  const hist = priceHistogram(rows, maxPriceBp ?? DEFAULT_MAX_BP);
  const fills = hist.reduce((n, b) => n + (b['live'] ?? 0) + (b['dry_run'] ?? 0), 0);
  const pnl = pnlPerTrade(rows);
  const axis = { stroke: palette.axis, tick: { fill: palette.axis, fontSize: 11 } };
  return (
    <div className="chart-grid chart-grid--two">
      <section
        className="card chart-card"
        data-testid="chart-trade-histogram"
        aria-labelledby="trade-hist-title"
      >
        <h3 id="trade-hist-title">Price paid</h3>
        <p className="muted chart-caption">Fill prices of the listed trades in 1¢ bins, grouped by mode.</p>
        {fills === 0 ? (
          <p className="muted chart-empty">No fills among these trades.</p>
        ) : (
          <div className="chart-body">
            <ResponsiveContainer width="100%" height={HEIGHT}>
              <BarChart data={hist} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <ChartDefs palette={palette} />
                <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
                <XAxis dataKey="bp" tickFormatter={(bp: number) => formatPrice(bp)} {...axis} />
                <YAxis allowDecimals={false} width={40} {...axis} />
                <Tooltip
                  content={
                    <ChartTooltip
                      formatLabel={(l) => `${formatPrice(Number(l))} – ${formatPrice(Number(l) + 99)}`}
                      formatValue={(v) => String(v)}
                    />
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {modes.map((mode) => (
                  <Bar
                    key={mode}
                    dataKey={mode}
                    name={MODE_LABEL[mode]}
                    isAnimationActive={false}
                    fill={barFill(mode, 'live', palette)}
                    stroke={mode === 'live' ? palette.live : palette.dryRun}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
      <section className="card chart-card" data-testid="chart-trade-pnl" aria-labelledby="trade-pnl-title">
        <h3 id="trade-pnl-title">P&amp;L per trade</h3>
        <p className="muted chart-caption">
          Realized P&amp;L of each settled trade in the list, by settlement time.
        </p>
        {pnl.length === 0 ? (
          <p className="muted chart-empty">No settled trades in the list.</p>
        ) : (
          <div className="chart-body">
            <ResponsiveContainer width="100%" height={HEIGHT}>
              <BarChart data={pnl} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <ChartDefs palette={palette} />
                <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
                <XAxis dataKey="id" tick={false} {...{ stroke: palette.axis }} />
                <YAxis tickFormatter={(v: number) => formatUsdExact(v)} width={80} {...axis} />
                <ReferenceLine y={0} stroke={palette.axis} />
                <Tooltip
                  content={({ active, payload }) => {
                    const bar = payload?.[0]?.payload as PnlBar | undefined;
                    if (!active || !bar) return null;
                    const v = bar[bar.mode] ?? 0;
                    return (
                      <div className="chart-tooltip" role="status" data-testid="trade-pnl-tooltip">
                        <div className="chart-tooltip-label">Trade {bar.id}</div>
                        <div className="chart-tooltip-row">
                          {MODE_LABEL[bar.mode]}: <strong>{formatUsdExact(v)}</strong>
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {modes.map((mode) => (
                  <Bar
                    key={mode}
                    dataKey={mode}
                    name={MODE_LABEL[mode]}
                    isAnimationActive={false}
                    fill={barFill(mode, 'live', palette)}
                    stroke={mode === 'live' ? palette.live : palette.dryRun}
                  >
                    {pnl.map((b) => {
                      const key = (b[mode] ?? 0) < 0 ? 'negative' : 'positive';
                      return <Cell key={b.id} fill={barFill(mode, key, palette)} stroke={palette[key]} />;
                    })}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}
