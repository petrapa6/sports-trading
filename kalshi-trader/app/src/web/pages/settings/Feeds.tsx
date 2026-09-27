import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  kalshiErrorMessage,
  type ApiFootballSettings,
  type FeedInfo,
  type FeedTestResult,
} from '../../api';

const UNAVAILABLE_TEXT: Record<string, string> = {
  'kalshi-live': 'unavailable (Kalshi credentials not configured)',
  'api-football': 'unavailable (no API-Football key stored)',
};

/**
 * Settings → Feeds → API-Football: the key field (masked: the stored key never comes back from the
 * server), today's request usage against the daily limit, and the limit itself.
 */
function ApiFootballPanel({ onChanged }: { onChanged: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['api-football'],
    queryFn: () => api.get<ApiFootballSettings>('api/settings/api-football'),
  });
  const [key, setKey] = useState('');
  const [limit, setLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      queryClient.setQueryData(
        ['api-football'],
        await api.post<ApiFootballSettings>('api/settings/api-football', body),
      );
      setMessage({ ok: true, text: done });
      onChanged();
      return true;
    } catch (err) {
      setMessage({ ok: false, text: kalshiErrorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const s = q.data;
  if (!s) return <p className="muted">Loading…</p>;
  const limitText = limit ?? String(s.quota.limit);
  const limitValue = /^\d+$/.test(limitText) ? Number(limitText) : null;
  return (
    <div className="api-football" data-testid="api-football-settings">
      <h3>API-Football</h3>
      <p className="muted">
        Soccer minute and score from API-Football (off by default). Its minute is used whenever it is fresh; a
        score disagreement with Kalshi for more than 20 s blocks entries. Every request counts against the
        daily limit below.
      </p>
      <form
        className="bankroll-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() === '') return;
          void save({ key: key.trim() }, 'API-Football key saved.').then((ok) => ok && setKey(''));
        }}
      >
        <div className="field">
          <label htmlFor="api-football-key">API key</label>
          <input
            id="api-football-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={s.maskedKey ?? 'not set'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <button type="submit" className="secondary small" disabled={busy || key.trim() === ''}>
          {s.configured ? 'Replace key' : 'Save key'}
        </button>
        {s.configured && (
          <button
            type="button"
            className="secondary small danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Remove the stored API-Football key?')) return;
              void save({ key: null }, 'API-Football key removed.');
            }}
          >
            Remove key
          </button>
        )}
      </form>
      <p data-testid="api-football-key-state">
        Key:{' '}
        {s.configured ? (
          <span aria-label="stored (masked)">{s.maskedKey} (stored, encrypted)</span>
        ) : (
          'not set'
        )}
      </p>
      <p data-testid="api-football-quota">
        Requests today: {s.quota.used} / {s.quota.limit}{' '}
        <span className="muted">({s.quota.day}; resets at local midnight)</span>
      </p>
      <form
        className="bankroll-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (limitValue === null) return;
          void save({ dailyLimit: limitValue }, 'Daily limit saved.').then((ok) => ok && setLimit(null));
        }}
      >
        <div className="field">
          <label htmlFor="api-football-limit">Daily request limit</label>
          <input
            id="api-football-limit"
            inputMode="numeric"
            value={limitText}
            aria-invalid={limitValue === null ? true : undefined}
            onChange={(e) => setLimit(e.target.value)}
          />
        </div>
        <button type="submit" className="secondary small" disabled={busy || limitValue === null}>
          Save limit
        </button>
      </form>
      {message && (
        <p className={message.ok ? 'success' : 'error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Settings → Feeds: score-feed adapters on/off and "Test feed" (one line per adapter). */
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
        one. With two feeds for a game (NHL, or soccer with API-Football), a score disagreement lasting more
        than 20 s blocks entries for it.
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
              Status: {f.available ? f.status : (UNAVAILABLE_TEXT[f.id] ?? 'unavailable')}
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
      <ApiFootballPanel onChanged={() => void queryClient.invalidateQueries({ queryKey: ['feeds'] })} />
    </section>
  );
}
