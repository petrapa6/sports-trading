/**
 * The eight Dashboard charts of SPEC.md §8 (Chart inventory, T10). Every chart takes the same `{ stats }`
 * props (the `GET /api/stats` response for the current filters), draws each mode separately — live solid,
 * dry run dashed or hatched, legends "Live" / "Dry run" — and never sums the two. Each chart has its own
 * loading and empty state; the palette follows the colour scheme.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { Mode } from './ModeBadge';
import { barFill, ChartDefs, lineStyle, MODE_LABEL, useChartPalette, type ChartPalette } from './chartStyle';
import { formatPrice, formatUsd } from '../format';
import { modesOf, type StatsResponse } from '../stats';

export interface ChartProps {
  stats: StatsResponse | undefined;
  loading: boolean;
}

const HEIGHT = 260;

// ---- shared pieces -------------------------------------------------------------------------------------

type Formatter = (value: number) => string;

const usd: Formatter = (v) => formatUsd(v);
const count: Formatter = (v) => String(v);
const pct: Formatter = (v) => `${(v * 100).toFixed(1)} %`;
const dateTime = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const dateOnly = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

interface TooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: string | number | ((obj: unknown) => unknown);
  payload?: Record<string, unknown>;
}

/**
 * The one tooltip format of every chart: a heading (the x value) and one line per series, each named by
 * its series name, which always starts with the mode ("Live …" / "Dry run …").
 */
export function ChartTooltip({
  active,
  payload,
  label,
  formatLabel,
  formatValue,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: unknown;
  formatLabel: (label: unknown, payload: readonly TooltipEntry[]) => ReactNode;
  formatValue: Formatter;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => typeof p.value === 'number');
  if (rows.length === 0) return null;
  return (
    <div className="chart-tooltip" role="status">
      <div className="chart-tooltip-label">{formatLabel(label, payload)}</div>
      {rows.map((p, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-swatch" style={{ background: p.color }} />
          {String(p.name)}: <strong>{formatValue(p.value as number)}</strong>
        </div>
      ))}
    </div>
  );
}

