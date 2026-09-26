import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { FilterBar, useFilters } from '../components/FilterBar';
import { GameCards } from '../components/GameCards';
import { RecentSignals } from '../components/RecentSignals';
import { StatsCharts } from '../components/StatsCharts';
import { StatsTiles } from '../components/StatsTiles';
import { StatusStrip } from '../components/StatusStrip';
import { serializeFilters } from '../filters';
import type { StatsResponse } from '../stats';

/** `GET /api/stats` for the current filter bar state (refreshed on trade events and every minute). */
export function useStats() {
  const [filters] = useFilters();
  const query = serializeFilters(filters);
  return useQuery({
    queryKey: ['trades', 'stats', query],
    queryFn: () => api.get<StatsResponse>(`api/stats${query}`),
    refetchInterval: 60_000,
  });
}

export function DashboardPage() {
  const stats = useStats();
  const props = { stats: stats.data, loading: stats.isPending };
  return (
    <>
      <h1>Dashboard</h1>
      <StatusStrip />
      <GameCards />
      <RecentSignals />
      <FilterBar />
      <StatsTiles {...props} />
      <StatsCharts {...props} />
    </>
  );
}
