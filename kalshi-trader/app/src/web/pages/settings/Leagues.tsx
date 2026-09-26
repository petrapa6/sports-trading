import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, kalshiErrorMessage, type DiscoveryResult, type KalshiSeries, type League } from '../../api';

function LeagueCard({ league, onSaved }: { league: League; onSaved: () => Promise<void> }) {
  const [series, setSeries] = useState(league.kalshiSeries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`api/leagues/${league.id}`, patch);
    } catch (err) {
      setError(kalshiErrorMessage(err));
    } finally {
      setBusy(false);
      await onSaved();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({ kalshi_series: series.trim().toUpperCase() });
  };

  return (
    <li className="league-card" data-testid={`league-${league.id}`}>
      <div className="league-head">
        <strong>{league.name}</strong> <span className="muted">({league.sport})</span>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`${league.name} enabled`}
            checked={league.enabled}
            disabled={busy}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span className="track" aria-hidden="true" />
          <span>{league.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
      <form className="league-series" onSubmit={submit}>
        <label htmlFor={`series-${league.id}`}>Kalshi series</label>
        <input
          id={`series-${league.id}`}
          value={series}
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(e) => setSeries(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={busy || series.trim() === league.kalshiSeries}>
          Save
        </button>
      </form>
      <label className="checkbox">
        <input
          type="checkbox"
          aria-label={`${league.name} include preseason`}
          checked={league.includePreseason}
          disabled={busy}
          onChange={(e) => void save({ include_preseason: e.target.checked })}
        />{' '}
        Include preseason
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function LeaguesSettings() {
  const queryClient = useQueryClient();
  const leagues = useQuery({ queryKey: ['leagues'], queryFn: () => api.get<League[]>('api/leagues') });
  const [series, setSeries] = useState<KalshiSeries[] | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [busy, setBusy] = useState<'series' | 'discovery' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['leagues'] });

  const discoverSeries = async () => {
    setBusy('series');
    setError(null);
    try {
      setSeries(await api.get<KalshiSeries[]>('api/kalshi/series'));
    } catch (err) {
      setError(kalshiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const runDiscovery = async () => {
    setBusy('discovery');
    setError(null);
    try {
      setDiscovery(await api.post<DiscoveryResult>('api/kalshi/discovery'));
    } catch (err) {
      setError(kalshiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="leagues-heading">
      <h2 id="leagues-heading">Leagues</h2>
      <p className="muted">
        Each league maps to one Kalshi series. Discovery lists its open events and markets at start-up and
        every day at 05:00.
      </p>
      {!leagues.data && <p className="muted">Loading…</p>}
      <ul className="league-list">
        {leagues.data?.map((l) => (
          <LeagueCard key={`${l.id}-${l.kalshiSeries}`} league={l} onSaved={refresh} />
        ))}
      </ul>

      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy !== null}
          onClick={() => void discoverSeries()}
        >
          Discover series
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void runDiscovery()}>
          Run discovery now
        </button>
      </div>
      {busy && <p className="muted">Working…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {series && (
        <div data-testid="discovered-series">
          <h3>Sports series ending in GAME</h3>
          {series.length === 0 ? (
            <p className="muted">No series found.</p>
          ) : (
            <ul className="series-list">
              {series.map((s) => (
                <li key={s.ticker}>
                  <code>{s.ticker}</code> {s.title && <span className="muted">— {s.title}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {discovery && (
        <div data-testid="discovery-result">
          <h3>Discovery result</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>League</th>
                  <th>Events</th>
                  <th>Games</th>
                  <th>Markets</th>
                  <th>Preseason skipped</th>
                  <th>Unmapped</th>
                </tr>
              </thead>
              <tbody>
                {discovery.leagues.map((l) => (
                  <tr key={l.leagueId}>
                    <td>
                      {l.leagueId} <code>{l.series}</code>
                      {l.error && <div className="error">{l.error}</div>}
                    </td>
                    <td>{l.events}</td>
                    <td>{l.games}</td>
                    <td>{l.markets}</td>
                    <td>{l.skippedPreseason}</td>
                    <td>{l.unknownMarkets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
