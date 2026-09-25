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
