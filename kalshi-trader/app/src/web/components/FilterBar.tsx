import { useQuery } from '@tanstack/react-query';
import { api, type League, type Status, type StrategyRef } from '../api';
import {
  parseFilters,
  serializeFilters,
  type Filters,
  type ModeFilter,
  type Range,
  type Sport,
} from '../filters';
import { navigate, useLocation } from '../router';

const MODE_LABEL: Record<ModeFilter, string> = { live: 'Live', dry_run: 'Dry run', both: 'Both' };
const RANGE_LABEL: Record<Range, string> = { '7d': '7d', '30d': '30d', season: 'Season', all: 'All' };
const SPORT_LABEL: Record<Sport, string> = { all: 'All sports', soccer: 'Soccer', hockey: 'Hockey' };

/** The URL-synced filter state of the current page. */
export function useFilters(): [Filters, (next: Filters) => void] {
  const { path, search } = useLocation();
  const filters = parseFilters(search);
  // Each change is a history entry, so back/forward walk through earlier filter states.
  const set = (next: Filters) => navigate(`${path}${serializeFilters(next)}`);
  return [filters, set];
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

/** The shared filter bar of every data page (SPEC.md §8). */
export function FilterBar() {
  const [f, set] = useFilters();
  const leagues = useQuery({ queryKey: ['leagues'], queryFn: () => api.get<League[]>('api/leagues') });
  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api.get<StrategyRef[]>('api/strategies'),
  });
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.get<Status>('api/status') });
  const currentEnv = status.data?.kalshiEnv;

  const visibleLeagues = (leagues.data ?? []).filter((l) => f.sport === 'all' || l.sport === f.sport);
  const visibleStrategies = (strategies.data ?? []).filter((s) => f.sport === 'all' || s.sport === f.sport);

  return (
    <section className="filter-bar" aria-label="Filters">
      <div className="filter-group">
        <label htmlFor="filter-sport">Sport</label>
        <select
          id="filter-sport"
          value={f.sport}
          onChange={(e) => {
            const sport = e.target.value as Sport;
            const keep = new Set(
              (leagues.data ?? []).filter((l) => sport === 'all' || l.sport === sport).map((l) => l.id),
            );
            set({ ...f, sport, leagues: f.leagues.filter((id) => keep.has(id)) });
          }}
        >
          {(Object.keys(SPORT_LABEL) as Sport[]).map((s) => (
            <option key={s} value={s}>
              {SPORT_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="filter-group">
        <legend>Leagues</legend>
        <div className="chips">
          {visibleLeagues.map((l) => (
            <label key={l.id} className="chip">
              <input
                type="checkbox"
                checked={f.leagues.includes(l.id)}
                onChange={(e) => set({ ...f, leagues: toggle(f.leagues, l.id, e.target.checked) })}
              />
              {l.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="filter-group">
        <legend>Strategies</legend>
        <div className="chips">
          {visibleStrategies.length === 0 && <span className="muted">No strategies yet</span>}
          {visibleStrategies.map((s) => (
            <label key={s.id} className="chip">
              <input
                type="checkbox"
                checked={f.strategies.includes(s.id)}
                onChange={(e) => set({ ...f, strategies: toggle(f.strategies, s.id, e.target.checked) })}
              />
              {s.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="filter-group">
        <legend>Mode</legend>
        <div className="segmented">
          {(Object.keys(MODE_LABEL) as ModeFilter[]).map((m) => (
            <label key={m} className={f.mode === m ? 'active' : undefined}>
              <input
                type="radio"
                name="filter-mode"
                checked={f.mode === m}
                onChange={() => set({ ...f, mode: m })}
              />
              {MODE_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="filter-group">
        <label htmlFor="filter-env">Kalshi environment</label>
        <select
          id="filter-env"
          value={f.env ?? currentEnv ?? 'demo'}
          onChange={(e) => {
            const env = e.target.value as 'demo' | 'prod';
            set({ ...f, env: env === currentEnv ? null : env });
          }}
        >
          <option value="demo">demo{currentEnv === 'demo' ? ' (current)' : ''}</option>
          <option value="prod">prod{currentEnv === 'prod' ? ' (current)' : ''}</option>
        </select>
      </div>

      <fieldset className="filter-group">
        <legend>Date range</legend>
        <div className="segmented">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <label key={r} className={f.range === r ? 'active' : undefined}>
              <input
                type="radio"
                name="filter-range"
                checked={f.range === r}
                onChange={() => set({ ...f, range: r })}
              />
              {RANGE_LABEL[r]}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
