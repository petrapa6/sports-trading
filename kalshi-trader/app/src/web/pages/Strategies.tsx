import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_WINDOW_MINUTES, StrategyCreateSchema, StrategyDefinitionSchema } from '../../core/strategy';
import {
  api,
  ApiError,
  formatUsd,
  type League,
  type Status,
  type StrategyDetail,
  type StrategyVersionView,
  type StrategyView,
} from '../api';
import { FilterBar, useFilters } from '../components/FilterBar';
import { ModeBadge } from '../components/ModeBadge';
import { downloadCsv, toCsv } from '../csv';
import { useStepUp } from '../reauth';
import { navigate } from '../router';

// ---- badges and small helpers --------------------------------------------------------------------

/** `PAUSED`, or the effective-mode badge (`LIVE`, `DRY RUN`, `LIVE → DRY RUN (add-on lock)`, …). */
export function EffectiveBadge({ s }: { s: Pick<StrategyView, 'effectiveMode' | 'mode' | 'modeReason'> }) {
  if (s.effectiveMode === 'paused') {
    return (
      <span
        className="mode-badge mode-badge--none"
        title={s.modeReason === 'global_kill_switch' ? 'Global kill switch is on' : 'Kill switch is on'}
      >
        PAUSED
      </span>
    );
  }
  return (
    <ModeBadge
      effective={s.effectiveMode}
      configured={s.mode}
      reason={
        s.modeReason === 'global_kill_switch' || s.modeReason === 'strategy_kill_switch' ? null : s.modeReason
      }
    />
  );
}

const SIDE_LABEL = { any: 'either side', home: 'home only', away: 'away only' } as const;

function ruleSummary(v: Pick<StrategyVersionView, 'rule' | 'sizing' | 'execution'>): string {
  const r = v.rule;
  return (
    `lead ≥ ${r.minLead} from minute ${r.atMinute} (window ${r.windowMinutes}), ${SIDE_LABEL[r.leaderSide]}; ` +
    `${v.sizing.percent}% ($${v.sizing.minStakeUsd}–$${v.sizing.maxStakeUsd}); max $${v.execution.maxPrice}` +
    (v.execution.minPrice !== null ? `, min $${v.execution.minPrice}` : '')
  );
}

function PerMode({ live, dry }: { live: ReactNode; dry: ReactNode }) {
  return (
    <span className="per-mode">
      <span title="Live">{live}</span> <span className="muted">|</span> <span title="Dry run">{dry}</span>
    </span>
  );
}

const errorText = (err: unknown) =>
  err instanceof ApiError ? `The request failed (${err.code}).` : 'The request failed.';

// ---- the editor form -------------------------------------------------------------------------------

interface FormState {
  name: string;
  sport: 'soccer' | 'hockey';
  leagueIds: string[];
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
  minDepthContracts: string;
  maxFeedAgeSec: string;
}

const NEW_FORM: FormState = {
  name: '',
  sport: 'soccer',
  leagueIds: [],
  minLead: '2',
  atMinute: '80',
  windowMinutes: String(DEFAULT_WINDOW_MINUTES.soccer),
  leaderSide: 'any',
  percent: '2',
  minStakeUsd: '1',
  maxStakeUsd: '50',
  maxPrice: '0.97',
  minPrice: '',
  maxSlippage: '0.01',
  minDepthContracts: '20',
  maxFeedAgeSec: '15',
};

function formOf(s: StrategyDetail): FormState {
  const r = s.rule;
  const z = s.sizing;
  const e = s.execution;
  if (!r || !z || !e) return { ...NEW_FORM, name: s.name, sport: s.sport, leagueIds: s.leagueIds };
  return {
    name: s.name,
    sport: s.sport,
    leagueIds: s.leagueIds,
    minLead: String(r.minLead),
    atMinute: String(r.atMinute),
    windowMinutes: String(r.windowMinutes),
    leaderSide: r.leaderSide,
    percent: String(z.percent),
    minStakeUsd: String(z.minStakeUsd),
    maxStakeUsd: String(z.maxStakeUsd),
    maxPrice: String(e.maxPrice),
    minPrice: e.minPrice === null ? '' : String(e.minPrice),
    maxSlippage: String(e.maxSlippage),
    minDepthContracts: String(e.minDepthContracts),
    maxFeedAgeSec: String(e.maxFeedAgeSec),
  };
}

