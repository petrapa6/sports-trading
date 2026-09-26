# Kalshi Sports Trading Bot — Specification (final, v1)

As of 2026-09-25, with both review rounds applied (§15 lists every change). Target repository: `petrapa6/sports-trading`. Conventions taken from the owner's existing Home Assistant app are recorded in §14 (Reference app facts), so no other repository needs to be read. This file is committed to the repository as `SPEC.md` and is the single source of truth; it supersedes the earlier living copy (https://claude.ai/code/artifact/b26367bb-fab1-44b2-a4e0-4416fbc377e5, rev 37).

### Conventions used everywhere

| Quantity | Representation in code and DB | Example |
| --- | --- | --- |
| Money (stake, cost, fee, payout, P&L, balances, bankroll) | integer **micro-dollars**, column suffix `_micros` (1 = $0.000001) | $0.0052 → `5200` |
| Price | integer **price units of $0.0001**, suffix `_bp` | $0.92 → `9200` |
| Contract count | integer **centi-contracts**, suffix `_cc` (100 = 1 contract) | 2 contracts → `200` |
| Time | ISO-8601 UTC text in SQLite; epoch ms in memory | `2026-09-25T19:04:11.512Z` |
| Mode | `live` or `dry_run` on every trade, log line, stat and chart; backtests are a separate third category `backtest` | — |

Identity that keeps arithmetic exact: `cost_micros = cc × bp`. Kalshi `*_dollars` strings (up to 6 decimals) and `*_fp` counts (2 decimals) are converted with exact decimal-string parsing (`core/decimal.ts`), never through floating point.

## 1. Overview

The app is a single Node.js service, packaged as a Home Assistant app (formerly "add-on") for a Raspberry Pi 5, that watches live soccer and NHL games, evaluates user-defined in-game strategies ("a team leads by N goals at minute M"), and buys the matching contract on Kalshi — either for real (**live**) or as a simulated fill (**dry run**) whose outcome is settled and scored exactly like a real one.

**Working name:** `kalshi-sports-trader` (rename freely).

### What it does

- Polls the score feeds every few seconds while games in the enabled leagues are in progress.
- For each running strategy, checks its trigger against the current game state; enters at most once per strategy per game, retrying within the trigger window when a soft guard (price, depth, stale feed, unfilled order) blocks the first attempt.
- Sizes the order as a percentage of the current Kalshi cash balance (dry run: of a shared virtual bankroll), finds the Kalshi market for that game, and places an immediate-or-cancel limit order (live) or records a virtual fill (dry run).
- Settles every trade when its market settles, records realized P&L, and keeps a full audit log in SQLite under the app's own `/data` so Home Assistant's Google Drive backup captures it.
- Serves a password-protected web UI (login, dashboard with Recharts, strategy editor, trade history with filters, backtesting, settings), reachable from the Home Assistant sidebar (ingress) and through your Cloudflare Tunnel.
- Labels every trade, log line, metric, chart series and export as **live** or **dry run**, and never aggregates the two together.

### What it does not do (v1)

- No pre-game bets, no selling before settlement, no hedging, no multi-leg positions, no top-up of a partially filled entry. One entry per game per strategy, held to settlement.
- No sports other than soccer and hockey; no leagues other than those configured. Adding a league is configuration; adding a sport is code (a small adapter).
- No NHL preseason games by default (per-league setting).
- No push notifications until T15 (Home Assistant notifications).

### Switches and effective mode

Five controls decide whether a strategy trades and how:

| Control | Where it is changed | Default | Effect |
| --- | --- | --- | --- |
| `allow_live_orders` | Home Assistant → the app's **Configuration** tab (add-on option) | `false` | Outer lock. While `false`, no real order can be sent, whatever the web UI says. It cannot be changed from the web UI, so a hijacked web session cannot enable live trading. Changing it restarts the app. |
| **Global kill switch** | Settings → Trading | off | Pauses everything: no outgoing HTTP at all (score feeds, Kalshi reads, orders, discovery, settlement polling). The UI keeps working from the database. Open positions still settle on Kalshi; the settler catches up after the switch is turned off. |
| **Global dry run** | Settings → Trading | **on** | Feeds and Kalshi reads keep running; no real orders; every strategy runs as dry run. |
| **Strategy kill switch** | Strategies page, per strategy | on for new strategies | The strategy is not evaluated and places nothing. Its open trades still settle (feeds and settlement are shared). Replaces the former `enabled` flag. |
| **Strategy mode** | Strategies page, per strategy | `dry_run` | `dry_run` or `live`. |

Effective mode, computed in `core/modes.ts` on every evaluation and again before every order attempt (switches are read from the DB each time, never cached):

```
if global_kill_switch            → paused   (scheduler idle, zero outgoing HTTP)
else if strategy.kill_switch     → paused   (strategy skipped; its settlements continue)
else if !allow_live_orders       → dry_run  (mode_reason = 'addon_lock')
else if global_dry_run           → dry_run  (mode_reason = 'global_dry_run')
else if strategy.mode == dry_run → dry_run  (mode_reason = 'strategy')
else                             → live     (mode_reason = null)
```

