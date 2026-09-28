# Changelog

All notable changes to the Kalshi Sports Trader app. Versions follow `config.yaml` / `package.json`.

## Unreleased

- **Web UI redesign ("Soft Calm"):** white rounded cards on a faint green-gray background, sage green as the only
  brand hue, Plus Jakarta Sans (bundled, no external requests), 44 px tap targets, a green focus ring, loading
  skeletons, spinners on submit buttons, a brief tint when a live value changes, softer charts in the same palette,
  and matching light and dark schemes. All colours, sizes, radii, shadows and timings come from one token file
  (`app/public/assets/tokens.css`). Deleting a saved backtest now asks for confirmation.

## 0.0.1 — 2026-09-27

Initial release.

- **Trading:** in-game strategies for soccer (EPL, La Liga, Bundesliga, Serie A, Ligue 1) and the NHL, evaluated
  against live game state and the Kalshi order book. Dry run by default (simulated fills at the real order-book
  price, per-mode bankroll); live orders need `allow_live_orders`, global dry run off and a live strategy, and go
  through a dedicated subaccount and order group with guards, retries, recovery on restart and reconciliation.
- **Feeds:** Kalshi market discovery and live data, the NHL Web API and API-Football (optional), with a network gate,
  rate limiting, score cross-checks and replay of recorded games.
- **Web UI:** dashboard with live game cards, Strategies, Trades, Stats (split by mode), Backtest and Settings
  (account, trading, leagues, feeds, notifications, data, diagnostics); live updates over SSE.
- **Backtesting:** historical importers (NHL, Kalshi backfill, CSV, API-Football), candle collector, price model and
  a simulator that reuses the live engine.
- **Notifications:** Home Assistant notifications for fills, settlements, the kill switch, the global dry-run
  switch and feed disagreements, toggled per event and per mode.
- **Security:** own login with optional TOTP, step-up re-authentication, sessions, CSRF protection, per-request-class headers and rate limits,
  audit log; the Kalshi key is handed over on a file descriptor and never enters the environment.
- **Home Assistant app:** aarch64 and amd64 images, ingress, non-root and read-only container, health check,
  watchdog, database maintenance and hot backups.
