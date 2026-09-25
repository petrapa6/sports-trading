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