Every trade stores `configured_mode` (the strategy's own setting), `effective_mode` and `mode_reason`, so a strategy configured live but running as dry run is visible as "live → dry run (global)". Re-entering the password (step-up, §10) is required for every change that can lead to real orders: turning the global kill switch off, turning global dry run off, turning a strategy kill switch off, and switching a strategy to `live`. Changes towards safety (switching anything on, switching to dry run) need no step-up.

### One code path

Dry run and live share the entire pipeline — feed, strategy evaluation, market lookup, guards, sizing, limit-price computation, settlement, reporting. The only branch is the final `placeOrder` call: a Kalshi IOC order in live, a virtual fill against the same orderbook in dry run.

## 2. How Kalshi works for this app

Kalshi is a CFTC-regulated exchange where every market is a binary Yes/No contract priced between $0 and $1; at settlement a winning contract pays $1.00. The price is the market's implied probability. Sports game markets stay open **during the game** (in-play trading), which is what makes the "leading at minute M" strategy possible.

### Market structure for our two sports (confirmed against the production API on 2026-09-25)

| Sport | League | Series ticker | Markets per game | Settles on |
| --- | --- | --- | --- | --- |
| Hockey | NHL | `KXNHLGAME` | 2 (home / away), mutually exclusive | Official final result including OT/shootout. Market rules: tie → every market settles at $0.50; game postponed but started within 48 h → stays open; cancelled or not started within 48 h → "fair price". The series also lists preseason games (`product_metadata.competition = "Pro Hockey Preseason"`), excluded by default. Example event `KXNHLGAME-26SEP24UTAVGK`. |
| Soccer | English Premier League | `KXEPLGAME` | 3 (home / tie / away) | 90 minutes plus stoppage time (no extra time or penalties). Example event `KXEPLGAME-26FEB07WOLCFC`. |
| Soccer | La Liga | `KXLALIGAGAME` | 3 | 90' + stoppage |
| Soccer | Bundesliga | `KXBUNDESLIGAGAME` | 3 | 90' + stoppage |
| Soccer | Serie A | `KXSERIEAGAME` | 3 | 90' + stoppage |
| Soccer | Ligue 1 | `KXLIGUE1GAME` | 3 | 90' + stoppage |

All six series report `fee_type: quadratic_with_maker_fees`, `fee_multiplier: 1`. The app never hard-codes event or market tickers: series tickers live in the `leagues` table; events come from `GET /events`; each market is mapped to a team through its `custom_strike` (e.g. `{"hockey_team": "<structured-target uuid>"}`) and `yes_sub_title`, or to `tie`.

Relevant market fields (observed on a settled NHL market):

- `status` moves through `unopened → open → closed → settled / finalized`. `can_close_early: true` — the market closes as soon as a winner is declared.
- `result` (`yes` / `no`) and **`settlement_value_dollars`** (`1.0000`, `0.0000`, `0.5000` for an NHL tie, or a fair-price value). Payout is always computed from `settlement_value_dollars`, never from `result` alone.
- `price_level_structure` and **`price_ranges`** (`[{start, end, step}]`): the valid price grid. NHL game markets currently use `linear_cent` ($0.01 steps), but some structures use sub-cent steps between $0.90 and $1.00 — exactly where this strategy trades — so limit prices are always snapped to the market's own `price_ranges`.
- The milestone (game) is **not** on the event; it is found with `GET /milestones?related_event_ticker=<event>` (§3).

### The trade the strategy makes

"Team X leads by N goals at minute M" → **buy YES on the market "X wins"** (Create Order V2: `side: "bid"` means buy YES). Late in a game that contract typically trades at $0.85–$0.98, so the position risks the whole stake to win a few cents per contract. Expected value depends entirely on how often the lead actually holds versus what the price implies — which is what dry run and backtesting measure.

- Limit price: `limit_bp = min(best_ask_bp + maxSlippage_bp, maxPrice_bp)`, snapped **down** to the market's price grid.
- Contracts (whole contracts in v1): `contracts = floor(stake_micros / (limit_bp × 100))`, sent as `count`.
- Fills can still be fractional (0.01-contract granularity) because resting orders from other users can be fractional; fills are stored in centi-contracts.
- Payout = `fill_cc × settlement_value_bp`; profit if the lead holds = payout − cost − fee.

### Fees

Taker fee per order (Kalshi fee schedule, effective 7 Jul 2026; fee-rounding guide):

```
model fee ($) = M × 0.07 × C × P × (1 − P)        C = contracts, P = price in $, M = series multiplier
```

Rounding: the model fee is rounded up to $0.000001, then the fee is increased so that **position cost + fee** lands on the account's balance precision — $0.0001 for direct members (Kalshi calls this rounding to a "centicent"). Integer implementation (`core/pricing.ts`):

```
raw_micros   = ceil( 7 × M × cc × bp × (10000 − bp) / 1_000_000 )
cost_micros  = cc × bp
fee_micros   = ceil( (cost_micros + raw_micros) / PREC ) × PREC − cost_micros      PREC = fee_balance_precision_micros
```

`PREC` is a setting, default `100` ($0.0001). Kalshi's own fee table still shows whole-cent fees (e.g. $0.01 for one contract at $0.92), so the setting can be raised to `10000` for conservative dry runs; T13 compares the first demo/prod fills against the formula and records which precision applies. Examples with `PREC = 100`: 1 contract at $0.92 → $0.0052; 2 at $0.94 → $0.0079; 100 at $0.50 → $1.75. Maker fees do not apply (orders are IOC, never resting). No settlement fee. Series multiplier from `GET /series/{ticker}` (`fee_multiplier`), with per-event overrides from `GET /events/{ticker}` when present.

In live mode the fee is taken from the exchange: Create Order V2 returns **`average_fee_paid` per contract**, so `fee = average_fee_paid × fill_count` (exact decimal multiplication).

### API essentials

| Item | Value |
| --- | --- |
| Base URL (prod) | `https://external-api.kalshi.com/trade-api/v2` (also `https://api.elections.kalshi.com/trade-api/v2`) |
| Base URL (demo) | `https://external-api.demo.kalshi.co/trade-api/v2` (also `https://demo-api.kalshi.co/trade-api/v2`) — paper money, used for all development |
| Auth | Headers `KALSHI-ACCESS-KEY` (key id), `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE` = base64 RSA-PSS/SHA-256 over `timestamp + METHOD + path` (path without query string). Node: `crypto.sign('sha256', msg, {key, padding: RSA_PKCS1_PSS_PADDING, saltLength: RSA_PSS_SALTLEN_DIGEST})`. Kalshi also accepts Ed25519 keys; v1 supports RSA only. |
| Balance | `GET /portfolio/balance?subaccount=<n>` — prefer `*_dollars` fields when present |
| Order book | `GET /markets/{ticker}/orderbook` → YES bids and NO bids only; YES ask levels are derived as `1 − NO bid` with the NO bid's size |
| Market | `GET /markets/{ticker}`; after the historical cutoff `GET /historical/markets/{ticker}` |
| Place order | `POST /portfolio/events/orders` (Create Order V2, returns `201`): `{ticker, side:"bid", count:"2", price:"0.9400", time_in_force:"immediate_or_cancel", self_trade_prevention_type:"taker_at_cross", client_order_id, order_group_id, subaccount}` (`subaccount` omitted when 0; `exchange_index` omitted → auto-routed). Response: `order_id`, `client_order_id`, `fill_count`, `remaining_count`, `average_fill_price` and `average_fee_paid` (both only when `fill_count > 0`), `ts_ms`. The legacy `/portfolio/orders` create endpoint is deprecated. |
| Order lookup | `GET /portfolio/orders?ticker=&min_ts=&status=` (**no `client_order_id` filter** — the app filters by ticker and time and matches `client_order_id` itself); orders older than the cutoff via `GET /historical/orders`. Order objects carry `fill_count_fp`, `taker_fill_cost_dollars`, `taker_fees_dollars`, `yes_price_dollars`. |
| Positions / fills / settlements | `GET /portfolio/positions`, `/portfolio/fills`, `/portfolio/settlements` (and `/historical/fills`) — reconciliation of live trades |
| Order groups | `POST /portfolio/order_groups` etc. — an exchange-enforced cap on contracts matched in a rolling 15-second window; every live order carries the app's `order_group_id` (§10) |
| Subaccounts | Numbered subaccounts (1–63) with API keys restricted to one subaccount; available from the Advanced API tier, which any account gets with one call to the upgrade endpoint once one of its last 100 orders was placed via the API (§10) |
| Milestones | `GET /milestones?related_event_ticker=<event>` → `id`, `start_date`, `details` (team ids), `source_ids` (e.g. Sportradar id) |
| Live game data | `GET /live_data/milestone/{milestone_id}` and the batch endpoint "Get Multiple Live Data" (exact path taken from `openapi.yaml` at build time) → `details.home_points`, `away_points`, `status` (`none`/`live`/`finished`), `round`, `final_round_time_left`, `tileLiveText`, `widgetLiveText`, `home_id`/`away_id`, soccer `home_significant_events`/`away_significant_events`. `details` is an open object — validate at runtime. |
| Game play-by-play | `GET /live_data/milestone/{milestone_id}/game_stats` → `pbp.periods[].events[]` (soccer and pro hockey supported) — candidate free source of goal timelines for Kalshi-era games (§3) |
| Candlesticks | `GET /series/{series_ticker}/markets/{ticker}/candlesticks?start_ts&end_ts&period_interval=1` → per minute `yes_ask`, `yes_bid` (OHLC, `*_dollars`), `price` (trade OHLC, nullable), `volume_fp`; settled before the cutoff: `GET /historical/markets/{ticker}/candlesticks` |
| Historical cutoff | `GET /historical/cutoff` → `market_settled_ts`, `trades_created_ts`, `orders_updated_ts`, `market_positions_last_updated_ts` (each data type has its own cutoff) |
| Exchange status | `GET /exchange/status` (`trading_active`, `exchange_active`), `GET /exchange/schedule` |
| Maintenance | Every **Thursday 03:00–05:00 ET** a trading pause (no new orders); rare unscheduled exchange pauses |
| Rate limit (Basic tier) | Read 200 tokens/s (bucket holds 3 s), write 100 tokens/s (bucket holds 1 s); default cost 10 tokens/request (`GET /account/endpoint_costs` lists exceptions) → 20 reads/s sustained. `429` carries no `Retry-After`; back off exponentially. |
| SDK | The official `kalshi-typescript` SDK lags the API; the app uses a thin hand-written client (~300 lines) validated against `openapi.yaml`, which also keeps the dependency surface small |
| Docs | https://docs.kalshi.com/llms.txt (index) |

Day-one check in the demo environment: whether demo lists live sports milestones with real-time scores. If demo live data is sparse, dry-run validation runs against **production read endpoints** with orders disabled (`allow_live_orders: false`), which is safe because reads cannot move money.

## 3. Data sources

The app needs **live game state** (score, minute/period, status) to fire strategies, **Kalshi market discovery** to know which contract to buy, and **historical goal timelines plus historical prices** for backtesting. Every feed sits behind a small adapter interface. While the global kill switch is on, no adapter makes any request.

### Live game state — `ScoreFeed` interface

```typescript
interface GameState {
  gameId: string;               // internal id = Kalshi event ticker
  leagueId: string;
  homeTeam: string; awayTeam: string;
  homeScore: number; awayScore: number;
  phase: 'scheduled' | 'live' | 'halftime' | 'intermission' | 'finished' | 'postponed';
  clock: {
    minute?: number;            // soccer match minute (stoppage counts as 45 / 90); hockey elapsed minute 0–60
    minuteSource?: 'feed' | 'derived';
    period?: number; secondsLeftInPeriod?: number;
    regulationOver: boolean;
  };
  source: string;               // adapter id
  observedAt: Date;             // when this app received it
  feedUpdatedAt?: Date;         // timestamp reported by the feed, if any
}
interface ScoreFeed { listLive(leagueId: string): Promise<GameState[]>; get(gameId: string): Promise<GameState>; }
```

| Adapter | Sport | Default | What it gives | Notes |
| --- | --- | --- | --- | --- |
| `kalshi-live` | both | **on** (primary) | One batch live-data call per tick for all tracked milestones: `home_points`, `away_points`, `status`, `round`, `final_round_time_left`, `tileLiveText`/`widgetLiveText`, team ids that map straight to market structured targets | Zero extra keys, no team-name matching, and it is the state Kalshi settles on. Soccer minute is not a first-class field: parsed from `tileLiveText`/`widgetLiveText` (`78'`, `45+2'`, `HT`, `FT`); if unparseable, derived (below). |
| `nhl-official` | hockey | **on** (cross-check) | `https://api-web.nhle.com/v1/score/now` → `period`, `clock.timeRemaining`, `homeTeam.score`, `gameState` (`FUT`, `PRE`, `LIVE`, `CRIT`, `FINAL`, `OFF`) | Authoritative clock for NHL; matched to games via tricodes, `teams.aliases` and milestone `source_ids` |
| `api-football` | soccer | off (T15) | `GET /fixtures?live=all` → `fixture.status.elapsed`, goals, status codes | Needs a paid plan for 5-second-class polling; deferred |

**Soccer minute fallback (derived).** When the Kalshi text cannot be parsed, the tracker derives the minute from wall-clock time since the observed kick-off (first transition to `live`) and since the observed start of the second half (first `live` after halftime), minute = whole minutes elapsed (floored), capped at 45 and 90 respectively; `minuteSource = 'derived'` is stored on every snapshot and shown in the trade snapshot. Accuracy is about ±1 minute; T07 verifies it on replays.

**Halftime / intermission.** Kalshi `status` has no break state. Soccer halftime = text `HT` or `round` change without play; hockey intermission = `final_round_time_left` `00:00` with `round` 1 or 2, or NHL `clock.inIntermission`. Strategies never fire during a break.

**Polling plan.** The scheduler polls at **5 s** while any tracked game is live, **60 s** during the hour before a scheduled game, and stops otherwise; the global kill switch puts it in `paused` (zero requests). With two feeds for a game (NHL), the `GameTracker` reconciles them: score = the agreed value; a disagreement lasting more than 20 s sets `games.blocked = 1`, is logged, and blocks entries for that game until the feeds agree again. Team matching between feeds uses the `teams` table seeded from Kalshi structured targets.

### Kalshi market discovery

At start-up and daily at 05:00 local time, for each enabled league:

1. `GET /events?series_ticker={series}&status=open&with_nested_markets=true` (cursor pagination).
2. Skip events whose `product_metadata.competition` contains `Preseason` unless the league's `include_preseason = 1`; store `competition` on the game.
3. For each event: `GET /milestones?related_event_ticker={event}` → `milestone_id`, `start_date` (scheduled kick-off), home/away team ids, `source_ids`.
4. Upsert `games` (event ticker, teams, `scheduled_at`, `milestone_id`, competition) and `markets` (ticker, outcome `home`/`away`/`tie`, status, `price_ranges`). A market whose target cannot be mapped is stored with `outcome = 'unknown'` and a `warn` log; it is never traded.

Just before an order attempt, the executor re-reads the exact market (`GET /markets/{ticker}`) and its orderbook.

**Backfill discovery** (Settings → Data, T11): the same walk with `status=settled` over a chosen date range, so that past-season Kalshi games (roughly 2025–26 onward) can be imported for exact backtests even though the app never saw them live.

### Historical data for backtesting

Backtesting "lead at minute M" needs **goal timestamps** and the **ask at the trigger minute**. v1 uses free sources only.

| Need | Source | Coverage | Notes |
| --- | --- | --- | --- |
| NHL goal timelines | NHL Web API `GET /v1/schedule/{date}` + `GET /v1/gamecenter/{gameId}/play-by-play` | All seasons, free, no key | Goal events carry period and time; ~1,312 regular-season games per season; preseason skipped by default |
| Soccer and NHL goal timelines for Kalshi-listed games | Kalshi `game_stats` play-by-play per milestone | Games Kalshi listed with a Sportradar id | Verified in T11 on production payloads (2026-09-26): usable for both sports — every event carries the running `home_points` / `away_points`; soccer events have the match `clock` (`62:25`, `90+1`) and `match_time`, hockey events the time remaining in the period. Imported by the Kalshi backfill (`source = 'kalshi_pbp'`) |
| Goal timelines of games the app tracked live | The app's own `game_snapshots`, archived into `hist_games` (`source = 'live'`) when a game finishes | From the day the app runs | Guarantees the price model and exact backtests survive snapshot pruning |
| Soccer, older seasons | Generic CSV importer (e.g. Kaggle "European Soccer Database", 2008–2016) | Whatever the user uploads | Modelled prices only (no Kalshi candles exist for those games) |
| Kalshi in-play prices | Candlesticks, 1-minute (`yes_ask` and `yes_bid` OHLC) | Since Kalshi listed each series (NHL and EPL game markets from roughly the 2025–26 season) | Exact backtests use the **ask close** at minute M |
| Prices before Kalshi existed | **Price model** fitted on collected candles: median ask by (sport, lead, minutes remaining) | Any season | Labelled "modelled" in the UI (§9) |
| Soccer, bulk paid import | API-Football (`/fixtures`, `/fixtures/events`) | 1,200+ leagues | Deferred to T15 (optional, needs a paid key) |

**Generic CSV importer** (Settings → Data): columns `league_code, season, date, home, away, home_goals_final, away_goals_final, goal_events` where `goal_events` is `home:23;away:67;home:90+2`. Any dataset the user can shape into this form becomes backtestable (modelled prices).

## 4. Architecture

One Node.js process (TypeScript, ESM) runs an HTTP server and a background trading loop; the UI is a React single-page app served from the same process. No message broker, no second container: the Pi 5 has plenty of headroom and a single process keeps the security surface small.

```mermaid
flowchart LR
  subgraph feeds[External]
    K[Kalshi REST]
    S[Score feeds<br/>Kalshi live data / NHL API]
  end
  subgraph app[kalshi-trader container]
    SW[Switches<br/>kill / dry run / addon lock] --> SCH
    SCH[Scheduler] --> GT[GameTracker]
    GT --> SE[StrategyEngine]
    SE --> EX[Executor<br/>dry run / live]
    EX --> ST[Settler]
    GT & SE & EX & ST --> DB[(SQLite<br/>/data/db)]
    API[Fastify API + auth] --> DB
    UI[React + Recharts] --> API
  end
  K --> GT & EX & ST
  S --> GT
  CF[cloudflared app] --> API
  ING[HA ingress] --> API
```

The scheduler wakes the tracker; the tracker turns feed data into `GameState`; the engine matches states against strategies and emits signals; the executor turns a signal into a virtual or real fill (or a skip); the settler closes trades when markets settle. Everything writes to SQLite; the UI reads SQLite plus a small live-status stream.

### Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js ≥ 22 (local dev: Node 22 LTS; container: the `nodejs` package of the pinned Home Assistant base image, which must be ≥ 22), TypeScript, ESM | Native `fetch`, `crypto.sign` for RSA-PSS, `process` APIs; same Node build for compile and run inside the container |
| HTTP | Fastify 5 + `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cookie`, `@fastify/csrf-protection`, `@fastify/static` | Schema-validated routes, mature security plugins; sessions are implemented in-house on the `sessions` table |
| DB | SQLite via `better-sqlite3` (WAL mode) + Drizzle ORM for typed schema and migrations | Synchronous, single file, trivially backed up |
| UI | React 19 + Vite, TanStack Query, TanStack Table, **Recharts** for every chart | TanStack Table gives the filtering/sorting the trades page needs |
| Validation | Zod for strategy JSON, API bodies and every external payload | Feed payloads are untrusted input |
| Numbers | `core/decimal.ts`: exact parsing of `*_dollars` / `*_fp` strings into integers | No floating point in money paths |
| Scheduling | In-process loop with `setTimeout` chains | One interval per state (live / pre-game / idle / paused) |
| Logging | Pino JSON to stdout (HA log tab) + `audit_log` table for anything money- or security-related | Every trading-related line carries `mode` (§8) |
| Tests | Vitest, `msw`, Playwright, recorded fixtures of real Kalshi/NHL payloads | Deterministic tests without network |

### Module map

```
kalshi-trader/app/src/
  server/        Fastify app, request classes, auth, routes (REST + SSE)
  core/
    decimal.ts       exact string ↔ integer conversions
    modes.ts         effective mode from the five switches (pure, table-tested)
    scheduler.ts     poll cadence; paused state for the global kill switch
    tracker.ts       merges feeds → GameState, detects phase changes, archives finished timelines
    engine.ts        evaluates strategies, window + once-per-game logic
    guards.ts        hard/soft guard evaluation (shared with the backtester)
    executor.ts      sizing, limit price, dry-run fill or Kalshi order, attempts
    settler.ts       closes trades on settlement, reconciles live positions
    pricing.ts       fee, cost, P&L math (pure, integer)
    maintenance.ts   WAL checkpoint, snapshot pruning
  feeds/
    kalshi/        client (signing, token buckets, backoff, network gate), discovery, live data
    nhl/           NHL Web API adapter
    apiFootball/   API-Football adapter (T15)
  backtest/      importers, candle collector, simulator (worker), price model
  db/            drizzle schema, migrations, repositories
  web/           React app
```

### Live status without polling the UI

`GET /api/live` (Server-Sent Events) pushes the switch states, tracked games with their current state, strategies with their **effective mode badge**, recent signals, and the last 50 log lines (each tagged with its `mode`). SSE works through Cloudflare Tunnel and HA ingress without special configuration.

### Concurrency and safety invariants

- One trading loop; feed polls run concurrently with `Promise.allSettled`, strategy evaluation and order attempts run serially.
- **Once per game per strategy:** `UNIQUE(strategy_id, game_id)` on `trades`. The row is inserted when the rule first matches (status `signalled`), before any orderbook read or order.
- **Every order attempt** (live or virtual) first inserts a `trade_attempts` row with status `pending` and a fresh unique `client_order_id` (`<trade.id>-<attempt_no>`), **then** calls Kalshi, then updates the row. A crash mid-order therefore always leaves a findable record.
- **Restart recovery** runs before the scheduler starts: for each `pending` live attempt, `GET /portfolio/orders?ticker=<market>&min_ts=<attempt time − 60 s>` (then `/historical/orders` if past the cutoff), match on `client_order_id`, apply the outcome; not found → `unfilled` with reason `restart_no_order`. Pending dry-run attempts are marked `unfilled` (`restart`).
- Switches are read from the DB on every evaluation and before every attempt; `allow_live_orders` comes from the process configuration (changing it restarts the app).
- **Global kill switch:** the Kalshi client and every feed adapter call a single `assertNetworkAllowed()` gate before any request; while the switch is on the gate rejects, the scheduler is `paused`, and in-flight requests are allowed to finish.
- The dry-run bankroll is updated inside the same SQLite transaction as the trade state change, so concurrent fills cannot lose an update.

## 5. Strategy model

A strategy is a row with a JSON `rule`; the engine evaluates the rule against every live `GameState` in the strategy's leagues. v1 ships one rule type, `lead_at_time`; the schema is versioned so more types can be added without migrating existing rows.

```json
{
  "name": "EPL 2-goal lead at 80'",
  "sport": "soccer",
  "leagueIds": ["epl", "laliga"],
  "mode": "dry_run",
  "killSwitch": true,
  "rule": {
    "type": "lead_at_time",
    "version": 1,
    "minLead": 2,
    "atMinute": 80,
    "windowMinutes": 5,
    "leaderSide": "any"
  },
  "sizing": { "type": "percent_of_balance", "percent": 2, "minStakeUsd": 1, "maxStakeUsd": 50 },
  "execution": {
    "orderType": "ioc_limit",
    "maxPrice": 0.97,
    "minPrice": null,
    "maxSlippage": 0.01,
    "minDepthContracts": 20,
    "maxFeedAgeSec": 15
  }
}
```

New strategies are created with `killSwitch: true` (paused) and `mode: "dry_run"`.

### Rule: `lead_at_time`

| Field | Meaning | Soccer | Hockey |
| --- | --- | --- | --- |
| `minLead` | Leader's goal margin must be ≥ this; integer ≥ 1 | goals | goals |
| `atMinute` | Earliest clock minute at which the strategy may enter | match minute 1–90 (stoppage counts as 45 / 90) | elapsed minute 1–59 = (period − 1) × 20 + (20 − time left), floored |
| `windowMinutes` | Entry window: the strategy may enter while `atMinute ≤ minute ≤ atMinute + windowMinutes` | default 5 | default 3 |
| `leaderSide` | `any`, `home`, or `away` | | |

The rule **matches** when `phase === 'live'`, the game is not `blocked`, `|home − away| ≥ minLead` with the leader on an allowed side, and the minute is inside the window. It never matches during halftime/intermission or after regulation (hockey OT is excluded; soccer stoppage time of the second half counts as minute 90).

**First match** inserts the `trades` row (`signalled`) with the trigger snapshot (score, minute, minute source, feed timestamps), the leader's market, `configured_mode`, `effective_mode`, `window_ends_at`. Then the executor makes an attempt.

**Retry within the window.** If an attempt is blocked by a *soft* guard (table below) the trade goes to `waiting` with `skip_reason` = that guard, and on every later tick while the rule still matches and the window is open the executor tries again (new `trade_attempts` row each time). If the leader changes or the lead drops below `minLead`, no attempt is made on that tick. When the window closes without a fill, the trade becomes `skipped` with the last soft reason and `window_expired = 1`. A *hard* guard ends the trade immediately as `skipped`. A partial fill ends the entry (no top-up in v1).

### Sizing: `percent_of_balance`

- **Live:** balance = Kalshi cash for the configured subaccount (`GET /portfolio/balance`) at the attempt, minus the cost of this app's live attempts still `pending`.
- **Dry run:** one **shared virtual bankroll** for all dry-run trades (Settings, default $100, editable, resettable with step-up), debited by cost + fee at the virtual fill and credited with the payout at settlement, so it compounds like a real account. Per-strategy equity curves are derived from each strategy's own trades.
- `stake_micros = clamp(balance × percent / 100, minStakeUsd, maxStakeUsd)` (converted to micros); `limit_bp` as in §2; `contracts = floor(stake_micros / (limit_bp × 100))`; if `contracts < 1` → hard skip `too_small`.

### Guards (identical in live, dry run and backtest; evaluated in this order)

| # | Guard | Class | Skip reason |
| --- | --- | --- | --- |
| 1 | Effective mode is `paused` (a kill switch was turned on mid-window) | hard | `paused` |
| 2 | Market `status` is `open` and `close_time` in the future | hard | `market_closed` |
| 3 | Exchange `trading_active` (`GET /exchange/status`) | soft | `exchange_paused` |
| 4 | Newest feed observation for the game is at most `maxFeedAgeSec` old | soft | `stale_feed` |
| 5 | Game not `blocked` by feed disagreement | soft | `feed_blocked` |
| 6 | Best YES ask ≤ `maxPrice` | soft | `price` |
| 7 | Best YES ask ≥ `minPrice` (optional; a very cheap ask for a "leading" team usually means the score just changed and the feed is behind) | soft | `min_price` |
| 8 | Contracts available at prices ≤ `limit_bp` ≥ `minDepthContracts` | soft | `liquidity` |
| 9 | Sizing yields ≥ 1 contract | hard | `too_small` |
| 10 | Live only: IOC order filled nothing | soft | `unfilled` |
| 11 | Live only: exchange rejected the order because the order group limit was hit | soft | `order_group_limit` |
| 12 | Live only: exchange rejected the order (4xx other than rate limit) | hard | `order_rejected` |
| 13 | Transient error (network, 5xx, 429 after backoff) | soft | `error` |

There is no daily loss limit or trades-per-day cap in v1 (decided 25 Sep 2026). The safety controls are the switches (§1), per-strategy `maxStakeUsd`, the order group and the dedicated subaccount (§10).

### Modes and lifecycle

`mode ∈ {dry_run, live}` and `kill_switch ∈ {0, 1}` per strategy; the effective mode follows §1. Editing a strategy's rule, sizing, execution or leagues creates a new `strategy_versions` row; trades reference the version they fired under, so changing `minLead` later never rewrites history. Toggling mode or kill switch does not create a version (they are recorded in `audit_log`). Deleting a strategy soft-deletes it (`deleted_at`) so its trades remain in reports.

## 6. Trade lifecycle and P&L

A trade moves through the same states in both modes; only the fill step differs.

```mermaid
stateDiagram-v2
  [*] --> signalled : rule first matches (row inserted, unique per strategy+game)
  signalled --> pending : attempt row inserted, order / virtual fill in progress
  signalled --> waiting : soft guard failed
  signalled --> skipped : hard guard failed
  waiting --> pending : rule still matches, next tick
  waiting --> skipped : window closed (window_expired) or hard guard
  pending --> filled : fill_cc > 0 (partial fills kept as-is)
  pending --> waiting : IOC unfilled / soft error
  pending --> skipped : order rejected
  filled --> settled_won : settlement value 1.00
  filled --> settled_lost : settlement value 0.00
  filled --> settled_void : any other settlement value (NHL tie 0.50, fair price)
  skipped --> [*]
  settled_won --> [*]
  settled_lost --> [*]
  settled_void --> [*]
```

### Filling

| Step | Dry run | Live |
| --- | --- | --- |
| Price | `limit_bp = min(best_ask + maxSlippage, maxPrice)`, snapped to the market's price grid | Same, sent as the IOC `price` |
| Contracts | `floor(stake / limit)`, capped by the contracts offered at prices ≤ `limit_bp` | Same, sent as `count` |
| Fill | Recorded immediately at the **limit price** for all contracts (worst case the live order could get) | `POST /portfolio/events/orders`, `immediate_or_cancel`, with `client_order_id`, `order_group_id`, `subaccount`; stores `fill_count`, `average_fill_price`, fee = `average_fee_paid × fill_count` |
| Fee | Fee formula (§2) with the series multiplier and `fee_balance_precision_micros` | From the response |
| Bankroll | Shared virtual bankroll debited by cost + fee | Kalshi balance (read back into `balance_snapshots`) |

Because dry run assumes the limit price and live usually fills at or below it, dry-run results are slightly conservative; the Trades page shows the ask at trigger next to the fill price in both modes.

### Settling

The settler runs every 60 s (not while the global kill switch is on) for trades in `filled`:

1. `GET /markets/{ticker}` (or `/historical/markets/{ticker}` once past `market_settled_ts`). When `status ∈ {settled, finalized}` and `settlement_value_dollars` is present → `settlement_value_bp`.
2. `payout_micros = fill_cc × settlement_value_bp`; status `settled_won` (10000), `settled_lost` (0) or `settled_void` (anything else).
3. Dry run: credit the payout to the shared bankroll and write a `bankroll_snapshots` row in the same transaction.
4. Live: reconcile against `GET /portfolio/settlements` for the ticker; if the exchange's `revenue` differs from `payout_micros` by more than 10 000 micros ($0.01), set `trades.reconcile_warning` and log `warn`.

P&L per trade: `realized_pnl_micros = payout_micros − cost_micros − fee_micros` where `cost_micros = fill_cc × avg_fill_price_bp`. Unrealized P&L for open trades = `fill_cc × (current yes_bid_bp − avg_fill_price_bp)` from the latest `GET /markets/{ticker}`.

### Metrics (computed per mode for every filter: strategy × league × date range × Kalshi environment)

Live and dry-run metrics are always computed and returned **separately**; no metric, tile or series ever sums the two.

| Metric | Definition |
| --- | --- |
| Trades, win rate | count of settled; `won / (won + lost)` (void excluded) |
| Net P&L, ROI | Σ realized; `net P&L / Σ (cost + fee)` of settled trades |
| Equity curve | cumulative realized P&L by settlement time; dry run also shows the shared bankroll line; live also shows the Kalshi balance line |
| Max drawdown | largest peak-to-trough drop of the equity curve |
| Avg price paid, avg fee | for the price/edge analysis |
| Implied vs actual | mean fill price (implied probability) vs actual win rate — the number that says whether a strategy has edge |
| Skips by reason | how often a rule matched but a guard blocked the entry (final and per-attempt counts) |
| Forced dry run share | dry-run trades whose `configured_mode` was `live` (mode_reason `global_dry_run` or `addon_lock`) |

## 7. Database schema (SQLite)

One file, `/data/db/trader.db`, WAL mode, `PRAGMA foreign_keys=ON`, `busy_timeout=5000`, migrated by Drizzle on start-up. Units follow the conventions table at the top: `*_micros` money, `*_bp` prices, `*_cc` contract counts, ISO-8601 UTC text times. Every money, price and count column is `INTEGER` and validated as an integer before insert.

```sql
CREATE TABLE leagues (
  id TEXT PRIMARY KEY,                 -- 'nhl','epl','laliga','bundesliga','seriea','ligue1'
  sport TEXT NOT NULL,                 -- 'soccer' | 'hockey'
  name TEXT NOT NULL,
  kalshi_series TEXT NOT NULL,         -- 'KXEPLGAME'
  feed_ids TEXT NOT NULL,              -- JSON {"apiFootball": 39, "nhl": null}
  include_preseason INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY, league_id TEXT REFERENCES leagues(id),
  name TEXT NOT NULL, abbreviation TEXT,
  kalshi_target_id TEXT,               -- structured target uuid (market custom_strike)
  aliases TEXT                         -- JSON array (NHL tricode, feed names)
);

CREATE TABLE games (
  id TEXT PRIMARY KEY,                 -- Kalshi event ticker
  league_id TEXT REFERENCES leagues(id),
  competition TEXT,                    -- product_metadata.competition
  home_team_id TEXT, away_team_id TEXT,
  scheduled_at TEXT NOT NULL,          -- milestone start_date
  milestone_id TEXT, feed_game_ids TEXT,        -- JSON per feed (incl. milestone source_ids)
  phase TEXT NOT NULL DEFAULT 'scheduled',
  home_score INTEGER, away_score INTEGER,
  clock_minute INTEGER, minute_source TEXT,     -- 'feed' | 'derived'
  kickoff_observed_at TEXT, second_half_observed_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,           -- feed disagreement > 20 s
  final_home INTEGER, final_away INTEGER, finished_at TEXT,
  timeline_archived INTEGER NOT NULL DEFAULT 0, -- goal timeline written to hist_games
  historical INTEGER NOT NULL DEFAULT 0,        -- 1 = backfilled settled event (T11): never tracked or traded
  pregame_home_bp INTEGER, pregame_away_bp INTEGER,  -- YES ask at kick-off (T15 underdogOnly)
  updated_at TEXT NOT NULL
);

CREATE TABLE markets (
  ticker TEXT PRIMARY KEY, game_id TEXT REFERENCES games(id),
  outcome TEXT NOT NULL,               -- 'home' | 'away' | 'tie' | 'unknown'
  status TEXT, result TEXT, settlement_value_bp INTEGER,
  close_time TEXT, price_ranges TEXT,  -- JSON [{start,end,step}] in dollars strings
  yes_bid_bp INTEGER, yes_ask_bp INTEGER, updated_at TEXT
);

CREATE TABLE game_snapshots (          -- feed observations, for replay and debugging
  id INTEGER PRIMARY KEY, game_id TEXT, observed_at TEXT, feed_updated_at TEXT, feed TEXT,
  home_score INTEGER, away_score INTEGER, phase TEXT,
  clock_minute INTEGER, minute_source TEXT, raw TEXT
);
CREATE INDEX ix_snapshots_game ON game_snapshots(game_id, observed_at);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sport TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','live')) DEFAULT 'dry_run',
  kill_switch INTEGER NOT NULL DEFAULT 1,       -- 1 = paused
  current_version INTEGER NOT NULL,
  created_at TEXT, updated_at TEXT, deleted_at TEXT
);

CREATE TABLE strategy_versions (
  strategy_id TEXT REFERENCES strategies(id), version INTEGER,
  league_ids TEXT NOT NULL, rule TEXT NOT NULL, sizing TEXT NOT NULL, execution TEXT NOT NULL,  -- JSON
  created_at TEXT, PRIMARY KEY (strategy_id, version)
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,                           -- UUID
  strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
  game_id TEXT NOT NULL, market_ticker TEXT, league_id TEXT NOT NULL,
  kalshi_env TEXT NOT NULL,                      -- 'demo' | 'prod'
  configured_mode TEXT NOT NULL,                 -- strategy.mode at first signal
  effective_mode TEXT NOT NULL,                  -- 'live' | 'dry_run' (mode of the filling attempt, else of the last attempt)
  mode_reason TEXT,                              -- null | 'strategy' | 'global_dry_run' | 'addon_lock'
  status TEXT NOT NULL,                          -- see §6
  skip_reason TEXT, window_expired INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  trigger_snapshot TEXT NOT NULL,                -- JSON GameState + orderbook top
  triggered_at TEXT NOT NULL, window_ends_at TEXT NOT NULL,
  balance_micros INTEGER, stake_micros INTEGER,
  limit_price_bp INTEGER, requested_cc INTEGER,
  fill_cc INTEGER, avg_fill_price_bp INTEGER, cost_micros INTEGER, fee_micros INTEGER,
  kalshi_order_id TEXT,
  settled_at TEXT, settlement_value_bp INTEGER, payout_micros INTEGER, realized_pnl_micros INTEGER,
  reconcile_warning TEXT,
  UNIQUE (strategy_id, game_id)
);
CREATE INDEX ix_trades_filter ON trades(effective_mode, kalshi_env, strategy_id, league_id, triggered_at);

CREATE TABLE trade_attempts (
  id INTEGER PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES trades(id), attempt_no INTEGER NOT NULL,
  at TEXT NOT NULL, effective_mode TEXT NOT NULL, mode_reason TEXT,
  client_order_id TEXT NOT NULL UNIQUE,          -- '<trade.id>-<attempt_no>'
  status TEXT NOT NULL,                          -- 'pending','filled','unfilled','soft_skip','hard_skip','error'
  reason TEXT,
  best_ask_bp INTEGER, depth_cc INTEGER, limit_price_bp INTEGER, requested_cc INTEGER,
  fill_cc INTEGER, avg_fill_price_bp INTEGER, fee_micros INTEGER,
  kalshi_order_id TEXT, response TEXT,           -- JSON, never contains credentials
  UNIQUE (trade_id, attempt_no)
);

CREATE TABLE balance_snapshots (                 -- live equity/balance line
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, kalshi_env TEXT NOT NULL, subaccount INTEGER NOT NULL,
  cash_micros INTEGER, portfolio_value_micros INTEGER
);

CREATE TABLE bankroll_snapshots (                -- shared dry-run bankroll after each change
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, trade_id TEXT,
  reason TEXT NOT NULL,                          -- 'fill' | 'settlement' | 'reset'
  bankroll_micros INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  actor TEXT NOT NULL,                           -- 'system' | 'user:<name>'
  ip TEXT, channel TEXT,                         -- 'ingress' | 'tunnel' | 'dev' | null
  mode TEXT,                                     -- 'live' | 'dry_run' | null (not trade-related)
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT   -- JSON
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                   -- argon2id
  totp_secret_enc TEXT,                          -- AES-256-GCM, null = TOTP off
  recovery_codes_hash TEXT,                      -- JSON array of argon2id hashes; used codes removed
  created_at TEXT, last_login_at TEXT
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                      -- SHA-256 of the opaque session id
  user_id INTEGER NOT NULL, channel TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_auth_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, ip TEXT, ua TEXT
);
CREATE TABLE login_attempts (id INTEGER PRIMARY KEY, at TEXT NOT NULL, ip TEXT, username TEXT, channel TEXT, ok INTEGER);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
-- keys and defaults: global_kill_switch=false, global_dry_run=true,
--   dry_run_bankroll_micros=100000000, dry_run_initial_bankroll_micros=100000000,
--   fee_balance_precision_micros=100, kalshi_order_group_id=null, order_group_contract_limit=200,
--   price_model=null, api_football_key_enc=null (T15), notifications={} (T15), feeds={} (T07)

-- Backtesting
CREATE TABLE hist_games (
  id TEXT PRIMARY KEY, league_id TEXT, season TEXT, competition TEXT, played_at TEXT,
  home TEXT, away TEXT, final_home INTEGER, final_away INTEGER,
  goal_events TEXT NOT NULL,                     -- JSON [{side:'home', period:1, minute:23, second:10}]
  source TEXT NOT NULL,                          -- 'nhl' | 'kalshi_pbp' | 'live' | 'csv' | 'api_football'
  kalshi_event_ticker TEXT
);
CREATE INDEX ix_hist_league_season ON hist_games(league_id, season);

CREATE TABLE hist_prices (                       -- Kalshi 1-minute candles
  market_ticker TEXT, minute_ts TEXT,
  ask_open_bp INTEGER, ask_high_bp INTEGER, ask_low_bp INTEGER, ask_close_bp INTEGER,
  bid_close_bp INTEGER, trade_close_bp INTEGER,  -- trade close nullable (no trade that minute)
  volume_cc INTEGER,
  PRIMARY KEY (market_ticker, minute_ts)
);

CREATE TABLE backtests (
  id TEXT PRIMARY KEY, created_at TEXT, league_id TEXT, season TEXT,
  strategy_version_ref TEXT, params TEXT, price_mode TEXT,   -- 'exact' | 'modelled'
  initial_bankroll_micros INTEGER, result_summary TEXT       -- JSON metrics
);
CREATE TABLE backtest_trades (
  id INTEGER PRIMARY KEY, backtest_id TEXT, hist_game_id TEXT, minute INTEGER, side TEXT,
  price_source TEXT,                             -- 'candle' | 'next_candle' | 'model'
  price_bp INTEGER, contracts_cc INTEGER, stake_micros INTEGER, fee_micros INTEGER,
  settlement_value_bp INTEGER, pnl_micros INTEGER, bankroll_after_micros INTEGER, skip_reason TEXT
);
```

Seed (migration): all six leagues with their series (`KXNHLGAME`, `KXEPLGAME`, `KXLALIGAGAME`, `KXBUNDESLIGAGAME`, `KXSERIEAGAME`, `KXLIGUE1GAME`), `enabled = 1`, `include_preseason = 0`.

Retention: `game_snapshots` older than 90 days are pruned nightly, but only for games with `timeline_archived = 1`; everything else is kept. Expected size after a season: well under 200 MB.

## 8. Web UI

Six pages behind the login. Every data page shares one **filter bar** — sport, leagues, strategies, **mode (live / dry run / both, default both)**, Kalshi environment (default: the current one), date range with presets 7d / 30d / season / all — whose state lives in the URL so views can be bookmarked. All charts are Recharts; all tables are TanStack Table with column sort and CSV export.

### Live vs dry run, everywhere

- **Badges:** a `LIVE` (solid, accent colour) or `DRY RUN` (outlined, neutral) badge on every trade row, live game card entry, strategy row and log line. When configured and effective modes differ, the badge reads e.g. `LIVE → DRY RUN (global)` / `(add-on lock)`. Live trades also show the environment (`demo` / `prod`).
- **Charts:** live series are solid lines/bars, dry-run series dashed lines / hatched bars; legends always say "Live" or "Dry run". With mode = both, each series is drawn once per mode; nothing is summed across modes.
- **Tiles:** with mode = both, every tile shows two values side by side (Live | Dry run).
- **Exports:** every CSV has `effective_mode`, `configured_mode`, `mode_reason`, `kalshi_env` columns.
- **Logs:** the Diagnostics log tail and SSE log lines show the mode tag and can be filtered by it.
- **Backtests** are a third category, shown only on the Backtest page and never plotted together with live or dry-run data.

| Page | Purpose | Main elements |
| --- | --- | --- |
| **Login** | Password facade | Username + password, optional TOTP code; generic error; lockout notice |
| **Dashboard** | Is it running, and is it making money? | Status strip: loop state (running / paused by kill switch / stale), last poll, feeds OK, Kalshi env + balance, **global kill switch**, **global dry run**, **add-on live lock** (read-only); live game cards with score, minute (with "derived" marker), strategies armed on that game with effective-mode badges; tiles (trades, win rate, net P&L, ROI, max drawdown, avg price, implied vs actual) per mode; the chart inventory below |
| **Strategies** | Create, edit, pause, switch mode | Table: name, sport, leagues, **kill switch toggle**, **mode toggle**, effective-mode badge, trades and P&L 30d per mode; editor drawer with all §5 fields and inline validation; "Test against last 30 days" (quick exact backtest, from T12; disabled until the strategy is saved); version history |
| **Trades** | Everything that fired or nearly fired | Table with filter bar + status filter (waiting / filled / settled / skipped by reason) + mode badges; row expands to trigger snapshot (score, minute, minute source, feed timestamps), attempts list (time, ask, depth, limit, outcome, reason), fill, settlement, reconcile warning, audit trail; charts: price-paid histogram and P&L per trade, both split by mode |
| **Backtest** | Replay a strategy over a past season | Form: league, season(s), strategy (existing version or ad-hoc), initial bankroll, price mode (exact / modelled); results: equity curve, drawdown, monthly P&L, trades table, tiles, "modelled" badge with the smallest sample size used; save; compare up to 3 saved runs; "Promote to strategy" |
| **Settings** | Everything operational | **Trading:** global kill switch (big, red), global dry run, add-on lock and Kalshi env/subaccount (read-only, with a note that they are changed in Home Assistant), dry-run bankroll (current, initial, reset with step-up), fee precision, order group status/limit; **Leagues:** enable, series ticker, include preseason, discover series, run discovery; **Feeds:** adapters on/off, test feed; **Data:** import CSV, fetch NHL season, backfill settled Kalshi events, collect candles, rebuild price model, DB size, vacuum; **Account:** change password, TOTP, active sessions with revoke; **Diagnostics:** log tail with mode filter, app version, DB path/size, test Kalshi connection |

Layout: one dark/light-aware responsive layout; on a phone the status strip and live game cards come first and charts stack vertically below `md`.

### Chart inventory (Recharts), every chart split by mode

| Chart | Type | Series / axes |
| --- | --- | --- |
| Equity curve | `LineChart` | x = time, y = cumulative realized P&L ($); per selected strategy and per mode; dry-run bankroll line (dashed) and live Kalshi balance line (solid) |
| Daily P&L | `BarChart` | x = day, y = realized P&L, positive/negative colours; live solid, dry run hatched; stacked by strategy within a mode |
| Drawdown | `AreaChart` | x = time, y = drawdown from peak (%), one area per mode |
| Implied vs actual | `ScatterChart` + reference line y = x | x = mean price paid, y = win rate; one point per (strategy, league, mode); point size = trade count; live filled markers, dry run hollow |
| Price paid distribution | `BarChart` (histogram) | 1¢ bins from `maxPrice − 15¢` to `maxPrice`, grouped by mode |
| Trades per minute triggered | `BarChart` | x = clock minute at entry, y = count, colour by outcome, grouped by mode |
| Skip reasons | horizontal `BarChart` | one bar per reason, grouped by mode (final skips and per-attempt skips toggle) |
| Balance history | `LineChart` | live Kalshi balance from `balance_snapshots` and dry-run bankroll from `bankroll_snapshots`, two clearly labelled lines |

Every chart takes the same `{ filters }` props and uses one endpoint, `GET /api/stats?…`, which returns pre-aggregated data keyed by mode — `{ live: {...}, dry_run: {...} }` — so the browser never receives raw trade rows for charts.

## 9. Backtesting

The backtester replays the **same `engine.ts`, `guards.ts` and `pricing.ts`** the live loop uses, fed by synthetic `GameState` ticks generated from `hist_games.goal_events`, so a rule cannot behave differently in a backtest than in production. Backtest results are their own category (`backtest`) and are never mixed with live or dry-run data.

### Algorithm

For each game in (league, season), in date order:

1. Build a minute-by-minute timeline from `goal_events` (soccer: minutes 1–90; hockey: elapsed minutes 1–60 from period + clock).
2. Step the engine through the timeline. When the rule first matches at minute M, ask the **price provider** for the leader market's YES ask at M; apply the guards (`maxPrice`, `minPrice`, `too_small`; depth is not modelled). If a soft guard blocks, retry at M+1 … until the window closes, exactly like the live retry.
3. Size with the running bankroll (percent sizing compounds), compute `limit_bp = min(ask + maxSlippage, maxPrice)`, contracts, fee (same formula and precision setting).
4. Decide the outcome from the final score using the sport's settlement rule (soccer: 90' + stoppage result; hockey: final incl. OT/SO, which `final_home/final_away` store; an NHL tie settles at $0.50).
5. Record a `backtest_trades` row and update the bankroll.

