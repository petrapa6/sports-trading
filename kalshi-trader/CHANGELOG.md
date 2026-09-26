# Changelog

All notable changes to the Kalshi Sports Trader app. Versions follow `config.yaml` / `package.json`.

## 1.0.0 — 2026-09-26

First release. Everything listed under 0.1.0 (T01–T13, developed as 0.1.0 and never released) is part of it.

### T14 — Hardening, operations, v1.0.0, HAOS hand-over checklist

- `npm run audit:security`: the security test suite, `gitleaks` over the git history, `npm audit --audit-level=high`
  and response headers per request class (ingress, tunnel, dev, other) against a running production build — a
  strict CSP (no `unsafe-inline` / `unsafe-eval` / wildcards), framing per class, `no-referrer`, `nosniff`, HSTS on
  tunnel responses, no stack traces — one line per check, a summary table, exit 1 on any failure.
- A database locked by another process past the 5 s `busy_timeout` answers `503 {"error":"db_busy"}` (with
  `Retry-After: 1`) instead of a 500.
- Failure drills in `scripts/drills/` with development-only drill endpoints (`/api/dev/drills/stall-scheduler`,
  `resume-scheduler`; 404 in production): stalled loop → `/healthz` 503; exclusive SQLite lock → `db_busy` then
  recovery; Kalshi 503 for 10 minutes → feeds keep polling, attempts `error`; global kill switch → zero requests.
- The Kalshi client logs `Kalshi reachable again` (outage length, failed calls) on the first successful call after
  an outage, and no longer waits for the discarded body of a 429 / 5xx answer to be cancelled before backing off.
- The nightly maintenance line reads `Maintenance done: wal_checkpoint(TRUNCATE), pruned N snapshots`.
- `npm run seed:season` (2 000 games, 60 000 snapshots, 400 trades; ≈45 MB after a checkpoint), a maintenance test
  on it, and a migration down/up check that keeps every row count.
- `npm run lighthouse:a11y`: Lighthouse accessibility for Dashboard and Trades at 1280 px and 390 px (all 100).
- Local `docker compose` runs add `no-new-privileges`; `npm run verify:T14 -- --only=container` checks the node
  process's capabilities (CapEff / CapPrm 0), the read-only root and `NoNewPrivs` in CI's Image workflow.
- Version 1.0.0 in `config.yaml`, `package.json` and the image label; `DOCS.md` completed (outbound hosts, health
  and maintenance, container hardening, troubleshooting); `docs/verification/HAOS.md` hand-over checklist;
  `docs/decisions/0003-spec-reconciliation.md`; `npm run verify:T14`, `docs/verification/T14.md`.

## 0.1.0 — development builds (T01–T13, not released)

### T01 — Repository scaffold, config, tooling, CI

- Node.js 22 / TypeScript (strict) / ESM project in `kalshi-trader/app` with the §4 module layout.
- Fastify 5 app factory (`src/server/app.ts`) with Pino JSON logging; `GET /healthz` returns `{"ok":true}`.
- `src/core/decimal.ts`: exact `*_dollars` / `*_fp` string ↔ integer (`_bp`, `_micros`, `_cc`) converters.
- `src/config.ts`: Zod-validated configuration from environment variables, then `config.local.json`, then
  defaults; fails fast naming the offending key; Kalshi credentials optional (one `warn` when absent);
  `ALLOW_LIVE_ORDERS` defaults to `false`.
- Secret hygiene: `.gitignore` / `.dockerignore`, lefthook pre-commit hook running gitleaks
  (`.gitleaks.toml` adds a rule for bare PEM private-key headers), forbidden-file check.
- ESLint (with a rule forbidding `parseFloat` / `Number()` / unary `+` on `*_dollars` / `*_fp` fields),
  Prettier, Vitest, Playwright; GitHub Actions `ci.yml`.
- `family-dashboard` could not be read in this session; conventions taken from SPEC.md §11
  (`docs/decisions/0001-conventions.md`).

### T02 — SQLite schema, migrations, repositories, maintenance

- `better-sqlite3` connection helper (`src/db/connection.ts`): WAL, `foreign_keys=ON`, `busy_timeout=5000`;
  creates the `DB_PATH` directory itself.