/** Number inputs → the §5 JSON (an empty required field stays missing, so the schema names it). */
function bodyOf(f: FormState) {
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  return {
    name: f.name,
    sport: f.sport,
    leagueIds: f.leagueIds,
    rule: {
      type: 'lead_at_time',
      version: 1,
      minLead: num(f.minLead),
      atMinute: num(f.atMinute),
      windowMinutes: num(f.windowMinutes),
      leaderSide: f.leaderSide,
    },
    sizing: {
      type: 'percent_of_balance',
      percent: num(f.percent),
      minStakeUsd: num(f.minStakeUsd),
      maxStakeUsd: num(f.maxStakeUsd),
    },
    execution: {
      orderType: 'ioc_limit',
      maxPrice: num(f.maxPrice),
      minPrice: f.minPrice.trim() === '' ? null : Number(f.minPrice),
      maxSlippage: num(f.maxSlippage),
      minDepthContracts: num(f.minDepthContracts),
      maxFeedAgeSec: num(f.maxFeedAgeSec),
    },
  };
}

type Errors = Record<string, string>;

/** `leagueIds.1` → `leagueIds`; everything else by its dotted path. */
const fieldKey = (path: string) => (path.startsWith('leagueIds') ? 'leagueIds' : path);

function addIssue(errors: Errors, line: string): void {
  const i = line.indexOf(': ');
  const [path, message] = i === -1 ? ['(body)', line] : [line.slice(0, i), line.slice(i + 2)];
  const key = fieldKey(path);
  errors[key] ??= message;
}

/** The same checks as the server: the shared Zod schema plus the leagues' sport. */
function validate(f: FormState, isNew: boolean, leagues: League[]): Errors {
  const errors: Errors = {};
  const schema = isNew ? StrategyCreateSchema : StrategyDefinitionSchema;
  const result = schema.safeParse(bodyOf(f));
  if (!result.success) {
    for (const issue of result.error.issues)
      addIssue(errors, `${issue.path.join('.') || '(body)'}: ${issue.message}`);
  }
  for (const id of f.leagueIds) {
    const league = leagues.find((l) => l.id === id);
    if (league && league.sport !== f.sport)
      errors['leagueIds'] ??= `${league.name} is not a ${f.sport} league`;
  }
  return errors;
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
  step?: string;
}

function NumberField({ id, label, value, error, onChange, hint, step }: FieldProps) {
  const inputId = `strategy-${id.replace('.', '-')}`;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="number"
        inputMode="decimal"
        step={step ?? 'any'}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="field-error error" id={`${inputId}-error`} role="alert" data-field={id}>
          {error}
        </span>
      )}
    </div>
  );
}

