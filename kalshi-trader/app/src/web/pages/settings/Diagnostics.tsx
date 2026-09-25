import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Diagnostics } from '../../api';
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