- Drizzle schema for every §7 table (`src/db/schema.ts`); migrations in `kalshi-trader/app/migrations`
  (`0000_initial_schema`, `0001_seed_leagues` with the six leagues), applied on start-up before the server
  listens (a failed migration exits 1). Hand-written down migrations in `migrations/down/`;
  `npm run db:migrate`, `db:migrate:down`, `db:generate`, `db:studio`.
- Typed repositories for every table (`src/db/repositories.ts`) that reject non-integer values in INTEGER
  columns (all `*_micros` / `*_bp` / `*_cc`), non-strings in TEXT columns and unknown columns; typed
  `settings` get/set with the §7 defaults (`src/db/settings.ts`).
- `src/core/maintenance.ts`: daily 02:30 local (`TZ`) `wal_checkpoint(TRUNCATE)` and pruning of
  `game_snapshots` older than 90 days for games with `timeline_archived = 1`; injectable clock.
- `/healthz` opens the database and runs `SELECT 1`; `503 {"ok":false,"db":"<error code>"}` when it cannot.
- `npm run verify:T02`; `docs/verification/T02.md`.

### T03 — Request classes, authentication, sessions, HTTP hardening, audit log

- Request classification (`src/server/requestClass.ts`): `ingress` / `tunnel` / `dev` / `other` from the socket
  peer, `X-Ingress-Path`, `CF-Connecting-IP` and `TRUSTED_PROXIES`; resolved client IP.
- `@fastify/helmet` with a strict CSP (`default-src 'self'`, no inline scripts), `Referrer-Policy: no-referrer`,
  framing per class (`SAMEORIGIN`/`'self'` for ingress, `DENY`/`'none'` otherwise), HSTS for the tunnel.
- `@fastify/rate-limit`: 300/min per client IP (assets and `/api/live` exempt), `/login` 5/min.
- Server-side sessions in `sessions` (SHA-256 of a 256-bit id, signed cookie, per-channel name/path/flags,
  12 h idle, 7 d absolute, rotation on login), session list/revoke, logout.
- First-run `/setup` (ingress or dev only, while `users` is empty) with argon2id (m = 64 MiB, t = 3); login with a
  constant-time failure path; lockout for tunnel/other after 10 failures per IP or username in 15 min (doubling);
  every attempt in `login_attempts` and `audit_log`.
- Step-up (`requireRecentAuth`, `POST /auth/reauth`), password change, CSRF tokens bound to the session
  (`@fastify/csrf-protection`, `GET /api/csrf`), TOTP enrol/confirm/disable (`otplib`) with 10 single-use
  recovery codes stored as argon2id hashes.
- `${DATA_DIR}/secret.key` (mode 600) generated on first start; HKDF-derived keys for cookies, CSRF and
  `encryptSetting` / `decryptSetting` (AES-256-GCM).
- Error handler: `{"error":"internal","correlationId":"…"}` with the id logged; no stack traces in responses.
- Minimal server-rendered login/setup pages (`public/assets/auth.css`); `npm run verify:T03`;
  `docs/verification/T03.md`.

### T04 — Web UI shell, filter bar, switches, Settings skeleton, SSE

- React 19 + Vite app in `src/web` (TanStack Query, TanStack Table, Recharts), built into `dist/web` by
  `npm run build` and served by Fastify: hashed assets under `/assets/` with
  `cache-control: public, max-age=31536000, immutable`; the HTML shell (no inline script or style) for `/`,
  `/strategies`, `/trades`, `/backtest`, `/settings/*`, `/login`, `/setup`, with `<base href>` and asset URLs
  rewritten to the `X-Ingress-Path` prefix. `npm run dev:web` (Vite on :5173, proxy to :8099).
- Phone-first, dark/light-aware layout with navigation to Dashboard, Strategies, Trades, Backtest, Settings
  (placeholder pages); React login (optional TOTP, generic error, lockout notice) and first-run setup pages;
  `GET /auth/state`.
- Shared filter bar (sport, leagues, strategies, mode live / dry run / both, Kalshi environment, 7d / 30d /
  season / all) whose state lives in the URL; `GET /api/leagues`, `GET /api/strategies`.
- `ModeBadge` (`LIVE`, `DRY RUN`, `LIVE → DRY RUN (global)`, `LIVE → DRY RUN (add-on lock)`) and the shared
  chart style tokens (live solid, dry run dashed / hatched).
