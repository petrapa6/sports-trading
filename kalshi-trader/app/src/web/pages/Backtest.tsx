import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type BacktestDetail,
  type BacktestItem,
  type BacktestOptions,
  type BacktestPriceMode,
  type BacktestTiles,
  type BacktestTradeView,
  type StrategyView,
} from '../api';
import { BacktestCharts, BacktestComparison } from '../components/BacktestCharts';
import { formatPct } from '../components/StatsTiles';
import { downloadCsv, toCsv } from '../csv';
import { formatContracts, formatPrice, formatUsd, formatUsdExact } from '../format';
import { useLive } from '../live';
import { Link, navigate, useLocation } from '../router';

/**
 * Backtest page (SPEC.md §8, §9, T12): a form (league, seasons, strategy version or ad-hoc parameters, initial
 * bankroll, exact / modelled prices), the selected run (progress, tiles, equity / drawdown / monthly charts,
 * trades table with CSV export, save, promote, delete) and a comparison of up to 3 saved runs. Backtests are a
 * separate category: nothing on this page is live or dry-run data. The selected run and the compared runs live
 * in the URL (`?run=<id>&compare=<id>,<id>`).
 */

const MAX_COMPARE = 3;

function useBacktestUrl() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const run = params.get('run');
  const compare = (params.get('compare') ?? '')
    .split(',')
    .filter((x) => x.length > 0)
    .slice(0, MAX_COMPARE);
  const set = (next: { run?: string | null; compare?: string[] }) => {
    const p = new URLSearchParams(search);
    if (next.run !== undefined) {
      if (next.run) p.set('run', next.run);
      else p.delete('run');
    }
    if (next.compare !== undefined) {
      if (next.compare.length > 0) p.set('compare', next.compare.join(','));
      else p.delete('compare');
    }
    const q = p.toString();
    navigate(`/backtest${q ? `?${q}` : ''}`, { replace: true });
  };
  return { run, compare, set };
}

const errorText = (err: unknown): string => {
  if (err instanceof ApiError) {
    const issues = err.body['issues'];
    if (Array.isArray(issues)) return issues.map(String).join('; ');
    if (err.code === 'backtest_busy') return 'Two backtests are already running; wait for one to finish.';
    return `The request failed (${err.code}).`;
  }
  return 'The request failed.';
};

// ---- form ----------------------------------------------------------------------------------------------

interface AdHoc {
  minLead: string;
  atMinute: string;
  windowMinutes: string;
  leaderSide: 'any' | 'home' | 'away';
  percent: string;
  minStakeUsd: string;
  maxStakeUsd: string;
  maxPrice: string;
  minPrice: string;
  maxSlippage: string;
}

const AD_HOC: Record<'soccer' | 'hockey', AdHoc> = {
  soccer: {
    minLead: '2',
    atMinute: '80',
    windowMinutes: '5',
    leaderSide: 'any',
    percent: '2',
    minStakeUsd: '1',
    maxStakeUsd: '50',
    maxPrice: '0.97',
    minPrice: '',
    maxSlippage: '0.01',
  },
  hockey: {
    minLead: '2',
    atMinute: '50',
    windowMinutes: '3',
    leaderSide: 'any',
    percent: '2',
    minStakeUsd: '1',
    maxStakeUsd: '50',
    maxPrice: '0.97',
    minPrice: '',
    maxSlippage: '0.01',
  },
};