/** A chart card: title, caption, loading / error / empty state, and the chart itself. */
function ChartCard({
  id,
  title,
  caption,
  loading,
  failed,
  empty,
  actions,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  loading: boolean;
  failed: boolean;
  empty: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card chart-card" data-testid={`chart-${id}`} aria-labelledby={`chart-${id}-title`}>
      <div className="section-head">
        <h3 id={`chart-${id}-title`}>{title}</h3>
        {actions}
      </div>
      {caption && <p className="muted chart-caption">{caption}</p>}
      {loading ? (
        <p className="muted chart-empty">Loading…</p>
      ) : failed ? (
        <p className="muted chart-empty">Could not load the data.</p>
      ) : empty ? (
        <p className="muted chart-empty" data-testid={`chart-${id}-empty`}>
          No data for these filters.
        </p>
      ) : (
        <div className="chart-body">
          <ResponsiveContainer width="100%" height={HEIGHT}>
            {children as ReactElement}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

const axisProps = (p: ChartPalette) => ({
  stroke: p.axis,
  tick: { fill: p.axis, fontSize: 11 },
  tickLine: { stroke: p.axis },
});

const legendProps = { wrapperStyle: { fontSize: 12 } };

/** Merges point series into one row per x (for shared tooltips); `key` becomes the row field. */
function mergeByX(series: { key: string; points: { x: number; y: number }[] }[]): Record<string, number>[] {
  const rows = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const p of s.points) {
      const row = rows.get(p.x) ?? { x: p.x };
      row[s.key] = p.y;
      rows.set(p.x, row);
    }
  }
  return [...rows.values()].sort((a, b) => (a['x'] ?? 0) - (b['x'] ?? 0));
}

const ms = (iso: string) => Date.parse(iso);
const modeKey = (mode: Mode, suffix?: string) => (suffix ? `${mode}:${suffix}` : mode);

function useChartBasics(props: ChartProps) {
  const palette = useChartPalette();
  const modes = props.stats ? modesOf(props.stats) : [];
  return { palette, modes, stats: props.stats };
}

const cardState = (props: ChartProps) => ({
  loading: props.loading && !props.stats,
  failed: !props.loading && !props.stats,
});

// ---- 1. Equity curve -------------------------------------------------------------------------------

export function EquityChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const series: {
    key: string;
    name: string;
    mode: Mode;
    kind: 'total' | 'strategy' | 'capital';
    points: { x: number; y: number }[];
  }[] = [];
  for (const mode of modes) {
    const s = stats?.[mode]?.series;
    if (!s) continue;
    series.push({
      key: modeKey(mode),
      name: `${MODE_LABEL[mode]} · all strategies`,
      mode,
      kind: 'total',
      points: s.equity.total.map((p) => ({ x: ms(p.t), y: p.cumMicros })),
    });
    for (const st of s.equity.byStrategy) {
      series.push({
        key: modeKey(mode, st.strategyId),
        name: `${MODE_LABEL[mode]} · ${st.strategyName}`,
        mode,
        kind: 'strategy',
        points: st.points.map((p) => ({ x: ms(p.t), y: p.cumMicros })),
      });
    }
    if (s.bankroll) {
      series.push({
        key: modeKey(mode, '__bankroll'),
        name: 'Dry run bankroll',
        mode,
        kind: 'capital',
        points: s.bankroll.map((p) => ({ x: ms(p.t), y: p.micros })),
      });
    }
    if (s.balance) {
      series.push({
        key: modeKey(mode, '__balance'),
        name: 'Live Kalshi balance',
        mode,
        kind: 'capital',
        points: s.balance
          .filter((p) => p.cashMicros !== null)
          .map((p) => ({ x: ms(p.t), y: p.cashMicros ?? 0 })),
      });
    }
  }
  const pnlPoints = series.filter((s) => s.kind !== 'capital').reduce((n, s) => n + s.points.length, 0);
  const data = mergeByX(series);
  const hasCapital = series.some((s) => s.kind === 'capital' && s.points.length > 0);
  return (
    <ChartCard
      id="equity"
      title="Equity curve"
      caption="Cumulative realized P&L by settlement time (left axis); dry-run bankroll and live Kalshi balance (right axis)."
      {...cardState(props)}
      empty={pnlPoints === 0 && !hasCapital}
    >
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={dateOnly}
          {...axisProps(palette)}
        />
        <YAxis yAxisId="pnl" tickFormatter={usd} width={72} {...axisProps(palette)} />
        <YAxis
          yAxisId="capital"
          orientation="right"
          tickFormatter={usd}
          width={72}
          hide={!hasCapital}
          {...axisProps(palette)}
        />
        <Tooltip content={<ChartTooltip formatLabel={(l) => dateTime(Number(l))} formatValue={usd} />} />
        <Legend {...legendProps} />
        {series.map((s) => (
          <Line
            key={s.key}
            yAxisId={s.kind === 'capital' ? 'capital' : 'pnl'}
            dataKey={s.key}
            name={s.name}
            type="stepAfter"
            connectNulls
            dot={false}
            isAnimationActive={false}
            {...lineStyle(s.mode, palette)}
            strokeWidth={s.kind === 'total' ? 2.5 : s.kind === 'capital' ? 1.5 : 1}
            strokeOpacity={s.kind === 'strategy' ? 0.55 : 1}
          />
        ))}
      </LineChart>
    </ChartCard>
  );
}

// ---- 2. Daily P&L ----------------------------------------------------------------------------------

export function DailyPnlChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const rows = new Map<string, Record<string, string | number>>();
  const bars: { key: string; name: string; mode: Mode }[] = [];
  for (const mode of modes) {
    const s = stats?.[mode]?.series;
    if (!s) continue;
    const seen = new Map<string, string>();
    for (const e of s.equity.byStrategy) seen.set(e.strategyId, e.strategyName);
    for (const d of s.dailyPnl) {
      const row = rows.get(d.day) ?? { day: d.day };
      for (const b of d.byStrategy) {
        row[modeKey(mode, b.strategyId)] = b.pnlMicros;
        if (!bars.some((x) => x.key === modeKey(mode, b.strategyId))) {
          bars.push({
            key: modeKey(mode, b.strategyId),
            name: `${MODE_LABEL[mode]} · ${seen.get(b.strategyId) ?? b.strategyId}`,
            mode,
          });
        }
      }
      rows.set(d.day, row);
    }
  }
  const data = [...rows.values()].sort((a, b) => String(a['day']).localeCompare(String(b['day'])));
  return (
    <ChartCard
      id="daily-pnl"
      title="Daily P&L"
      caption="Realized P&L per settlement day, stacked by strategy within each mode (live solid, dry run hatched)."
      {...cardState(props)}
      empty={data.length === 0}
    >
      <BarChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickFormatter={(d: string) => dateOnly(Date.parse(d))} {...axisProps(palette)} />
        <YAxis tickFormatter={usd} width={72} {...axisProps(palette)} />
        <ReferenceLine y={0} stroke={palette.axis} />
        <Tooltip content={<ChartTooltip formatLabel={(l) => String(l)} formatValue={usd} />} />
        <Legend {...legendProps} />
        {bars.map((b) => (
          <Bar
            key={b.key}
            dataKey={b.key}
            name={b.name}
            stackId={b.mode}
            isAnimationActive={false}
            fill={barFill(b.mode, 'live', palette)}
            stroke={b.mode === 'live' ? palette.live : palette.dryRun}
          >
            {data.map((row, i) => {
              const v = Number(row[b.key] ?? 0);
              const key = v < 0 ? 'negative' : 'positive';
              return (
                <Cell
                  key={i}
                  fill={barFill(b.mode, key, palette)}
                  stroke={palette[key]}
                  strokeDasharray={b.mode === 'dry_run' ? '3 2' : undefined}
                />
              );
            })}
          </Bar>
        ))}
      </BarChart>
    </ChartCard>
  );
}

