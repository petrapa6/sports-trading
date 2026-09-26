/**
 * Backtest charts (SPEC.md §8 Backtest page, §9 Output, T12): equity curve, drawdown and monthly P&L of one run,
 * and the equity lines of up to three saved runs side by side. Backtests are their own category: these charts
 * never show live or dry-run data, and their legends name the run ("Backtest …"), never "Live" / "Dry run".
 */
import type { ReactElement, ReactNode } from 'react';
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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestDetail, BacktestSummary } from '../api';
import { formatUsd } from '../format';
import { useChartPalette, type ChartPalette } from './chartStyle';

const HEIGHT = 260;

/** Colours of the backtest series (one per compared run), light and dark. */
export const BACKTEST_COLORS: Record<ChartPalette['scheme'], readonly string[]> = {
  light: ['#0d9488', '#ea580c', '#db2777'],
  dark: ['#2dd4bf', '#fb923c', '#f472b6'],
};

const axisProps = (p: ChartPalette) => ({
  stroke: p.axis,
  tick: { fill: p.axis, fontSize: 11 },
  tickLine: { stroke: p.axis },
});
const legendProps = { wrapperStyle: { fontSize: 12 } };
const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
const usdTick = (v: number) => formatUsd(v);

function Card({
  id,
  title,
  empty,
  children,
}: {
  id: string;
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="card chart-card"
      data-testid={`bt-chart-${id}`}
      aria-labelledby={`bt-chart-${id}-title`}
    >
      <div className="section-head">
        <h3 id={`bt-chart-${id}-title`}>{title}</h3>
      </div>
      {empty ? (
        <p className="muted chart-empty">No trades in this backtest.</p>
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

function tooltipProps(p: ChartPalette, label: (v: unknown) => string) {
  return {
    formatter: (value: unknown, name: unknown) =>
      [formatUsd(Number(value)), String(name)] as [string, string],
    labelFormatter: label,
    contentStyle: {
      background: p.scheme === 'dark' ? '#1d2027' : '#ffffff',
      borderColor: p.grid,
      color: p.text,
    },
  };
}

export function BacktestCharts({ summary }: { summary: BacktestSummary }) {
  const palette = useChartPalette();
  const color = BACKTEST_COLORS[palette.scheme][0] ?? palette.live;
  const equity = summary.series.equity.map((p) => ({
    x: Date.parse(p.t),
    pnl: p.cumMicros,
    bankroll: p.bankrollMicros,
  }));
  const drawdown = summary.series.drawdown.map((p) => ({ x: Date.parse(p.t), dd: -p.drawdownMicros }));
  const monthly = summary.series.monthly;
  const dateLabel = (v: unknown) => day(Number(v));
  return (
    <div className="chart-grid">
      <Card id="equity" title="Backtest equity curve" empty={equity.length === 0}>
        <LineChart data={equity} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={day}
            {...axisProps(palette)}
          />
          <YAxis tickFormatter={usdTick} width={72} {...axisProps(palette)} />
          <Tooltip {...tooltipProps(palette, dateLabel)} />
          <Legend {...legendProps} />
          <Line
            type="stepAfter"
            dataKey="pnl"
            name="Backtest P&L (cumulative)"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </Card>
      <Card id="drawdown" title="Backtest drawdown" empty={drawdown.length === 0}>
        <AreaChart data={drawdown} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={day}
            {...axisProps(palette)}
          />
          <YAxis tickFormatter={usdTick} width={72} {...axisProps(palette)} />
          <Tooltip {...tooltipProps(palette, dateLabel)} />
          <Legend {...legendProps} />
          <Area
            type="stepAfter"
            dataKey="dd"
            name="Backtest drawdown from peak"
            stroke={palette.negative}
            fill={palette.negative}
            fillOpacity={0.2}
            isAnimationActive={false}
          />
        </AreaChart>
      </Card>
      <Card id="monthly" title="Backtest monthly P&L" empty={monthly.length === 0}>
        <BarChart data={monthly} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
          <XAxis dataKey="month" {...axisProps(palette)} />
          <YAxis tickFormatter={usdTick} width={72} {...axisProps(palette)} />
          <Tooltip {...tooltipProps(palette, (v) => String(v))} />
          <Legend {...legendProps} />
          <Bar dataKey="pnlMicros" name="Backtest P&L per month" fill={color} isAnimationActive={false}>
            {monthly.map((m) => (
              <Cell key={m.month} fill={m.pnlMicros >= 0 ? palette.positive : palette.negative} />
            ))}
          </Bar>
        </BarChart>
      </Card>
    </div>
  );
}

/** Equity lines of up to three saved runs, x = game date. */
export function BacktestComparison({ runs }: { runs: BacktestDetail[] }) {
  const palette = useChartPalette();
  const colors = BACKTEST_COLORS[palette.scheme];
  const rows = new Map<number, Record<string, number>>();
  runs.forEach((run, i) => {
    for (const p of run.summary?.series.equity ?? []) {
      const x = Date.parse(p.t);
      const row = rows.get(x) ?? { x };
      row[`r${i}`] = p.cumMicros;
      rows.set(x, row);
    }
  });
  const data = [...rows.values()].sort((a, b) => (a['x'] ?? 0) - (b['x'] ?? 0));
  return (
    <Card id="compare" title="Backtest comparison — equity" empty={data.length === 0}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey="x"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={day}
          {...axisProps(palette)}
        />
        <YAxis tickFormatter={usdTick} width={72} {...axisProps(palette)} />
        <Tooltip {...tooltipProps(palette, (v) => day(Number(v)))} />
        <Legend {...legendProps} />
        {runs.map((run, i) => (
          <Line
            key={run.id}
            type="stepAfter"
            dataKey={`r${i}`}
            name={`Backtest: ${run.name ?? run.strategyName ?? run.id.slice(0, 8)}`}
            stroke={colors[i % colors.length] ?? palette.live}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Card>
  );
}