- `GET /api/live` (SSE): switch states, the last 50 log lines from an in-memory ring fed by Pino (each with
  `mode`), new lines as they are logged, switch changes, a heartbeat every 10 s; the session is re-checked at
  every heartbeat. React hook with automatic reconnect and a "Live: reconnected" indicator.
- Settings → Trading: global kill switch and global dry run (`POST /api/settings`; turning either off needs
  step-up, the React prompt asks for the password; audit rows `global_kill_switch_on/off`,
  `global_dry_run_on/off`), read-only `allow_live_orders`, Kalshi environment and subaccount
  (`GET /api/status`). Settings → Account: password change, TOTP enrol with QR code / disable, sessions with
  revoke. Settings → Diagnostics: version, DB path and size (`GET /api/diagnostics`), live log tail with a mode
  filter.
- Playwright suite `test/e2e/shell.spec.ts` at 1280 px and 390 px (zero CSP console messages, no sideways
  scrolling, ingress through a local prefix-stripping proxy); `npm run verify:T04`; `docs/verification/T04.md`.

### T05 — Home Assistant app packaging

- The repository is a Home Assistant app repository: `repository.yaml`; `kalshi-trader/config.yaml` (exactly
  SPEC.md §11: ingress on 8099, `ports: 8099/tcp: null`, `init: true`, no `map`, options incl.
  `allow_live_orders`, `kalshi_subaccount`, `trusted_proxies`, optional `timezone`), `translations/en.yaml`,
  `DOCS.md`, `README.md`, `icon.png`, `logo.png`.
- Two-stage `Dockerfile` on the pinned `ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b…` (Alpine 3.22,
  `nodejs` 22) for both stages (`docs/decisions/0002-base-image.md`); native modules compiled in the build stage;
  production dependencies only; Node runs as `trader` (uid 1000) via `su-exec`; healthcheck on `/healthz`.
- `run.sh` (bashio, root): exports the options, prepares `/data/db` and `/data/app` (uid 1000, mode 700), hands the
  private key to Node on fd 3. Deviation from §11: the descriptor number is passed as `--kalshi-private-key-fd=3`
  (not `KALSHI_PRIVATE_KEY_FD=3` in the environment), so no `KALSHI_PRIVATE*` name is in `/proc/<pid>/environ`.
  Node reads fd 3 at boot and closes it once the database and the listening socket are open, so fd 3 is free
  after boot.
- Development-only `GET /api/dev/key-fingerprint` (only with `NODE_ENV=development`, only from loopback): the
  SHA-256 of the loaded key's SPKI public key, equal to `openssl pkey -in key.pem -pubout | sha256sum`.
- `docker-compose.yml` for local runs (`./.local/data:/data`, `read_only: true`, `tmpfs: /tmp`, init) and
  `npm run compose:options` (writes the root-owned `options.json` from `config.local.json`).
- `npm run check:addon` (`scripts/check-addon-config.ts`): required keys, options ↔ schema parity,
  `ingress_port` = `PORT`, `ports` 8099 = `null`, `init: true`, no `map`, no privileged keys, version =
  `package.json`. New dev dependency `yaml` for it.
- CI `image.yml`: `docker buildx build --platform linux/arm64,linux/amd64` under QEMU plus the arm64
  `better-sqlite3` check, and the amd64 container checks of `npm run verify:T05`; `publish.yml` (GHCR) present but
  disabled. `docs/verification/T05.md`.

### T06 — Kalshi API client, network gate, market discovery

- `src/feeds/kalshi/client.ts`: hand-written Kalshi Trade API v2 client — RSA-PSS/SHA-256 signing over
  `timestamp + METHOD + path` (no query; `signing.ts`), base URL by `KALSHI_ENV`, token buckets (reads 200/s ×
  3 s, writes 100/s × 1 s, 10 tokens per request; `rateLimiter.ts`), backoff on `429`/`5xx` (0.5, 1, 2, 4 s; 5
  attempts, then `KalshiUnavailable`), typed methods for balance, exchange status/schedule, series, events,
  milestones, markets (incl. historical), orderbook (YES asks derived from NO bids), candlesticks (incl.
  historical), historical cutoff, live data (single and batch), game stats, Create Order V2, orders (incl.
  historical), positions, settlements, fills, order groups and the tier upgrade. Every response is Zod-validated
  (`schemas.ts`, `.passthrough()`) and converted to `_bp` / `_micros` / `_cc`; cursor pagination; `subaccount`
  when > 0. Only method + path are logged.
