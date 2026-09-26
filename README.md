# Kalshi Sports Trader

A Home Assistant app (formerly "add-on") that watches live soccer and NHL games, evaluates in-game
strategies and buys the matching Kalshi contract — for real (**live**) or as a simulated fill (**dry run**).
[`SPEC.md`](SPEC.md) is the single source of truth; this repository is built ticket by ticket (§14).

The repository root is the Home Assistant app repository; the Node.js project lives in
[`kalshi-trader/app`](kalshi-trader/app).

## Local development (SPEC.md §12)

Requirements: **Node.js 22**, git, and [`gitleaks`](https://github.com/gitleaks/gitleaks) for the
pre-commit secret scan (`brew install gitleaks`, or
`go install github.com/zricethezav/gitleaks/v8@v8.30.1`). Without gitleaks the hook falls back to a
built-in private-key check; CI always runs gitleaks.

```bash
git clone https://github.com/petrapa6/sports-trading.git
cd sports-trading/kalshi-trader/app
npm install          # also installs the lefthook pre-commit hook
npm run build        # compiles the server and builds the web app into dist/web
npm run dev          # app + API on http://localhost:8099 (serves the last web build)
npm run dev:web      # optional: UI with hot reload on http://localhost:5173, proxying the API to :8099
curl -s localhost:8099/healthz   # {"ok":true} (503 {"ok":false,"db":"…"} if the database cannot be opened)
```

The SQLite database (default `./.local/trader.db`, WAL mode) and its directory are created and migrated on
start-up; a failed migration exits non-zero before the server listens.

`npm run dev` validates the configuration first (a bad value exits non-zero naming the key), then runs the
server with reload-on-save. Its stdout is Pino JSON only — `.npmrc` sets `loglevel=silent` to keep npm's
banner off stdout; add `--loglevel=warn` to any npm command to see npm's own diagnostics.

| Script | What it does |
| --- | --- |
| `npm run dev` | App + API on `:8099` with reload; serves the React build from `dist/web` (without one, minimal server-rendered login/setup pages) |
| `npm run dev:web` | Vite dev server for the React app on `:5173` with hot reload; `/api`, `/auth`, `/healthz` and the login/setup posts are proxied to `:8099` |
| `npm run build` / `npm start` | Compile the server to `dist/` and the web app to `dist/web` (`build:web` builds only the UI); run `dist/server/main.js` |
| `npm test` | Vitest unit and security tests |
| `npm run e2e` | Builds the web app, then Playwright (headless Chromium) at 1280 px and 390 px against a fresh database in `.local/e2e` and a local stand-in for the ingress proxy; first run `npx playwright install chromium` |
| `npm run lint` / `npm run typecheck` | ESLint + Prettier check / `tsc --noEmit` (strict) |
| `npm run audit:security` | Security tests + `npm audit --audit-level=high` |
| `npm run db:migrate` | Apply pending migrations to `DB_PATH` (`-- --status` lists them); the app also migrates on start-up |
| `npm run db:migrate:down` | Roll back the latest migration (`-- --steps N`, `-- --all`) |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` (drizzle-kit); add its down file in `migrations/down/` |
| `npm run db:studio` | Drizzle Studio on the database at `DB_PATH` |
| `npm run verify:T01` | T01 acceptance checks, PASS/FAIL per item (`--quick` skips the fresh-clone run) |
| `npm run verify:T02` | T02 acceptance checks (database, migrations, repositories, maintenance, `/healthz`) |
| `npm run verify:T03` | T03 acceptance checks (request classes, login, sessions, CSRF, step-up, headers, rate limits) |
| `npm run verify:T04` | T04 acceptance checks (web build, e2e shell, filter bar, SSE, switches, account, ingress, diagnostics) |
| `npm run check:addon` | Static checks of `kalshi-trader/config.yaml` (keys, options ↔ schema, ports, init, privileges, version) |
| `npm run compose:options` | Write `.local/data/options.json` for `docker compose` from `config.local.json` (`-- --out <file>`) |
| `npm run verify:T05` | T05 acceptance checks (check:addon, compose health, non-root, read-only, key hand-over, run.sh, image size; `-- --arm64` adds the arm64 build) |

### Signing in (SPEC.md §10)

Every route except `/login`, `/setup` (first run), `/healthz` and `/assets/*` needs a session (the web app's
HTML shell carries no data; a browser without a session is sent to `/login`). On a fresh database open
<http://localhost:8099/setup> once (`npm run dev` treats loopback requests as class `dev`, which
may run setup; in Home Assistant only the sidebar/ingress may) to create the single user, then sign in at
`/login`. API clients send the token from `GET /api/csrf` as `x-csrf-token` on every state-changing request.
`${DATA_DIR}/secret.key` (generated on first start, mode 600) signs session cookies and encrypts secret
settings; deleting it logs everyone out.

### Configuration

Settings come from environment variables first, then a git-ignored `kalshi-trader/app/config.local.json`
(copy [`config.local.example.json`](kalshi-trader/app/config.local.example.json); set `CONFIG_LOCAL_PATH`
to use another file), then defaults. There are **no `.env` files**.

| Env var | `config.local.json` key | Default | Notes |
| --- | --- | --- | --- |
| `KALSHI_ENV` | `kalshiEnv` | `demo` | `demo` or `prod` |
| `KALSHI_KEY_ID` | `kalshiKeyId` | — | optional until T06 |
| `KALSHI_PRIVATE_KEY_FD` | `kalshiPrivateKeyFd` | — | fd with the PEM (set by `run.sh` in Home Assistant) |
| — | `kalshiPrivateKeyPath` | — | local dev: path to a PEM **outside** the repository |
| `KALSHI_SUBACCOUNT` | `kalshiSubaccount` | `0` | 0–63 |
| `ALLOW_LIVE_ORDERS` | `allowLiveOrders` | `false` | `true` / `false`; outer lock for real orders |
| `LOG_LEVEL` | `logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `DATA_DIR` | `dataDir` | `./.local/data` | |
| `DB_PATH` | `dbPath` | `./.local/trader.db` | |
| `PORT` | `port` | `8099` | |
| `TRUSTED_PROXIES` | `trustedProxies` | `172.30.32.0/23` | comma-separated IPs / CIDRs |
| `TZ` | `tz` | container TZ, else UTC | IANA zone |

Keys, PEMs, `config.local.json`, databases and `.local/` are git-ignored and blocked by the pre-commit hook.

## Container (Home Assistant image, SPEC.md §11–§12)

```bash
cd kalshi-trader/app && npm run compose:options && cd ../..   # .local/data/options.json from config.local.json
docker compose up --build -d                                   # production image, read-only root, /data = .local/data
curl -s localhost:8099/healthz
docker buildx build --builder <name> --platform linux/arm64 kalshi-trader/   # Pi image under QEMU
```

Never run `docker buildx use <builder>` on a shared machine; pass `--builder` per build. Installing the app in Home
Assistant is described in [`kalshi-trader/DOCS.md`](kalshi-trader/DOCS.md).

## Repository layout

```
SPEC.md                    specification (source of truth)
docs/decisions/            architecture decision records
docs/verification/         per-ticket verification notes (TXX.md)
repository.yaml            Home Assistant app repository metadata
docker-compose.yml         local runs of the production image (§12)
kalshi-trader/             the Home Assistant app: config.yaml, Dockerfile, run.sh, DOCS.md, translations/, icons
  CHANGELOG.md
  app/                     the Node project (src/, test/, scripts/, migrations/)
.github/workflows/ci.yml   lint, typecheck, test, e2e, npm audit, gitleaks
.github/workflows/image.yml  arm64 + amd64 image build (QEMU), verify:T05 container checks
.github/workflows/publish.yml  optional GHCR publish (disabled)
```
