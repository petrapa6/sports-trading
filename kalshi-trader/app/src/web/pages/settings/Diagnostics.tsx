import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatUsd, type Diagnostics, type KalshiConnectionTest } from '../../api';
import { ModeBadge } from '../../components/ModeBadge';
import { useLive } from '../../live';
import { filterLogs, type LogModeFilter } from '../../logFilter';

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

export function DiagnosticsSettings() {
  const diag = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.get<Diagnostics>('api/diagnostics'),
  });
  const { logs } = useLive();
  const [filter, setFilter] = useState<LogModeFilter>('all');
  const shown = filterLogs(logs, filter);
  const [test, setTest] = useState<KalshiConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.post<KalshiConnectionTest>('api/diagnostics/kalshi'));
    } catch {
      setTest(null);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="diagnostics-heading">
      <h2 id="diagnostics-heading">Diagnostics</h2>
      <dl className="readonly-list">
        <div className="readonly-item">
          <dt>App version</dt>
          <dd data-testid="app-version">{diag.data?.version ?? '…'}</dd>
        </div>
        <div className="readonly-item">
          <dt>Database path</dt>
          <dd>
            <code data-testid="db-path">{diag.data?.dbPath ?? '…'}</code>
          </dd>
        </div>
        <div className="readonly-item">
          <dt>Database size</dt>
          <dd data-testid="db-size">{diag.data ? mb(diag.data.dbSizeBytes) : '…'}</dd>
        </div>
      </dl>

      <h3>Kalshi connection</h3>
      <div className="actions">
        <button type="button" className="secondary" disabled={testing} onClick={() => void runTest()}>
          Test Kalshi connection
        </button>
      </div>
      {testing && <p className="muted">Testing…</p>}
      {test && (
        <dl className="readonly-list" data-testid="kalshi-test">
          <div className="readonly-item">
            <dt>Environment</dt>
            <dd>
              <code>{test.env}</code>
            </dd>
          </div>
          <div className="readonly-item">
            <dt>Subaccount</dt>
            <dd>
              <code>{test.subaccount === 0 ? '0 (primary)' : test.subaccount}</code>
            </dd>
          </div>
          {test.ok && test.balance && (
            <div className="readonly-item">
              <dt>Balance</dt>
              <dd data-testid="kalshi-balance">{formatUsd(test.balance.cashMicros)}</dd>
            </div>
          )}
          {test.ok && test.exchange && (
            <div className="readonly-item">
              <dt>Exchange</dt>
              <dd>
                {test.exchange.exchangeActive ? 'open' : 'closed'}; trading{' '}
                {test.exchange.tradingActive ? 'active' : 'paused'}
              </dd>
            </div>
          )}
          {!test.ok && (
            <p className="error" role="alert">
              {test.error}
            </p>
          )}
        </dl>
      )}

      <div className="log-header">
        <h3>Log tail</h3>
        <label htmlFor="log-mode">Mode</label>
        <select id="log-mode" value={filter} onChange={(e) => setFilter(e.target.value as LogModeFilter)}>
          <option value="all">All lines</option>
          <option value="live">Live</option>
          <option value="dry_run">Dry run</option>
        </select>
      </div>
      <ol className="log-tail" data-testid="log-tail">
        {shown.length === 0 && <li className="muted">No log lines.</li>}
        {shown.map((l) => (
          <li key={`${l.seq}-${l.time}`} className={`log-line level-${l.level}`} data-mode={l.mode ?? 'none'}>
            <time dateTime={l.time}>{new Date(l.time).toLocaleTimeString()}</time>
            <span className="log-level">{l.level}</span>
            {l.mode ? (
              <ModeBadge effective={l.mode} />
            ) : (
              <span className="mode-badge mode-badge--none">—</span>
            )}
            <span className="log-msg">{l.msg}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