// ---- 3. Drawdown -----------------------------------------------------------------------------------

export function DrawdownChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const series = modes.map((mode) => ({
    key: mode,
    mode,
    points: (stats?.[mode]?.series.drawdown ?? []).map((p) => ({ x: ms(p.t), y: -p.drawdownMicros })),
  }));
  const data = mergeByX(series);
  return (
    <ChartCard
      id="drawdown"
      title="Drawdown"
      caption="Drop from the running peak of the equity curve, in dollars (one area per mode)."
      {...cardState(props)}
      empty={data.length === 0}
    >
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={dateOnly}
          {...axisProps(palette)}
        />
        <YAxis tickFormatter={usd} width={72} {...axisProps(palette)} />
        <Tooltip content={<ChartTooltip formatLabel={(l) => dateTime(Number(l))} formatValue={usd} />} />
        <Legend {...legendProps} />
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            name={MODE_LABEL[s.mode]}
            type="stepAfter"
            connectNulls
            isAnimationActive={false}
            {...lineStyle(s.mode, palette)}
            fill={barFill(s.mode, 'live', palette)}
            fillOpacity={s.mode === 'live' ? 0.25 : 1}
          />
        ))}
      </AreaChart>
    </ChartCard>
  );
}

// ---- 4. Implied vs actual --------------------------------------------------------------------------

export function ImpliedVsActualChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const series = modes.map((mode) => ({
    mode,
    points: (stats?.[mode]?.series.impliedVsActual ?? []).map((p) => ({
      ...p,
      label: `${MODE_LABEL[mode]} · ${p.strategyName} · ${p.leagueId}`,
    })),
  }));
  const empty = series.every((s) => s.points.length === 0);
  const minX = Math.min(0.8, ...series.flatMap((s) => s.points.map((p) => Math.floor(p.x * 20) / 20)));
  return (
    <ChartCard
      id="implied-vs-actual"
      title="Implied vs actual"
      caption="Mean price paid (implied probability) against the actual win rate, one point per strategy and league; point size = trades. Above the diagonal = edge."
      {...cardState(props)}
      empty={empty}
    >
      <ScatterChart margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type="number"
          name="Mean price"
          domain={[minX, 1]}
          tickFormatter={pct}
          {...axisProps(palette)}
        />
        <YAxis
          dataKey="y"
          type="number"
          name="Win rate"
          domain={[0, 1]}
          tickFormatter={pct}
          width={56}
          {...axisProps(palette)}
        />
        <ZAxis dataKey="n" type="number" range={[60, 360]} name="Trades" />
        <ReferenceLine
          segment={[
            { x: minX, y: minX },
            { x: 1, y: 1 },
          ]}
          stroke={palette.axis}
          strokeDasharray="4 4"
        />
        <Tooltip
          content={({ active, payload }) => {
            const point = payload?.[0]?.payload as
              { label: string; x: number; y: number; n: number } | undefined;
            if (!active || !point) return null;
            return (
              <div className="chart-tooltip" role="status">
                <div className="chart-tooltip-label">{point.label}</div>
                <div className="chart-tooltip-row">
                  Mean price {pct(point.x)} · win rate {pct(point.y)} · n = {point.n}
                </div>
              </div>
            );
          }}
        />
        <Legend {...legendProps} />
        {series.map((s) => (
          <Scatter
            key={s.mode}
            name={MODE_LABEL[s.mode]}
            data={s.points}
            isAnimationActive={false}
            fill={s.mode === 'live' ? palette.live : 'none'}
            stroke={s.mode === 'live' ? palette.live : palette.dryRun}
            strokeWidth={2}
          />
        ))}
      </ScatterChart>
    </ChartCard>
  );
}

