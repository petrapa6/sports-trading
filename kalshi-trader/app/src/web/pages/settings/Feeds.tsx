import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, kalshiErrorMessage, type FeedInfo, type FeedTestResult } from '../../api';

/** Settings → Feeds (T07): score-feed adapters on/off and "Test feed" (one line per adapter). */
export function FeedsSettings() {
  const queryClient = useQueryClient();
  const feeds = useQuery({ queryKey: ['feeds'], queryFn: () => api.get<FeedInfo[]>('api/feeds') });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FeedTestResult[] | null>(null);

  const toggle = async (feed: FeedInfo, enabled: boolean) => {
    setBusy(feed.id);
    setError(null);
    try {
      queryClient.setQueryData(['feeds'], await api.post<FeedInfo[]>(`api/feeds/${feed.id}`, { enabled }));
    } catch (err) {
      setError(kalshiErrorMessage(err));
      await queryClient.invalidateQueries({ queryKey: ['feeds'] });
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      setResults((await api.post<{ results: FeedTestResult[] }>('api/feeds/test')).results);
    } catch (err) {
      setError(kalshiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="feeds-heading">
      <h2 id="feeds-heading">Feeds</h2>
      <p className="muted">
        Score feeds are polled every 5 s while a tracked game is in progress and every 60 s in the hour before
        one. With two feeds for a game (NHL), a score disagreement lasting more than 20 s blocks entries for
        it.
      </p>
      {!feeds.data && <p className="muted">Loading…</p>}
      <ul className="league-list">
        {feeds.data?.map((f) => (
          <li key={f.id} className="league-card" data-testid={`feed-${f.id}`}>
            <div className="league-head">
              <strong>{f.name}</strong> <span className="muted">({f.sports.join(', ')})</span>
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${f.name} enabled`}
                  checked={f.enabled}
                  disabled={busy !== null}
                  onChange={(e) => void toggle(f, e.target.checked)}
                />
                <span className="track" aria-hidden="true" />
                <span>{f.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
            <span className="muted">
              Status: {f.available ? f.status : 'unavailable (Kalshi credentials not configured)'}
              {f.lastError ? ` — ${f.lastError}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void test()}>
          Test feed
        </button>
      </div>
      {busy === 'test' && <p className="muted">Testing…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {results && (
        <ul className="feed-test" data-testid="feed-test-results">
          {results.map((r) => (
            <li key={r.id} data-testid={`feed-test-${r.id}`} className={r.ok ? 'success' : 'error'}>
              <strong>{r.name}</strong>: {r.ok ? 'OK' : 'failed'} — {r.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
