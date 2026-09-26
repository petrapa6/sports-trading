import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { Fragment, useMemo, useState } from 'react';
import { api, type TradeDetail, type TradeView } from '../api';
import { FilterBar, useFilters } from '../components/FilterBar';
import { ModeBadge } from '../components/ModeBadge';
import { downloadCsv, toCsv } from '../csv';
import { serializeFilters } from '../filters';
import { formatContracts, formatPrice, formatUsd, formatUsdExact } from '../format';

// ---- status filter ---------------------------------------------------------------------------------

const SKIP_REASONS = [
  'price',
  'min_price',
  'liquidity',
  'stale_feed',
  'feed_blocked',
  'exchange_paused',
  'market_closed',
  'too_small',
  'paused',
  'error',
  'no_market',
  'live_not_implemented',
  'restart',
  'window_expired',
] as const;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Signalled / pending' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'filled', label: 'Filled' },
  { value: 'settled', label: 'Settled' },
  { value: 'skipped', label: 'Skipped (any reason)' },
  ...SKIP_REASONS.map((r) => ({ value: `skipped:${r}`, label: `Skipped: ${r.replaceAll('_', ' ')}` })),
];

function statusQuery(value: string): string {
  if (value === 'all') return '';
  const [status, reason] = value.split(':');
  return `status=${status ?? 'all'}${reason ? `&reason=${reason}` : ''}`;
}

const STATUS_LABEL: Record<string, string> = {
  signalled: 'Signalled',
  waiting: 'Waiting',
  pending: 'Pending',
  filled: 'Filled',
  skipped: 'Skipped',
  settled_won: 'Won',
  settled_lost: 'Lost',
  settled_void: 'Void',
};

// ---- small views -------------------------------------------------------------------------------------

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : '—');
const price = (bp: number | null) => (bp === null ? '—' : formatPrice(bp));
const contracts = (cc: number | null) => (cc === null ? '—' : formatContracts(cc));

function TradeMode({
  t,
}: {
  t: Pick<TradeView, 'effectiveMode' | 'configuredMode' | 'modeReason' | 'kalshiEnv'>;
}) {
  return (
    <span className="trade-mode">
      <ModeBadge effective={t.effectiveMode} configured={t.configuredMode} reason={t.modeReason} />
      {t.effectiveMode === 'live' && <span className="env-tag">{t.kalshiEnv}</span>}
    </span>
  );
}

function StatusCell({ t }: { t: TradeView }) {
  return (
    <span className={`trade-status status-${t.status}`} data-testid={`status-${t.id}`}>
      {STATUS_LABEL[t.status] ?? t.status}
      {t.skipReason && (t.status === 'skipped' || t.status === 'waiting') && (
        <span className="muted">
          {' '}
          ({t.skipReason.replaceAll('_', ' ')}
          {t.windowExpired ? ', window closed' : ''})
        </span>
      )}
    </span>
  );
}