Output: the §6 metrics, equity curve, drawdown, monthly P&L, per-trade list.

### Price providers

| Mode | Where the price comes from | Accuracy | Available for |
| --- | --- | --- | --- |
| **exact** | `hist_prices.ask_close_bp` at minute M for that game's market; if missing, the next candle within 3 minutes (`price_source = 'next_candle'`); otherwise `skipped_no_price` | Real market ask | Games with a `kalshi_event_ticker` and imported candles — roughly 2025–26 onward |
| **modelled** | `priceModel(sport, lead, minutesRemaining)` | Estimate, shown with a warning badge and sample size | Any season |

The price model is a lookup table of the **median ask close** by (sport, lead bucket 1 / 2 / 3+, remaining-minute bucket of 5), built from `hist_prices` joined to `hist_games` goal timelines (never to `game_snapshots`, which are pruned) — Settings → Data → Rebuild price model. Cells with fewer than 20 observations fall back to a conservative seed table (soccer, lead 2, 10 min left → $0.96; lead 1, 10 min left → $0.85; hockey, lead 2, 5 min left → $0.97; the full table is defined in the T11 implementation notes). The UI states the sample size behind every modelled run.

### Why exact mode matters

With a 2-goal lead at 80' the contract is usually $0.94–$0.98. A 1¢ error in the assumed price changes the strategy's edge by roughly a third of its expected profit, so a modelled backtest is good for ranking rules against each other and bad for deciding stake size. Dry run exists to collect exact prices: after a season of dry run the app has the candles and archived timelines to backtest exactly.

### Performance

A season of EPL (380 games) replays in well under a second on the Pi; five leagues × ten seasons in a few seconds. Backtests run in a `worker_threads` worker so the trading loop is never blocked.

## 10. Security

Threat model: the app is reachable from the internet through a Cloudflare Tunnel, it holds a key that can spend real money, and it runs on the same host as your home automation. Design goals in order: **no secret ever lands in the repository, an image or the database**; **nobody without the password gets a single byte of app data**; **a compromise of the web app cannot place real orders unless you enabled that in Home Assistant, and a compromise of the whole app cannot spend more than the subaccount holds**.

### Request classes

Every request is classified once, by the socket peer and headers, before any route runs:

| Class | Rule | Treatment |
| --- | --- | --- |
| `ingress` | Peer is the Supervisor ingress proxy (`172.30.32.2`), `X-Ingress-Path` present, **no** `CF-Connecting-IP` | Already behind Home Assistant's login. Own login still required. First-run `/setup` allowed. No lockout (only rate limiting). Framing allowed from the same origin. |
| `tunnel` | Request carries `CF-Connecting-IP` and the peer is inside `trusted_proxies` (default `172.30.32.0/23`, the Home Assistant internal network where the `cloudflared` app runs) | Client IP = `CF-Connecting-IP`. Full lockout rules. `/setup` → 403. Framing denied. |
| `dev` | `NODE_ENV=development` and peer is loopback | Local development only; `/setup` allowed. |
| `other` | Anything else (including `CF-Connecting-IP` from an untrusted peer, which is ignored) | Treated like `tunnel` with the socket address as client IP. With `ports: 8099/tcp: null` (default) nothing outside the Home Assistant network can reach the app at all. |

### Secrets

| Secret | Where it lives | How it gets there | Never |
| --- | --- | --- | --- |
| Kalshi API key id + RSA private key (PEM) | Home Assistant app options (`/data/options.json`, root-only) as `kalshi_key_id` and `kalshi_private_key_b64` (schema type `password`) | Pasted once in the app's **Configuration** tab | In git, in the image, in the database or any app-written file under `/data` (backed up to Google Drive; only the Supervisor-written `options.json` holds it, protected by the backup password), in logs, in environment variables |
| Private key at runtime | Node process memory only | `run.sh` (root) decodes it and hands it to Node on **file descriptor 3**; Node reads fd 3 once at boot and closes it | `process.env`, `/proc/<pid>/environ`, disk |
| Session/encryption secret | `/data/app/secret.key` (mode 600, owned by the app user), 32 random bytes generated on first start | Automatic | Regenerated unless deleted (which logs everyone out and makes encrypted settings unreadable) |
| API-Football key (T15) | `settings.api_football_key_enc`, AES-256-GCM under a key derived from `secret.key` | Settings page | Plaintext in the DB |
| App user password | `users.password_hash`, argon2id (m = 64 MiB, t = 3) | First-run setup, only from `ingress` (or `dev`) while `users` is empty | — |

No `.env` files exist in any environment. Local development reads the same settings from a git-ignored `config.local.json` (the private key as a **path** to a PEM outside the repository); `config.local.example.json` is committed with empty values. The repository ships `.gitignore` entries for `*.key`, `*.pem`, `config.local.json`, `*.db*`, `.local/`, and a **pre-commit hook plus CI step running `gitleaks`**; `.dockerignore` excludes the same paths.

### Login and sessions

- Username + password on every route except `/login`, `/setup` (first run), `/healthz` (returns only status) and static assets. Wrong username and wrong password return the same response in the same time.
- **Optional TOTP** (RFC 6238, `otplib`), off at launch, enabled per user in Settings → Account; setup shows a QR code; 10 recovery codes shown once, stored as argon2id hashes, each usable once.
- Sessions: opaque 256-bit id (only its SHA-256 is stored), idle timeout 12 h, absolute lifetime 7 days, revocable from Settings, id rotated on login.
  - Tunnel/other: cookie `kst_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
  - Ingress: cookie `kst_session_ingress`, `HttpOnly; SameSite=Strict; Path=<X-Ingress-Path>`, `Secure` only when the browser-facing scheme is HTTPS (`X-Forwarded-Proto`), so ingress login works when Home Assistant is opened over plain http on the LAN.
- **Brute-force protection** (tunnel/other only): 10 failed attempts per client IP or per username within 15 minutes → 15-minute lockout, doubling on each repeat; ingress is never locked out (the only account cannot be locked out by an internet attacker, because you can always log in via the sidebar). All attempts are written to `login_attempts` and `audit_log` with IP and channel.
- **Step-up authentication** (password re-entered within the last 5 minutes): turning the global kill switch off, turning global dry run off, turning a strategy kill switch off, switching a strategy to live, resetting the dry-run bankroll, CSV import, changing the password or TOTP.
- CSRF: `SameSite=Strict` plus a per-session token checked on every state-changing request (`@fastify/csrf-protection`).

### HTTP hardening

- `@fastify/helmet` with a strict Content-Security-Policy (`default-src 'self'`, no inline scripts; React and Recharts are bundled, no CDN), `Referrer-Policy: no-referrer`.
- Framing: `ingress` responses send `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (Home Assistant shows the app in an iframe on its own origin); all other responses send `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Rate limit: 300 requests/min per client IP (static assets and the SSE stream exempt); `/login` 5/min per client IP.
- All input validated with Zod/Fastify JSON schema; unknown fields rejected; SQL only through parameterised Drizzle queries.
- Body size limit 1 MB, except CSV import (20 MB, authenticated, step-up).
- No directory listings, no source maps in production builds, no stack traces in responses; errors return `{"error":"internal","correlationId":"…"}` and the id appears in the server log.
- Diagnostic "drill" endpoints (T14) exist only when `NODE_ENV=development`.

### Cloudflare Tunnel (documented in `DOCS.md`)

- `cloudflared` runs as a Home Assistant app on the same Pi. The tunnel's service target is `http://<repo-prefix>-kalshi-trader:8099` (`local-kalshi-trader` when the app is installed locally; `<hash>-kalshi-trader` when installed from the GitHub repository — the exact hostname is shown on the app's Info page). `ports: 8099/tcp: null` keeps the app unreachable from the LAN.
- Strongly recommended and free: **Cloudflare Access** (one-time PIN to your email or Google login) in front of the hostname — a second wall before the app's own login that also hides the login page from scanners.
- Cloudflare WAF managed rules and Bot Fight Mode on.

### Blast-radius limits

- **`allow_live_orders` add-on option** (default `false`): real orders are impossible while it is off, whatever the web UI or database says.
- **Dedicated Kalshi subaccount** (option `kalshi_subaccount`, default 0 = primary): move only the bankroll you intend to trade into a subaccount and create an API key **restricted to that subaccount**. Even a full compromise of the Pi can then only trade that subaccount's funds. Subaccounts require the Advanced API tier (one call to the upgrade endpoint after one API-placed order). Documented step by step in `DOCS.md`.
- **Order group:** at start-up the app creates (or reuses, via `settings.kalshi_order_group_id`) a Kalshi order group with `order_group_contract_limit` (default 200 contracts per rolling 15 s); every live order carries its id. When the exchange triggers the group, further orders are rejected until it is reset from Settings (step-up) — an exchange-side brake against runaway loops.
- Per-strategy `maxStakeUsd`, the global and per-strategy kill switches and global dry run, all enforced in `executor.ts` before any order and logged when hit.
- The Kalshi client exposes no deposit, withdrawal or transfer method (enforced by an allow-list test).
- Delete the API key in Kalshi if the Pi is ever lost; Kalshi RSA keys cannot be reconstructed from the exchange.

### Container and supply chain

- Built and run from the same pinned Home Assistant base image; the Node process runs as the non-root user `trader` (uid 1000); `run.sh` alone runs as root to read options, prepare directories and hand over the key. `apparmor: true` (default profile), no `host_network`, no `privileged`, no `full_access`, no `hassio_api`; `homeassistant_api` only from T15.
- Read-only root filesystem is enforced in local `docker compose` runs (`read_only: true`); Home Assistant has no equivalent option, so on HAOS the protections are non-root, AppArmor and the absence of extra privileges.
- `npm ci` with a committed lockfile; `npm audit` and Dependabot in CI; dependencies limited to §4.
- Outbound egress by design: Kalshi hosts, `api-web.nhle.com`, API-Football (T15), `supervisor` (T15). Documented so it can be enforced at the router/Pi-hole.
- Every money- or security-related action (order attempt, fill, settlement, switch change, mode change, limits change, login, failed login, lockout, key/session events) goes to `audit_log` with actor, IP, channel and mode, and cannot be deleted from the UI.

## 11. Home Assistant app packaging

Home Assistant calls add-ons **apps**; since Supervisor 2026.04 there is no `build.yaml` and no default `BUILD_FROM`, so the base image is an explicit `FROM` in the Dockerfile. The repository is a standard app repository added under **Settings → Apps → Repositories**. Where this section is silent on a convention (labels, `DOCS.md` layout, local build scripts), T01/T05 follow the reference-app facts in §14; where this section is explicit, it wins.

### Repository layout

```
sports-trading/                 (git repo root = HA app repository)
  repository.yaml               name, url, maintainer
  SPEC.md                       this document
  kalshi-trader/
    config.yaml
    Dockerfile
    run.sh
    DOCS.md  README.md  CHANGELOG.md  icon.png  logo.png
    translations/en.yaml        option labels and descriptions
    app/                        the Node project (package.json, src/, web/, test/)
  docker-compose.yml            local runs (§12)
  .github/workflows/            ci.yml, image.yml, (optional, disabled) publish.yml
```

### `config.yaml`

```yaml
name: Kalshi Sports Trader
version: "0.1.0"
slug: kalshi-trader
description: In-game sports strategy trader for Kalshi with dry-run mode and backtesting
url: https://github.com/petrapa6/sports-trading
arch: [aarch64, amd64]
startup: application
boot: auto
init: true                    # Docker's init as PID 1; the image does not use s6
ingress: true
ingress_port: 8099
panel_icon: mdi:chart-timeline-variant
ports:
  8099/tcp: null              # unmapped: reached only via ingress and the cloudflared app
ports_description:
  8099/tcp: Web UI (map only if cloudflared runs outside Home Assistant)
# no `map`: everything lives in the app's own /data (always mounted, included in HA backups)
backup: hot
backup_exclude:
  - "/data/app/cache/**"
watchdog: http://[HOST]:[PORT:8099]/healthz
tmpfs: true
options:
  kalshi_env: demo
  kalshi_key_id: ""
  kalshi_private_key_b64: ""
  kalshi_subaccount: 0
  allow_live_orders: false
  log_level: info
  trusted_proxies: "172.30.32.0/23"
schema:
  kalshi_env: list(demo|prod)
  kalshi_key_id: password
  kalshi_private_key_b64: password      # base64 of the PEM file, one line
  kalshi_subaccount: int(0,63)
  allow_live_orders: bool
  log_level: list(debug|info|warn|error)
  trusted_proxies: str
  timezone: str?                        # optional IANA zone; default: container TZ, else UTC
```

The private key is entered as **one base64 line** (`base64 -w0 key.pem`) because the Configuration tab uses single-line fields. Home Assistant backups include each app's `/data` (and therefore `options.json`), so set a **backup password** in the Google Drive Backup app.

### `Dockerfile` (multi-stage, aarch64 + amd64)

```dockerfile
# Both stages use the SAME pinned base (chosen in T05, docs/decisions/0002-base-image.md).
FROM ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63 AS build
RUN apk add --no-cache nodejs npm python3 make g++
WORKDIR /app
COPY app/package*.json ./
# `npm ci` runs the `prepare` script (git hook installer, a no-op without git), so it must exist first.
COPY app/scripts/install-hooks.mjs ./scripts/
RUN npm ci
COPY app/ .
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
RUN apk add --no-cache nodejs su-exec \
 && adduser -D -u 1000 trader
WORKDIR /app
COPY --from=build --chown=trader:trader /app/dist ./dist
COPY --from=build --chown=trader:trader /app/node_modules ./node_modules
# Drizzle migrations are read at start-up (T02).
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./
COPY run.sh /run.sh
RUN chmod 755 /run.sh
ENV NODE_ENV=production
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8099/healthz || exit 1
LABEL io.hass.version="0.1.0" io.hass.type="app" io.hass.arch="aarch64|amd64" \
      org.opencontainers.image.title="Kalshi Sports Trader" \
      org.opencontainers.image.source="https://github.com/petrapa6/sports-trading"
ENTRYPOINT []
CMD ["/run.sh"]
```

`better-sqlite3` is compiled in the build stage against the same Alpine and Node as the runtime stage, so the native module always matches. The Supervisor builds the image on the Pi on first install (a few minutes) unless pre-built images are published to GHCR (optional workflow, disabled by default).

### `run.sh`

```bash
#!/usr/bin/env bash
# Kalshi Sports Trader start script (SPEC.md §11). Runs as root: reads the app options, prepares the
# app's data directories, hands the private key to Node on fd 3 and drops to uid 1000 (`trader`).
#
# Options are read from /data/options.json with jq (as the reference app does) rather than through
# bashio::config, which asks the Supervisor API and therefore only works inside Home Assistant; the file
# is written by the Supervisor, so the result is the same there, and local `docker compose` runs work too.
set -euo pipefail

OPTIONS=/data/options.json
die() { echo "[kalshi-trader] ERROR: $*" >&2; exit 1; }
[[ -r "$OPTIONS" ]] || die "$OPTIONS is missing or unreadable"
jq -e 'type == "object"' "$OPTIONS" >/dev/null || die "$OPTIONS is not a JSON object"

# The option's value as text; nothing when the key is absent or null (false and 0 are kept).
opt() { jq -r --arg k "$1" 'if has($k) and .[$k] != null then .[$k] | tostring else empty end' "$OPTIONS"; }

export KALSHI_ENV="$(opt kalshi_env)"
export KALSHI_KEY_ID="$(opt kalshi_key_id)"
export KALSHI_SUBACCOUNT="$(opt kalshi_subaccount)"
export ALLOW_LIVE_ORDERS="$(opt allow_live_orders)"
export LOG_LEVEL="$(opt log_level)"
export TRUSTED_PROXIES="$(opt trusted_proxies)"
timezone="$(opt timezone)"
if [[ -n "$timezone" ]]; then export TZ="$timezone"; fi
export DATA_DIR=/data/app DB_PATH=/data/db/trader.db PORT=8099
mkdir -p /data/db /data/app
chown -R trader:trader /data/db /data/app
chmod 700 /data/db /data/app
# The key goes to Node on fd 3 only (never the environment); the fd number is an argument so that no
# KALSHI_PRIVATE* name appears in /proc/<pid>/environ.
exec su-exec trader:trader node /app/dist/server/main.js --kalshi-private-key-fd=3 \
  3< <(opt kalshi_private_key_b64 | base64 -d)
```

Node reads the PEM with `fs.readFileSync(3)` at boot, closes the descriptor once the database and the listening socket are open (so no long-lived file inherits fd 3), and keeps the key only in memory. The descriptor number is passed as the argument `--kalshi-private-key-fd=3` rather than as `KALSHI_PRIVATE_KEY_FD=3` in the environment, so no `KALSHI_PRIVATE*` name appears in `/proc/<pid>/environ` (T05); the `KALSHI_PRIVATE_KEY_FD` variable still works outside the container. Options are read from `/data/options.json` with `jq` (as the reference app does) instead of `bashio::config`, which queries the Supervisor API and fails outside Home Assistant (found in T05: local `docker compose` and the `run.sh` fixture test have no Supervisor). The app writes only `/data/db` (database, WAL, SHM) and `/data/app` (`secret.key`, `cache/`); `/data` itself and `options.json` stay root-owned, which is why the database has its own subdirectory instead of sitting directly in `/data`.

### Behaviour inside Home Assistant

- **Ingress:** the UI is in the HA sidebar; requests come from `172.30.32.2` with `X-Ingress-Path`, and the app serves assets and cookies under that path (§10).
- **Health:** `/healthz` returns `200 {"ok":true,"loop":"running"|"idle"|"paused"}` if the DB opens and the trading loop has ticked within 2 minutes or is intentionally paused by the global kill switch; otherwise `503`. The Supervisor watchdog restarts the container on `503`.
- **Backups:** the DB is under `/data`, which Home Assistant includes in every backup of the app, so the Google Drive Backup app captures it; `PRAGMA wal_checkpoint(TRUNCATE)` runs nightly at 02:30 local time (`TZ`); WAL keeps hot backups consistent.
- **Logs:** Pino JSON lines in the app's Log tab; `log_level` is an option; trading lines carry `mode`.
- **Updates:** bump `version` in `config.yaml` (it must equal `package.json`); migrations run on start and stay backward-compatible for one version so a rollback is possible.
- **Resources:** ~150 MB RAM idle, ~250 MB during a backtest; CPU negligible except during the first native build.

## 12. Local development and testing

`git clone && npm install && npm run dev` (in `kalshi-trader/app`) starts the API on `:8099` and Vite on `:5173` with hot reload, against `./.local/trader.db`. Configuration comes from environment variables or `config.local.json` (git-ignored; `kalshiPrivateKeyPath` points to a PEM outside the repo), so the code path is the same as in the container.

### Environments

| Env | Kalshi | Score feeds | Purpose |
| --- | --- | --- | --- |
| `test` | `msw` mocks with recorded fixtures | Recorded fixtures | Unit and integration tests, CI |
| `replay` | Recorded orderbooks / msw | `game_snapshots` replayed at up to 100× | Reproduce an evening deterministically |
| `demo` | Kalshi demo | Live feeds | End-to-end including real order placement with paper money (`allow_live_orders` true in `config.local.json`) |
| `prod` | Kalshi production | Live feeds | The Pi |

`docker compose up --build` builds the same Dockerfile locally (amd64) with `./.local/data` mounted as `/data`, `read_only: true`, `tmpfs: /tmp`, and an `options.json` generated from `config.local.json` by `npm run compose:options`. `docker buildx build --platform linux/arm64` verifies the Pi build under QEMU.

### Test plan

- **Unit:** `decimal.ts`, `pricing.ts` (fee rounding at both precisions, cost, P&L, sizing edge cases), `modes.ts` (every switch combination), `guards.ts`, `engine.ts` (window, retry, once-per-game, halftime, stoppage time, OT), feed parsers against recorded payloads, Kalshi request signing against a known-good signature.
- **Integration:** trigger → dry-run fill → settle on the mock server; retry within the window; restart recovery of `pending` attempts; switch enforcement including zero outgoing HTTP under the global kill switch.
- **Security:** request classification, login lockout per channel, session expiry, CSRF, step-up, CSP and framing headers per channel, `gitleaks`; `npm run audit:security` runs them all.
- **Manual before go-live:** one full match day in `demo` with a live strategy, fills verified against the Kalshi demo portfolio and the fee formula.

CI (GitHub Actions): lint, typecheck, tests, e2e, `npm audit --audit-level=high`, `gitleaks`, arm64 + amd64 image build. CI needs no secrets because nothing there talks to Kalshi.

## 13. Risks, decisions, build order

### Risks worth knowing before writing code

| Risk | Impact | Mitigation in this spec |
| --- | --- | --- |
| Kalshi soccer live data has no clean match-minute field | Soccer strategies fire late or not at all | Text parser + derived-minute fallback, `minuteSource` recorded; verify in the first dry-run week; API-Football adapter in T15 |
| Late-game prices of $0.94–$0.98: one loss erases ~16–49 wins (more after fees) | Strategy can be net negative even at a 95 % win rate; these markets are liquid and efficient (a settled NHL game checked on 2026-09-25 traded ~290k contracts per side) | Expect near-zero or negative EV until proven otherwise; implied-vs-actual chart, `maxPrice`, exact backtests, dry run → demo → prod with `maxStakeUsd` ≤ $5 |
| Score feed lags the market (buying right after the opponent scores) | Adverse selection | `maxFeedAgeSec`, optional `minPrice`, feed cross-check for NHL, snapshot timestamps on every trade |
| Thin orderbooks | Partial fills or none | `minDepthContracts`, IOC orders, retry within the window, partial fills recorded honestly |
| Kalshi API changes (V2 orders, fixed-point fields, open `details` schema) | Breakage | Zod-validated payloads that fail loudly; client pinned to an `openapi.yaml` version; changelog watch |
| Fee rounding differs from the model | Dry-run P&L off by up to ~1¢ per order | `fee_balance_precision_micros` setting; T13 checks real fills |
| Exchange pauses (Thursday 03:00–05:00 ET, rare outages) | Orders rejected | `GET /exchange/status` guard (soft, retried) |
| Regulatory / account terms | Kalshi restricts some jurisdictions and automated behaviour patterns | Only your own account and key; read Kalshi's API terms; personal tool, not a service |
| Feed team-name mismatch | Wrong market bought | Kalshi live data keyed by milestone → market (no name matching) by default; alias table for NHL; trade snapshot shows both names |

