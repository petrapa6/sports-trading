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
