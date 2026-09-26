import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  kalshiErrorMessage,
  type CsvImportResult,
  type DataSummary,
  type JobView,
  type PriceModelSummary,
  type VacuumResult,
} from '../../api';
import { useStepUp } from '../../reauth';

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const SPORT_LABEL = { soccer: 'Soccer', hockey: 'Hockey' } as const;
const STATUS_LABEL: Record<JobView['status'], string> = {
  running: 'Running',
  paused: 'Paused (kill switch)',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** The NHL season in progress (or the last one before July): `20252026`. */
function currentSeason(now = new Date()): string {
  const start = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${start}${start + 1}`;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 413) return 'The file is larger than 20 MB.';
  return kalshiErrorMessage(err);
}

function JobRow({ job, onCancel }: { job: JobView; onCancel: (id: string) => void }) {
  const active = job.status === 'running' || job.status === 'paused';
  const progress = job.total !== null ? `${job.done} / ${job.total}` : String(job.done);
  return (
    <li className="job-row" data-testid={`job-${job.type}`} data-status={job.status}>
      <div className="job-head">
        <strong>{job.label}</strong>
        <span className={`job-status ${job.status}`}>{STATUS_LABEL[job.status]}</span>
      </div>
      <div className="muted">
        {progress} {job.message ? `· ${job.message}` : ''}
      </div>
      {job.error && (
        <p className="error" role="alert">
          {job.error}
        </p>
      )}
      {active && (
        <button type="button" className="secondary" onClick={() => onCancel(job.id)}>
          Cancel
        </button>
      )}
    </li>
  );
}

function ModelSummary({ model }: { model: PriceModelSummary }) {
  return (
    <dl className="readonly-list" data-testid="price-model">
      {(['soccer', 'hockey'] as const).map((sport) => {
        const s = model.sports[sport];
        return (
          <div className="readonly-item" key={sport} data-testid={`price-model-${sport}`}>
            <dt>{SPORT_LABEL[sport]}</dt>
            <dd>
              Sample size {s.observations} ({s.games} games) · {s.modelledCells} modelled cells, the rest from
              the seed table
            </dd>
          </div>
        );
      })}
      <div className="readonly-item">
        <dt>Built</dt>
        <dd>
          {new Date(model.builtAt).toLocaleString()} · cells below {model.minSamples} observations use the
          seed table
        </dd>
      </div>
    </dl>
  );
}

export function DataSettings() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const summary = useQuery({
    queryKey: ['data-summary'],
    queryFn: () => api.get<DataSummary>('api/data/summary'),
  });
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ jobs: JobView[] }>('api/jobs'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [season, setSeason] = useState(currentSeason);
  const [preseason, setPreseason] = useState(false);
  const [from, setFrom] = useState(() => isoDay(Date.now() - 30 * 86_400_000));
  const [to, setTo] = useState(() => isoDay(Date.now()));
  const [model, setModel] = useState<PriceModelSummary | null>(null);
  const [vacuum, setVacuum] = useState<VacuumResult | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['data-summary'] });
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const addJob = (job: JobView) =>
    queryClient.setQueryData<{ jobs: JobView[] }>(['jobs'], (old) => ({
      jobs: [job, ...(old?.jobs ?? []).filter((j) => j.id !== job.id)],
    }));

  const importCsv = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    void run('csv', async () => {
      const text = await file.text();
      const result = await stepUp(() => api.upload<CsvImportResult>('api/data/csv', text, 'text/csv'));
      if (!result) return;
      setNotice(`${result.rows} rows imported (${result.inserted} new, ${result.updated} updated).`);
      await refresh();
    });
  };
  const startNhl = (e: FormEvent) => {
    e.preventDefault();
    void run('nhl', async () => {
      addJob(await api.post<JobView>('api/data/nhl', { season, includePreseason: preseason }));
    });
  };
  const startBackfill = (e: FormEvent) => {
    e.preventDefault();
    void run('backfill', async () => {
      addJob(await api.post<JobView>('api/data/kalshi-backfill', { from, to }));
    });
  };
  const startCandles = () =>
    void run('candles', async () => {
      addJob(await api.post<JobView>('api/data/candles'));
    });
  const rebuild = () =>
    void run('model', async () => {
      setModel(await api.post<PriceModelSummary>('api/data/price-model'));
      await refresh();
    });
  const runVacuum = () =>
    void run('vacuum', async () => {
      setVacuum(await api.post<VacuumResult>('api/data/vacuum'));
      await refresh();
    });
  const cancel = (id: string) =>
    void run('cancel', async () => {
      addJob(await api.del<JobView>(`api/jobs/${id}`));
      await refresh();
    });

  const s = summary.data;
  const shownModel = model ?? s?.priceModel ?? null;
  const jobList = jobs.data?.jobs ?? [];

  return (
    <section className="settings-section" aria-labelledby="data-heading">
      <h2 id="data-heading">Data</h2>
      <p className="muted">
        Goal timelines and Kalshi prices for backtesting. Long jobs pause while the global kill switch is on
        and can be cancelled; what they already stored is kept.
      </p>

      <dl className="readonly-list">
        <div className="readonly-item">
          <dt>Database size</dt>
          <dd data-testid="data-db-size">
            {s ? `${mb(s.dbSizeBytes)} (${s.dbSizeBytes.toLocaleString('en-US')} bytes, file and WAL)` : '…'}
          </dd>
        </div>
        <div className="readonly-item">
          <dt>Goal timelines</dt>
          <dd data-testid="data-hist-games">
            {s
              ? `${s.histGames.total}${
                  Object.keys(s.histGames.bySource).length > 0
                    ? ` (${Object.entries(s.histGames.bySource)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(', ')})`
                    : ''
                }, ${s.linkedHistGames} linked to Kalshi events`
              : '…'}
          </dd>
        </div>
        <div className="readonly-item">
          <dt>Kalshi candles</dt>
          <dd data-testid="data-hist-prices">
            {s ? `${s.histPrices} one-minute candles, ${s.backfilledGames} backfilled games` : '…'}
          </dd>
        </div>
      </dl>
      <div className="actions">
        <button type="button" className="secondary" disabled={busy !== null} onClick={runVacuum}>
          Vacuum database
        </button>
      </div>
      {vacuum && (
        <p className="muted" data-testid="vacuum-result">
          Vacuum: {mb(vacuum.beforeBytes)} → {mb(vacuum.afterBytes)}
        </p>
      )}

      <h3>Import CSV</h3>
      <p className="muted">
        Columns{' '}
        <code>league_code, season, date, home, away, home_goals_final, away_goals_final, goal_events</code>{' '}
        with <code>goal_events</code> like <code>home:23;away:67;home:90+2</code>. Up to 20 MB; needs your
        password.
      </p>
      <form className="data-form" onSubmit={importCsv}>
        <label htmlFor="csv-file">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={!file || busy !== null}>
          Import CSV
        </button>
      </form>

      <h3>NHL season</h3>
      <form className="data-form" onSubmit={startNhl}>
        <label htmlFor="nhl-season">Season</label>
        <input
          id="nhl-season"
          value={season}
          inputMode="numeric"
          pattern="\d{8}"
          title="e.g. 20252026"
          onChange={(e) => setSeason(e.target.value.trim())}
        />
        <label className="checkbox">
          <input type="checkbox" checked={preseason} onChange={(e) => setPreseason(e.target.checked)} />{' '}
          Include preseason
        </label>
        <button type="submit" disabled={busy !== null}>
          Fetch NHL season
        </button>
      </form>

      <h3>Kalshi</h3>
      <form className="data-form" onSubmit={startBackfill}>
        <label htmlFor="backfill-from">From</label>
        <input id="backfill-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label htmlFor="backfill-to">To</label>
        <input id="backfill-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button type="submit" disabled={busy !== null}>
          Backfill settled events
        </button>
      </form>
      <div className="actions">
        <button type="button" className="secondary" disabled={busy !== null} onClick={startCandles}>
          Collect candles
        </button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={rebuild}>
          Rebuild price model
        </button>
      </div>

      {notice && (
        <p className="success" role="status" data-testid="data-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert" data-testid="data-error">
          {error}
        </p>
      )}

      {shownModel && (
        <>
          <h3>Price model</h3>
          <ModelSummary model={shownModel} />
        </>
      )}

      <h3>Jobs</h3>
      {jobList.length === 0 ? (
        <p className="muted">No jobs since the app started.</p>
      ) : (
        <ul className="job-list">
          {jobList.map((j) => (
            <JobRow key={j.id} job={j} onCancel={cancel} />
          ))}
        </ul>
      )}
    </section>
  );
}