### Decisions

| Date | Question | Decision |
| --- | --- | --- |
| 25 Sep 2026 | Soccer leagues in v1 | EPL, La Liga, Bundesliga, Serie A, Ligue 1 (plus NHL); Champions League dropped |
| 25 Sep 2026 | Dry-run bankroll | One shared virtual bankroll for all dry-run trades (default $100, resettable) |
| 25 Sep 2026 | Daily loss limit / trades-per-day cap | Dropped; switches, `maxStakeUsd`, order group and subaccount remain |
| 25 Sep 2026 | TOTP | Optional, off at launch, can be enabled later |
| 25 Sep 2026 | Home Assistant notifications | Later (T15) |
| 25 Sep 2026 | Backtest history source | NHL Web API + Kalshi candles + archived live timelines + Kalshi play-by-play (if usable); soccer older seasons via CSV; API-Football deferred |
| 25 Sep 2026 (review) | Kill switch semantics | Two global switches: **kill switch** (pause everything, no outgoing HTTP) and **dry run** (keep APIs, no real orders, log results). Live strategies pause under the kill switch and run as dry run under global dry run. |
| 25 Sep 2026 (review) | Per-strategy controls | Each strategy has its own kill switch (replaces `enabled`) and its own dry-run/live mode |
| 25 Sep 2026 (review) | Mode labelling | Every trade, log line, metric, chart and export distinguishes live from dry run; never aggregated together |
| 25 Sep 2026 (review) | Outer lock | `allow_live_orders` add-on option, default false |
| 25 Sep 2026 (review) | Tunnel | `cloudflared` as a Home Assistant app on the Pi; port 8099 unmapped |
| 25 Sep 2026 (review) | Blocked entries | Retry every tick until the window closes (soft guards); hard guards end the entry |
| 25 Sep 2026 (review) | NHL scope | Regular season and playoffs; preseason excluded (per-league setting) |
| 25 Sep 2026 (review) | Units | Money in micro-dollars, prices in $0.0001, counts in centi-contracts |

### Build order (each step usable on its own)

1. **Skeleton + security** (T01–T05): scaffold, schema, auth, UI shell with switches, HA packaging. Nothing trades.
2. **Kalshi client + feeds** (T06–T07): discovery, live data, replay, live dashboard cards.
3. **Engine + dry run** (T08–T09): strategies, guards, retries, dry-run fills, settlement, trades page. Run for a week.
4. **Analytics + backtesting** (T10–T12).
5. **Live mode** (T13): order groups, subaccount, recovery, reconciliation; one match day on demo, then prod with small `maxStakeUsd`.
6. **Hardening + release** (T14), then **extras** (T15).

## 14. Implementation plan

Fifteen tickets, implemented strictly in order by one developer agent (Opus 5.5), one ticket per session. Each ticket leaves `petrapa6/sports-trading` in a deployable state, ends with a passing `npm test`, and has **acceptance criteria the agent can verify on its own machine** — the Home Assistant OS deployment is done by hand after T14, so no criterion assumes a Pi. T01–T05 produce a secured, deployable shell that trades nothing; T06–T09 make dry run work; T10–T12 add analytics and backtesting; T13 turns on live trading; T14–T15 harden and extend.

### Repositories and references

- **Target repository:** `petrapa6/sports-trading`. Its root is the Home Assistant app repository (layout in §11); the Node project lives in `kalshi-trader/app/`. This document is committed at the root as `SPEC.md`.
- **Reference app:** the owner's *Family Dashboard*, another Home Assistant app already running on the same HAOS host. Everything this project needs from it is recorded under **Reference app facts** below; agents do not read that repository. Where it and this spec disagree, **this spec wins**.
- **Spec is the source of truth.** Any deviation discovered during a ticket is written into `SPEC.md` in the same commit.

### Reference app facts

*Family Dashboard* (Next.js 16 + Prisma 7 + SQLite via `better-sqlite3`, app version 1.0.37, packaging read on 2026-09-25) runs on the same Raspberry Pi 5 under HAOS. The table records what it does and what this app does with it. "Adopt" items are binding for T01/T05; "Differs" items are listed only so no one "fixes" this app to match the reference.