// ---- 5. Price paid distribution --------------------------------------------------------------------

/** One row per 1¢ bin with a count per mode. */
export function histogramRows(stats: StatsResponse, modes: Mode[]): Record<string, number>[] {
  const rows = new Map<number, Record<string, number>>();
  for (const mode of modes) {
    for (const b of stats[mode]?.series.priceHistogram.bins ?? []) {
      const row = rows.get(b.bp) ?? { bp: b.bp };
      row[mode] = b.count;
      rows.set(b.bp, row);
    }
  }
  return [...rows.values()].sort((a, b) => (a['bp'] ?? 0) - (b['bp'] ?? 0));
}

export function PriceHistogramChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const data = stats ? histogramRows(stats, modes) : [];
  const outside = modes.reduce(
    (n, m) =>
      n + (stats?.[m]?.series.priceHistogram.below ?? 0) + (stats?.[m]?.series.priceHistogram.above ?? 0),
    0,
  );
  return (
    <ChartCard
      id="price-histogram"
      title="Price paid distribution"
      caption={`Fill prices in 1¢ bins up to maxPrice, grouped by mode${outside > 0 ? ` (${outside} fills outside the range not shown)` : ''}.`}
      {...cardState(props)}
      empty={data.length === 0}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="bp" tickFormatter={(bp: number) => formatPrice(bp)} {...axisProps(palette)} />
        <YAxis allowDecimals={false} width={40} {...axisProps(palette)} />
        <Tooltip
          content={
            <ChartTooltip
              formatLabel={(l) => `${formatPrice(Number(l))} – ${formatPrice(Number(l) + 99)}`}
              formatValue={count}
            />
          }
        />
        <Legend {...legendProps} />
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
    </ChartCard>
  );
}

// ---- 6. Trades per minute triggered ----------------------------------------------------------------

const OUTCOMES = [
  { key: 'won', label: 'won', color: 'positive' },
  { key: 'lost', label: 'lost', color: 'negative' },
  { key: 'void', label: 'void', color: 'neutral' },
  { key: 'open', label: 'open', color: 'open' },
] as const;

export function TradesPerMinuteChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const rows = new Map<number, Record<string, number>>();
  for (const mode of modes) {
    for (const m of stats?.[mode]?.series.tradesPerMinute ?? []) {
      const row = rows.get(m.minute) ?? { minute: m.minute };
      for (const o of OUTCOMES) if (m[o.key] > 0) row[modeKey(mode, o.key)] = m[o.key];
      rows.set(m.minute, row);
    }
  }
  const data = [...rows.values()].sort((a, b) => (a['minute'] ?? 0) - (b['minute'] ?? 0));
  return (
    <ChartCard
      id="trades-per-minute"
      title="Trades per minute triggered"
      caption="Filled trades by clock minute at entry, coloured by outcome, one stack per mode."
      {...cardState(props)}
      empty={data.length === 0}
    >
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis dataKey="minute" tickFormatter={(m: number) => `${m}'`} {...axisProps(palette)} />
        <YAxis allowDecimals={false} width={40} {...axisProps(palette)} />
        <Tooltip content={<ChartTooltip formatLabel={(l) => `Minute ${String(l)}`} formatValue={count} />} />
        <Legend {...legendProps} />
        {modes.flatMap((mode) =>
          OUTCOMES.map((o) => (
            <Bar
              key={modeKey(mode, o.key)}
              dataKey={modeKey(mode, o.key)}
              name={`${MODE_LABEL[mode]} · ${o.label}`}
              stackId={mode}
              isAnimationActive={false}
              fill={barFill(mode, o.color, palette)}
              stroke={palette[o.color]}
            />
          )),
        )}
      </BarChart>
    </ChartCard>
  );
}