function VersionHistory({ versions }: { versions: StrategyVersionView[] }) {
  return (
    <section aria-labelledby="versions-heading">
      <h3 id="versions-heading">Version history</h3>
      <ol className="version-list" data-testid="version-history" reversed>
        {[...versions].reverse().map((v) => (
          <li key={v.version} data-testid={`version-${v.version}`}>
            <strong>v{v.version}</strong>{' '}
            <span className="muted">{v.createdAt ? new Date(v.createdAt).toLocaleString('en-GB') : ''}</span>
            <div>
              {v.leagueIds.join(', ').toUpperCase()} — {ruleSummary(v)}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StrategyEditor({
  id,
  onClose,
  onCreated,
}: {
  id: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const isNew = id === null;
  const leagues = useQuery({ queryKey: ['leagues'], queryFn: () => api.get<League[]>('api/leagues') });
  const detail = useQuery({
    queryKey: ['strategies', 'detail', id],
    queryFn: () => api.get<StrategyDetail>(`api/strategies/${id}`),
    enabled: !isNew,
  });
  if (!isNew && !detail.data) {
    return (
      <Drawer title="Edit strategy" onClose={onClose}>
        <p className="muted">Loading…</p>
      </Drawer>
    );
  }
  return (
    <EditorForm
      key={detail.data ? `${detail.data.id}-${detail.data.currentVersion}` : 'new'}
      detail={detail.data ?? null}
      leagues={leagues.data ?? []}
      onClose={onClose}
      onSaved={async (created) => {
        await queryClient.invalidateQueries({ queryKey: ['strategies'] });
        if (created) onCreated();
      }}
    />
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="drawer-backdrop">
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="drawer-head">
          <h2 id="drawer-title">{title}</h2>
          <button type="button" className="secondary small" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

function EditorForm({
  detail,
  leagues,
  onClose,
  onSaved,
}: {
  detail: StrategyDetail | null;
  leagues: League[];
  onClose: () => void;
  onSaved: (created: boolean) => Promise<void>;
}) {
  const isNew = detail === null;
  const [form, setForm] = useState<FormState>(detail ? formOf(detail) : NEW_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    // Once a field has an error, re-check as the user types, so the message goes away when fixed.
    if (Object.keys(errors).length > 0) setErrors(validate(next, isNew, leagues));
  };

  const setSport = (sport: FormState['sport']) => {
    const other = sport === 'soccer' ? 'hockey' : 'soccer';
    setErrors({});
    setForm((f) => ({
      ...f,
      sport,
      leagueIds: f.leagueIds.filter((lid) => leagues.find((l) => l.id === lid)?.sport === sport),
      windowMinutes:
        f.windowMinutes === String(DEFAULT_WINDOW_MINUTES[other])
          ? String(DEFAULT_WINDOW_MINUTES[sport])
          : f.windowMinutes,
      atMinute: sport === 'hockey' && Number(f.atMinute) > 59 ? '50' : f.atMinute,
    }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const found = validate(form, isNew, leagues);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const saved =
        detail === null
          ? await api.post<StrategyDetail>('api/strategies', bodyOf(form))
          : await api.post<StrategyDetail>(`api/strategies/${detail.id}`, bodyOf(form));
      setMessage(isNew ? 'Strategy created.' : `Saved (version ${saved.currentVersion}).`);
      await onSaved(isNew);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body['issues'])) {
        const server: Errors = {};
        for (const line of err.body['issues'] as string[]) addIssue(server, line);
        setErrors(server);
      } else {
        setErrors({ '(body)': errorText(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail || !window.confirm(`Delete "${detail.name}"? Its trades stay in the reports.`)) return;
    setBusy(true);
    try {
      await api.post(`api/strategies/${detail.id}/delete`);
      await onSaved(false);
      onClose();
    } catch (err) {
      setErrors({ '(body)': errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  /** Quick exact backtest of the saved version over the last 30 days (T12), shown on the Backtest page. */
  const test30d = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const { id } = await api.post<{ id: string }>('api/backtests', {
        strategyId: detail.id,
        lastDays: 30,
        priceMode: 'exact',
        quick: true,
      });
      navigate(`/backtest?run=${id}`);
    } catch (err) {
      setErrors({ '(body)': errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const sportLeagues = leagues.filter((l) => l.sport === form.sport);
  const numberField = (
    key: keyof FormState,
    path: string,
    label: string,
    extra: Partial<FieldProps> = {},
  ) => (
    <NumberField
      id={path}
      label={label}
      value={form[key] as string}
      error={errors[path]}
      onChange={(v) => set(key, v as never)}
      {...extra}
    />
  );
  const general = Object.entries(errors).filter(
    ([k]) => !k.includes('.') && !['name', 'sport', 'leagueIds'].includes(k),
  );

  return (
    <Drawer title={detail === null ? 'New strategy' : `Edit “${detail.name}”`} onClose={onClose}>
      <form className="strategy-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="strategy-name">Name</label>
          <input
            id="strategy-name"
            value={form.name}
            maxLength={80}
            aria-invalid={errors['name'] ? true : undefined}
            onChange={(e) => set('name', e.target.value)}
          />
          {errors['name'] && (
            <span className="field-error error" role="alert" data-field="name">
              {errors['name']}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="strategy-sport">Sport</label>
          <select
            id="strategy-sport"
            value={form.sport}
            disabled={!isNew}
            title={isNew ? undefined : 'The sport of a strategy cannot be changed'}
            onChange={(e) => setSport(e.target.value as FormState['sport'])}
          >
            <option value="soccer">Soccer</option>
            <option value="hockey">Hockey</option>
          </select>
        </div>
        <fieldset className="field">
          <legend>Leagues</legend>
          <div className="chips">
            {sportLeagues.map((l) => (
              <label key={l.id} className="chip">
                <input
                  type="checkbox"
                  checked={form.leagueIds.includes(l.id)}
                  onChange={(e) =>
                    set(
                      'leagueIds',
                      e.target.checked ? [...form.leagueIds, l.id] : form.leagueIds.filter((x) => x !== l.id),
                    )
                  }
                />{' '}
                {l.name}
              </label>
            ))}
          </div>
          {errors['leagueIds'] && (
            <span className="field-error error" role="alert" data-field="leagueIds">
              {errors['leagueIds']}
            </span>
          )}
        </fieldset>

        <h3>Rule: lead at time</h3>
        <div className="field-grid">
          {numberField('minLead', 'rule.minLead', 'Minimum lead (goals)', { step: '1' })}
          {numberField('atMinute', 'rule.atMinute', 'From minute', {
            step: '1',
            hint: form.sport === 'soccer' ? 'Match minute 1–90 (stoppage = 90)' : 'Elapsed minute 1–59',
          })}
          {numberField('windowMinutes', 'rule.windowMinutes', 'Window (minutes)', { step: '1' })}
          <div className="field">
            <label htmlFor="strategy-leaderSide">Leader side</label>
            <select
              id="strategy-leaderSide"
              value={form.leaderSide}
              onChange={(e) => set('leaderSide', e.target.value as FormState['leaderSide'])}
            >
              <option value="any">Any</option>
              <option value="home">Home</option>
              <option value="away">Away</option>
            </select>
          </div>
        </div>

        <h3>Sizing</h3>
        <div className="field-grid">
          {numberField('percent', 'sizing.percent', 'Stake (% of balance)')}
          {numberField('minStakeUsd', 'sizing.minStakeUsd', 'Min stake ($)')}
          {numberField('maxStakeUsd', 'sizing.maxStakeUsd', 'Max stake ($)')}
        </div>

        <h3>Execution (IOC limit)</h3>
        <div className="field-grid">
          {numberField('maxPrice', 'execution.maxPrice', 'Max price ($)')}
          {numberField('minPrice', 'execution.minPrice', 'Min price ($, optional)')}
          {numberField('maxSlippage', 'execution.maxSlippage', 'Max slippage ($)')}
          {numberField('minDepthContracts', 'execution.minDepthContracts', 'Min depth (contracts)', {
            step: '1',
          })}
          {numberField('maxFeedAgeSec', 'execution.maxFeedAgeSec', 'Max feed age (s)', { step: '1' })}
        </div>

        {general.map(([k, v]) => (
          <p key={k} className="error" role="alert">
            {k === '(body)' ? v : `${k}: ${v}`}
          </p>
        ))}
        {message && (
          <p className="success" role="status">
            {message}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {isNew ? 'Create strategy' : 'Save'}
          </button>
          {isNew ? (
            <span className="tooltip-wrap" title="save the strategy first">
              <button type="button" className="secondary" disabled aria-describedby="test-30d-note">
                Test against last 30 days
              </button>
              <span id="test-30d-note" className="visually-hidden">
                save the strategy first
              </span>
            </span>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              title="Quick exact backtest over the games collected in the strategy's leagues in the last 30 days"
              onClick={() => void test30d()}
            >
              Test against last 30 days
            </button>
          )}
          {!isNew && (
            <button type="button" className="secondary danger" disabled={busy} onClick={() => void remove()}>
              Delete strategy
            </button>
          )}
        </div>
        {isNew && <p className="muted">New strategies start with the kill switch on and in dry run.</p>}
      </form>
      {detail && <VersionHistory versions={detail.versions} />}
    </Drawer>
  );
}

// ---- the page ----------------------------------------------------------------------------------------

const column = createColumnHelper<StrategyView>();

export function StrategiesPage() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const [filters] = useFilters();
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const list = useQuery({
    queryKey: ['strategies', showDeleted ? 'all' : 'active'],
    queryFn: () => api.get<StrategyView[]>(`api/strategies${showDeleted ? '?includeDeleted=1' : ''}`),
  });
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('api/status') });

  const change = async (s: StrategyView, path: 'kill-switch' | 'mode', body: Record<string, unknown>) => {
    setBusy(s.id);
    setError(null);
    try {
      await stepUp(() => api.post(`api/strategies/${s.id}/${path}`, body));
    } catch (err) {
      setError(`Could not change “${s.name}”: ${errorText(err)}`);
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: ['strategies'] });
    }
  };

  // `data` must keep its identity between renders (TanStack Table re-renders on every new array), so the
  // filter lists are compared by value.
  const leagueKey = filters.leagues.join(',');
  const strategyKey = filters.strategies.join(',');
  const rows = useMemo(() => {
    const leagues = leagueKey === '' ? [] : leagueKey.split(',');
    const ids = strategyKey === '' ? [] : strategyKey.split(',');
    return (list.data ?? []).filter(
      (s) =>
        (filters.sport === 'all' || s.sport === filters.sport) &&
        (leagues.length === 0 || s.leagueIds.some((l) => leagues.includes(l))) &&
        (ids.length === 0 || ids.includes(s.id)),
    );
  }, [list.data, filters.sport, leagueKey, strategyKey]);

  // Cells are rendered as components (flexRender): the columns must keep their identity between renders,
  // or every cell (and its switch) would be remounted on each render.
  const changeRef = useRef(change);
  changeRef.current = change;
  const columns = useMemo(
    () => [
      column.accessor('name', {
        header: 'Name',
        cell: (c) => (
          <button
            type="button"
            className="link-button"
            disabled={c.row.original.deletedAt !== null}
            onClick={() => setEditing({ id: c.row.original.id })}
          >
            {c.getValue()}
          </button>
        ),
      }),
      column.accessor('sport', { header: 'Sport' }),
      column.accessor((s) => s.leagueIds.join(', ').toUpperCase(), { id: 'leagues', header: 'Leagues' }),
      column.display({
        id: 'killSwitch',
        header: 'Kill switch',
        cell: (c) => {
          const s = c.row.original;
          return (
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Kill switch: ${s.name}`}
                checked={s.killSwitch}
                disabled={busy !== null || s.deletedAt !== null}
                onChange={(e) => void changeRef.current(s, 'kill-switch', { killSwitch: e.target.checked })}
              />
              <span className="track" aria-hidden="true" />
              <span>{s.killSwitch ? 'On (paused)' : 'Off'}</span>
            </label>
          );
        },
      }),
      column.display({
        id: 'mode',
        header: 'Mode',
        cell: (c) => {
          const s = c.row.original;
          return (
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Live mode: ${s.name}`}
                checked={s.mode === 'live'}
                disabled={busy !== null || s.deletedAt !== null}
                onChange={(e) =>
                  void changeRef.current(s, 'mode', { mode: e.target.checked ? 'live' : 'dry_run' })
                }
              />
              <span className="track" aria-hidden="true" />
              <span>{s.mode === 'live' ? 'Live' : 'Dry run'}</span>
            </label>
          );
        },
      }),
      column.accessor('effectiveMode', {
        header: 'Effective',
        cell: (c) => (
          <span data-testid={`effective-${c.row.original.id}`}>
            {c.row.original.deletedAt !== null ? (
              <span className="mode-badge mode-badge--none">DELETED</span>
            ) : (
              <EffectiveBadge s={c.row.original} />
            )}
          </span>
        ),
      }),
      column.accessor((s) => s.last30d.live.trades + s.last30d.dry_run.trades, {
        id: 'trades30d',
        header: 'Trades 30d (Live | Dry run)',
        cell: (c) => (
          <PerMode live={c.row.original.last30d.live.trades} dry={c.row.original.last30d.dry_run.trades} />
        ),
      }),
      column.display({
        id: 'pnl30d',
        header: 'P&L 30d (Live | Dry run)',
        cell: (c) => (
          <PerMode
            live={formatUsd(c.row.original.last30d.live.pnlMicros)}
            dry={formatUsd(c.row.original.last30d.dry_run.pnlMicros)}
          />
        ),
      }),
      column.accessor('currentVersion', { header: 'Version', cell: (c) => `v${c.getValue()}` }),
    ],
    [busy],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const exportCsv = () => {
    const env = status.data?.kalshiEnv ?? '';
    downloadCsv(
      'strategies.csv',
      toCsv(
        [
          'id',
          'name',
          'sport',
          'leagues',
          'kill_switch',
          'configured_mode',
          'effective_mode',
          'mode_reason',
          'kalshi_env',
          'version',
          'trades_30d_live',
          'pnl_30d_live_micros',
          'trades_30d_dry_run',
          'pnl_30d_dry_run_micros',
          'deleted_at',
        ],
        rows.map((s) => [
          s.id,
          s.name,
          s.sport,
          s.leagueIds.join(' '),
          s.killSwitch ? 1 : 0,
          s.mode,
          s.effectiveMode,
          s.modeReason ?? '',
          env,
          s.currentVersion,
          s.last30d.live.trades,
          s.last30d.live.pnlMicros,
          s.last30d.dry_run.trades,
          s.last30d.dry_run.pnlMicros,
          s.deletedAt ?? '',
        ]),
      ),
    );
  };

  return (
    <>
      <h1>Strategies</h1>
      <FilterBar />
      <section className="card" aria-labelledby="strategies-heading">
        <div className="section-head">
          <h2 id="strategies-heading">Strategies</h2>
          <div className="actions">
            <label className="inline-check">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => setShowDeleted(e.target.checked)}
              />{' '}
              Show deleted
            </label>
            <button
              type="button"
              className="secondary small"
              onClick={exportCsv}
              disabled={rows.length === 0}
            >
              Export CSV
            </button>
            <button type="button" className="small" onClick={() => setEditing({ id: null })}>
              New strategy
            </button>
          </div>
        </div>
        <p className="muted">
          Turning a kill switch off or switching a strategy to live needs your password. The effective mode
          also follows the global switches and the add-on lock set in Home Assistant.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!list.data ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted" data-testid="no-strategies">
            No strategies yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table data-testid="strategies-table">
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
                        {h.column.getCanSort() ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={h.column.getToggleSortingHandler()}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((r) => (
                  <tr key={r.id} data-testid={`strategy-row-${r.original.id}`}>
                    {r.getVisibleCells().map((c) => (
                      <td key={c.id} data-label={String(c.column.columnDef.header)}>
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <StrategyEditor id={editing.id} onClose={() => setEditing(null)} onCreated={() => setEditing(null)} />
      )}
    </>
  );
}