- `src/feeds/network.ts`: `assertNetworkAllowed()` gate — `NetworkPaused` while the global kill switch is on
  (read from the database on every call).
- `src/feeds/kalshi/discovery.ts`: open events → preseason filter → milestones → upsert `teams`, `games`,
  `markets` (outcomes `home`/`away`/`tie`/`unknown`, `price_ranges`); idempotent; at start-up (after the server
  listens), daily at 05:00 local, and on demand; never two runs at once.
- `src/core/pricing.ts`: `feeMicros` / `costMicros` (SPEC.md §2 fee formula, integer).
- API: `GET /api/leagues` now returns the series and include-preseason flag; `POST /api/leagues/:id` (audited
  `league_change`); `GET /api/kalshi/series` (Sports series ending in `GAME`); `POST /api/kalshi/discovery`
  (audited `discovery_run`); `POST /api/diagnostics/kalshi` (environment, subaccount, balance, exchange status or a
  readable error).
- UI: Settings → Leagues (enable, series ticker, include preseason, Discover series, Run discovery now);
  Settings → Diagnostics → Test Kalshi connection.
- `npm run kalshi:smoke`, `npm run fixtures:record:kalshi`, `npm run verify:T06`; hand-written fixtures in
  `test/fixtures/kalshi/` served by `msw` (new dev dependency) in unit tests and by `test/e2e/fake-kalshi.ts` in
  the e2e run. Deviations and unverified field names: SPEC.md §14 T06 implementation notes;
  `docs/verification/T06.md`.

### T07 — Score feeds, GameTracker, Scheduler, replay, live cards, timeline archive

- `src/feeds/gameState.ts`: `GameState` / `ScoreFeed` (SPEC.md §3), feed ids, derived soccer minute (whole minutes
  since the observed kick-off / second-half start, capped at 45 / 90), hockey elapsed minute.
- `src/feeds/kalshi/live.ts` (`kalshi-live`): one batch live-data request per tick for every tracked milestone;
  hockey `round` / `final_round_time_left` (intermission at `00:00` in rounds 1–2); soccer minute parsed from
  `tileLiveText` / `widgetLiveText` (`78'`, `45+2'` → 45, `90+4'` → 90, `HT`, `FT`, `1st Half`, `Postponed`),
  otherwise derived (`minuteSource: 'derived'`), an unknown text logged once per game.
- `src/feeds/nhl/feed.ts` (`nhl-official`): NHL Web API `/v1/score/now` (+ `/v1/gamecenter/{id}/landing` for a
  tracked game missing from it), matched by tricodes (`teams.aliases`) and start time or an NHL id in the milestone
  `source_ids`; `FUT`/`PRE` scheduled, `LIVE`/`CRIT` live, `FINAL`/`OFF` finished. Every request passes the
  network gate.
- `src/core/tracker.ts`: feed merge (agreed score; a disagreement > 20 s sets `games.blocked = 1` with a `warn`,
  agreement clears it; NHL feed = hockey clock), one `game_snapshots` row per observation (with `minute_source`),
  `games` updates, kick-off / second-half observation, `stateUpdated` / `phaseChanged` events; on `finished` the
  goal events are derived from the snapshot score changes and written to `hist_games` (`source='live'`),
  `timeline_archived = 1`.
- `src/core/scheduler.ts`: 5 s while a tracked game is in progress, 60 s in the hour before a game, idle
  otherwise, **paused** (zero requests) while the global kill switch is on; feeds polled with
  `Promise.allSettled`; Kalshi balance every 5 min for the status strip. `/healthz` now answers
  `{"ok":true,"loop":"running"|"idle"|"paused"|"starting"}`, and `503 {"ok":false,"loop":"stale"}` after 2 minutes
  without a tick.
