import { FilterBar } from '../components/FilterBar';
import { GameCards } from '../components/GameCards';
import { RecentSignals } from '../components/RecentSignals';
import { StatusStrip } from '../components/StatusStrip';

export function DashboardPage() {
  return (
    <>
      <h1>Dashboard</h1>
      <StatusStrip />
      <GameCards />
      <RecentSignals />
      <FilterBar />
      <section className="card placeholder">
        <h2>Tiles and charts</h2>
        <p className="muted">The per-mode tiles and the Recharts charts arrive with the stats endpoint.</p>
      </section>
    </>
  );
}

export function BacktestPage() {
  return (
    <>
      <h1>Backtest</h1>
      <section className="card placeholder">
        <p className="muted">
          Backtests replay a strategy over a past season. They are a separate category and are never plotted
          together with live or dry-run data.
        </p>
      </section>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1>Not found</h1>
      <p className="muted">This page does not exist.</p>
    </>
  );
}
