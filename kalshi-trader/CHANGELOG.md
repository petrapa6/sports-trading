# Changelog

All notable changes to the Kalshi Sports Trader app. Versions follow `config.yaml` / `package.json`.

## 0.1.0 — unreleased

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
