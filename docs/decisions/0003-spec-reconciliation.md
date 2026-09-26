# 0003 — SPEC.md reconciled with the 1.0.0 implementation

- **Status:** accepted (T14, 2026-09-26)
- **Context:** T14 asks for `SPEC.md` to be reconciled with the implementation in
  `docs/decisions/0002-spec-reconciliation.md`. Number `0002` was already taken by the base-image decision (T05),
  so this record is `0003`. The deviation is noted in SPEC.md's T14 implementation notes.
- **Method:** the normative body of SPEC.md (§1–§13) was compared line by line with the implementation notes of
  T01–T13 and with the code (`kalshi-trader/app/src`, `config.yaml`, `Dockerfile`, `run.sh`, migrations,
  `docker-compose.yml`). The body was corrected wherever a reader could otherwise rely on a wrong fact. Wording
  differences and details the body does not state were left alone. The ticket sections (§14) are history and
  stay as they were.

## Corrections made to the body

| § | Was | Now (matches the code) |
| --- | --- | --- |
| §2 API | Order groups "`POST /portfolio/order_groups` etc." | `…/order_groups/create`, `GET …/{id}`, `PUT …/{id}/reset`; tier upgrade `POST /account/api_usage_level/upgrade` (`client.ts`) |
| §2 API | Batch live data "path taken from `openapi.yaml`" | `GET /live_data/batch?milestone_ids=…` → `live_datas` |
| §2 API, §13 risks | Client "~300 lines validated against `openapi.yaml`", "pinned to an `openapi.yaml` version" | Hand-written client with Zod schemas written from the documentation and recorded payloads; no `openapi.yaml` is used |
| §3 | `ScoreFeed` had only `listLive` / `get` | Also `id`, `sports`, `poll(games)`, `test(games)` (`feeds/gameState.ts`) |
| §4 module map | Network gate inside `feeds/kalshi/` | `feeds/network.ts` |
| §4 invariants | `/historical/orders` "if past the cutoff" | Always tried when `/portfolio/orders` has no match; a failed lookup leaves the attempt `pending` for the settler |
| §5 guards | Market `status` `open` | `open` or `active`; a missing `close_time` passes |
| §5 guards | Only the 13 guard reasons | Adds `no_market`, `window_expired`, `restart`, `restart_no_order`, `order_not_found`, `mode_changed` |
| §6 | Unrealized P&L "from the latest `GET /markets/{ticker}`" | Defined in `pricing.ts`; not shown in the v1 UI |
| §7 | `audit_log.channel` without `other` | Includes `other` |
| §8 charts | Drawdown in % | In dollars, from the running peak |
| §8 charts | "The browser never receives raw trade rows for charts" | True for the Dashboard; the Trades page's small charts use the rows it already lists |
| §9 | Hockey minutes 1–60 | 1–59 (`backtest/clock.ts`) |
| §10 Secrets | fd 3 closed "once at boot" | Closed once the database and the listening socket are open (as §11 already said) |
| §10 Login | Lockout "doubling on each repeat" | Doubling when an earlier lockout started within 24 h, capped at 24 h |
| §10 Supply chain | "dependencies limited to §4" | Runtime dependencies; dev-only `msw`, `qrcode`, `yaml` |
| §11 layout | `app/ (package.json, src/, web/, test/)` | `src/` includes `src/web/`; also `migrations/`, `public/`, `scripts/` |
| §11 Behaviour | `/healthz` states and bodies | Adds `starting`, the two 503 bodies, the retry on each probe, and `db_busy` (T14) |
| §12 | `npm run dev` starts Vite too | Vite is `npm run dev:web` |
| §12 | Replay of `game_snapshots` | JSONL recordings posted to `/api/dev/replay`; `--live-mock` |
| §12 | `allow_live_orders` in `config.local.json` | `allowLiveOrders` (camelCase; unknown keys are rejected) |

Checked and already consistent: the `config.yaml` and `run.sh` listings in §11, the §7 schema against the
migrations, the settings keys and defaults, the rate-limit exemptions, the Kalshi base URLs, the price-model
threshold (20) and the session lifetimes (12 h idle, 7 days absolute).

## Known gap, not changed

The image copies `dist/web` but not `app/public/`, which holds `auth.css` for the server-rendered login and setup
fallback pages. Those pages are served only when no web build exists, which never happens in the image, so
nothing visible breaks. Adding `public/` to the image is left for a later release, because T14 excludes new work.
