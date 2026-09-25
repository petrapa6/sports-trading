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
npm run dev          # API on http://localhost:8099
curl -s localhost:8099/healthz   # {"ok":true} (503 {"ok":false,"db":"…"} if the database cannot be opened)
```

The SQLite database (default `./.local/trader.db`, WAL mode) and its directory are created and migrated on
start-up; a failed migration exits non-zero before the server listens.

`npm run dev` validates the configuration first (a bad value exits non-zero naming the key), then runs the
server with reload-on-save. Its stdout is Pino JSON only — `.npmrc` sets `loglevel=silent` to keep npm's
banner off stdout; add `--loglevel=warn` to any npm command to see npm's own diagnostics.

| Script | What it does |
| --- | --- |
| `npm run dev` | API on `:8099` with reload (the Vite UI on `:5173` arrives with T04) |
| `npm run build` / `npm start` | Compile to `dist/` and run `dist/server/main.js` |
| `npm test` | Vitest unit and security tests |
| `npm run e2e` | Playwright (headless Chromium) at 1280 px and 390 px; first run `npx playwright install chromium` |
| `npm run lint` / `npm run typecheck` | ESLint + Prettier check / `tsc --noEmit` (strict) |
| `npm run audit:security` | Security tests + `npm audit --audit-level=high` |
| `npm run db:migrate` | Apply pending migrations to `DB_PATH` (`-- --status` lists them); the app also migrates on start-up |
| `npm run db:migrate:down` | Roll back the latest migration (`-- --steps N`, `-- --all`) |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` (drizzle-kit); add its down file in `migrations/down/` |
| `npm run db:studio` | Drizzle Studio on the database at `DB_PATH` |
| `npm run verify:T01` | T01 acceptance checks, PASS/FAIL per item (`--quick` skips the fresh-clone run) |
| `npm run verify:T02` | T02 acceptance checks (database, migrations, repositories, maintenance, `/healthz`) |

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

## Repository layout

```
SPEC.md                    specification (source of truth)
docs/decisions/            architecture decision records
docs/verification/         per-ticket verification notes (TXX.md)
kalshi-trader/             the Home Assistant app (config.yaml, Dockerfile, run.sh arrive in T05)
  CHANGELOG.md
  app/                     the Node project (src/, test/, scripts/, migrations/)
.github/workflows/ci.yml   lint, typecheck, test, e2e, npm audit, gitleaks
```