- Replay: `src/core/replay.ts` (self-contained JSONL lines), `npm run replay -- --file … --speed 100` (posts to the
  development-only `POST /api/dev/replay`), `npm run fixtures:record:feeds`, sample
  `test/fixtures/replay/nhl-sample.jsonl`; `npm run feeds:smoke` (today's NHL games from the real API).
- API: `GET /api/games`, `GET /api/loop`, `GET /api/feeds`, `POST /api/feeds/:id` (audited `feed_change`),
  `POST /api/feeds/test`; SSE `/api/live` adds `games` (`{games: […]}` with score and clock incl.
  `minuteSource`) and `loop` events. New setting `feeds` (adapter → enabled).
- UI: Dashboard status strip (loop state, last poll, feeds with per-adapter status, Kalshi env + balance, the three
  switches) and live game cards (score, phase / clock, minute with a "derived" marker, blocked warning);
  Settings → Feeds (adapters on/off, Test feed).
- CI: a `feeds-smoke` job runs `npm run feeds:smoke` against the real NHL API. `npm run verify:T07`;
  `docs/verification/T07.md`. Deviations: SPEC.md §14 T07 implementation notes.

### T08 — Strategy model, effective mode, engine, Strategies page

- `src/core/strategy.ts`: Zod schemas for the §5 strategy JSON (`rule.version`, `minLead ≥ 1`, soccer `atMinute`
  1–90 / hockey 1–59, sport-default `windowMinutes` 5 / 3, `leaderSide`, `percent_of_balance` sizing,
  `execution` with `maxSlippage` default 0.01, optional `minPrice` < `maxPrice`, `maxFeedAgeSec` default 15);
  amounts limited to the precision the integer units hold (prices 4 decimals). Shared with the web editor.
- `src/core/modes.ts`: `effectiveMode(...)` exactly per §1 (table-tested over all 32 switch combinations).
- `src/core/engine.ts`: `lead_at_time` evaluator (soccer match minute with stoppage = 45 / 90, hockey elapsed
  minute from period and clock; never in a break, after regulation / in OT, or while `blocked` — logged at
  `debug`) and `StrategyEngine`: on every `stateUpdated`, strategies whose effective mode is not `paused`, whose
  leagues include the game's and whose sport matches are evaluated; the first match per (strategy, game) emits a
  `Signal` (`strategyId`, `version`, `gameId`, `marketTicker`, `snapshot`, `configuredMode`, `effectiveMode`,
  `modeReason`), logged with its `mode` and pushed over SSE; none when a `trades` row exists.
- `src/core/strategyStore.ts` + `src/server/routes/strategies.ts`: create (kill switch on, `dry_run`, version 1),
  edit (a new `strategy_versions` row; earlier versions untouched), kill switch and mode toggles (no version;
  audited `strategy_kill_switch_changed` / `strategy_mode_changed`; step-up for kill switch **off** and mode →
  **live**), soft delete, list with `?includeDeleted=1`, 30-day trades / P&L per mode.
- SSE `/api/live` adds `strategies` (effective-mode badges), `signals` (recent) and `signal` events; live game
  cards list the armed strategies with their badges; Dashboard "Recent signals".
- Strategies page: TanStack table (sort, CSV export) with kill switch and mode toggles and the effective-mode
  badge, editor drawer with every §5 field and inline validation, version history, "Test against last 30 days"
  disabled until T12.
- Replayed games get `<event>-<ABBR>` markets so replay signals carry a market ticker.
- `npm run verify:T08`; `docs/verification/T08.md`. Deviations: SPEC.md §14 T08 implementation notes.

### T09 — Executor, guards, retries and Settler in dry run; Trades page

- `src/core/pricing.ts`: `feeMicros` (also `{multiplier}`), `limitPriceBp` snapped down to the market's
  `price_ranges`, `contractsFor`, `stakeMicros`, `payoutMicros`, `realizedPnlMicros`, `unrealizedPnlMicros`.
- `src/core/guards.ts`: the §5 guard table with hard / soft classes; `evaluateEntry` runs guards 1–9 and computes
  best ask, limit, depth, stake and contracts (shared with the backtester in T12).
- `src/core/executor.ts`: trade row on the signal (`signalled`), serial attempt queue; each attempt inserts its
  `trade_attempts` row (`pending`, `<trade.id>-<n>`) before any HTTP, recomputes the effective mode, reads market,
  exchange status and orderbook, runs the guards; soft → `waiting` and retried on every tick while the rule
  matches, window end → `skipped` / `window_expired`; dry-run virtual fill at the limit price with the bankroll
  debit and a `bankroll_snapshots` row in one transaction; live effective mode → `hard_skip` /
  `live_not_implemented`. Start-up recovery of pending dry-run attempts (`unfilled` / `restart`).
- `src/core/settler.ts`: every 60 s (idle under the global kill switch) settles `filled` trades from
  `settlement_value_dollars` (`/historical/markets` past the cutoff), credits the dry-run bankroll.
- Every trade and attempt state change writes an `audit_log` row (`entity = 'trade'`, `mode`); SSE `trade` events.
- `GET /api/trades` (filter bar + status / reason) and `GET /api/trades/:id`; `POST /api/settings/bankroll/reset`
  (step-up); `fee_balance_precision_micros` and `dry_run_initial_bankroll_micros` writable.
- Trades page (TanStack table, status filter, mode badges, expandable snapshot / attempts / fill / settlement /
  audit trail, CSV with mode columns); Settings → Trading: dry-run bankroll and fee precision.
- `npm run verify:T09`; `docs/verification/T09.md`. Deviations: SPEC.md §14 T09 implementation notes.

### T10 — Stats endpoint and Recharts dashboard, split by mode

- `GET /api/stats?sport&leagues&strategies&mode&env&range` (`src/server/routes/stats.ts`, `src/core/stats.ts`):
  `{ live: {tiles, series}, dry_run: {tiles, series} }`, a mode filtered out is absent; every aggregate is computed
  per mode in SQL (`src/db/stats.ts`, window functions for the equity curve); unknown league → `400`.
- Tiles: trades, win rate (void excluded), net P&L, ROI, max drawdown, avg price, avg fee, implied vs actual,
  forced-dry-run share (dry run only). Series: equity (total + per strategy), bankroll / balance line, daily P&L,
  drawdown, implied-vs-actual points, price histogram, trades per minute, skip reasons (final and per attempt).
- Dashboard: per-mode tiles (two values side by side with mode = both) and the eight Recharts charts (live solid,
  dry run dashed / hatched, legends "Live" / "Dry run", one tooltip format naming the mode, empty and loading
  states, light / dark palette). Trades page: price-paid histogram and P&L per trade, split by mode.
- `test/fixtures/db/stats-seed.sql` with `stats-seed.expected.json` and `stats-seed.md`;
  `npm run seed:demo -- --trades 500`; `npm run verify:T10`; `docs/verification/T10.md`.
  Deviations: SPEC.md §14 T10 implementation notes.

### T11 — Historical importers, candle collector, backfill, price model

- NHL importer (`src/backtest/nhlImporter.ts`): `/v1/schedule/{date}` week by week over a season +
  `/v1/gamecenter/{id}/play-by-play` → `hist_games` (`source='nhl'`, id `nhl:<gameId>`); preseason only on
  request; official final incl. the shootout, shootout attempts never goal events; resumable (`skipped N existing`),
  4 requests/s, network gate; `npm run import:nhl -- --season 20252026 [--limit N] [--preseason]`.
- Kalshi backfill (`src/backtest/kalshiBackfill.ts`): settled events of the enabled series within a date range →
  games with `historical = 1` (new column, migration `0002_games_historical`; never tracked or traded) and their
  settled markets; then the play-by-play importer (`src/backtest/kalshiPbp.ts`) turns `game_stats` into
  `hist_games` (`source='kalshi_pbp'`) — soccer and hockey payloads qualify.
- CSV importer (`src/backtest/csvImporter.ts`): §3 columns, per-row validation naming row and column, 20 MB limit,
  step-up; idempotent upsert.
- Candle collector (`src/backtest/candles.ts`): 1-minute candles of every finished / backfilled game's markets →
  `hist_prices` (`/historical/markets/…` before the historical cutoff, `/series/…` after); links NHL / CSV
  timelines to their Kalshi event (`kalshi_event_ticker`).
- Price model (`src/backtest/priceModel.ts`): median ask close by (sport, lead 1/2/3+, 5-minute remaining bucket)
  from `hist_prices` + `hist_games`, seed table below 20 observations, stored in `settings.price_model`;
  `priceModelLookup` for T12.
- Jobs (`src/backtest/jobs.ts`): in-memory data jobs with SSE `job` progress, cancel (`DELETE /api/jobs/:id`),
  paused while the global kill switch is on. Routes in `src/server/routes/data.ts`.
- Settings → Data page: import CSV, fetch NHL season, backfill settled Kalshi events, collect candles, rebuild
  price model (per-sport sample sizes), DB size, vacuum, job list with cancel.
- `npm run verify:T11`; `docs/verification/T11.md`. Deviations: SPEC.md §14 T11 implementation notes.

### T12 — Backtest simulator and Backtest page

- `src/backtest/simulator.ts`: pure, deterministic replay of a strategy over `hist_games` goal timelines with the
  production `evaluateLeadAtTime` (engine), `evaluateEntry` (guards) and `pricing.ts`; minute ticks
  (`src/backtest/clock.ts`), window retry exactly like the executor, compounding bankroll, settlement from the final
  score (NHL tie $0.50), §6 metrics with equity, drawdown and monthly P&L.
- Price providers: `exact` (`hist_prices.ask_close_bp` at the candle minute, else the next candle within 3 minutes,
  else `skipped_no_price`; candles placed with the inverse of T11's clock model) and `modelled` (T11's
  `priceModelLookup` on `settings.price_model`, or T11's seed table before a model is built; the summary reports
  `minSampleSize`). One timeline per Kalshi event (T11's source ranking).
- `worker_threads` worker (`src/backtest/worker.ts`) with its own database connection; `BacktestRunner` relays
  progress as SSE `backtest` events on `/api/live`.
- API: `GET /api/backtests/options`, `POST /api/backtests` (strategy version or ad-hoc, seasons or last N days,
  exact / modelled), `GET /api/backtests[/:id]`, `POST /api/backtests/:id/save|delete|promote`, `DELETE
  /api/backtests/:id`.
- Backtest page: form, progress, tiles, equity / drawdown / monthly charts, trades table with CSV, modelled badge,
  save, compare up to 3 saved runs, promote to strategy. Strategies page "Test against last 30 days" enabled.
- `test/fixtures/parity/game-a.json` parity test (tracker → engine → executor vs simulator); `npm run verify:T12`;
  `docs/verification/T12.md`. Deviations: SPEC.md §14 T12 implementation notes.

### T13 — Live trading path: orders, order group, subaccount, recovery, reconciliation

- Executor live branch (`src/core/executor.ts`): sizing from `GET /portfolio/balance` minus the cost of the app's
  pending live attempts; trade `pending` with the attempt's limit and count before Create Order V2 (IOC,
  `client_order_id = <trade.id>-<n>`, `price` with 4 decimals, whole-contract `count` capped by depth, order group,
  subaccount); outcomes `filled` (exchange count, average price and fee), `unfilled` → waiting, 4xx →
  `order_rejected`, order-group rejection → `order_group_limit`; unknown outcomes looked up by `client_order_id`;
  switches re-read right before the order.
- Start-up recovery of pending live attempts via `getOrders` / `getHistoricalOrders` matched by `client_order_id`
  (`restart_no_order` when absent); `src/core/startup.ts` orders order group → recovery → loops; unresolved
  attempts retried by the settler loop.
- `src/core/orderGroup.ts`: order group created or reused at start-up when live orders are possible;
  `GET /api/settings/order-group`, `POST /api/settings/order-group/reset` (step-up, audited); Settings → Trading
  shows state, id, contract limit and a reset button.
- Settler: live trades reconciled with `GET /portfolio/settlements` (`reconcile_warning` + `warn` above $0.01),
  shown in the Trades row and detail.
- `src/core/balances.ts`: `balance_snapshots` every 15 min and after each live fill / settlement, never under the
  global kill switch.
- Kalshi client: `listMarkets`; allow-list test (`test/unit/kalshi/allowlist.test.ts`) forbidding deposit,
  withdrawal and transfer methods.
- `npm run e2e:demo` (one real IOC order on demo, fee comparison at both precisions), `npm run replay --
  --live-mock` (in-process live replay against the msw mock); `npm run verify:T13`; `docs/verification/T13.md`.
  Deviations: SPEC.md §14 T13 implementation notes.