// ---- 7. Skip reasons -------------------------------------------------------------------------------

export function SkipReasonsChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const [kind, setKind] = useState<'final' | 'perAttempt'>('final');
  const rows = new Map<string, Record<string, string | number>>();
  for (const mode of modes) {
    for (const r of stats?.[mode]?.series.skipReasons[kind] ?? []) {
      const row = rows.get(r.reason) ?? { reason: r.reason.replaceAll('_', ' ') };
      row[mode] = r.count;
      rows.set(r.reason, row);
    }
  }
  const data = [...rows.values()].sort(
    (a, b) =>
      Number(b['live'] ?? 0) + Number(b['dry_run'] ?? 0) - Number(a['live'] ?? 0) - Number(a['dry_run'] ?? 0),
  );
  return (
    <ChartCard
      id="skip-reasons"
      title="Skip reasons"
      caption={
        kind === 'final'
          ? 'Trades that ended skipped, per reason and mode.'
          : 'Attempts blocked by a guard or left unfilled, per reason and mode.'
      }
      {...cardState(props)}
      empty={data.length === 0}
      actions={
        <div className="segmented small" role="group" aria-label="Skip counts">
          <button
            type="button"
            className={kind === 'final' ? 'active' : undefined}
            aria-pressed={kind === 'final'}
            onClick={() => setKind('final')}
          >
            Final
          </button>
          <button
            type="button"
            className={kind === 'perAttempt' ? 'active' : undefined}
            aria-pressed={kind === 'perAttempt'}
            onClick={() => setKind('perAttempt')}
          >
            Per attempt
          </button>
        </div>
      }
    >
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <ChartDefs palette={palette} />
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis type="number" allowDecimals={false} {...axisProps(palette)} />
        <YAxis type="category" dataKey="reason" width={96} {...axisProps(palette)} />
        <Tooltip content={<ChartTooltip formatLabel={(l) => String(l)} formatValue={count} />} />
        <Legend {...legendProps} />
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
    </ChartCard>
  );
}

// ---- 8. Balance history ----------------------------------------------------------------------------

export function BalanceHistoryChart(props: ChartProps) {
  const { palette, modes, stats } = useChartBasics(props);
  const series: { key: string; name: string; mode: Mode; points: { x: number; y: number }[] }[] = [];
  for (const mode of modes) {
    const s = stats?.[mode]?.series;
    if (s?.balance) {
      series.push({
        key: 'live',
        name: 'Live Kalshi balance',
        mode,
        points: s.balance
          .filter((p) => p.cashMicros !== null)
          .map((p) => ({ x: ms(p.t), y: p.cashMicros ?? 0 })),
      });
    }
    if (s?.bankroll) {
      series.push({
        key: 'dry_run',
        name: 'Dry run bankroll',
        mode,
        points: s.bankroll.map((p) => ({ x: ms(p.t), y: p.micros })),
      });
    }
  }
  const data = mergeByX(series);
  return (
    <ChartCard
      id="balance-history"
      title="Balance history"
      caption="Live Kalshi cash balance (balance snapshots) and the shared dry-run bankroll (bankroll snapshots), never added together."
      {...cardState(props)}
      empty={data.length === 0}
    >
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={dateOnly}
          {...axisProps(palette)}
        />
        <YAxis tickFormatter={usd} width={80} domain={['auto', 'auto']} {...axisProps(palette)} />
        <Tooltip content={<ChartTooltip formatLabel={(l) => dateTime(Number(l))} formatValue={usd} />} />
        <Legend {...legendProps} />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.name}
            type="stepAfter"
            connectNulls
            dot={false}
            isAnimationActive={false}
            {...lineStyle(s.mode, palette)}
          />
        ))}
      </LineChart>
    </ChartCard>
  );
}

/** All eight charts of the chart inventory, in a responsive grid. */
export function StatsCharts(props: ChartProps) {
  return (
    <div className="chart-grid" data-testid="stats-charts">
      <EquityChart {...props} />
      <DailyPnlChart {...props} />
      <DrawdownChart {...props} />
      <ImpliedVsActualChart {...props} />
      <PriceHistogramChart {...props} />
      <TradesPerMinuteChart {...props} />
      <SkipReasonsChart {...props} />
      <BalanceHistoryChart {...props} />
    </div>
  );
}
