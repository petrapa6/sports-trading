# Kalshi Sports Trader

In-game sports strategy trader for Kalshi with dry-run mode and backtesting — a Home Assistant app.

- Watches live soccer and NHL games and evaluates your strategies in real time.
- **Dry run** by default: simulated fills at the real order-book price; real orders need the
  `allow_live_orders` option, global dry run off and a live strategy.
- Web UI in the Home Assistant sidebar (ingress); optional remote access through the `cloudflared` app.

See the **Documentation** tab (`DOCS.md`) for installation, the Kalshi key, every option, remote access and
backups. Source and specification: <https://github.com/petrapa6/sports-trading>.
