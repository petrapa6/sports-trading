import { FilterBar } from '../components/FilterBar';
import { GameCards } from '../components/GameCards';
import { StatusStrip } from '../components/StatusStrip';

export function DashboardPage() {
  return (
    <>
      <h1>Dashboard</h1>
      <StatusStrip />
      <GameCards />
      <FilterBar />
      <section className="card placeholder">
        <h2>Tiles and charts</h2>
        <p className="muted">The per-mode tiles and the Recharts charts arrive with the stats endpoint.</p>
      </section>
    </>
  );
}

export function StrategiesPage() {
  return (
    <>
      <h1>Strategies</h1>
      <FilterBar />
      <section className="card placeholder">
        <p className="muted">The strategy table and editor arrive with the strategy engine.</p>
      </section>
    </>
  );
}

export function TradesPage() {
  return (
    <>
      <h1>Trades</h1>
      <FilterBar />
      <section className="card placeholder">
        <p className="muted">The trade history arrives with the executor.</p>
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