function BacktestForm({ onStarted }: { onStarted: (id: string) => void }) {
  const options = useQuery({
    queryKey: ['backtests', 'options'],
    queryFn: () => api.get<BacktestOptions>('api/backtests/options'),
  });
  const strategies = useQuery({
    queryKey: ['strategies', 'active'],
    queryFn: () => api.get<StrategyView[]>('api/strategies'),
  });
  const leagues = options.data?.leagues ?? [];
  const [leagueId, setLeagueId] = useState('');
  const league =
    leagues.find((l) => l.id === leagueId) ?? leagues.find((l) => l.seasons.length > 0) ?? leagues[0];
  const sport = (league?.sport === 'hockey' ? 'hockey' : 'soccer') as 'soccer' | 'hockey';
  const [seasons, setSeasons] = useState<string[]>([]);
  const [strategyId, setStrategyId] = useState('');
  const [adHoc, setAdHoc] = useState<AdHoc>(AD_HOC.soccer);
  const [bankroll, setBankroll] = useState('100');
  const [priceMode, setPriceMode] = useState<BacktestPriceMode>('exact');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAdHoc(AD_HOC[sport]);
    setSeasons([]);
    setStrategyId('');
  }, [sport, league?.id]);

  const sportStrategies = (strategies.data ?? []).filter((s) => s.sport === sport);
  const set = <K extends keyof AdHoc>(k: K, v: AdHoc[K]) => setAdHoc((a) => ({ ...a, [k]: v }));
  const num = (v: string) => Number(v);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!league) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      leagueIds: [league.id],
      seasons,
      priceMode,
      initialBankrollUsd: num(bankroll),
    };
    if (strategyId) body['strategyId'] = strategyId;
    else
      body['definition'] = {
        sport,
        leagueIds: [league.id],
        rule: {
          type: 'lead_at_time',
          minLead: num(adHoc.minLead),
          atMinute: num(adHoc.atMinute),
          windowMinutes: num(adHoc.windowMinutes),
          leaderSide: adHoc.leaderSide,
        },
        sizing: {
          percent: num(adHoc.percent),
          minStakeUsd: num(adHoc.minStakeUsd),
          maxStakeUsd: num(adHoc.maxStakeUsd),
        },
        execution: {
          maxPrice: num(adHoc.maxPrice),
          minPrice: adHoc.minPrice.trim() === '' ? null : num(adHoc.minPrice),
          maxSlippage: num(adHoc.maxSlippage),
        },
      };
    try {
      const { id } = await api.post<{ id: string }>('api/backtests', body);
      onStarted(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof AdHoc, label: string, step = 'any') => (
    <div className="field">
      <label htmlFor={`bt-${k}`}>{label}</label>
      <input
        id={`bt-${k}`}
        type="number"
        step={step}
        value={adHoc[k]}
        onChange={(e) => set(k, e.target.value as never)}
      />
    </div>
  );

  return (
    <form
      className="card strategy-form backtest-form"
      onSubmit={(e) => void submit(e)}
      aria-label="Run a backtest"
    >
      <h2>Run a backtest</h2>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="bt-league">League</label>
          <select id="bt-league" value={league?.id ?? ''} onChange={(e) => setLeagueId(e.target.value)}>
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.seasons.reduce((n, s) => n + s.games, 0)} games)
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bt-strategy">Strategy</label>
          <select id="bt-strategy" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
            <option value="">Ad-hoc parameters</option>
            {sportStrategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} (v{s.currentVersion})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bt-bankroll">Initial bankroll ($)</label>
          <input
            id="bt-bankroll"
            type="number"
            step="0.01"
            min="1"
            value={bankroll}
            onChange={(e) => setBankroll(e.target.value)}
          />
        </div>
      </div>

      <fieldset>
        <legend>Seasons (none selected = all)</legend>
        {league && league.seasons.length === 0 && (
          <p className="muted">No historical games for this league yet (Settings → Data imports them).</p>
        )}
        <div className="chips">
          {league?.seasons.map((s) => (
            <label key={s.season} className="inline-check">
              <input
                type="checkbox"
                checked={seasons.includes(s.season)}
                onChange={(e) =>
                  setSeasons((cur) =>
                    e.target.checked ? [...cur, s.season] : cur.filter((x) => x !== s.season),
                  )
                }
              />
              {s.season}{' '}
              <span className="muted">
                ({s.games} games, {s.withKalshi} with Kalshi prices)
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Prices</legend>
        <label className="inline-check">
          <input
            type="radio"
            name="bt-price-mode"
            checked={priceMode === 'exact'}
            onChange={() => setPriceMode('exact')}
          />
          Exact (Kalshi candles)
        </label>
        <label className="inline-check">
          <input
            type="radio"
            name="bt-price-mode"
            checked={priceMode === 'modelled'}
            onChange={() => setPriceMode('modelled')}
          />
          Modelled (price model{options.data && !options.data.priceModel.built ? ', seed table only' : ''})
        </label>
      </fieldset>

      {!strategyId && (
        <>
          <h3>Rule</h3>
          <div className="field-grid">
            {field('minLead', 'Min lead (goals)', '1')}
            {field('atMinute', 'At minute', '1')}
            {field('windowMinutes', 'Window (minutes)', '1')}
            <div className="field">
              <label htmlFor="bt-leaderSide">Leader side</label>
              <select
                id="bt-leaderSide"
                value={adHoc.leaderSide}
                onChange={(e) => set('leaderSide', e.target.value as AdHoc['leaderSide'])}
              >
                <option value="any">Any</option>
                <option value="home">Home</option>
                <option value="away">Away</option>
              </select>
            </div>
          </div>
          <h3>Sizing and prices</h3>
          <div className="field-grid">
            {field('percent', 'Stake (% of bankroll)')}
            {field('minStakeUsd', 'Min stake ($)')}
            {field('maxStakeUsd', 'Max stake ($)')}
            {field('maxPrice', 'Max price ($)')}
            {field('minPrice', 'Min price ($, optional)')}
            {field('maxSlippage', 'Max slippage ($)')}
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !league}>
          Run backtest
        </button>
      </div>
    </form>
  );
}

// ---- tiles ---------------------------------------------------------------------------------------------

const TILES: {
  id: string;
  label: string;
  value: (t: BacktestTiles) => string;
  hint?: (t: BacktestTiles) => string;
}[] = [
  {
    id: 'trades',
    label: 'Trades',
    value: (t) => String(t.trades),
    hint: (t) => `${t.matched} matches in ${t.games} games`,
  },
  {
    id: 'win-rate',
    label: 'Win rate',
    value: (t) => (t.won + t.lost === 0 ? '—' : formatPct(t.winRate)),
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
  { id: 'avg-price', label: 'Avg price', value: (t) => (t.trades === 0 ? '—' : formatPrice(t.avgPriceBp)) },
  { id: 'avg-fee', label: 'Avg fee', value: (t) => (t.trades === 0 ? '—' : formatUsdExact(t.avgFeeMicros)) },
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
    id: 'bankroll',
    label: 'Bankroll',
    value: (t) => formatUsd(t.finalBankrollMicros),
    hint: (t) => `from ${formatUsd(t.initialBankrollMicros)}`,
  },
];

function Tiles({ tiles }: { tiles: BacktestTiles }) {
  return (
    <section className="stats-tiles" aria-label="Backtest metrics" data-testid="backtest-tiles">
      {TILES.map((d) => (
        <div key={d.id} className="stat-tile" data-testid={`bt-tile-${d.id}`}>
          <div className="stat-label">{d.label}</div>
          <div className="stat-values stat-values--1">
            <div className="stat-value stat-value--backtest">
              <strong className="stat-number">{d.value(tiles)}</strong>
              {d.hint && <span className="stat-hint muted">{d.hint(tiles)}</span>}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

export function ModelledBadge({ tiles }: { tiles: Pick<BacktestTiles, 'priceMode' | 'minSampleSize'> }) {
  if (tiles.priceMode !== 'modelled') return null;
  const n = tiles.minSampleSize ?? 0;
  return (
    <span
      className="modelled-badge"
      data-testid="modelled-badge"
      title="Prices come from the price model, not from real Kalshi candles"
    >
      Modelled prices · smallest sample size {n}
      {n < 20 ? ' (seed table)' : ''}
    </span>
  );
}

// ---- trades table --------------------------------------------------------------------------------------

const column = createColumnHelper<BacktestTradeView>();
const dash = '—';
const CSV_HEADER = [
  'category',
  'played_at',
  'hist_game_id',
  'home',
  'away',
  'final',
  'minute',
  'side',
  'price_source',
  'price_bp',
  'contracts_cc',
  'stake_micros',
  'fee_micros',
  'settlement_value_bp',
  'pnl_micros',
  'bankroll_after_micros',
  'skip_reason',
] as const;

function TradesTable({ run }: { run: BacktestDetail }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo(
    () => [
      column.accessor('playedAt', { header: 'Date', cell: (c) => (c.getValue() ?? dash).slice(0, 10) }),
      column.accessor((r) => `${r.home ?? '?'} – ${r.away ?? '?'}`, { id: 'game', header: 'Game' }),
      column.accessor('final', { header: 'Final', cell: (c) => c.getValue() ?? dash }),
      column.accessor('minute', { header: 'Minute', cell: (c) => c.getValue() ?? dash }),
      column.accessor('side', { header: 'Side', cell: (c) => c.getValue() ?? dash }),
      column.accessor('priceSource', { header: 'Price source', cell: (c) => c.getValue() ?? dash }),
      column.accessor('priceBp', {
        header: 'Price',
        cell: (c) => (c.getValue() === null ? dash : formatPrice(c.getValue() ?? 0)),
      }),
      column.accessor('contractsCc', {
        header: 'Contracts',
        cell: (c) => (c.getValue() === null ? dash : formatContracts(c.getValue() ?? 0)),
      }),
      column.accessor('feeMicros', {
        header: 'Fee',
        cell: (c) => (c.getValue() === null ? dash : formatUsdExact(c.getValue() ?? 0)),
      }),
      column.accessor('settlementValueBp', {
        header: 'Settled',
        cell: (c) => (c.getValue() === null ? dash : formatPrice(c.getValue() ?? 0)),
      }),
      column.accessor('pnlMicros', {
        header: 'P&L',
        cell: (c) => {
          const v = c.getValue();
          return v === null ? dash : <span className={v < 0 ? 'neg' : undefined}>{formatUsdExact(v)}</span>;
        },
      }),
      column.accessor('bankrollAfterMicros', {
        header: 'Bankroll',
        cell: (c) => (c.getValue() === null ? dash : formatUsd(c.getValue() ?? 0)),
      }),
      column.accessor('skipReason', {
        header: 'Skip reason',
        cell: (c) => c.getValue()?.replaceAll('_', ' ') ?? '',
      }),
    ],
    [],
  );
  const table = useReactTable({
    data: run.trades,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const exportCsv = () =>
    downloadCsv(
      `backtest-${run.id.slice(0, 8)}.csv`,
      toCsv(
        CSV_HEADER,
        run.trades.map((t) => [
          'backtest',
          t.playedAt,
          t.histGameId,
          t.home,
          t.away,
          t.final,
          t.minute,
          t.side,
          t.priceSource,
          t.priceBp,
          t.contractsCc,
          t.stakeMicros,
          t.feeMicros,
          t.settlementValueBp,
          t.pnlMicros,
          t.bankrollAfterMicros,
          t.skipReason,
        ]),
      ),
    );
  return (
    <section className="card" aria-labelledby="bt-trades-title">
      <div className="section-head">
        <h3 id="bt-trades-title">Backtest trades ({run.trades.length})</h3>
        <div className="actions">
          <button
            type="button"
            className="secondary small"
            onClick={exportCsv}
            disabled={run.trades.length === 0}
          >
            Export CSV
          </button>
        </div>
      </div>
      {run.trades.length === 0 ? (
        <p className="muted">The rule never matched in these games.</p>
      ) : (
        <div className="table-wrap">
          <table className="trades-table" data-testid="backtest-trades">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      aria-sort={
                        h.column.getIsSorted() === 'asc'
                          ? 'ascending'
                          : h.column.getIsSorted() === 'desc'
                            ? 'descending'
                            : undefined
                      }
                    >
                      <button
                        type="button"
                        className="link-button"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {h.column.getIsSorted() === 'asc'
                          ? ' ▲'
                          : h.column.getIsSorted() === 'desc'
                            ? ' ▼'
                            : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- selected run --------------------------------------------------------------------------------------

function describe(
  run: Pick<BacktestItem, 'leagueIds' | 'seasons' | 'sinceIso' | 'priceMode' | 'strategy' | 'strategyName'>,
) {
  const what = run.strategy
    ? `${run.strategy.name} v${run.strategy.version}`
    : run.strategyName && run.strategyName !== 'Ad-hoc'
      ? `${run.strategyName} (ad-hoc)`
      : 'Ad-hoc parameters';
  const when = run.sinceIso
    ? `since ${run.sinceIso.slice(0, 10)}`
    : run.seasons.length > 0
      ? run.seasons.join(', ')
      : 'all seasons';
  return `${what} · ${run.leagueIds.join(', ')} · ${when} · ${run.priceMode}`;
}

function RunView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const live = useLive();
  const detail = useQuery({
    queryKey: ['backtests', 'detail', id],
    queryFn: () => api.get<BacktestDetail>(`api/backtests/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = live.backtests[id];
  const run = detail.data;

  useEffect(() => {
    if (progress && progress.status !== 'running')
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
  }, [progress, queryClient]);
  useEffect(() => setName(run?.name ?? ''), [run?.name]);

  if (detail.isPending) return <section className="card muted">Loading the backtest…</section>;
  if (!run) return <section className="card muted">This backtest no longer exists.</section>;

  const act = async (fn: () => Promise<string>) => {
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
      await queryClient.invalidateQueries({ queryKey: ['backtests'] });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const save = () =>
    act(async () => {
      await api.post(`api/backtests/${id}/save`, { name: name.trim() || describe(run).slice(0, 80) });
      return 'Saved.';
    });
  const promote = () =>
    act(async () => {
      const s = await api.post<{ name: string }>(`api/backtests/${id}/promote`, {});
      await queryClient.invalidateQueries({ queryKey: ['strategies'] });
      return `Strategy "${s.name}" created (kill switch on, dry run).`;
    });
  const remove = async () => {
    try {
      await api.post(`api/backtests/${id}/delete`);
      await queryClient.invalidateQueries({ queryKey: ['backtests'] });
      onDeleted();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const done = progress?.done ?? run.progress?.done ?? 0;
  const total = progress?.total ?? run.progress?.total ?? 0;
  return (
    <section
      className="backtest-run"
      aria-labelledby="bt-run-title"
      data-testid="backtest-run"
      data-status={run.status}
    >
      <div className="section-head">
        <h2 id="bt-run-title">
          Backtest results{run.name ? `: ${run.name}` : ''}{' '}
          {run.summary && <ModelledBadge tiles={run.summary} />}
        </h2>
      </div>
      <p className="muted">{describe(run)}</p>
      {run.status === 'running' && (
        <div className="card" role="status" data-testid="backtest-progress">
          <p>
            Running… {done} / {total || '?'} games
          </p>
          <progress max={total || 1} value={done} />
        </div>
      )}
      {run.status === 'failed' && <p className="error">The backtest failed: {run.error}</p>}
      {run.status === 'interrupted' && (
        <p className="error">The backtest was interrupted (the app restarted).</p>
      )}
      {run.summary && (
        <>
          <Tiles tiles={run.summary} />
          {run.summary.skips.length > 0 && (
            <p className="muted" data-testid="backtest-skips">
              Skipped:{' '}
              {run.summary.skips.map((s) => `${s.reason.replaceAll('_', ' ')} ${s.count}`).join(' · ')}
            </p>
          )}
          <BacktestCharts summary={run.summary} />
          <TradesTable run={run} />
        </>
      )}
      <div className="card backtest-actions">
        <div className="field">
          <label htmlFor="bt-name">Name</label>
          <input
            id="bt-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. EPL 2-goal lead at 80'"
          />
        </div>
        <div className="actions">
          <button type="button" onClick={() => void save()} disabled={run.status !== 'done'}>
            {run.saved ? 'Save name' : 'Save backtest'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void promote()}
            disabled={run.status !== 'done'}
          >
            Promote to strategy
          </button>
          <button type="button" className="secondary danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
        {message && (
          <p className="success" role="status">
            {message} {message.startsWith('Strategy') && <Link to="/strategies">Open Strategies</Link>}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

// ---- saved runs and comparison ------------------------------------------------------------------------

function RunList({
  runs,
  selected,
  compare,
  onSelect,
  onCompare,
}: {
  runs: BacktestItem[];
  selected: string | null;
  compare: string[];
  onSelect: (id: string) => void;
  onCompare: (ids: string[]) => void;
}) {
  const saved = runs.filter((r) => r.saved);
  const recent = runs.filter((r) => !r.saved);
  const row = (r: BacktestItem, canCompare: boolean) => (
    <li key={r.id} className={r.id === selected ? 'selected' : undefined} data-testid={`bt-run-${r.id}`}>
      {canCompare && (
        <input
          type="checkbox"
          aria-label={`Compare ${r.name ?? r.id}`}
          checked={compare.includes(r.id)}
          disabled={!compare.includes(r.id) && compare.length >= MAX_COMPARE}
          onChange={(e) =>
            onCompare(e.target.checked ? [...compare, r.id] : compare.filter((x) => x !== r.id))
          }
        />
      )}
      <button type="button" className="link-button" onClick={() => onSelect(r.id)}>
        {r.name ?? describe(r)}
      </button>
      <span className="muted">
        {' '}
        {r.status === 'done' && r.summary
          ? `${r.summary.trades} trades · ${formatUsd(r.summary.netPnlMicros)}`
          : r.status}
        {r.priceMode === 'modelled' ? ' · modelled' : ''}
      </span>
    </li>
  );
  return (
    <section className="card" aria-labelledby="bt-saved-title">
      <h2 id="bt-saved-title">Saved backtests</h2>
      {saved.length === 0 ? (
        <p className="muted">
          No saved backtests yet. Save a run to compare it with others (up to {MAX_COMPARE}).
        </p>
      ) : (
        <ul className="backtest-list" data-testid="saved-backtests">
          {saved.map((r) => row(r, true))}
        </ul>
      )}
      {recent.length > 0 && (
        <>
          <h3>Recent runs (not saved)</h3>
          <ul className="backtest-list">{recent.map((r) => row(r, false))}</ul>
        </>
      )}
    </section>
  );
}

function Comparison({ ids }: { ids: string[] }) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['backtests', 'detail', id],
      queryFn: () => api.get<BacktestDetail>(`api/backtests/${id}`),
    })),
  });
  const runs = results.flatMap((r) => (r.data ? [r.data] : []));
  if (runs.length < 2) return null;
  return (
    <section aria-label="Backtest comparison" data-testid="backtest-compare">
      <BacktestComparison runs={runs} />
      <div className="table-wrap card">
        <table className="trades-table">
          <thead>
            <tr>
              <th>Backtest</th>
              <th>Trades</th>
              <th>Win rate</th>
              <th>Net P&amp;L</th>
              <th>ROI</th>
              <th>Max drawdown</th>
              <th>Prices</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.name ?? r.id.slice(0, 8)}</td>
                <td>{r.summary?.trades ?? dash}</td>
                <td>{r.summary ? formatPct(r.summary.winRate) : dash}</td>
                <td>{r.summary ? formatUsd(r.summary.netPnlMicros) : dash}</td>
                <td>{r.summary ? formatPct(r.summary.roi) : dash}</td>
                <td>{r.summary ? formatUsd(r.summary.maxDrawdownMicros) : dash}</td>
                <td>{r.priceMode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BacktestPage() {
  const url = useBacktestUrl();
  const live = useLive();
  const anyRunning = Object.values(live.backtests).some((p) => p.status === 'running');
  const list = useQuery({
    queryKey: ['backtests', 'list'],
    queryFn: () => api.get<BacktestItem[]>('api/backtests'),
    refetchInterval: anyRunning ? 3000 : false,
  });
  return (
    <>
      <h1>Backtest</h1>
      <p className="muted">
        Backtests replay a strategy over past games with the production rule, guards and pricing. They are a
        separate category and are never plotted together with real or simulated trading.
      </p>
      <BacktestForm onStarted={(id) => url.set({ run: id })} />
      {url.run && (
        <RunView
          key={url.run}
          id={url.run}
          onDeleted={() => url.set({ run: null, compare: url.compare.filter((x) => x !== url.run) })}
        />
      )}
      <RunList
        runs={list.data ?? []}
        selected={url.run}
        compare={url.compare}
        onSelect={(id) => url.set({ run: id })}
        onCompare={(ids) => url.set({ compare: ids.slice(0, MAX_COMPARE) })}
      />
      {url.compare.length >= 2 && <Comparison ids={url.compare} />}
    </>
  );
}