function Detail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['trades', 'detail', id],
    queryFn: () => api.get<TradeDetail>(`api/trades/${id}`),
  });
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? 'Could not load the trade.' : 'Loading…'}</p>;
  const s = d.snapshot;
  return (
    <div className="trade-detail" data-testid={`trade-detail-${id}`}>
      <section aria-label="Trigger snapshot" data-testid={`snapshot-${id}`}>
        <h3>Trigger snapshot</h3>
        {s ? (
          <dl className="kv">
            <dt>Score</dt>
            <dd>
              {s.homeTeam} {s.homeScore}–{s.awayScore} {s.awayTeam}
            </dd>
            <dt>Minute</dt>
            <dd>
              {s.minute ?? s.clock.minute ?? '—'}
              {s.clock.period !== undefined ? ` (period ${s.clock.period})` : ''}
            </dd>
            <dt>Minute source</dt>
            <dd>{s.clock.minuteSource ?? '—'}</dd>
            <dt>Observed</dt>
            <dd>{time(s.observedAt)}</dd>
            <dt>Feed timestamp</dt>
            <dd>{time(s.feedUpdatedAt)}</dd>
            <dt>Feed</dt>
            <dd>{s.source}</dd>
            <dt>Ask at trigger</dt>
            <dd>
              {price(s.orderbook?.bestAskBp ?? null)}
              {s.orderbook?.bestBidBp != null ? ` (bid ${formatPrice(s.orderbook.bestBidBp)})` : ''}
            </dd>
          </dl>
        ) : (
          <p className="muted">No snapshot.</p>
        )}
      </section>

      <section aria-label="Attempts">
        <h3>Attempts</h3>
        {d.attemptsList.length === 0 ? (
          <p className="muted">No attempts.</p>
        ) : (
          <div className="table-wrap">
            <table className="attempts" data-testid={`attempts-${id}`}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Mode</th>
                  <th>Ask</th>
                  <th>Depth ≤ limit</th>
                  <th>Limit</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {d.attemptsList.map((a) => (
                  <tr key={a.attemptNo}>
                    <td>{a.attemptNo}</td>
                    <td>{time(a.at)}</td>
                    <td>
                      <ModeBadge
                        effective={a.effectiveMode}
                        configured={d.configuredMode}
                        reason={a.modeReason}
                      />
                    </td>
                    <td>{price(a.bestAskBp)}</td>
                    <td>{contracts(a.depthCc)}</td>
                    <td>{price(a.limitPriceBp)}</td>
                    <td>
                      {a.status.replaceAll('_', ' ')}
                      {a.fillCc !== null ? ` ${formatContracts(a.fillCc)} @ ${price(a.avgFillPriceBp)}` : ''}
                    </td>
                    <td>{a.reason?.replaceAll('_', ' ') ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Fill and settlement">
        <h3>Fill and settlement</h3>
        <dl className="kv">
          <dt>Balance at fill</dt>
          <dd>{d.balanceMicros === null ? '—' : formatUsd(d.balanceMicros)}</dd>
          <dt>Stake</dt>
          <dd>{d.stakeMicros === null ? '—' : formatUsd(d.stakeMicros)}</dd>
          <dt>Fill</dt>
          <dd>
            {d.fillCc === null
              ? '—'
              : `${formatContracts(d.fillCc)} of ${contracts(d.requestedCc)} @ ${price(d.avgFillPriceBp)}`}
          </dd>
          <dt>Cost + fee</dt>
          <dd>
            {d.costMicros === null
              ? '—'
              : `${formatUsdExact(d.costMicros)} + ${formatUsdExact(d.feeMicros ?? 0)}`}
          </dd>
          <dt>Settlement</dt>
          <dd>
            {d.settlementValueBp === null
              ? '—'
              : `${price(d.settlementValueBp)} at ${time(d.settledAt)}, payout ${formatUsdExact(d.payoutMicros ?? 0)}`}
          </dd>
          <dt>Realized P&amp;L</dt>
          <dd>{d.realizedPnlMicros === null ? '—' : formatUsdExact(d.realizedPnlMicros)}</dd>
          {d.reconcileWarning && (
            <>
              <dt>Reconcile warning</dt>
              <dd className="error">{d.reconcileWarning}</dd>
            </>
          )}
        </dl>
      </section>

      <section aria-label="Audit trail">
        <h3>Audit trail</h3>
        <ol className="audit-trail" data-testid={`audit-${id}`}>
          {d.audit.map((a, i) => (
            <li key={i}>
              <span className="muted">{time(a.at)}</span> <code>{a.action}</code>
              {a.mode ? <span className="muted"> [{a.mode}]</span> : null}
              {a.detail && typeof a.detail['reason'] === 'string' ? ` — ${a.detail['reason']}` : ''}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ---- the page ----------------------------------------------------------------------------------------

const column = createColumnHelper<TradeView>();

/** The CSV columns; every export carries the four mode columns (§8). */
export const TRADE_CSV_HEADER = [
  'id',
  'triggered_at',
  'strategy_id',
  'strategy_name',
  'strategy_version',
  'game_id',
  'league_id',
  'market_ticker',
  'effective_mode',
  'configured_mode',
  'mode_reason',
  'kalshi_env',
  'status',
  'skip_reason',
  'window_expired',
  'attempts',
  'minute',
  'score',
  'ask_at_trigger_bp',
  'limit_price_bp',
  'requested_cc',
  'fill_cc',
  'avg_fill_price_bp',
  'cost_micros',
  'fee_micros',
  'settled_at',
  'settlement_value_bp',
  'payout_micros',
  'realized_pnl_micros',
] as const;

export function tradeCsvRow(t: TradeView): unknown[] {
  return [
    t.id,
    t.triggeredAt,
    t.strategyId,
    t.strategyName ?? '',
    t.strategyVersion,
    t.gameId,
    t.leagueId,
    t.marketTicker ?? '',
    t.effectiveMode,
    t.configuredMode,
    t.modeReason ?? '',
    t.kalshiEnv,
    t.status,
    t.skipReason ?? '',
    t.windowExpired ? 1 : 0,
    t.attempts,
    t.minute ?? '',
    t.score ?? '',
    t.askAtTriggerBp ?? '',
    t.limitPriceBp ?? '',
    t.requestedCc ?? '',
    t.fillCc ?? '',
    t.avgFillPriceBp ?? '',
    t.costMicros ?? '',
    t.feeMicros ?? '',
    t.settledAt ?? '',
    t.settlementValueBp ?? '',
    t.payoutMicros ?? '',
    t.realizedPnlMicros ?? '',
  ];
}

export function TradesPage() {
  const [filters] = useFilters();
  const [status, setStatus] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sorting, setSorting] = useState<SortingState>([]);
  const filterQuery = serializeFilters(filters).replace(/^\?/, '');
  const query = [filterQuery, statusQuery(status)].filter(Boolean).join('&');
  const list = useQuery({
    queryKey: ['trades', 'list', query],
    queryFn: () => api.get<{ trades: TradeView[] }>(`api/trades${query ? `?${query}` : ''}`),
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => list.data?.trades ?? [], [list.data]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns = useMemo(
    () => [
      column.accessor('triggeredAt', {
        header: 'Triggered',
        cell: (c) => (
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded.has(c.row.original.id)}
            aria-controls={`trade-detail-row-${c.row.original.id}`}
            onClick={() => toggle(c.row.original.id)}
          >
            {expanded.has(c.row.original.id) ? '▾ ' : '▸ '}
            {time(c.getValue())}
          </button>
        ),
      }),
      column.accessor((t) => t.strategyName ?? t.strategyId, {
        id: 'strategy',
        header: 'Strategy',
        cell: (c) => `${c.getValue()} v${c.row.original.strategyVersion}`,
      }),
      column.accessor((t) => `${t.homeTeam ?? '?'} – ${t.awayTeam ?? '?'}`, {
        id: 'game',
        header: 'Game',
        cell: (c) => {
          const t = c.row.original;
          return (
            <span>
              {c.getValue()}
              {t.score && (
                <span className="muted">
                  {' '}
                  {t.score}
                  {t.minute !== null ? ` @ ${t.minute}'` : ''}
                </span>
              )}
              {t.side && <span className="muted"> · buys {t.side}</span>}
            </span>
          );
        },
      }),
      column.accessor('effectiveMode', {
        header: 'Mode',
        cell: (c) => (
          <span data-testid={`mode-${c.row.original.id}`}>
            <TradeMode t={c.row.original} />
          </span>
        ),
      }),
      column.accessor('status', { header: 'Status', cell: (c) => <StatusCell t={c.row.original} /> }),
      column.accessor('askAtTriggerBp', { header: 'Ask at trigger', cell: (c) => price(c.getValue()) }),
      column.accessor('avgFillPriceBp', {
        header: 'Fill',
        cell: (c) => {
          const t = c.row.original;
          return t.fillCc === null ? '—' : `${formatContracts(t.fillCc)} @ ${price(t.avgFillPriceBp)}`;
        },
      }),
      column.accessor((t) => (t.costMicros ?? 0) + (t.feeMicros ?? 0), {
        id: 'cost',
        header: 'Cost + fee',
        cell: (c) => (c.row.original.costMicros === null ? '—' : formatUsdExact(c.getValue())),
      }),
      column.accessor('realizedPnlMicros', {
        header: 'P&L',
        cell: (c) => {
          const v = c.getValue();
          return v === null ? '—' : <span className={v < 0 ? 'neg' : 'pos'}>{formatUsdExact(v)}</span>;
        },
      }),
    ],
    [expanded],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const exportCsv = () => downloadCsv('trades.csv', toCsv(TRADE_CSV_HEADER, rows.map(tradeCsvRow)));

  return (
    <>
      <h1>Trades</h1>
      <FilterBar />
      <section className="card" aria-labelledby="trades-heading">
        <div className="section-head">
          <h2 id="trades-heading">Trades</h2>
          <div className="actions">
            <label className="inline-check" htmlFor="trade-status">
              Status
            </label>
            <select id="trade-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary small"
              onClick={exportCsv}
              disabled={rows.length === 0}
            >
              Export CSV
            </button>
          </div>
        </div>
        <p className="muted">
          Everything that fired or nearly fired. Live and dry-run trades carry their own badge and are never
          added together; dry-run fills are recorded at the limit price.
        </p>
        {!list.data ? (
          <p className="muted">{list.isError ? 'Could not load trades.' : 'Loading…'}</p>
        ) : rows.length === 0 ? (
          <p className="muted" data-testid="no-trades">
            No trades match these filters.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="trades-table" data-testid="trades-table">
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
                          {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr data-testid={`trade-row-${r.original.id}`}>
                      {r.getVisibleCells().map((c) => (
                        <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                      ))}
                    </tr>
                    {expanded.has(r.original.id) && (
                      <tr id={`trade-detail-row-${r.original.id}`} className="detail-row">
                        <td colSpan={r.getVisibleCells().length}>
                          <Detail id={r.original.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