| Topic | Family Dashboard | This app |
| --- | --- | --- |
| Repository shape | Repo root **is** the single app: `config.yaml`, `Dockerfile`, `run.sh`, `DOCS.md`, `repository.yaml` at the root; Next.js project in `app/` | Differs: app repository with the app in `kalshi-trader/` and the Node project in `kalshi-trader/app/` (§11) |
| `repository.yaml` | Three keys: `name: Family Dashboard`, `url: <its GitHub URL>`, `maintainer: Pavel` | Adopt: same three keys — `name: Kalshi Sports Trader`, `url: https://github.com/petrapa6/sports-trading`, `maintainer: Pavel` |
| `config.yaml` style | String values quoted (`name: "Family Dashboard"`, `version: "1.0.37"`); has a `url` key; `arch: [aarch64, amd64]`; `startup: application`; `boot: auto`; secrets as `password`, optional keys as `str?` | Adopted into §11: the `url` key. Quoting is optional (YAML-equivalent) |
| Slug | `family_dashboard` (underscore) | Differs: `kalshi-trader` (§11 is explicit; hyphens are valid) |
| Ports / ingress | No ingress; `ports: 8099/tcp: 8099` — **host port 8099 on the Pi is taken by Family Dashboard** | Differs: ingress on 8099, `ports: 8099/tcp: null`. If the port is ever mapped (cloudflared outside HA), it must use another host port (e.g. 8100) — `DOCS.md` says so |
| Storage | `map: [data:rw]` (legacy string syntax); DB at `/data/dashboard.db` (`DATABASE_URL=file:/data/dashboard.db` exported in `run.sh`; dev fallback `file:./data/dashboard.db`); uploads in `/data/uploads`; nothing under `/share` | Adopt: everything in the app's own `/data`, no `map` entry; DB at `/data/db/trader.db` (subdirectory so `/data` and `options.json` stay root-owned, §11). The connection helper creates the directory itself (T02) because `better-sqlite3` does not |
| Backups | Relies on HA backups (which include the app's `/data`) plus the **Google Drive Backup** app (`sabeechen/hassio-google-drive-backup`) for nightly off-site copies; no custom backup scripts | Adopt: same — HA backups of the app plus the Google Drive Backup app; T14 checklist item 5 verifies it |
| Base image | `node:20-alpine`, 3 stages (`builder`, `prisma-deps`, `runner`); `apk add python3 make g++` in build stages to compile `better-sqlite3`/`bcrypt`; runtime adds `bash sqlite jq tini`; `ENTRYPOINT ["/sbin/tini","--"]`; runs as root; `EXPOSE 8099`; no `HEALTHCHECK`, no `io.hass.*` labels | Differs: pinned `ghcr.io/home-assistant/base` for both stages, Docker `init: true`, non-root (§11). No tag to copy — T05 picks it. Adopt: the same native-build toolchain (`python3 make g++`) in the build stage only |
| `build.yaml` | Present but legacy: `build_from: aarch64: ghcr.io/home-assistant/aarch64-base:3.19` (ignored, the Dockerfile has an explicit `FROM`) and labels `org.opencontainers.image.title` / `org.opencontainers.image.source` | Differs: no `build.yaml` (§11). Adopt: the two OCI labels, moved into the Dockerfile `LABEL` (§11) |
| `run.sh` | `#!/usr/bin/env bash`, `set -euo pipefail`; reads `/data/options.json` with `jq -r '.key // empty'`; exports env; fails fast (`exit 1`, message on stderr prefixed `[dashboard] ERROR:`) when a required secret is empty; `mkdir -p` data dirs; runs DB migrations before start (a failed migration exits 1, so the app never starts on a half-migrated DB); `exec node server.js` | Differs: `bashio` + fd-3 key hand-over (§11). Adopt: `set -e`-style fail-fast, prefixed stderr messages (`[kalshi-trader] ERROR: …`), migrations before the server listens (done in Node, T02), `exec` so Node receives signals |
| Translations | None | Differs: `translations/en.yaml` (§11) |
| `DOCS.md` | Sections *Configuration* (table `Option \| Description`), *Features*, *Data Storage* (paths), *Backup* | Adopt: an options table in the same `Option \| Description` form, plus *Data Storage* and *Backup* sections, alongside the T05 headings |
| `.dockerignore` | Excludes `.git`, `node_modules`, build output, `.env*`, local data, `*.md` except `!DOCS.md` | Adopt the `*.md` / `!DOCS.md` pattern on top of §10's secret paths |
| CI | No `.github/workflows`; checks run locally via a `Makefile` | Differs: `ci.yml` / `image.yml` (§11, §12) |
| Local image builds | `docker buildx build --builder haos-builder --platform linux/amd64 --load` for local runs; arm64 cross-build under QEMU exported as a tarball (`--output type=docker,dest=<name>-arm64.tar.gz`), copied with `scp -P 22222 … root@<pi>:/root/` and loaded with `ssh -p 22222 root@<pi> 'docker load < …'` for manual Pi tests | Adopt: **never run `docker buildx use <builder>`** (it changes the global default and breaks other projects on the same machine); pass `--builder <name>` on each `docker buildx build`. The tarball route is optional for manual Pi tests (T14) |
| Remote access | Cloudflare Tunnel + Cloudflare Access email gate for its two users; login rate limit; HSTS/CSP/X-Frame-Options headers | Same Cloudflare account and approach (§10 Tunnel); this app gets its own hostname and Access policy |
| Versioning | `version` in `config.yaml` bumped per release; no `CHANGELOG.md` | Differs: `config.yaml` = `package.json` version, `CHANGELOG.md` (§11) |

### Local verification environment

| Tool | Used for |
| --- | --- |
| `npm test` (Vitest) | Unit and integration tests; `msw` mocks every external HTTP call with recorded fixtures under `test/fixtures/` |
| `npm run dev` + `curl` | HTTP-level checks against the running app on `:8099` |
| `npm run e2e` (Playwright, headless Chromium) | Browser checks in `test/e2e/` at 1280 px and 390 px, asserting zero CSP violations in the console |
| `docker compose up --build` | The production image on amd64 with `./.local/data` mounted as `/data`, read-only root |
| `docker buildx build --platform linux/arm64` | Proves the Pi image (incl. native `better-sqlite3`) builds; QEMU is enough |
| `npm run verify:TXX` | One script per ticket running that ticket's automatable acceptance checks, printing PASS/FAIL per item; manual items are listed in `docs/verification/TXX.md` with exact steps and observed results |
| Kalshi **demo** environment | Optional: with a demo key path in `config.local.json` (never committed), smoke scripts run against demo; without it every Kalshi test runs on fixtures and smoke scripts print `SKIPPED (no demo key)` |
| `npm run replay` | Plays back recorded feed snapshots at up to 100× |
| Fake timers (`vi.useFakeTimers`) | Every time-dependent rule is tested by advancing a fake clock, never by sleeping |

### Definition of done (every ticket)

- Everything under **Scope** is implemented as described in the referenced sections; nothing under **Out of scope** is started.
- Every **Acceptance** item passes; `npm run verify:TXX` is green and `docs/verification/TXX.md` exists with manual steps and observed results.
- **Acceptance boxes are ticked in `SPEC.md`:** the implementing agent changes `- [ ]` to `- [x]` for every Acceptance item it actually ran and saw pass, in the same branch as the ticket's code. An item that was not run, failed, or could not be verified on the agent's machine stays `- [ ]`, with a one-line reason in the ticket's **Implementation notes**. Never tick an item on the strength of reasoning alone.
- `npm run lint && npm run typecheck && npm test && npm run e2e` pass locally and in CI on the pushed branch.
- No secret, `.env` file, key or database lands in git (`gitleaks` clean); `npm audit --audit-level=high` clean.
- Money, prices and counts use the integer units from the conventions table; no floating point in money paths (lint rule or test).
- From T08 on: every trade, attempt, trading log line, audit row, stat and chart touched by the ticket carries its mode (`live` / `dry_run`) and nothing aggregates across modes.
- `CHANGELOG.md` gets an entry; any deviation from the spec is written into `SPEC.md`.
- From T05 on, `docker compose up --build` reaches a healthy container and the arm64 image builds in CI.

### Ticket overview

| # | Ticket | Spec sections | Depends on |
| --- | --- | --- | --- |
| T01 | Repository scaffold, config, tooling, CI | §4, §10 Secrets, §12 | — |
| T02 | SQLite schema, migrations, repositories, maintenance | §7 | T01 |
| T03 | Request classes, authentication, sessions, HTTP hardening, audit log | §10 | T02 |
| T04 | Web UI shell, filter bar, switches, Settings skeleton, SSE | §1 Switches, §8, §4 Live status | T03 |
| T05 | Home Assistant app packaging (local verification only) | §11, §10 Tunnel/Container, §12 | T04 |
| T06 | Kalshi API client, network gate, market discovery | §2, §3 Discovery | T02 |
| T07 | Score feeds, GameTracker, Scheduler, replay, live cards, timeline archive | §3 Live state, §4 | T06 |
| T08 | Strategy model, effective mode, engine, Strategies page | §1 Switches, §5, §8 | T07 |
| T09 | Executor, guards, retries and Settler in dry run; Trades page | §5 Guards/Sizing, §6, §8 | T08 |
| T10 | Stats endpoint and Recharts dashboard, split by mode | §6 Metrics, §8 | T09 |
| T11 | Historical importers, candle collector, backfill, price model | §3 Historical, §7, §9 | T06, T07 |
| T12 | Backtest simulator and Backtest page | §9, §8 | T08, T09, T11 |
| T13 | Live trading path: orders, order group, subaccount, recovery, reconciliation | §2, §4 Invariants, §6, §10 Blast radius | T09 |
| T14 | Hardening, operations, v1.0.0, HAOS hand-over checklist | §10, §11, §12 | T13 |
| T15 | API-Football adapter, HA notifications, extra rule parameters | §3, §13 | T14 |

### T01 — Repository scaffold, config, tooling, CI

**Goal:** a runnable Node.js 22 / TypeScript / ESM project with Fastify serving `/healthz`, plus every guard that keeps secrets out of git.

**Scope**
- Record in `docs/decisions/0001-conventions.md` which conventions are adopted (from §11 and §14 Reference app facts).
- Commit this document as `SPEC.md` at the repository root.
- Layout from §4 under `kalshi-trader/app/`; `package.json` (`"engines": {"node": ">=22"}`) with `dev`, `build`, `test`, `e2e`, `lint`, `typecheck`, `audit:security`, `verify:T01` scripts; committed lockfile.
- Fastify 5 app factory (`server/app.ts`) with Pino JSON logging and `GET /healthz` returning `{"ok":true}`; `server/main.ts` entrypoint.
- `core/decimal.ts` with exact converters: `dollarsToBp("0.9300") = 9300`, `dollarsToMicros("0.007896") = 7896`, `fpToCc("1.55") = 155`, and the reverse formatters (`bpToDollars(9400) = "0.9400"`, `ccToFp(200) = "2.00"`); inputs with more precision than the target unit throw.
- Config loader (`config.ts`): Zod schema for `KALSHI_ENV`, `KALSHI_KEY_ID`, private key source (`KALSHI_PRIVATE_KEY_FD` or `kalshiPrivateKeyPath` in `config.local.json`), `KALSHI_SUBACCOUNT`, `ALLOW_LIVE_ORDERS`, `LOG_LEVEL`, `DATA_DIR`, `DB_PATH`, `PORT`, `TRUSTED_PROXIES`, `TZ`; env vars first, then `config.local.json`; fails fast naming the offending key; Kalshi credentials optional until T06 (one `warn` if absent). `config.local.example.json` committed with empty values.
- `.gitignore` (`*.key`, `*.pem`, `config.local.json`, `*.db*`, `.local/`, `node_modules`, `dist`), `.dockerignore` with the same, `gitleaks` pre-commit hook (`lefthook`) and `.gitleaks.toml`.
- Vitest, Playwright (Chromium), ESLint (incl. a rule or test forbidding `parseFloat`/`Number()` on `*_dollars` fields) + Prettier, strict `tsconfig`; `test/e2e/` smoke spec hitting `/healthz`.
- GitHub Actions `ci.yml`: lint, typecheck, test, e2e, `npm audit --audit-level=high`, `gitleaks`.
- `README.md` with local run instructions from §12; `docs/verification/` folder.

**Out of scope:** DB, auth, UI, Docker.

**Acceptance (verify locally)**
- [x] Fresh clone on Node 22: `npm ci && npm run lint && npm run typecheck && npm test && npm run e2e` all exit 0.
- [x] `npm run dev` then `curl -s localhost:8099/healthz` returns exactly `{"ok":true}` within 5 s; every stdout line is valid JSON (`| jq -e . >/dev/null`).
- [x] `PORT=abc npm run dev` exits non-zero within 2 s with a message containing `PORT`; `LOG_LEVEL=nope` likewise names `LOG_LEVEL`; `ALLOW_LIVE_ORDERS=maybe` names `ALLOW_LIVE_ORDERS`.
- [x] With no `config.local.json` and no Kalshi settings the app starts and logs exactly one `warn` about missing Kalshi credentials; `ALLOW_LIVE_ORDERS` defaults to `false`.
- [x] `config.local.json` `{"port": 8123}` is honoured; env `PORT=8124` overrides it.
- [x] Decimal tests: the examples above pass; `dollarsToBp("0.93005")` throws; `fpToCc("1.555")` throws; round-trip of 1 000 random values is exact.
- [x] Secret hook: on a scratch branch, committing a file containing `-----BEGIN RSA PRIVATE KEY-----` is rejected; `config.local.json` and `foo.db` are ignored by `git status`.
- [x] `docs/decisions/0001-conventions.md` lists at least slug convention, `map` entries, base image tag, DB path handling, with their source (§11 or §14 Reference app facts); `SPEC.md` exists at the root.
- [x] Branch pushed; the GitHub Actions run is green (URL recorded in the verification doc).

**Implementation notes (T01, deviations and clarifications)**
- The reference app could not be read in the T01 session, so `docs/decisions/0001-conventions.md` was written from §11 alone. Its facts have since been inlined into §14 (Reference app facts); T05 applies the "Adopt" rows and updates the decision record — no access to the reference repository is needed.
- `config.local.json` keys are the camelCase names of the settings (`port`, `logLevel`, `allowLiveOrders`, `kalshiPrivateKeyPath`, …); unknown keys are rejected. `CONFIG_LOCAL_PATH` (env) selects another file; default `./config.local.json` in `kalshi-trader/app`. Empty environment variables count as unset (`run.sh` exports blank options). `LOG_LEVEL` accepts `debug|info|warn|error` as in `config.yaml`.
- `npm run dev` (`scripts/dev.ts`) validates the configuration before starting `tsx watch`, so an invalid setting exits non-zero instead of leaving a watcher running. `kalshi-trader/app/.npmrc` sets `loglevel=silent` so npm's script banner does not break "every stdout line is JSON"; CI passes `--loglevel=warn` to `npm ci` / `npm audit`.
- `lefthook.yml` and `.gitleaks.toml` live at the repository root (the git root); the hook is installed by the app's `prepare` script. `.gitleaks.toml` extends the default rules with a rule for a bare PEM private-key header (the built-in rule needs a full key body) and allow-lists `SPEC.md`, which quotes such a header. The hook also refuses force-added key/PEM/`config.local.json`/database/`.env` files, and falls back to a built-in private-key check (with a warning) if `gitleaks` is not installed. `.env` / `.env.*` are git-ignored as well.
- `docs/` (decisions, verification) lives at the repository root.

### T02 — SQLite schema, migrations, repositories, maintenance

**Goal:** the complete §7 schema under Drizzle, with typed repositories the rest of the app uses instead of raw SQL.

**Scope**
- `better-sqlite3` connection helper: WAL, `foreign_keys=ON`, `busy_timeout=5000`, creates the `DB_PATH` directory if missing (`run.sh` also creates it; the helper must not rely on that, so local runs work too).
- Drizzle schema for every table in §7 (including `trade_attempts`, `bankroll_snapshots`, `settings`, `hist_*`, `backtests`, `backtest_trades`); initial migration; migrations on start-up; `npm run db:migrate`, `db:migrate:down`, `db:studio`.
- Repositories with typed methods for every table; `settings` typed `get`/`set` with the §7 defaults (`global_kill_switch=false`, `global_dry_run=true`, `dry_run_bankroll_micros=100000000`, `dry_run_initial_bankroll_micros=100000000`, `fee_balance_precision_micros=100`, `order_group_contract_limit=200`).
- Money/price/count columns validated as safe integers in the repository layer.
- Seed migration: the six leagues with series `KXNHLGAME`, `KXEPLGAME`, `KXLALIGAGAME`, `KXBUNDESLIGAGAME`, `KXSERIEAGAME`, `KXLIGUE1GAME`, all `enabled=1`, `include_preseason=0`.
- `core/maintenance.ts`: `wal_checkpoint(TRUNCATE)` at 02:30 local (`TZ`) and pruning of `game_snapshots` older than 90 days **for games with `timeline_archived = 1`**; schedule computed with an injectable clock.
- `/healthz` opens the DB and runs `SELECT 1`.

**Out of scope:** business logic.

**Acceptance (verify locally)**
- [x] `rm -rf .local && DB_PATH=./.local/data/db/trader.db npm run dev` creates the directory, `trader.db` and `trader.db-wal`; `PRAGMA journal_mode` is `wal`; `PRAGMA foreign_keys` in the app connection is 1 (test).
- [x] `.tables` lists exactly: `leagues teams games markets game_snapshots strategies strategy_versions trades trade_attempts balance_snapshots bankroll_snapshots audit_log users sessions login_attempts settings hist_games hist_prices backtests backtest_trades` plus Drizzle's migration table.
- [x] Restarting against the same file applies no migration and logs no error; `SELECT count(*) FROM leagues` = 6, all with a non-empty `kalshi_series` and `enabled=1`.
- [x] Repository tests: two `trades` rows with the same `(strategy_id, game_id)` → `UNIQUE` error; two `trade_attempts` with the same `client_order_id` → `UNIQUE` error; `settings.get('global_dry_run')` → `true` and `settings.get('global_kill_switch')` → `false` on an empty table; `set`/`get` round-trips JSON; every repository has at least one CRUD test.
- [x] Inserting `stake_micros: 12.5` or `fill_cc: "200"` fails validation.
- [x] Maintenance (fake timers): 100 snapshots aged 91 days of an archived game, 50 aged 91 days of a non-archived game, 10 aged 89 days → after the 02:30 tick 60 remain; `wal_checkpoint` is called once per day (spy).
- [x] `db:migrate:down` then `db:migrate` on a seeded DB succeeds with unchanged row counts.
- [x] `/healthz` returns `503 {"ok":false,"db":"…"}` when `DB_PATH` points to an unwritable directory.

**Implementation notes (T02, deviations and clarifications)**
- Migrations live in `kalshi-trader/app/migrations/` (drizzle-kit output: `0000_initial_schema.sql`, `0001_seed_leagues.sql`, `meta/`), outside `src/` so `src/db` and `dist/db` resolve them the same way; T05's Dockerfile must copy this folder into the image. Drizzle has no down migrations, so each migration has a hand-written `migrations/down/<tag>.sql`; `db:migrate:down` runs it and removes the row from `__drizzle_migrations` in one transaction (default one step; `-- --steps N`, `-- --all`). `npm run db:generate` (drizzle-kit) was added for future schema changes.
- The seed migration uses `INSERT OR IGNORE`; its down migration deletes the six leagues and fails (changing nothing) while teams or games still reference them. `feed_ids` is seeded as `{"apiFootball": <id>, "nhl": null}` with the API-Football league ids (EPL 39, La Liga 140, Bundesliga 78, Serie A 135, Ligue 1 61; NHL `null`); T07/T15 may refine it.
- Drizzle emits `UNIQUE` constraints as unique indexes (`trades_strategy_game_unique`, `trade_attempts_client_order_id_unique`, …) and the `mode` check as a named `CHECK` constraint; behaviour matches §7. Schema property names are the snake_case column names.
- Repository validation is derived from the table definition: every INTEGER column (so every `*_micros`, `*_bp`, `*_cc`) must be a safe integer, every TEXT column a string, unknown keys are rejected; NOT NULL is left to SQLite. `fee_balance_precision_micros` accepts any positive divisor of 1 000 000 (100 and 10 000 in practice).
- Start-up vs. `/healthz`: migrations run before the server listens and a failed migration exits 1, but a database that cannot be *opened* (unwritable or missing directory) does not stop the server — it logs an `error`, `/healthz` returns `503 {"ok":false,"db":"<code>"}` (an error code such as `SQLITE_CANTOPEN` or `ENOTDIR`, never a path) and each probe retries the open, so the app recovers without a restart. Without this, the 503 acceptance item could not be observed.
- Root ignores directory permissions, so on a root machine the unwritable directory is simulated with a regular file in place of the directory; the `chmod 555` variant is a unit test that runs on the non-root CI runner (skipped as root).
- Maintenance runs at 02:30 in the process time zone (`TZ`, else the system zone). On the autumn DST change it runs once, at the second 02:30; on the spring change (02:30 does not exist) it runs once just after the gap.

### T03 — Request classes, authentication, sessions, HTTP hardening, audit log

**Goal:** every route except `/login`, `/setup` (first run), `/healthz` and static assets requires a valid session; all §10 controls are in place.

**Scope**
- `server/requestClass.ts`: classify each request as `ingress`, `tunnel`, `dev` or `other` per §10 (ingress peer `172.30.32.2` configurable for tests; `TRUSTED_PROXIES` CIDR list); resolve the client IP.
- `@fastify/helmet` with the §10 CSP; framing headers per class; `@fastify/rate-limit` (300/min per client IP, assets and SSE exempt; `/login` 5/min); `@fastify/cookie`; server-side sessions in `sessions` (hashed id, per-channel cookie name/path/flags, 12 h idle, 7 d absolute, rotation on login); `@fastify/csrf-protection`.
- First-run `/setup` creating the single user with argon2id (m=64 MiB, t=3); only while `users` is empty and only for class `ingress` or `dev`.
- Login with a constant-time failure path; lockout (class `tunnel`/`other` only) after 10 failures per client IP or per username in 15 min, doubling thereafter; `login_attempts` written with channel.
- Step-up: `requireRecentAuth(5 min)` decorator using `sessions.last_auth_at`; `POST /auth/reauth`.
- TOTP: `otplib` enrol/verify/disable routes; off by default; 10 recovery codes shown once and stored hashed.
- `audit_log` writer (actor, IP, channel, mode) used for login, failed login, lockout, logout, password change, session revoke, TOTP changes.
- `${DATA_DIR}/secret.key` (mode 600) generated on first start; `encryptSetting`/`decryptSetting` (AES-256-GCM, key derived with HKDF from it).
- Correlation-id error handler; no stack traces in responses.

**Out of scope:** React pages (JSON endpoints plus a minimal server-rendered login/setup form).

**Acceptance (verify locally, `test/security/*.test.ts` + curl)**
- [x] Classification table test: peer `172.30.32.2` + `X-Ingress-Path` → `ingress`; peer `172.30.33.5` + `CF-Connecting-IP: 198.51.100.7` → `tunnel` with client IP `198.51.100.7`; peer `10.0.0.9` + `CF-Connecting-IP` → `other` with client IP `10.0.0.9`; peer `172.30.32.2` + `CF-Connecting-IP` → `tunnel`; loopback in development → `dev`, loopback in production → `other`.
- [x] `curl -i localhost:8099/api/anything` → `401 {"error":"unauthorized"}`; `/healthz` and `/login` reachable without a session.
- [x] Setup: empty `users` + class `ingress` → user created; second call → `410`; class `tunnel` → `403`.
- [x] Lockout (tunnel): 10 wrong passwords for `alice` → the 11th with the correct password is `429`; `login_attempts` has 11 rows; `audit_log` has a `lockout` row; +15 min (fake timers) → success; a second lockout lasts 30 min. The same 10 failures via `ingress` → no lockout, the correct password succeeds.
- [x] Timing: over 200 iterations, median response time for unknown username vs wrong password differs by < 20 %.
- [x] Tunnel login `Set-Cookie`: `kst_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Ingress login with `X-Forwarded-Proto: http`: `kst_session_ingress`, `Path=/api/hassio_ingress/abc`, no `Secure`; with `https`: `Secure`. The session id after login differs from any earlier id; +12 h 1 min idle → `401`; hourly activity but +7 d 1 min total → `401`.
- [x] `POST /api/settings` without the CSRF token → `403`; with the token from `GET /api/csrf` → `200`.
- [x] A `requireRecentAuth` route returns `403 {"error":"reauth_required"}` when the last authentication is 5 min 1 s old and `200` after `POST /auth/reauth`.
- [x] Headers on `/`: CSP contains `default-src 'self'` and no `unsafe-inline` for scripts; `referrer-policy: no-referrer`; for `tunnel`: `x-frame-options: DENY` and `frame-ancestors 'none'`; for `ingress`: `x-frame-options: SAMEORIGIN` and `frame-ancestors 'self'`.
- [x] `secret.key` mode is `600`; deleting it and restarting makes every existing session `401`.
- [x] `encryptSetting('abc')` ≠ `abc`, `decryptSetting` returns `abc`, decrypting with a different key throws.
- [x] TOTP: enrol returns an `otpauth://` URI; a code generated from its secret verifies; afterwards login without a code → `401 {"error":"totp_required"}`; disable restores password-only login; each of the 10 recovery codes works exactly once.
- [x] Rate limit: 301 requests to `/api/csrf` within a minute from one client IP → the 301st is `429`; 300 asset requests are not limited; 6 `/login` requests → the 6th is `429`.
- [x] Error responses are `{"error":"internal","correlationId":"…"}` with the same id in one log line; no response body in the whole test run contains stack frames.

**Implementation notes (T03, deviations and clarifications)**
- `buildApp` is now `async` (plugins are awaited in order so classification runs before helmet). Static assets live in `kalshi-trader/app/public/assets/` (outside `src/`, like `migrations/`) and are served at `/assets/`; T05's Dockerfile must copy `public/`. Until the React shell (T04) there are minimal server-rendered pages: `/login`, `/setup` and a signed-in placeholder at `/` (no inline scripts or styles; relative links so they work under the ingress prefix).
- Endpoints: `GET/POST /login`, `GET/POST /setup` (JSON or HTML form), `POST /auth/logout`, `POST /auth/reauth`, `GET /auth/me`, `POST /auth/password` (step-up; revokes the user's other sessions), `GET /auth/sessions`, `POST /auth/sessions/:id/revoke`, `POST /auth/totp/enrol` (step-up), `POST /auth/totp/confirm`, `POST /auth/totp/disable` (step-up), `GET /api/csrf`, `GET/POST /api/settings` (only `order_group_contract_limit` is writable so far; switches and bankroll reset come with step-up in T04). Unknown paths require a session first (`401`), then `404`.
- Classification: `X-Ingress-Path` must look like `/api/hassio_ingress/<token>`, otherwise the request is not `ingress` (the value becomes a cookie `Path`). The ingress client IP is the last `X-Forwarded-For` hop (what the Supervisor saw), else the peer. `npm run dev` sets `NODE_ENV=development` when unset, so loopback requests are class `dev`; `npm start` and the e2e server are production (`other`).
- Sessions: the cookie value is the opaque id signed with an HMAC key derived (HKDF) from `secret.key`, so a new `secret.key` invalidates every cookie; on generating a new key `main.ts` also deletes all `sessions` rows and writes `secret_key_generated` to `audit_log`. Cookies carry `Max-Age` = 7 days; class `dev` cookies omit `Secure` (plain http on localhost). An ingress session is only accepted via ingress and vice versa. Every key (`cookie`, `csrf`, `settings`) is derived from `secret.key` with HKDF-SHA256; `encryptSetting` output is `v1:<base64url(iv ‖ tag ‖ ciphertext)>`. `secret.key` is `${DATA_DIR}/secret.key`; T05's `run.sh` must set `DATA_DIR=/data/app` to match §10.
- CSRF: `@fastify/csrf-protection` in cookie mode (secret cookie `kst_csrf`, signed, same per-channel path/flags as the session cookie) with the token HMAC-bound to the session (`userInfo` = session hash), so it is per-session. Sent as `x-csrf-token` (or `_csrf` in a form). `/login` and `/setup` are exempt (no session yet).
- Lockout: failed attempts on `tunnel`/`other` only, counted per client IP and per username since max(now − 15 min, end of the previous lockout of that key); lockouts are persisted as `audit_log` rows (`action='lockout'`, `entity` `ip`|`username`, `detail.until`), so they survive restarts. A lockout doubles when an earlier one for the same key started within 24 h (cap 24 h). Attempts during a lockout are recorded (`ok=0`, audit `login_blocked`) but do not extend it. Failed `POST /auth/reauth` counts like a failed login. Usernames are stored lower-case; passwords need ≥ 12 characters.
- Constant-time failure: an unknown username is verified against a dummy argon2id hash with the same parameters; both failures return `401 {"error":"invalid_credentials"}`. Measured medians: 89.3 ms vs 88.5 ms (1.0 %). All other tests use cheap argon2 parameters; the timing test and the hash-format check use the real m = 64 MiB, t = 3.
- TOTP: `enrol` keeps the new secret in memory for 10 minutes until `confirm` with a valid code enables it (secret stored with `encryptSetting`) and returns the 10 recovery codes once. Codes are accepted ±30 s and a code's time step cannot be reused (in-memory, per user). Login with TOTP on: `totp` or `recoveryCode` in the body, else `401 {"error":"totp_required"}`. The QR code is rendered from the `otpauth://` URI by the Settings page (T04).
- Headers: helmet CSP without `upgrade-insecure-requests` (ingress is often plain http on the LAN); `X-Frame-Options` and `frame-ancestors` per class; HSTS only for `tunnel`. Rate limits are keyed on the resolved client IP; `/login` has its own 5/min bucket per method; `/healthz` is not exempt. 429 bodies are `{"error":"rate_limited","retryAfterSeconds":n}` (lockout: `{"error":"locked_out",…}` plus `Retry-After`).
- Errors: 4xx return a stable code (`bad_request` with Zod `issues`, `csrf`, `payload_too_large`, `not_found`, …); anything else returns `{"error":"internal","correlationId"}`, where the correlation id is the request id (also `correlationId` on every request log line). A database that is unavailable returns `503 {"error":"unavailable"}`.
- Tests: the lockout and rate-limit tests fake `Date` only (`vi.useFakeTimers({ toFake: ['Date'] })`) and space `/login` calls 13 s apart so the 5/min limit does not mask the lockout; the timing test raises the rate limits. The test client fails any response whose body contains a stack frame.

### T04 — Web UI shell, filter bar, switches, Settings skeleton, SSE

**Goal:** the React application with routing, layout, the shared filter bar with mode handling, the global switches, and the Settings pages that do not depend on trading.

**Scope**
- Vite + React 19 + TanStack Query + TanStack Table + Recharts; production build served by Fastify from `/`; dev proxy to `:8099`; `X-Ingress-Path`-aware base path.
- Layout from §8: dark/light aware, phone-first; navigation to Dashboard, Strategies, Trades, Backtest, Settings; placeholder pages.
- Login and first-run setup pages (username, password, optional TOTP, generic error, lockout notice).
- Shared filter bar with URL-synced state: sport, leagues, strategies, **mode (live / dry run / both)**, Kalshi environment, date range presets.
- `ModeBadge` component (`LIVE`, `DRY RUN`, `LIVE → DRY RUN (global)`, `LIVE → DRY RUN (add-on lock)`) and the shared chart style tokens (live solid, dry run dashed/hatched) used by every later ticket.
- `GET /api/live` SSE: heartbeat every 10 s, switch states, last 50 log lines from a ring buffer fed by Pino (each with its `mode` field or `null`); React hook with reconnect.
- Settings → **Trading**: global kill switch and global dry run toggles (`settings.global_kill_switch`, `settings.global_dry_run`; step-up to turn either off; audit rows), read-only display of `allow_live_orders`, Kalshi env and subaccount.
- Settings → Account (change password with step-up, TOTP enrol/disable, sessions with revoke) and Diagnostics (log tail with mode filter, app version, DB path and size).

**Out of scope:** charts with data, strategies, trades, backtest content.

**Acceptance (verify locally, Playwright `test/e2e/shell.spec.ts`)**
- [x] `npm run build` emits `dist/web/index.html`; `curl -I localhost:8099/` → `200 text/html`; hashed assets → `200` with `cache-control: public, max-age=31536000, immutable`.
- [x] e2e at 1280 px and 390 px: setup → login → Dashboard placeholder → each nav item renders its heading → logout returns to `/login`; at 390 px `document.documentElement.scrollWidth <= 390` on every page.
- [x] Zero console messages matching `Content Security Policy` during the whole e2e run.
- [x] Filter bar: selecting league `epl`, mode `live` and preset `30d` yields `?leagues=epl&mode=live&range=30d`; reload restores it; back restores the previous state; default mode is `both`.
- [x] `curl -N` on `/api/live` prints `event: heartbeat` at least every 15 s and an initial `event: logs` with ≤ 50 entries each having a `mode` key; killing and restarting the dev server shows "reconnected" within 10 s without reload.
- [x] Switches: turning the global kill switch **on** needs no prompt, persists across reload and writes `audit_log` `global_kill_switch_on`; turning it **off** without recent re-auth opens the password prompt; the same for global dry run (off requires step-up; on does not). The Trading page shows `allow_live_orders: false` as a locked, read-only item.
- [x] Account: wrong current password → inline error; correct → success and the old password no longer works; TOTP enrol shows a QR image and a code generated from the shown secret enables it; revoking a second session (second browser context) logs that context out on its next request.
- [x] Ingress: `curl -H 'X-Ingress-Path: /api/hassio_ingress/abc'` (from the ingress test peer) returns HTML whose asset URLs and `<base href>` start with `/api/hassio_ingress/abc/`; e2e under that header navigates all pages without 404s.
- [x] Diagnostics shows app version from `package.json`, DB path, DB size in MB, and live-updating log lines; the mode filter `dry_run` hides lines whose mode is not `dry_run`.
- [x] `ModeBadge` renders the four variants (component test with snapshots).

**Implementation notes (T04, deviations and clarifications)**
- Build and serving: `vite.config.ts` builds `src/web` into `dist/web` with `base: './'` (no inline scripts or styles, no source maps, `assetsInlineLimit: 0`); `npm run build` = `tsc` + `vite build`, `build:web` only the UI, `dev:web` = Vite on :5173 proxying to :8099. `src/server/web.ts` serves `dist/web/assets` and `public/assets` under `/assets/` (hashed Vite files `public, max-age=31536000, immutable`, everything else `no-cache`) and the HTML shell (`no-store`) for `/login`, `/setup` (same gate as before: 403 / 410) and the client routes `/`, `/strategies`, `/trades`, `/backtest`, `/settings`, `/settings/{trading,account,diagnostics}`. The shell carries no data, so those routes are public at the HTTP level: a browser navigation (`Accept: text/html`) without a session is still redirected to `/login` (303), other clients get the shell (`curl -I /` → `200 text/html`). Per request, `<base href>` and every `./` URL are rewritten to the browser-facing prefix (`X-Ingress-Path` or `/`); all API calls in the app are relative to `<base>`. Without a web build (unit tests, fresh checkout) the T03 server-rendered pages are served instead, and the HTML form posts of `/login` and `/setup` keep working. T05's Dockerfile must run `npm run build` and copy `dist/web` and `package.json` (the version shown in Diagnostics) into the image.
- React stack: React 19, TanStack Query, TanStack Table **v8** (v9 had just changed its API), Recharts, `qrcode` (TOTP QR as a `data:` PNG, allowed by `img-src`); all are bundled by Vite and therefore `devDependencies`. Routing is a small History-API router (`src/web/router.tsx`), no router dependency. `tsconfig.web.json` (DOM, JSX, bundler resolution) covers `src/web` and `test/unit/web`; `npm run typecheck` runs both configs.
- New endpoints: `GET /auth/state` (public: `needsSetup`, `setupAllowed` for this channel — what the T03 login page already showed), `GET /api/status` (switches + add-on lock, Kalshi env/subaccount, version), `GET /api/diagnostics` (version, absolute DB path, size of the DB file plus its WAL), `GET /api/leagues`, `GET /api/strategies` (id/name/sport only), `GET /api/live`. `POST /api/settings` now accepts `global_kill_switch` and `global_dry_run`: a change that turns either **off** needs a step-up within 5 min (`403 reauth_required`, checked before anything is written); turning on does not. Audit rows `global_kill_switch_on|off`, `global_dry_run_on|off` carry `mode` = the global mode after the change (`live` only when `allow_live_orders` is on and global dry run off, else `dry_run`); the same log line (`"Global kill switch turned on"`, with `mode`) goes to Pino. Setting a switch to its current value is a no-op.
- SSE: `retry: 2000`, then `switches`, `logs` (≤ 50, each `{seq,time,level,msg,mode}`), then `log` per new line, `switches` on change and `heartbeat` (`{at, switches}`) every 10 s. The ring buffer (`src/server/logRing.ts`) is a second Pino destination at the configured level; Fastify's per-request lines (`req`/`res`) are not kept. Each heartbeat re-checks the session row, so a revoked or expired session gets `event: end` and the stream closes; streams are ended on shutdown (`preClose`). The browser hook keeps one `EventSource`, recreates it 3 s after the browser gives up, and shows "Live: reconnected" after any interruption.
- Step-up UI: any action answering `403 reauth_required` opens the password dialog (`POST /auth/reauth`) and is retried once. The password change asks for the current password and uses it for the step-up (a wrong one counts as a failed re-auth, as in T03).
- Filter bar URL: keys in the fixed order `sport, leagues, strategies, mode, env, range`, lists comma-separated, defaults omitted (`sport=all`, `mode=both`, `env` = the current Kalshi environment, `range=all`); every change is a history entry. Malformed values fall back to the defaults.
- e2e: `npm run e2e` builds the UI, starts the production server on :8198 with a fresh `.local/e2e` database and a stand-in for the Supervisor ingress proxy on :8199 (`test/e2e/ingress-proxy.ts`: strips `/api/hassio_ingress/abc`, adds `X-Ingress-Path`, `X-Forwarded-For`, `X-Forwarded-Proto: http`), one worker in file order. `KST_E2E=1` (honoured only when `NODE_ENV` is not `production`) makes the loopback peer the ingress proxy and raises the rate limits (login 1000/min, global 10 000/min) so the suite's many sign-ins do not trip them; it is not a configuration key and the container must run with `NODE_ENV=production` (T05). Step-up prompts are exercised by ageing `sessions.last_auth_at` in the e2e database (SQLite WAL allows the second writer). `verify:T04` runs the same suite once (JSON reporter), plus live checks against `npm run dev` (with `KST_E2E=1` so a loopback request with `X-Ingress-Path` is the "ingress test peer") and a headless-Chromium reconnect check across a dev-server restart.
- T03 test change: `auth.test.ts` used `global_dry_run` as the "unknown field" example for `POST /api/settings`; it now uses `api_football_key_enc` (never writable through the API).

### T05 — Home Assistant app packaging (local verification only)

**Goal:** the repository is a valid Home Assistant app repository whose image builds for `aarch64` and `amd64`, runs Node as non-root, keeps the DB in `/data/db`, and never exposes the private key through the environment. **Deployment to HAOS is manual, after T14.**

**Scope**
- `repository.yaml`, `kalshi-trader/config.yaml`, `Dockerfile`, `run.sh`, `translations/en.yaml`, `DOCS.md`, `icon.png`, `logo.png`, `CHANGELOG.md` exactly per §11, applying the "Adopt" rows of §14 Reference app facts where §11 is silent. Pin the base image tag and digest (verify that the tag exists for both arches and that its Alpine ships `nodejs` ≥ 22; record the choice in `docs/decisions/`).
- Private key hand-over on fd 3 (`KALSHI_PRIVATE_KEY_FD`); Node reads and closes it at boot.
- `docker-compose.yml` for local runs mapping `./.local/data:/data`, `read_only: true`, `tmpfs: /tmp`, and `/data/options.json` generated by `npm run compose:options` from `config.local.json`.
- CI `image.yml`: `docker buildx build --platform linux/arm64,linux/amd64`; optional GHCR publish workflow present but disabled.
- `scripts/check-addon-config.ts` (`npm run check:addon`): required keys, `schema` ↔ `options` parity (optional `?` keys may be absent from `options`), `ingress_port` = `PORT`, `ports` 8099 = `null`, `init: true`, no `map` key (or an empty one), none of `host_network`/`privileged`/`full_access`/`hassio_api`, `version` = `package.json` version.
- `DOCS.md`: install steps; Kalshi key generation and `base64 -w0 key.pem`; every option including `allow_live_orders` and `kalshi_subaccount`; dedicated subaccount + restricted key walkthrough (incl. the Advanced tier upgrade call); `cloudflared` app target hostname; Cloudflare Access; backup password.

**Out of scope:** anything trading related; HAOS installation.

**Acceptance (verify locally)**
- [x] `npm run check:addon` exits 0; removing `slug`, adding an option without a schema entry, or setting `ports: 8099/tcp: 8099` makes it exit 1 naming the key.
- [x] `docker compose up --build -d` → health `healthy` within 90 s; `curl localhost:8099/healthz` (compose maps the port for local testing only) → `{"ok":true,…}`; `.local/data/db/trader.db` exists and is owned by uid 1000; `.local/data/options.json` is still owned by root.
- [x] `docker compose exec kalshi-trader sh -c 'stat -c %u /proc/$(pgrep -f dist/server/main.js)'` → `1000`; `touch /app/x` fails with `Read-only file system`; the app writes `/data/db` and `/data/app` and cannot write `/data/options.json`.
- [x] Key never in the environment: `tr '\0' '\n' < /proc/<node pid>/environ | grep -c -e KALSHI_PRIVATE -e 'BEGIN .*PRIVATE KEY'` → `0`; `ls -l /proc/<node pid>/fd/3` → no such fd after boot; a development-only endpoint returns the loaded key's SHA-256 public-key fingerprint, equal to `openssl pkey -in key.pem -pubout | sha256sum` of the fixture key.
- [x] `run.sh` test (container with a fixture `/data/options.json`): exported `KALSHI_ENV`, `KALSHI_KEY_ID`, `KALSHI_SUBACCOUNT`, `ALLOW_LIVE_ORDERS`, `LOG_LEVEL`, `TRUSTED_PROXIES` match the options; `timezone` absent → `TZ` unchanged, present → exported.
- [x] `docker buildx build --platform linux/arm64 -t kalshi-trader:arm64 --load kalshi-trader/` succeeds and `docker run --rm --platform linux/arm64 --entrypoint node kalshi-trader:arm64 -e "require('/app/node_modules/better-sqlite3')(':memory:').prepare('select 1').get()"` exits 0.
- [x] amd64 image < 350 MB; no dev dependencies in `/app/node_modules` (`ls /app/node_modules | grep -c vitest` → 0).
- [x] `config.yaml` matches §11 field for field (diff in the verification doc).
- [x] `DOCS.md` has a heading for every Scope item; `translations/en.yaml` has `name` and `description` for every option.
- [x] CI `image.yml` green for both platforms.

**Implementation notes (T05, deviations and clarifications)**
- Base image: `ghcr.io/home-assistant/base:3.22-2026.08.0` pinned by digest for both stages (Alpine 3.22, `nodejs` 22.23.2); `docs/decisions/0002-base-image.md`.
- `run.sh` reads `/data/options.json` with `jq` (the reference app's approach) instead of `bashio::config`, which queries the Supervisor API and fails outside Home Assistant (compose and the fixture test); the Supervisor writes the same file, so behaviour on HAOS is unchanged. It fails fast with `[kalshi-trader] ERROR: …` when the file is missing.
- The key fd number reaches Node as the argument `--kalshi-private-key-fd=3`, not `KALSHI_PRIVATE_KEY_FD=3` in the environment, because the acceptance grep for `KALSHI_PRIVATE` in `/proc/<pid>/environ` must return 0; the variable still works elsewhere. Node reads fd 3 at boot but closes it only after the database and the listening socket are open, so no long-lived file is numbered 3.
- Dockerfile additions to §11: `scripts/install-hooks.mjs` is copied before `npm ci` (the `prepare` script), `migrations/` is copied into the runtime stage (read at start-up since T02), and empty scope directories left by `npm prune` (e.g. `@vitest`) are removed.
- The container checks (items 2–7, 10) ran in GitHub Actions (`image.yml`), not in the development session: that session's egress policy blocks the GHCR blob host and the Alpine CDN, so the base image cannot be pulled there. `verify:T05` is the same script either way. Observations about the literal commands (the `pgrep -f` self-match, and reading `/proc` of uid 1000 as root without `CAP_SYS_PTRACE`) are in `docs/verification/T05.md`.
- The fixture key is generated per run with `openssl genpkey` (never committed). The development-only endpoint is `GET /api/dev/key-fingerprint`: registered only with `NODE_ENV=development`, answering only class `dev` (loopback).
- `yaml` added as a dev dependency (for `check:addon` and tests). `publish.yml` is manual-only and its job runs only when the repository variable `PUBLISH_IMAGES` is `true`.

### T06 — Kalshi API client, network gate, market discovery

**Goal:** a thin, tested Kalshi client using the integer units, and the discovery job that fills `games`, `markets` and `teams`.

**Scope**
- `feeds/kalshi/client.ts`: RSA-PSS signing (§2); base URL by `KALSHI_ENV`; every request passes `assertNetworkAllowed()` (rejects while `global_kill_switch` is on). Typed methods: `getBalance`, `getExchangeStatus`, `getExchangeSchedule`, `listSeries`, `getSeries`, `listEvents(series, status, nested, cursor)`, `getEvent`, `listMilestones({relatedEventTicker})`, `getMarket`, `getHistoricalMarket`, `getOrderbook`, `getCandlesticks(series, ticker, …)`, `getHistoricalCandlesticks`, `getHistoricalCutoff`, `getLiveData(milestoneId)`, `getLiveDataBatch(milestoneIds)`, `getGameStats(milestoneId)`, `createOrderV2`, `getOrders({ticker, minTs, status})`, `getHistoricalOrders`, `getPositions`, `getSettlements`, `getFills`, `createOrderGroup`, `getOrderGroup`, `resetOrderGroup`, `upgradeApiUsageLevel` (manual use only). All responses Zod-validated with `.passthrough()`, converted to `_bp`/`_micros`/`_cc` by `decimal.ts`; cursor pagination handled; `subaccount` passed when `KALSHI_SUBACCOUNT > 0`.
- Token buckets (Basic tier: read 200 tokens/s with 3 s capacity, write 100 tokens/s with 1 s capacity, 10 tokens per request unless configured) and exponential backoff on 429/5xx (0.5, 1, 2, 4, 8 s; max 5 attempts). Log method + path only.
- `feeds/kalshi/discovery.ts` per §3: open events → preseason filter → milestones → upsert `games`, `markets` (with `price_ranges`), `teams` (structured targets); idempotent; runs at start-up and daily at 05:00 local.
- Settings → Leagues: enable toggle, editable `kalshi_series`, include-preseason toggle, "Discover series" (Sports series whose ticker ends in `GAME`), "Run discovery now".
- Settings → Diagnostics → "Test Kalshi connection" (environment, subaccount, balance, exchange status).
- `npm run kalshi:smoke` and `npm run fixtures:record:kalshi` (records demo responses into `test/fixtures/kalshi/`; responses carry no credentials).

**Out of scope:** placing orders from the app (the method exists and is tested against the mock; nothing calls it).

**Acceptance (verify locally)**
- [x] Signing: for `timestamp=1700000000000`, `GET`, `/trade-api/v2/portfolio/balance` and the fixture key, the signature verifies with `crypto.verify` (same PSS parameters) and the signed string equals `1700000000000GET/trade-api/v2/portfolio/balance`; a path with `?limit=5` signs without the query string.
- [x] Every method has an `msw` test against a fixture and returns typed integers (e.g. an orderbook NO bid `"0.0700"` with size `"50.00"` becomes a YES ask level `{price_bp: 9300, size_cc: 5000}`); an extra unknown field passes; a fixture missing `ticker` fails with a `ZodError` naming `ticker`.
- [x] Candlesticks request URL is `/series/KXNHLGAME/markets/<ticker>/candlesticks?…&period_interval=1`; the parsed candle has `ask_close_bp`, `bid_close_bp`, nullable `trade_close_bp`.
- [x] Network gate: with `global_kill_switch=true`, every client method rejects with `NetworkPaused` and msw records zero requests.
- [x] Rate limiter (fake timers): after 3 idle seconds the read bucket holds 600 tokens (60 requests): 40 reads queued at once all pass immediately, a further 40 queued right after → 20 pass immediately and the remaining 20 at 20 per second; `429, 429, 200` → one result after 0.5 s and 1 s delays; six consecutive `503`s throw `KalshiUnavailable` after 5 attempts.
- [x] Logs from the whole client test run never contain the key id value or any `/portfolio/*` response body (grep on captured Pino output).
- [x] Discovery against fixtures for one NHL regular-season event, one NHL preseason event and one EPL event: `games` gains 2 rows (preseason skipped, logged at `info`) with `milestone_id`, teams, `scheduled_at` from the milestone and `competition`; `markets` gains 2 + 3 rows with outcomes `home/away` and `home/tie/away` and non-empty `price_ranges`; a second run changes nothing (except `updated_at`); with `include_preseason=1` the preseason event is added.
- [x] Team mapping: the EPL fixture's `-CFC` market maps via `custom_strike` to the team whose `kalshi_target_id` matches; `TIE` maps to `tie`; an unknown target → `outcome='unknown'` and one `warn`, discovery continues.
- [x] `createOrderV2` sends `{ticker, side:"bid", count:"2", price:"0.9400", time_in_force:"immediate_or_cancel", self_trade_prevention_type:"taker_at_cross", client_order_id, order_group_id}` (+ `subaccount` when > 0) to `POST /portfolio/events/orders` and parses `fill_count "2.00"` → `200` cc, `average_fill_price "0.9300"` → `9300`, `average_fee_paid "0.0046"` per contract → total fee `9200` micros (equals `feeMicros` for 2 contracts at $0.93).
- [x] `getOrders` sends `ticker` and `min_ts` (never `client_order_id`) and paginates.
- [ ] `npm run kalshi:smoke` with a demo key prints environment, balance, exchange status and counts of open events per enabled series (0 is fine off-season); without a key prints `SKIPPED (no demo key)` and exits 0.
- [x] e2e: Settings → Leagues shows six leagues with their series; "Discover series" (mocked) lists them; toggling include-preseason persists; "Test Kalshi connection" shows `demo` and a balance or a readable error.

**Implementation notes (T06, deviations and clarifications)**
- Not ticked: `kalshi:smoke` **with a demo key**. The development session's egress policy blocks every Kalshi host (and `docs.kalshi.com`), so it could not be run against demo. The "without a key" half passes (`SKIPPED (no demo key)`, exit 0), and `verify:T06` runs the script against the fixture stand-in to check its output; run `npm run kalshi:smoke` with a demo key in `config.local.json` to close the item.
- Fixtures in `test/fixtures/kalshi/` are **hand-written** from §2 and the documented response shapes, because neither the API nor `openapi.yaml` was reachable. Field names that are guesses until `npm run fixtures:record:kalshi` (writes to `test/fixtures/kalshi/recorded/`) is run against demo: the milestone `details` home/away team-id keys (discovery accepts `home_team_id`/`away_team_id`, `home_id`/`away_id` and a few variants), the batch live-data path (`GET /live_data/batch?milestone_ids=a,b`, response `live_datas`), the order-group paths (`POST /portfolio/order_groups/create`, `GET /portfolio/order_groups/{id}`, `PUT …/{id}/reset`) and the tier-upgrade path (`POST /account/api_usage_level/upgrade`). Each is isolated in one place in `feeds/kalshi/client.ts` / `discovery.ts`.
- The network gate lives in `src/feeds/network.ts` (not under `feeds/kalshi/`), because every feed adapter (T07) uses the same `assertNetworkAllowed()`. It reads `global_kill_switch` from the database on every call and fails closed; it is checked before a request and again after the token-bucket / backoff wait.
- Without a key id **and** a private key there is no Kalshi client: discovery does not run, and every Kalshi action (Discover series, Run discovery now, Test Kalshi connection) answers a readable `kalshi_not_configured` error. Network errors (no HTTP answer) are not retried (`KalshiNetworkError`); only `429` / `5xx` get the backoff, and `429` after 5 attempts also ends as `KalshiUnavailable`.
- Zod 4 keeps `.passthrough()` (an alias of `.loose()`); a missing required field throws the `ZodError` itself (path e.g. `market.ticker`). `*_dollars` / `*_fp` fields win over the legacy integer cents / contracts fields, which are used only when the former are absent.
- `createOrderV2` takes whole `contracts` and a `priceBp`; the total fee is `average_fee_paid × fill_count` computed exactly (`fee_micros = avg_fee_micros × fill_cc / 100`, rounded up to the micro-dollar for a fractional fill). `core/pricing.ts` gains `feeMicros` / `costMicros` (§2 formula, multiplier in thousandths) so the acceptance comparison can be made; T09 builds on it.
- Team ids are `<league>:<structured target uuid>` unless a team with the same `kalshi_target_id` already exists in the league (then it is reused and its aliases merged). Teams are created only for markets mapped to `home` / `away`; a market whose target matches neither milestone team (or that has none and is not `TIE`) is stored as `unknown` with one `warn`. `games.feed_game_ids` holds `{"kalshi_milestone": <id>, …source_ids}`.
- Discovery runs after the server listens (so a slow Kalshi never delays `/healthz`), daily at 05:00 local (`TZ`), and on "Run discovery now" (audited `discovery_run`); runs never overlap (`409 discovery_running`). A league that fails is reported in the result and the others continue; `NetworkPaused` aborts the run. League edits are audited as `league_change`; they need no step-up (they cannot lead to a real order by themselves).
- Test-only switches: `KST_E2E_KALSHI_URL` points the e2e server at `test/e2e/fake-kalshi.ts` (honoured only with `KST_E2E=1` outside production, like `KST_E2E`); `KALSHI_SCRIPT_BASE_URL` points the command-line scripts at a stand-in. The e2e run generates its own key and `config.local.json` under `.local/e2e/`.
- `msw` added as a dev dependency.


### T07 — Score feeds, GameTracker, Scheduler, replay, live cards, timeline archive

**Goal:** the app knows, within one poll interval, the score and clock of every tracked game; the pipeline can be exercised without a live game; finished games leave a permanent goal timeline.

**Scope**
- `ScoreFeed` interface and `GameState` from §3.
- `feeds/kalshi/live.ts`: one batch live-data call per tick → `GameState`; soccer minute parser for `tileLiveText`/`widgetLiveText`; halftime/intermission detection (§3); unknown text → derived minute + one `warn` per game.
- Derived soccer minute from observed kick-off / second-half start (`games.kickoff_observed_at`, `second_half_observed_at`), `minuteSource` on every state and snapshot.
- `feeds/nhl/`: `api-web.nhle.com/v1/score/now` (+ `/v1/gamecenter/{id}/landing` when needed), matched via tricodes, `teams.aliases` and milestone `source_ids`.
- `core/tracker.ts`: feed merge and disagreement rule (> 20 s → `games.blocked=1`, logged; agreement clears it), writes `game_snapshots`, updates `games`, emits `stateUpdated` / `phaseChanged`. On `finished`: derive goal events from the snapshot score changes (side, period, minute, second) and write `hist_games` (`source='live'`), set `timeline_archived=1`.
- `core/scheduler.ts`: 5 s while any game is live, 60 s within 60 min before a scheduled game, idle otherwise, **paused** while `global_kill_switch` is on (zero requests, `/healthz` `loop:"paused"` with 200); `Promise.allSettled` across feeds; health tick (`503 {"ok":false,"loop":"stale"}` after 2 min without a tick while running).
- Replay: `npm run replay -- --file test/fixtures/replay/<name>.jsonl --speed 100`; `npm run fixtures:record:feeds` records a real evening in that format.
- Settings → Feeds: enable/disable adapters, "Test feed".
- SSE payload extended with tracked games; Dashboard status strip (loop state, last poll, feeds OK, Kalshi env + balance, the three switch states) and live game cards (§8).

**Out of scope:** strategies, trades.

**Acceptance (verify locally)**
- [x] Soccer minute parser table test: `"78'"` → 78, `"45+2'"` → 45, `"90+4'"` → 90, `"HT"` → halftime, `"FT"` → finished, `"1st Half"` → no minute, `"Postponed"` → postponed; an unseen string yields a derived minute with `minuteSource:'derived'` and exactly one `warn` per game id.
- [x] Derived minute (fake timers): kick-off observed at T → at T+30 min 10 s the minute is 30 (`derived`); second half observed at S → at S+20 min the minute is 65; capped at 45/90.
- [x] Kalshi live fixture (NHL, `round: 2`, `final_round_time_left: "12:34"`) → `phase:'live'`, `period:2`, `secondsLeftInPeriod:754`, minute 27; `round: 1` with `"00:00"` → `intermission`; `status:'finished'` → `finished`, `regulationOver:true`.
- [x] NHL adapter: `LIVE`, period 3, `"05:00"` → minute 55; `OFF`/`FINAL` → finished; `FUT` → scheduled; `CRIT` → live.
- [x] Batch: 8 live milestones → exactly one live-data request per tick (msw count).
- [x] Tracker replay of `test/fixtures/replay/nhl-sample.jsonl` produces the expected snapshot sequence (`toMatchSnapshot`) with phases `scheduled → live → intermission → live → finished`; `game_snapshots` has one row per input line; on `finished` a `hist_games` row with `source='live'` and the correct goal events exists and `timeline_archived=1`.
- [x] Disagreement: 2-1 vs 1-1 for 25 s → `games.blocked=1` and a `warn`; agreement → `blocked=0`; `stateUpdated` events carry `blocked`.
- [x] Scheduler (fake timers): no games → zero feed calls in 10 min; game in 30 min → a call every 60 s; live game → every 5 s; after `finished` → idle within one interval. Global kill switch on → zero requests over 10 min of fake time and `/healthz` → `200 {"ok":true,"loop":"paused"}`; off → polling resumes within one interval. Stopped scheduler while running → `503` after 2 min.
- [x] A feed throwing on every call does not stop the other feed or the loop; the status strip shows that feed as `error`.
- [x] `npm run replay -- --file test/fixtures/replay/nhl-sample.jsonl --speed 100` against the dev server: e2e sees the card appear, its score change and its phase reach "Final" within 30 s; SSE frames include `games[]` with `homeScore`, `awayScore`, `clock` (incl. `minuteSource`).
- [x] `npm run feeds:smoke` prints today's NHL games from the real NHL API or `no games today`; exits 0.
- [x] e2e: Settings → Feeds toggles persist; "Test feed" shows one result line per adapter.

**Implementation notes (T07, deviations and clarifications)**
- `npm run feeds:smoke` against the real NHL API was observed in CI, not in the development session: that session's egress policy blocks `api-web.nhle.com` (the proxy answers `403`), so there it ran only against the fixture stand-in (`NHL_SCRIPT_BASE_URL`). The `feeds-smoke` job in `ci.yml` runs it on every push (run URL and output in `docs/verification/T07.md`).
- `ScoreFeed` gains `poll(games)` (one call per tick for every tracked game the adapter covers — this is how `kalshi-live` makes exactly one batch request per tick across leagues) and `test(games)` (Settings → Feeds); `listLive` / `get` from §3 are implemented on top of `poll`. `FeedObservation` carries the raw payload (stored in `game_snapshots.raw` as `{"clock": …, "payload": …}`, so the goal timeline can use period and seconds after a restart) and an optional feed game id (the NHL id is remembered in `games.feed_game_ids.nhl`, then used for `/gamecenter/{id}/landing`).
- Soccer parser details: `45+2'` → 45 and `90+4'` → 90 (stoppage counts as 45 / 90); a plain minute above 90 is capped at 90; `1st Half` / `2nd Half` set the half without a minute, so the minute is derived (no `warn`: the text is known); only an unrecognised text is logged, once per game id. Kalshi `round` 1 / 2 is used as the soccer half when present. Hockey: round ≥ 4 (overtime) counts as minute 60 with `regulationOver: true`; round 3 at `00:00` while still `live` (going to overtime) is `regulationOver: true` too.
- Tracker merge: a feed's observation counts for 60 s. The score is the one all fresh feeds agree on; while they disagree the last agreed score is kept, and `blocked` is set once the disagreement has lasted more than 20 s. A single fresh feed never clears `blocked` (only agreement does). For hockey the NHL feed's phase and clock win when fresh; a game is `finished` as soon as any fresh feed says so. Snapshots are written per observation of each feed (one row per replay line); the archived timeline uses the `kalshi-live` snapshots when there are any. `hist_games.id` is `live:<event ticker>`, `season` is `YYYY-YY` (July starts a season). Observations of an archived game are ignored.
- Tracked set: games in progress whose scheduled start is less than 12 h ago, and scheduled games from 60 min before to 6 h after their start, in enabled leagues. The dashboard also shows games finished in the last 3 h. Idle means no feed request; the database is re-checked every 60 s. While paused the switch is re-read every 5 s, and immediately after any switch change (`wake()`), so polling resumes within one interval. A tick that cannot read the kill switch counts as paused (fail closed).
- `/healthz` (§11 Behaviour): besides `running` / `idle` / `paused` the loop can read `starting` (before the first tick, right after boot) — still `200`. The T01/T02 checks that expected exactly `{"ok":true}` were relaxed to allow the `loop` field (and `test/e2e/healthz.spec.ts` updated); `buildApp` without the live services (unit tests) still answers `{"ok":true}`.
- The Kalshi balance for the status strip is read every 5 minutes while the loop is not paused (kept in memory only; `balance_snapshots` is left to T13).
- New setting `feeds` (`{"kalshi-live": bool, "nhl-official": bool}`, an adapter missing from the map is on); changes are audited as `feed_change` and need no step-up. Without Kalshi credentials the `kalshi-live` adapter does not exist (Settings → Feeds shows it as unavailable and "Test feed" says why).
- Replay format: one self-contained JSON object per line — `{at, feed, game: {id, leagueId, home, away, …}, payload}` with the feed's own record as `payload` — played through the same adapter conversion and `GameTracker.ingest` as live polling. `npm run replay` posts each line to `POST /api/dev/replay`, registered only with `NODE_ENV=development` (class `dev`) or in the e2e server (`KST_E2E=1`, loopback peers); the first line of each game resets it and schedules it "now". Replayed games carry `feed_game_ids.replay = true` and are never polled. `npm run fixtures:record:feeds` writes a line whenever a game's payload changed (NHL games in progress, and Kalshi live data of the tracked games when a key is configured).
- The e2e server points the NHL adapter at the fixture stand-in (`KST_E2E_NHL_URL`, `test/e2e/fake-kalshi.ts` under `/nhl/v1`, honoured only with `KST_E2E=1` outside production). The replay e2e runs twice: `test/e2e/replay.spec.ts` on the production build inside `npm run e2e`, and `verify:T07` against `npm run dev` in headless Chromium.
- The live game cards list "No strategies armed" until T08 fills `strategies` with effective-mode badges.

### T08 — Strategy model, effective mode, engine, Strategies page

**Goal:** strategies can be created, versioned, paused and switched between modes; the engine emits signals labelled with their effective mode; nothing acts on them yet.

**Scope**
- Zod schemas for strategy JSON (§5) with `rule.version`; `minLead ≥ 1`; soccer `atMinute` 1–90, hockey 1–59; `execution` fields incl. `maxSlippage` (default 0.01), `minPrice` (optional, < `maxPrice`), `maxFeedAgeSec` (default 15).
- `core/modes.ts`: `effectiveMode({globalKill, strategyKill, allowLiveOrders, globalDryRun, strategyMode}) → {mode: 'paused'|'dry_run'|'live', reason}` exactly per §1.
- `lead_at_time` evaluator (soccer and hockey clock semantics, window, `leaderSide`, never during breaks or after regulation, never when `blocked`).
- Strategy API: create (kill switch on, `dry_run`), edit (new `strategy_versions` row, `current_version` bumped), kill switch on/off, mode switch, soft delete, list (optionally including deleted). Step-up for kill switch **off** and mode → `live`; audit rows `strategy_kill_switch_changed`, `strategy_mode_changed`.
- `core/engine.ts`: on every `stateUpdated`, evaluate strategies whose effective mode is not `paused`, whose `leagueIds` include the game's league and whose sport matches; produce `Signal {strategyId, version, gameId, marketTicker, snapshot, configuredMode, effectiveMode, modeReason}`; once per game per strategy (no signal if a `trades` row exists). Signals are logged with `mode` and pushed over SSE. (Retry within the window is driven by the executor in T09.)
- Strategies page (§8): table with kill switch and mode toggles and effective-mode badge, editor drawer with all fields and validation, version history. "Test against last 30 days" present but disabled with tooltip "available after backtesting (T12)".

**Out of scope:** sizing, fills, settlement.

**Acceptance (verify locally)**
- [x] `modes.ts` table test over all 32 combinations of the five switches: global kill → `paused`; else strategy kill → `paused`; else `allowLiveOrders=false` → `dry_run/addon_lock`; else global dry run → `dry_run/global_dry_run`; else strategy `dry_run` → `dry_run/strategy`; else `live/null`.
- [x] Soccer rule `{minLead:2, atMinute:80, windowMinutes:5, leaderSide:'any'}`: 2-0 at 80' → signal for the home market; 2-0 at 79' → none; 2-0 first seen at 84' → signal; at 86' → none; 1-0 at 80' → none; 0-2 at 80' → signal for the away market; `leaderSide:'home'` with 0-2 → none; `halftime` → none; `regulationOver` → none; `blocked` → none (with a `debug` line); stoppage `90+3` counts as 90 → signal only with a window covering 90.
- [x] Hockey `{minLead:2, atMinute:50}`: period 3 with 10:00 left (minute 50) and 3-1 → signal; 10:01 left (49) → none; period 2 → none; `intermission` → none; OT → none.
- [x] Once per game: after any `trades` row exists for (strategy, game), re-evaluation emits nothing; a different strategy on the same game still signals.
- [x] Paused strategies are not evaluated (spy): strategy kill switch on → zero evaluations; global kill switch on → the engine receives no states at all.
- [x] Signal labelling: with `allowLiveOrders=false` and a strategy in `live` the signal carries `configuredMode:'live', effectiveMode:'dry_run', modeReason:'addon_lock'`, and its log line has `"mode":"dry_run"`.
- [x] Validation: `percent: 150` → `400` naming `sizing.percent`; soccer `atMinute: 95` → `400`; `minLead: 0` → `400`; `minPrice ≥ maxPrice` → `400`; `leagueIds: ['nba']` → `400`; a hockey strategy with an EPL league → `400`.
- [x] API: create → `kill_switch=1`, `mode='dry_run'`, `current_version=1`, one version row; edit `minLead` → version 2, version 1 unchanged; a `trades` row referencing version 1 still joins to its rule; toggles create no version; delete → hidden by default, visible with `?includeDeleted=1`.
- [x] Step-up: kill switch off or mode → live without recent re-auth → `403 reauth_required`; with it → `200` and an audit row; kill switch on and mode → dry run need no re-auth.
- [x] Replay (`nhl-sample.jsonl`) with a matching strategy whose kill switch is off → exactly one `signal` SSE event for that game with `snapshot.homeScore`, `snapshot.clock.minute`, `marketTicker`, `effectiveMode`.
- [x] e2e: create a strategy (invalid percent shows an inline error first), turn its kill switch off (password prompt), edit it and see two versions; switching mode to live opens the re-auth prompt and the badge then reads `LIVE → DRY RUN (add-on lock)`.

**Implementation notes (T08, deviations and clarifications)**
- API shape: `GET /api/strategies[?includeDeleted=1]`, `GET /api/strategies/:id` (with `versions`), `POST /api/strategies` (create, `201`), `POST /api/strategies/:id` (edit), `POST /api/strategies/:id/kill-switch` `{killSwitch}`, `POST /api/strategies/:id/mode` `{mode}`, `POST /api/strategies/:id/delete` (soft delete). All state changes are `POST` with the CSRF token, like the rest of the API. Validation errors are `400 {"error":"bad_request","issues":["sizing.percent: …"]}` (the issue path names the field). Besides the two audit actions of the scope, create / edit / delete are audited as `strategy_created`, `strategy_edited`, `strategy_deleted`; the `mode` of these rows and log lines is the mode the strategy trades in once running (both kill switches ignored), so it is always `live` or `dry_run`.
- Strategy JSON details: a create may carry `mode` / `killSwitch` as in the §5 example, but only `"dry_run"` / `true` (anything else is `400`). `rule.version` defaults to 1; `windowMinutes` (0–90) defaults to 5 for soccer and 3 for hockey; `leaderSide` defaults to `any`. `execution.maxPrice` is required; `orderType` defaults to `ioc_limit`, `minPrice` to `null`, `maxSlippage` to 0.01 (≤ 0.50), `minDepthContracts` to 20 (the §5 example), `maxFeedAgeSec` to 15 (1–600). Amounts are limited to the precision the integer units hold exactly — prices (`maxPrice`, `minPrice`, `maxSlippage`) at most 4 decimals, `minStakeUsd` / `maxStakeUsd` at most 2, `percent` (0 < p ≤ 100) at most 2 — so conversion to `_bp` / `_micros` (`strategyPriceBp`) never rounds; `minStakeUsd ≤ maxStakeUsd`. `leagueIds` must name existing leagues of the strategy's sport (`leagueIds.<i>: unknown league "nba"`). The sport of a strategy cannot be changed by an edit (`400`); the name can, without a new version. An edit that changes nothing versioned creates no version.
- `effectiveMode` returns `{mode:'paused', reason:'global_kill_switch' | 'strategy_kill_switch'}` for the two paused rows (the §1 table gives no reason there; `trades.mode_reason` only ever stores the dry-run reasons).
- Once per game in T08: the engine does not write `trades` (the executor inserts the `signalled` row in T09). It emits no signal when a `trades` row exists for (strategy, game), and remembers each (strategy, game) it signalled for the life of the process, so a rule that keeps matching on later ticks (e.g. 55' and 59' of the replay) signals once. A replay reset of a game (`GameTracker.forget`, new `gameReset` event) clears that memory for the game.
- Hockey minute for the rule is computed from `period` and `secondsLeftInPeriod` when both are known (`floor(((p − 1) × 1200 + 1200 − left) / 60)`), else the state's `clock.minute`; period ≥ 4 never matches. The `blocked` check comes last, so the `debug` line is written only when the rule would otherwise match.
- The signal's market is the game's `markets` row whose `outcome` is the leader's side; if discovery has not mapped one, the signal carries `marketTicker: null` and a `warn` is logged (T09 skips such a trade). Replayed games now get `<event>-<ABBR>` home / away (and `<event>-TIE` for soccer) market rows, so replay signals carry a ticker.
- SSE `/api/live` adds `strategies` (`{strategies: StrategyView[]}` with configured / effective mode and reason, sent initially and after every strategy or switch change), `signals` (the last 20, initially) and one `signal` event per new signal. `GameView.strategies` entries carry `configuredMode`, `effectiveMode` and `modeReason`, so the card badge can read `LIVE → DRY RUN (…)`. The Dashboard shows a "Recent signals" list.
- The Strategies table shows 30-day trades and realized P&L per mode (from `trades.triggered_at`; empty until T09) and exports CSV with `configured_mode`, `effective_mode`, `mode_reason`, `kalshi_env`. The editor validates with the same Zod schema as the server (shared `src/core/strategy.ts`) and also maps server `issues` to the fields.
- `docker compose up --build` was not run in the development session: the Docker daemon runs there, but the egress proxy refuses the blob download of the pinned base image (`403` from `pkg-containers.githubusercontent.com`); the `Image` workflow runs the compose check and the arm64 build on the pushed branch.

### T09 — Executor, guards, retries and Settler in dry run; Trades page

**Goal:** dry run works end to end: signal → guards (with retry inside the window) → virtual fill → settlement → shared bankroll → Trades page, all labelled `dry_run`.

**Scope**
- `core/pricing.ts` (pure, integer): `feeMicros({cc, bp, multiplier, precisionMicros})` per §2, `limitPriceBp({askBp, maxSlippageBp, maxPriceBp, priceRanges})` (snapped down to the grid), `contractsFor({stakeMicros, limitBp})`, `costMicros`, `realizedPnlMicros`, `unrealizedPnlMicros`.
- `core/guards.ts`: the §5 guard table with hard/soft classes (shared with the backtester).
- `core/executor.ts`: on a signal insert the `trades` row (`signalled`); for each attempt insert a `trade_attempts` row (`pending`, `client_order_id = <trade.id>-<n>`) **before** any HTTP; recompute the effective mode; read market + orderbook; run guards; dry-run sizing from `dry_run_bankroll_micros`; virtual fill at the limit price for `min(contracts, contracts offered ≤ limit)`; bankroll debited by cost + fee and a `bankroll_snapshots` row (`fill`) in the same transaction. Soft failure → trade `waiting`, retried on every tick while the rule still matches and the window is open; window end → `skipped`, `window_expired=1`; hard failure → `skipped`. Live effective mode → attempt `hard_skip` with reason `live_not_implemented` (until T13).
- `core/settler.ts`: every 60 s for `filled` trades (paused under the global kill switch): settle per §6 using `settlement_value_dollars`; `settled_won`/`settled_lost`/`settled_void`; payout credited to the bankroll with a `bankroll_snapshots` row (`settlement`).
- Start-up: `pending` dry-run attempts → `unfilled` (`restart`); their trades return to `waiting` if the window is still open, else `skipped`.
- Settings → Trading: dry-run bankroll (current, initial, reset with step-up → `bankroll_snapshots` row `reset`), fee precision.
- Trades page (§8): table with filter bar, status filter, mode badges, expandable row (snapshot, attempts, fill, settlement, audit trail), CSV export with mode columns.
- Every trade and attempt state change writes an `audit_log` row with `entity='trade'`, `entity_id`, `mode`.

**Out of scope:** charts, live orders.

**Acceptance (verify locally)**
- [x] Pricing: `feeMicros({cc:100, bp:9200, multiplier:1, precisionMicros:100}) = 5200`; `({cc:200, bp:9400, …100}) = 7900`; `({cc:10000, bp:5000, …100}) = 1750000`; `({cc:10000, bp:9200, …100}) = 515200`; multiplier 0 → 0; `({cc:100, bp:9200, …10000}) = 10000`. `limitPriceBp({askBp:9300, maxSlippageBp:100, maxPriceBp:9700, linear_cent})` = 9400; ask 9650 → 9700; ask 9300 with a `$0.005` grid and slippage 0.0075 → 9350. `contractsFor({stakeMicros:2000000, limitBp:9400}) = 2`; `({900000, 9400}) = 0`. `realizedPnlMicros({fillCc:200, avgBp:9400, feeMicros:7900, payoutMicros:2000000}) = 112100`; lost → `-1887900`; `unrealizedPnlMicros({fillCc:200, avgBp:9400, bidBp:9600}) = 40000`.
- [x] Order of operations (msw spy): the `trade_attempts` insert precedes the market/orderbook requests; if the orderbook request throws, the attempt is `error`, the trade `waiting`, the error logged, nothing thrown to the scheduler.
- [x] Guards, each producing the named reason and **no bankroll change**: market `closed` → `skipped/market_closed` (hard); `trading_active:false` → `waiting/exchange_paused`; newest feed observation 20 s old with `maxFeedAgeSec` 15 → `waiting/stale_feed`; `blocked` → `waiting/feed_blocked`; ask 0.98 vs `maxPrice` 0.97 → `waiting/price`; ask 0.40 with `minPrice` 0.80 → `waiting/min_price`; 5 contracts ≤ limit vs `minDepthContracts` 20 → `waiting/liquidity`; bankroll $1 at 2 % with `minStakeUsd` 0.01 → `skipped/too_small`.
- [x] Retry: tick 1 ask 0.98 (`waiting`, attempts 1), tick 2 ask 0.96 → `filled` at limit 0.97, attempts 2, two `trade_attempts` rows; a window that ends with the ask still above `maxPrice` → `skipped`, `skip_reason='price'`, `window_expired=1`; lead dropping to 1 mid-window → no attempt on those ticks.
- [x] Happy path: bankroll $100, 2 %, `minStakeUsd` 1, `maxStakeUsd` 50, ask 0.93 with 50 contracts ≤ 0.94, `maxSlippage` 0.01, `maxPrice` 0.97 → stake 2 000 000, limit 9400, 200 cc, cost 1 880 000, fee 7 900, bankroll 98 112 100, trade `effective_mode='dry_run'`; `maxStakeUsd` 1 → 1 contract; only 1 contract offered ≤ limit → 1 contract.
- [x] Settler (fake timers, msw): settlement value 1.0000 → `settled_won`, payout 2 000 000, P&L 112 100, bankroll 100 112 100, one `bankroll_snapshots` row; 0.0000 → `settled_lost`, P&L −1 887 900, bankroll 98 112 100; 0.5000 → `settled_void`, payout 1 000 000, P&L −887 900, bankroll 99 112 100; a market still `open` → untouched and re-checked next minute; a market past the historical cutoff → read from `/historical/markets/{ticker}`.
- [x] Two strategies on one game fill in the same tick: the bankroll reflects both debits sequentially (no lost update).
- [x] Restart: a `pending` dry-run attempt from 10 min ago with the window closed → attempt `unfilled/restart`, trade `skipped`; with the window still open → trade `waiting`.
- [x] Global kill switch on with filled trades and a waiting trade → zero HTTP requests from executor and settler (msw count), states unchanged; switch off → settlement catches up on the next run.
- [x] End-to-end replay with one dry-run strategy → exactly one trade for that game, states `signalled → pending → filled → settled_*` in `audit_log` order (each row with `mode='dry_run'`), bankroll updated; the e2e Trades page shows the row with a `DRY RUN` badge, the snapshot (score, minute, minute source, feed timestamps) and the attempts list.
- [x] A strategy configured `live` with `allow_live_orders=false` fills as dry run with badge `LIVE → DRY RUN (add-on lock)`; with `allow_live_orders=true`, global dry run off and mode live → attempt `hard_skip/live_not_implemented`, nothing crashes.
- [x] e2e: CSV export has a header row with `effective_mode, configured_mode, mode_reason, kalshi_env` and one line per visible trade; bankroll reset requires re-auth, restores the initial value, writes an audit row and a `bankroll_snapshots` row with `reason='reset'`.

**Implementation notes (T09, deviations and clarifications)**
- Market status: Kalshi reports a tradable market as `active` (the `open` of §2 is the list filter); guard 2 accepts `open` or `active` with `close_time` in the future (a missing `close_time` passes).
- Guard inputs: the best ask comes from the orderbook (`1 − NO bid`); an empty ask side fails as `liquidity`; a limit that snaps below the best ask (coarse grid) fails as `price`. Guard 4 uses the newest of the triggering state's `observedAt` and the game's latest `game_snapshots.observed_at`; guard 5 uses `games.blocked` or the state's `blocked`. The executor reads market, exchange status and orderbook on every attempt (in that order) and keeps the `markets` row (status, bid / ask, grid) current.
- Trade status: a trade goes `signalled → waiting | skipped` when a guard fails and `→ pending → filled` only when the guards passed (the dry-run fill writes both in one transaction). `effective_mode` / `mode_reason` of the trade follow the latest attempt. A signal without a market ticker inserts the trade and skips it at once (`skip_reason = 'no_market'`, no attempt). Other reasons beyond the §5 table: `live_not_implemented` (until T13), `restart`, `window_expired` (window closed without any soft reason recorded).
- Audit rows: `trade_<status>` for every trade transition and `attempt_<status>` for every attempt row change, `actor = 'system'`, `entity = 'trade'`, `entity_id` = trade id, `mode` = the trade's / attempt's effective mode. Bankroll reset is audited as `dry_run_bankroll_reset` (`entity = 'settings'`, `mode = 'dry_run'`).
- Retries: on every `stateUpdated` of a game its `waiting` trades are re-evaluated with the rule of the version they fired under; a match for the same leader → a new attempt (none while an attempt of the trade is queued, none while the global kill switch is on); the window counts as closed when the rule minute passes `atMinute + windowMinutes`, regulation is over / OT, or the game is finished or postponed. `window_ends_at` is a wall-clock estimate (signal time + remaining window minutes + 1); it decides only at start-up recovery and in a once-a-minute sweep (run with the settler) that expires open trades of finished games or 30 min past that estimate.
- Sizing: `stake = floor(balance × percent / 100)` clamped to `[minStake, maxStake]`; the virtual fill is `min(requested, offered ≤ limit)` centi-contracts at the limit price. Fee multiplier: the event's `fee_multiplier` when reported, else the series', read once per process; a failed lookup falls back to 1 with a `warn`.
- Settler: `/historical/markets/{ticker}` is used when the stored `markets.close_time` is before `market_settled_ts`, or when `/markets/{ticker}` answers 404. Live trades are settled the same way but credit no bankroll (reconciliation against `/portfolio/settlements` is T13).
- Recovery: pending **live** attempts are left untouched with a `warn` (live recovery is T13). Trades left `signalled` or `pending` without a pending attempt are treated like the recovered ones.
- API: `GET /api/trades?sport&leagues&strategies&mode&env&range&status&reason` (`env` defaults to the running environment; `range` season = from 1 July UTC; `status` groups `open` (signalled / pending), `waiting`, `filled`, `settled`, `skipped`), `GET /api/trades/:id` (snapshot, attempts, audit trail), `POST /api/settings/bankroll/reset` (step-up). `POST /api/settings` also accepts `fee_balance_precision_micros` and `dry_run_initial_bankroll_micros` ($1 – $10M; the current bankroll changes only on reset). SSE `/api/live` adds a `trade` event (`{id, status}`) per change.
- The Trades page charts (price-paid histogram, P&L per trade) come with the stats endpoint in T10 (charts are out of scope here).
- `docker compose up --build` was not run in the development session (no Docker daemon was available); the `Image` workflow covers it on the pushed branch.

### T10 — Stats endpoint and Recharts dashboard, split by mode

**Goal:** every §6 metric and §8 chart, driven by one aggregated endpoint that keeps live and dry run apart.

**Scope**
- `GET /api/stats` accepting the filter-bar parameters; response `{ live: {tiles, series}, dry_run: {tiles, series} }` (a mode filtered out is absent). Tiles: trades, win rate, net P&L, ROI, max drawdown, avg price, avg fee, implied vs actual, forced-dry-run share (dry run only). Series: equity curve (per strategy + total), bankroll line (dry run) / balance line (live), daily P&L, drawdown, implied-vs-actual points, price-paid histogram, trades per trigger minute, skip reasons (final and per attempt). SQL aggregation in repositories.
- `test/fixtures/db/stats-seed.sql`: 30 trades across 2 strategies, 2 leagues, both modes (incl. forced dry run and one `settled_void`), with `stats-seed.expected.json` computed by hand and documented in `stats-seed.md`.
- Dashboard: tiles (two values side by side when mode = both), all eight charts with live solid / dry run dashed or hatched and legend labels "Live"/"Dry run", shared `{filters}` props, empty and loading states, dark/light palette, one tooltip format that always names the mode.
- Trades page charts (price-paid histogram, P&L per trade), split by mode.
- `npm run seed:demo -- --trades 500` generator (both modes) for manual checks.

**Out of scope:** backtests.

**Acceptance (verify locally)**
- [x] With `stats-seed.sql`, `GET /api/stats` equals `stats-seed.expected.json` for: unfiltered; `strategies=A`; `leagues=epl`; `mode=dry_run` (no `live` key); `mode=live` (no `dry_run` key); a date range covering half the trades. Win rate excludes `settled_void`, `skipped`, `waiting`; ROI divides by Σ (cost + fee) of settled trades; max drawdown equals the documented value per mode.
- [x] Mode separation: changing the outcome of one live trade in the seed changes only values under `live`; no field anywhere in the response equals a sum over both modes (test compares against per-mode recomputation).
- [x] Equity points are ordered by `settled_at`; the bankroll line has one point per `bankroll_snapshots` row in range; the live balance line one point per `balance_snapshots` row.
- [x] Implied vs actual returns one point per (strategy, league) within each mode with `x`, `y`, `n`.
- [x] Empty DB → `200` with zeroed tiles and empty arrays for both modes; unknown league id → `400`.
- [x] 500 seeded trades → response < 200 KB and contains no per-trade rows (`JSON.stringify(res).includes('trigger_snapshot') === false`).
- [x] 10 000 generated trades → `/api/stats` median < 300 ms over 20 calls (numbers recorded).
- [x] e2e on the seeded DB: eight `.recharts-wrapper` elements; with mode = both every chart legend contains both "Live" and "Dry run" and every tile shows two values; with mode = live no "Dry run" text appears in any chart; empty DB shows empty states; no horizontal overflow at 390 px; dark mode changes series colours.
- [x] Trades page histogram and per-trade bars follow the same filter; hovering a bar shows the trade id and its mode.

**Implementation notes (T10, deviations and clarifications)**
- Filters: the same parameters as `GET /api/trades` (`sport, leagues, strategies, mode, env, range`); trades are selected by `triggered_at` in range and `kalshi_env` (default: the running environment). The bankroll line is the shared dry-run bankroll (not narrowed by strategy / league); the balance line is narrowed by environment. Both use snapshots taken in range.
- Tiles: "trades" counts settled trades; avg price and avg fee are per-trade means over trades with a fill (open or settled); implied vs actual uses won + lost trades only; forced-dry-run share is over every dry-run trade in the filter. Ratios are fractions rounded to 4 decimals and are 0 without a denominator (the UI shows "—"); integer averages round half away from zero.
- Drawdown is plotted and reported in dollars from the running peak of the equity curve (which starts at $0), not in %: realized P&L has no capital base to divide by.
- Price histogram: the upper end is the highest `maxPrice` among the strategies the filter covers (default $0.97); fills outside the 15¢ range are counted in `below` / `above`. Empty series have no bins.
- The Trades page charts are computed in the browser from the listed trades (so they also follow the status filter), not from `/api/stats`.
- Response size grows with settled trades (one equity point per settled trade and strategy): 10 000 trades → 1.9 MB, 500 → well under 200 KB.
- `docker compose up --build` was not run in the development session (no Docker daemon was available); the `Image` workflow covers it on the pushed branch.

### T11 — Historical importers, candle collector, backfill, price model

**Goal:** `hist_games` and `hist_prices` can be filled from free sources, past Kalshi seasons can be backfilled, and the price model can be rebuilt.

**Scope**
- NHL importer: `GET /v1/schedule/{date}` week by week for a season + `GET /v1/gamecenter/{gameId}/play-by-play` → `hist_games` (`source='nhl'`) with goal events `{side, period, minute, second}`, final incl. OT/SO; preseason skipped unless requested; resumable, 4 req/s cap, progress over SSE, `--limit`.
- Kalshi backfill discovery: settled events for enabled series over a date range (events are always available on the live endpoint) → `games`/`markets` rows marked historical (no tracking) with milestones.
- Kalshi play-by-play importer: `game_stats` for backfilled milestones → `hist_games` (`source='kalshi_pbp'`) when goal events with a period and clock can be extracted; the verification doc records whether soccer and hockey payloads qualify; if not, the importer is disabled and `SPEC.md` §3 updated.
- CSV importer (§3 format): per-row validation with row number and column; 20 MB limit; step-up required.
- Candle collector: for every finished or backfilled game with markets, 1-minute candles from `/series/{series}/markets/{ticker}/candlesticks` (or `/historical/markets/{ticker}/candlesticks` when settled before `market_settled_ts`) → `hist_prices` (ask OHLC, bid close, trade close, volume); sets `hist_games.kalshi_event_ticker`; idempotent.
- Price model builder: median `ask_close_bp` by (sport, lead bucket 1/2/3+, remaining-minute bucket of 5) from `hist_prices` joined to `hist_games` goal timelines; stored in `settings.price_model` with `sampleSize` per cell; seed table (§9) where `sampleSize < 20`.
- Settings → Data: import CSV, fetch NHL season, backfill Kalshi events, collect candles, rebuild price model, DB size, vacuum; long jobs show progress and can be cancelled (`DELETE /api/jobs/:id`). All jobs respect the global kill switch (they pause and resume).

**Out of scope:** the simulator.

**Acceptance (verify locally)**
- [x] NHL importer (msw: schedule with 3 games incl. one preseason + play-by-play files) → 2 `hist_games` rows by default, 3 with preseason requested; goal events have period, minute, second and `side` from the scoring team id; a shootout game stores the official final (e.g. 3-2) and `goal_events` exclude shootout attempts; a second run inserts 0 rows and logs `skipped N existing`.
- [x] Network smoke: `npm run import:nhl -- --season 20252026 --limit 5` inserts 5 games with non-empty `goal_events` (or exits 0 with a clear network error).
- [x] Backfill discovery (msw) over a date range with 2 settled EPL events → 2 historical `games` rows with milestones and 3 markets each, not tracked by the scheduler.
- [x] Play-by-play importer on a recorded `game_stats` fixture: either produces the expected goal timeline, or the importer is disabled with the reason recorded in `docs/verification/T11.md` and `SPEC.md`.
- [x] CSV: 3 valid rows → 3 rows (`home:23;away:67;home:90+2` → minutes 23, 67, 90); `home_goals_final` not matching the home goal events → `400` naming the row; 21 MB → `413`; without re-auth → `403`.
- [x] Candles: a game settled after the cutoff uses `/series/…/markets/{ticker}/candlesticks`, one settled before uses `/historical/markets/{ticker}/candlesticks` (asserted on URLs); rows carry `ask_close_bp` and `bid_close_bp`; a minute without trades has `trade_close_bp NULL`; rerunning changes nothing.
- [x] Price model: 60 observations at (soccer, lead 2, 10–15 min left) → cell median equals the hand-computed ask median and `sampleSize=60`; a 5-observation cell reports the seed value with `sampleSize=5`, `seeded=true`; empty DB → full seed table; the builder reads `hist_games`, not `game_snapshots` (a test deletes all snapshots first).
- [x] Jobs: `DELETE /api/jobs/:id` stops the NHL import within one request and keeps inserted rows; global kill switch on → the job pauses with zero requests and resumes when switched off.
- [x] e2e: Settings → Data: uploading the sample CSV shows "3 rows imported"; "Rebuild price model" shows per-sport sample sizes; DB size updates after vacuum.

**Implementation notes (T11, deviations and clarifications)**
- Modules: `src/backtest/{jobs,nhlImporter,csvImporter,kalshiPbp,kalshiBackfill,candles,priceModel}.ts`, routes in `src/server/routes/data.ts`: `GET /api/data/summary`, `POST /api/data/csv` (`text/csv`, step-up checked before the body is read, 20 MB), `POST /api/data/nhl` `{season, includePreseason?, limit?}`, `POST /api/data/kalshi-backfill` `{from, to, leagueIds?, playByPlay?}`, `POST /api/data/candles` `{gameIds?, force?}` (the three answer `202` with the job), `POST /api/data/price-model`, `POST /api/data/vacuum`, `GET /api/jobs`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id`. Audit rows: `hist_csv_import`, `data_job_start`, `data_job_cancel`, `price_model_rebuild`, `db_vacuum`. Only the CSV import needs step-up (§10); the dialog text now reads "Changes that can lead to real orders, and data imports, need your password again."
- Jobs live in memory (a restart forgets the list; every importer is resumable because it skips stored rows); one job per type at a time (`409 job_running`). Every outgoing request of a job goes through `ctx.request`: while the global kill switch is on the job is `paused` and sends nothing (the switch is re-read every second and on every switch change); a request rejected with `NetworkPaused` in between is retried after the pause. Cancel aborts the request in flight (`AbortSignal`) and stops at the next checkpoint; rows already written stay. Progress is pushed as the SSE event `job`.
- Schema: `games.historical` (migration `0002_games_historical`, with its down migration). Backfilled settled events are stored as `phase = 'finished'`, `historical = 1`, `finished_at` = the markets' latest close; `GameTracker.pollTargets` / `displayGames` exclude them, so the scheduler never polls them and the engine never sees them. A game the app already tracked live keeps its row (only its markets are refreshed). The backfill date range is matched on the markets' earliest close time (UTC day, inclusive; at most 400 days); the API has no date filter, so every settled event of a series is listed.
- NHL importer: the walk starts at `YYYY-09-01` of the season's first year and follows `nextStartDate` until the playoffs end; game types 2 (regular) and 3 (playoffs) are imported, 1 (preseason) on request, others never; only `OFF` / `FINAL` games. `hist_games.home` / `away` hold the NHL tricodes (`BUF`) so the candle collector can link them to Kalshi teams; `competition` is `Pro Hockey` / `Pro Hockey Preseason` / `Pro Hockey Playoffs`. Goal minute = elapsed game time (`(period − 1) × 20 + mm`, so overtime goals are ≥ 60); the official final includes the shootout winner's goal (a game whose goal events do not add up to the final, the one shootout goal aside, is skipped with a `warn`). Rate: at most 4 requests/s. The network smoke could not reach the NHL API from the development session (the egress proxy answers `403`); the script then exits 0 with `network error, nothing imported`, which the acceptance item allows.
- Kalshi play-by-play: verified on production `game_stats` payloads (2026-09-26, two EPL, two La Liga and two NHL preseason games; field names and example events in `docs/verification/T11.md`). Periods come unordered and events newest first; a goal is a rise of `home_points` / `away_points` between consecutive events in time order (so VAR-cancelled `possible_goal` events never count and own goals count for the credited side). Soccer: minute = `match_time` (stoppage counts as 45 / 90, like the live feed and the CSV), second = the clock's seconds. Hockey: the clock is the time *remaining*; minute = elapsed game time (overtime periods 5 min unless the clock shows more); shootout periods are ignored for goals. The fixtures under `test/fixtures/kalshi/game_stats_<milestone>.json` are modelled on those payloads (same fields, the observed goal events of FUL–MUN) rather than byte-for-byte recordings. The hockey `period_number` / `period_type` fields were not observed directly (only the soccer period objects were printed) and are assumed to match; a hockey payload without `period_number` is rejected as unusable, never guessed.
- CSV: header row required, columns in any order, RFC 4180 quoting; `league_code` must be a league id of this app (`epl`, `nhl`, …); `date` `YYYY-MM-DD` (optionally with a time); ids `csv:<league>:<date>:<home>:<away>` (re-importing a file updates instead of duplicating); all rows are validated before anything is written; row numbers count data rows (row 1 = line 2). Soccer goal periods: minute ≤ 45 → 1, else 2; hockey `floor(minute / 20) + 1`, overtime (≥ 60) → 4.
- Candles: window from 60 min before the scheduled start to the markets' latest close (6 h when unknown); a market that closed before `market_settled_ts` of `GET /historical/cutoff` uses the historical endpoint. `minute_ts` = the candle's `end_period_ts`. Production candles are sparse (minutes without a change are omitted), which T12's "next candle within 3 minutes" rule must expect. Markets that already have candles are skipped unless `force`. The collector links an NHL / CSV timeline to its event when league, start (± 12 h) and both teams (tricode, alias or name) match.
- Price model: candles are placed on the match clock with a fixed model from the scheduled start (soccer: wall minutes 0–46 → minute `min(e, 45)`, 47–61 half-time skipped, then `45 + (e − 62)` capped at 90, after 97 skipped; hockey: three 36-minute periods with 18-minute intermissions, minute `(p − 1) × 20 + floor(w × 20 / 36)`); goals count from their minute on (soccer `≤ m`, hockey `< m`). An observation is a candle of the leader's market with an ask close; one timeline per event (`live` > `kalshi_pbp` > `nhl` > `csv`). Median of an even count = mean of the two middle values rounded half up. Seed table (whole cents, clamped to $0.50–$0.99): ask = $1 − slope × r, r = the bucket's lower bound in minutes, slope per lead 1 / 2 / 3+ = soccer 1.5¢ / 0.4¢ / 0.15¢, hockey 2¢ / 0.6¢ / 0.2¢ per minute (gives the §9 anchors). Buckets `[0,5)` … `[90,95)` soccer, `[0,5)` … `[60,65)` hockey. With no `hist_games` rows the rebuild stores the full seed table.
- `docker compose up --build` was not run in the development session (no Docker daemon); the `Image` workflow covers it on the pushed branch.

### T12 — Backtest simulator and Backtest page

**Goal:** replay a strategy over a league season with exact or modelled prices, using the production engine, guards and pricing code; results are labelled as backtests.

**Scope**
- `backtest/simulator.ts`: minute ticks from `goal_events` → `GameState`; runs `engine.ts`, `guards.ts` and `pricing.ts` unchanged; window retry as in §9; price providers `exact` and `modelled`; compounding bankroll; writes `backtests` and `backtest_trades`; `worker_threads` worker with SSE progress; deterministic.
- API: run (existing strategy version or ad-hoc params), list, get, delete, promote (creates a strategy with kill switch on and `mode='dry_run'`).
- Backtest page (§8): form, results (equity, drawdown, monthly P&L, trades table, tiles, `modelled` badge with the smallest sample size), comparison of up to 3 saved runs; every view titled/labelled "Backtest", never mixed with live or dry-run series.
- Strategies page "Test against last 30 days" enabled: quick exact backtest over the strategy's leagues' collected data.

**Out of scope:** new rule types.

**Acceptance (verify locally)**
- [x] Determinism: the same backtest twice yields byte-identical `backtest_trades` (excluding ids/timestamps).
- [x] Parity: a synthetic game (`test/fixtures/parity/game-a.json`, goals at 12', 55', 78') is (a) replayed through tracker → engine → executor (dry run) with the orderbook mocked from the same candle series and (b) run through the simulator in exact mode; both enter at the same minute with the same limit price, contracts, fee and P&L.
- [x] Exact mode: candle at minute 80 → used (`price_source='candle'`); absent at 80 but present at 82 → used with `next_candle`; none within 3 min → `skipped_no_price`. The ask close (not the trade close) is used.
- [x] Retry parity: ask above `maxPrice` at 80' and below at 82' → entry at 82' in both the simulator and the live replay.
- [x] Modelled mode: every trade has `price_source='model'`; the summary has `priceMode='modelled'` and `minSampleSize`.
- [x] Compounding: bankroll $100, 2 %, two winning trades → the second stake is 2 % of the post-first-trade bankroll (asserted in micros).
- [x] Settlement: soccer 2-1 after 90' → won; NHL 2-2 after regulation, 3-2 in OT for the leader → won; lead lost in OT → lost; NHL tie → void at $0.50.
- [x] Worker isolation: during a 5 000-game synthetic backtest `GET /healthz` answers in < 100 ms and SSE `progress` events arrive with increasing `done/total`.
- [x] Performance: 1 300 games complete in < 5 s on the dev machine (recorded for Pi comparison).
- [x] Promote: `POST /api/backtests/:id/promote` creates a strategy with `mode='dry_run'`, `kill_switch=1`, version 1 equal to the backtest params.
- [x] e2e: run a backtest from the form, see tiles, equity/drawdown/monthly charts and the trades table; save it; run a second with a different `atMinute`; the comparison view shows two equity lines; the modelled badge appears only in modelled mode; no "Live"/"Dry run" legend appears on the Backtest page.

**Implementation notes (T12, deviations and clarifications)**
- Built on T11 (merged first): modelled prices use T11's `settings.price_model` through `priceModelLookup` (`src/backtest/priceModel.ts`), falling back to T11's full seed table (`seedModel`) when no model has been built; `minSampleSize` is the smallest `sampleSize` of the cells a run used (0 = seed only) and `seededPrices` counts prices from seeded cells. Exact prices read the candles T11's collector stores.
- Game minute → candle: the exact inverse of T11's clock model (`matchMinute`, the one the price-model builder uses to place candles), anchored at the event's scheduled start (`games.scheduled_at`, else `hist_games.played_at`): the candle of game minute M is the one at wall minute `e = wallMinuteOf(sport, M)` (`src/backtest/clock.ts`: soccer `M` in the first half, `M + 17` in the second; hockey `54 × period index + ceil(minute in period × 36 / 20)`), with `e = floor((minute_ts − start) / 1 min)` exactly as the builder computes it. "Next candle within 3 minutes" = wall minutes `e + 1 … e + 3` (production candles are sparse, T11).
- One timeline per Kalshi event: when several `hist_games` rows describe the same event, the backtest replays the one T11's builder trusts most (`SOURCE_RANK`: `live` > `kalshi_pbp` > `nhl` > `csv`).
- Ticks: a goal recorded at minute `m` is in the score from tick `m` (the live rule sees a goal in the minute it is scored; T11's builder counts hockey goals from `m + 1`, which only affects which candles become observations); soccer ticks 1–90, hockey 1–59 (at 60:00 regulation is over, and overtime goals are recorded at minute ≥ 60), period / seconds-left derived so `ruleMinute()` equals the live NHL minute. The simulator never sees halftime, blocked feeds, stale feeds, closed markets or exchange pauses (those guards are omitted); depth is not modelled (one ask level of unlimited size, `minDepthContracts` ignored), so a fill is always the full requested size; fee multiplier 1 (every configured series).
- `skipped_no_price` is soft: the next minute of the window is tried (a later candle may exist); a skip row records the last minute tried, the last ask and the last soft reason (`window_expired` if none). Skip rows are stored in `backtest_trades` with `skip_reason`; `price_bp` of a fill is the limit (fill) price.
- Settlement from the final score: leader won → $1.00, lost → $0; a draw → $0.50 in hockey (Kalshi tie rule), $0 in soccer (the tie market wins). Games are settled in date order before the next game is sized (sequential compounding).
- Save / name: no schema change; `backtests.params` holds the resolved request (`name`, `saved`, `quick`, sport, leagues, seasons, `sinceIso`, strategy reference, the replayed definition). Unsaved finished runs beyond the newest 10 are deleted when a new run starts. `league_id` / `season` hold comma-joined lists (`since YYYY-MM-DD` for the quick test). At most 2 runs at a time (`429 backtest_busy`). A run without a result after a restart shows as `interrupted`.
- The worker opens its own connection to the database file and writes the result itself; in development and tests it is loaded through `src/backtest/tsxWorker.mjs` (tsx), in the image `dist/backtest/worker.js` directly. Progress: SSE `backtest` events `{id, status, done, total}` (about 50 per run).
- "Test against last 30 days" runs an exact backtest of the strategy's current version over its leagues' `hist_games` played in the last 30 days and opens it on the Backtest page (disabled for an unsaved strategy). Promote creates the strategy from the replayed definition (its own `leagueIds`), audited as `strategy_created` with `fromBacktest`.
- `docker compose up --build` was not run in the development session (no Docker daemon was available); the `Image` workflow covers it on the pushed branch.

### T13 — Live trading path: orders, order group, subaccount, recovery, reconciliation

**Goal:** a strategy whose effective mode is `live` places real IOC orders on Kalshi with every safety invariant from §4 and §10.

**Scope**
- Executor live branch: balance from `GET /portfolio/balance` (subaccount) minus the cost of `pending` live attempts; `createOrderV2` with `immediate_or_cancel`, `client_order_id = <trade.id>-<n>`, `price` = `limit_bp` (4 decimals), `count` from sizing, `order_group_id`, `subaccount` when > 0; store `fill_count`, `average_fill_price`, fee = `average_fee_paid × fill_count`; `fill_count` 0 → attempt `unfilled` (soft, retried in the window); partial fills → `filled` with the actual count.
- Order group: created at start-up when live orders are possible (or reused from `settings.kalshi_order_group_id` if still valid) with `order_group_contract_limit`; Settings → Trading shows its status and offers "Reset" (step-up, audited); a group-limit rejection → soft `order_group_limit` + `warn`.
- Start-up recovery (before the scheduler starts): for each `pending` live attempt, `getOrders({ticker, minTs})` (then `getHistoricalOrders`) matched by `client_order_id` → apply `fill_count_fp`, `taker_fill_cost_dollars`, `taker_fees_dollars`; not found → `unfilled` with reason `restart_no_order`; the trade returns to `waiting` or becomes `skipped` depending on the window.
- Settler live path: reconcile with `GET /portfolio/settlements`; difference > 10 000 micros → `trades.reconcile_warning` + `warn`, shown in the UI.
- `balance_snapshots` every 15 min (not under the global kill switch) and after each live fill/settlement.
- Effective mode enforced before every attempt (§1): `allow_live_orders=false`, global dry run on or strategy `dry_run` → the attempt runs as dry run with the matching `mode_reason`; a kill switch turned on mid-window → `skipped/paused`.
- Fee check: `npm run e2e:demo` compares the exchange's fee with `feeMicros` at both precisions and prints which one matches; the verification doc records the result and `fee_balance_precision_micros` is set accordingly in the defaults if needed.
- Static rule: the client exposes no deposit/withdrawal/transfer method; a test enumerates client methods against an allow-list.
- `npm run e2e:demo`: with a demo key, places one IOC order for 1 contract on the cheapest open demo market, reads it back via `getOrders` + `client_order_id`, prints the result; without a key prints `SKIPPED`.

**Out of scope:** selling before settlement, hedging, top-ups.

**Acceptance (verify locally, Kalshi mocked with msw unless noted)**
- [ ] Order body: ask 0.93, `maxSlippage` 0.01, `maxPrice` 0.97, stake 2 000 000 → body `{"ticker":…, "side":"bid", "count":"2", "price":"0.9400", "time_in_force":"immediate_or_cancel", "self_trade_prevention_type":"taker_at_cross", "client_order_id":"<trade.id>-1", "order_group_id":"<id>"}`; with `KALSHI_SUBACCOUNT=3` also `"subaccount":3`; the `pending` attempt row exists before the request.
- [ ] Response `fill_count:"2.00", average_fill_price:"0.9300", average_fee_paid:"0.0046"` → trade `filled`, `fill_cc 200`, `avg_fill_price_bp 9300`, `cost_micros 1860000`, `fee_micros 9200`, `effective_mode 'live'`; `fill_count:"1.00"` → `filled` with 100 cc; `"0.00"` → attempt `unfilled`, trade `waiting`, retried next tick; HTTP 400/409 → `skipped/order_rejected` with the error message stored; order-group rejection → `waiting/order_group_limit`.
- [ ] Live sizing: balance $100 with one `pending` live attempt costing $3 → sizing base 97 000 000 micros.
- [ ] Recovery: a `pending` live attempt + `getOrders` returning an executed order with our `client_order_id`, `fill_count_fp "2.00"`, `taker_fill_cost_dollars "1.8600"`, `taker_fees_dollars "0.0092"` → trade `filled` with those values; an empty list (and empty historical list) → `unfilled/restart_no_order`; recovery completes before the first scheduler tick (order asserted); the request never contains `client_order_id` as a query parameter.
- [ ] Reconciliation: settlements reporting revenue 20 000 micros different → `reconcile_warning` set and one `warn`; equal → none.
- [ ] `balance_snapshots`: +15 min (fake timers) → one row; after a mocked fill → an extra row within 1 s; global kill switch on → no rows and no requests.
- [ ] Switch matrix with a live-configured strategy: `allow_live_orders=false` → zero requests to `/portfolio/events/orders` (msw spy), trade `dry_run/addon_lock`; global dry run on → zero order requests, `dry_run/global_dry_run`; strategy kill switch turned on mid-window → `skipped/paused`; global kill switch on → zero requests of any kind. `maxStakeUsd` 1 with ask 0.93 → `count:"1"`.
- [ ] Step-up: switching a strategy to live without recent re-auth → `403`; with re-auth → `200` and an audit row; the e2e confirms the prompt.
- [ ] Client allow-list test passes and fails if a method named `withdraw`, `deposit` or `transfer` is added (mutation test in the verification doc).
- [ ] `npm run e2e:demo` with a demo key: prints order id, `fill_count`, the fee comparison and the trade row id; the Trades page shows the trade with a `LIVE` badge and environment `demo`; without a key prints `SKIPPED (no demo key)`.
- [ ] `npm run replay -- --live-mock` with a live strategy (`allow_live_orders=true`, global dry run off) against the msw Kalshi mock → one live trade that fills and settles; `balance_snapshots` grows; `/api/stats` shows it only under `live`.

### T14 — Hardening, operations, v1.0.0, HAOS hand-over checklist

**Goal:** the app is trustworthy to leave running unattended, and the user has an exact checklist for the manual HAOS deployment.

**Scope**
- `npm run audit:security`: security test suite, `gitleaks`, `npm audit`, header checks per request class against a running instance; prints a summary table.
- Container hardening verified in compose: read-only root FS, Node non-root, no added capabilities; egress hostnames documented in `DOCS.md`.
- Failure drills (scripts, with the drill endpoints available only in `NODE_ENV=development`): scheduler stall → `/healthz` 503; DB locked by another process → `503 {"error":"db_busy"}` not 500; Kalshi down for 10 min → feeds keep polling, attempts `error`/`waiting`, recovery logged; global kill switch → zero outgoing requests for 10 min and `/healthz` 200 `paused`.
- Maintenance verified end to end (checkpoint log line, pruning counts only for archived games); migration down/up test.
- DB size test: `npm run seed:season` (2 000 games, 60 000 snapshots, 400 trades) → `trader.db` < 200 MB after checkpoint.
- Playwright full regression green; Lighthouse accessibility ≥ 90 on Dashboard and Trades.
- Version `1.0.0` in `config.yaml` and `package.json`; `CHANGELOG.md`; `DOCS.md` complete; `SPEC.md` reconciled with the implementation (`docs/decisions/0002-spec-reconciliation.md`).
- `docs/verification/HAOS.md`: the manual checklist below.

**Out of scope:** new features.

**Acceptance (verify locally)**
- [ ] `npm run audit:security` exits 0 with one line per check; a permissive CSP (`unsafe-inline`) or `X-Frame-Options` missing on tunnel responses in a scratch branch makes it exit 1.
- [ ] `/proc/<node pid>/status` CapEff shows no added capabilities; `touch /app/x` → read-only error.
- [ ] Drill scripts under `scripts/drills/`: (a) `stall-scheduler` → `/healthz` 503 within 2 min; (b) exclusive SQLite lock for 10 s → `503 {"error":"db_busy"}` then recovery; (c) Kalshi 503 for 10 min of fake time → feeds still polled, attempts `error`, first successful call after recovery logged; (d) global kill switch → zero requests (msw + feed mocks) and `/healthz` `paused`. Drill endpoints return 404 in a production build.
- [ ] Maintenance: fake time crossing 02:30 logs `wal_checkpoint` and `pruned N snapshots`; `-wal` shrinks to < 1 MB on the seeded DB; snapshots of non-archived games survive.
- [ ] `npm run db:migrate:down && npm run db:migrate` on a seeded DB keeps row counts.
- [ ] `npm run seed:season` then checkpoint → `trader.db` < 200 MB (recorded).
- [ ] `npm run e2e` green at both widths; Lighthouse a11y ≥ 90 on Dashboard and Trades.
- [ ] `config.yaml` version, `package.json` version and the top `CHANGELOG.md` heading all read `1.0.0`; `npm run check:addon` passes; arm64 and amd64 images build in CI.
- [ ] `docs/verification/HAOS.md` exists with this checklist:
  1. In Kalshi: create a dedicated subaccount, transfer only the trading bankroll to it, upgrade to the Advanced API tier if needed, and create an API key restricted to that subaccount (demo first).
  2. Add `https://github.com/petrapa6/sports-trading` under Settings → Apps → Repositories; install *Kalshi Sports Trader*.
  3. Configuration: `kalshi_key_id`, base64 PEM, `kalshi_env: demo`, `kalshi_subaccount`, `allow_live_orders: false`; start; the Log tab shows `listening on 8099` and `migrations applied`.
  4. Open via the sidebar (ingress); complete first-run setup; log in; Settings → Trading shows global dry run on, kill switch off, add-on lock "live orders disabled".
  5. The app's backup (Settings → System → Backups, or the next Google Drive backup) contains `db/trader.db` in the Kalshi Sports Trader app's data; a backup password is set.
  6. In the `cloudflared` app, point the hostname at the service shown on this app's Info page (`http://<prefix>-kalshi-trader:8099`); the hostname shows the login page; Cloudflare Access enabled; `/setup` over the tunnel returns 403.
  7. Settings → Diagnostics → Test Kalshi connection succeeds; Leagues → Run discovery lists upcoming games (no preseason).
  8. On the next NHL evening the Dashboard cards update live; a dry-run strategy fires and settles with `DRY RUN` badges everywhere; RAM from the Info tab is recorded.
  9. Toggle the global kill switch on for a live game and confirm the loop shows "paused" and the cards stop updating; toggle it off.
  10. Switch `kalshi_env` to `prod` with a prod key (restricted to the prod subaccount); keep everything in dry run for at least a week; then set `allow_live_orders: true`, turn global dry run off (step-up) and enable one live strategy with `maxStakeUsd` ≤ 5.

### T15 — API-Football adapter, Home Assistant notifications, extra rule parameters

**Goal:** phase-7 extras deferred by the 25 Sep decisions.

**Scope**
- `feeds/apiFootball/`: `GET /fixtures?live=all` → `GameState` with `fixture.status.elapsed` as the minute (`minuteSource:'feed'`) and status codes mapped to phases; key stored with `encryptSetting`; league ids in `leagues.feed_ids.apiFootball`; daily quota guard (default 100) with a counter in `settings`; optional bulk historical import into `hist_games` (`source='api_football'`) when a paid key is present. Respects the network gate.
- Home Assistant notifications through the Supervisor proxy (`homeassistant_api: true` only; `SUPERVISOR_TOKEN` from env; `hassio_api` stays off): events `trade_filled`, `trade_settled`, `kill_switch_changed`, `global_dry_run_changed`, `feed_disagreement`; every message states the mode (`[LIVE]` / `[DRY RUN]`) and environment; per-event and per-mode toggles in Settings; no-op with a `debug` line when the token is absent.
- Additional `lead_at_time` parameters: `maxOpponentGoals`, `underdogOnly` (pre-game favourite = market with the higher YES ask at kick-off, recorded in `games.pregame_home_bp/pregame_away_bp`).

**Out of scope:** new sports.

**Acceptance (verify locally)**
- [ ] Fixture `status.short: '2H', elapsed: 78`, goals 2-0 → `{phase:'live', clock.minute:78, minuteSource:'feed', homeScore:2}`; `'HT'` → `halftime`; `'FT'` → `finished`; `'PST'` → `postponed`.
- [ ] Quota guard: counter at 100 → no call, `warn`, feed status `quota`; resets at local midnight (fake timers). Global kill switch → zero calls.
- [ ] Stored key: DB value ≠ plaintext; `decryptSetting` returns it; it never appears in logs.
- [ ] Tracker with `kalshi-live` and `api-football`: soccer minute comes from API-Football when present; disagreeing scores for > 20 s → `blocked` as in T07.
- [ ] Notifications: msw mock of `http://supervisor/core/api/services/persistent_notification/create` receives a POST with `Authorization: Bearer <SUPERVISOR_TOKEN>` whose message contains `[DRY RUN]`, the strategy name and P&L on a dry-run fill, and `[LIVE]` on a live fill; toggles off → no request; no token → no request and one `debug` line.
- [ ] `npm run check:addon` passes with `homeassistant_api: true` and fails if `hassio_api` is added.
- [ ] Rule tests: `maxOpponentGoals: 0` with 2-1 → no signal, 2-0 → signal; `underdogOnly: true` fires only when the leader's kick-off YES ask was below the opponent's.
- [ ] e2e: Settings → Feeds shows the masked API-Football key field and quota usage; Settings → Notifications toggles persist.

## 15. Change log from the review (25 Sep 2026)

Changes relative to the living copy (rev 37), for traceability:

1. **Switches:** the single kill switch became two global switches (kill switch = pause all outgoing HTTP; dry run = no real orders) plus a per-strategy kill switch (replacing `enabled`) and per-strategy mode; the `allow_live_orders` add-on option replaces the `prodOnly` flag; effective-mode algorithm and step-up rules defined (§1). The former contradiction between "forces dry run" and `skipped_kill_switch` is gone.
2. **Mode labelling:** trades store configured/effective mode and reason; logs, audit rows, SSE, stats, charts, tiles and exports are split by mode and never aggregated together; backtests are a separate category (§6, §8).
3. **Units:** money in micro-dollars, prices in $0.0001, counts in centi-contracts, exact decimal parsing; fee rounding corrected to Kalshi's centicent rule with a configurable precision; `average_fee_paid` treated as per-contract; limit prices snapped to `price_ranges` (§2, §7).
4. **Entry semantics:** soft guards retry every tick until the window closes; hard guards end the entry; `trade_attempts` table with one `client_order_id` per attempt; new guards `maxFeedAgeSec`, `minPrice`; unified limit price `min(ask + maxSlippage, maxPrice)` for dry run, live and backtest (§5, §6, §9).
5. **Kalshi API corrections:** no `client_order_id` filter on order lookup (recovery by ticker + time); settlement from `settlement_value_dollars` (NHL tie $0.50, fair price) with status `finalized`; candlestick path includes the series and stores ask/bid; milestone lookup via `/milestones?related_event_ticker`; batch live data; maintenance only on Thursdays; rate-limit bucket sizes; all five soccer series tickers confirmed; NHL preseason excluded by default (§2, §3).
6. **Blast radius:** dedicated Kalshi subaccount with a restricted key, exchange-side order group, `allow_live_orders` outer lock (§10).
7. **Security fixes:** request classes replace the Cloudflare-IP-range trust that could not work behind `cloudflared`; `/setup` only via ingress; framing headers and cookies per channel so ingress works; lockout only for internet traffic; rate limit 300/min with assets and SSE exempt; drill endpoints development-only (§10).
8. **Packaging fixes:** same pinned HA base for build and runtime; Docker init instead of tini + s6 mix; `run.sh` runs as root, prepares directories, hands the key to Node on fd 3 and drops to uid 1000; port 8099 unmapped; read-only root filesystem only claimed for compose; `trusted_proxies`, `kalshi_subaccount`, `allow_live_orders`, `timezone` options (§11).
9. **Data gaps:** finished games archived into `hist_games` before snapshot pruning; price model joins `hist_games`; settled-event backfill; Kalshi play-by-play as a candidate free source; derived soccer minute fallback (§3, §9).
10. **Schema additions:** `trade_attempts`, `games.blocked/competition/timeline_archived/…`, `markets.price_ranges/settlement_value_bp`, session timestamps and channel, recovery-code hashes, `audit_log.ip/channel/mode`, `trades.reconcile_warning`, `backtest_trades.price_source`, autoincrement ids for snapshot tables (§7).
11. **T15:** `hassio_api` removed (only `homeassistant_api` needed); notifications state the mode.
12. **Reference app inlined (after T01):** everything needed from the owner's Family Dashboard app is recorded in §14 Reference app facts, so agents no longer read that repository. It corrected an earlier assumption (Family Dashboard keeps its DB in `/data`, not `/share`) and added the `url` key, OCI labels, the host-port-8099 clash note and the `--builder` rule (§11, §14).
13. **Storage moved to `/data` (after T01):** the database lives at `/data/db/trader.db` in the app's own data directory, like the reference app; the `share` map entry is gone. Definition of done now requires ticking every verified Acceptance box in `SPEC.md` (§14).

## Sources

- Kalshi API documentation index — https://docs.kalshi.com/llms.txt
- Create Order (V2) — https://docs.kalshi.com/api-reference/orders/create-order-v2.md
- Get Orders — https://docs.kalshi.com/api-reference/orders/get-orders.md
- Rate limits and tiers — https://docs.kalshi.com/getting_started/rate_limits.md
- Fixed-point representation and price level structures — https://docs.kalshi.com/getting_started/fixed_point_migration.md
- Fee rounding — https://docs.kalshi.com/getting_started/fee_rounding.md
- Kalshi fee schedule (effective 7 Jul 2026) — https://kalshi.com/docs/kalshi-fee-schedule.pdf
- Historical data and cutoffs — https://docs.kalshi.com/getting_started/historical_data.md
- Market candlesticks — https://docs.kalshi.com/api-reference/market/get-market-candlesticks.md
- Maintenance and pauses — https://docs.kalshi.com/getting_started/maintenance_and_pauses.md
- Live data — https://docs.kalshi.com/api-reference/live-data/get-live-data.md
- Game stats (play-by-play) — https://docs.kalshi.com/api-reference/live-data/get-game-stats.md
- Milestones — https://docs.kalshi.com/api-reference/milestone/get-milestones.md
- Live data `details` field reference (DFlow, mirrors Kalshi) — https://pond.dflow.net/resources/metadata-api/live-data/live-data-details.md
- Series checked on the production API: `/trade-api/v2/series/{KXNHLGAME, KXEPLGAME, KXLALIGAGAME, KXBUNDESLIGAGAME, KXSERIEAGAME, KXLIGUE1GAME}`; settled NHL event sample `/trade-api/v2/events?series_ticker=KXNHLGAME&status=settled&with_nested_markets=true`
- NHL Web API unofficial reference — https://github.com/Zmalski/NHL-API-Reference
- API-Football tiers and endpoints — https://bruin-data.github.io/ingestr/soccer-sources/api-football.html
- Home Assistant app configuration (updated 17 Sep 2026) — https://developers.home-assistant.io/docs/apps/configuration/
