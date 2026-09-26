# Kalshi Sports Trader

Watches live soccer and NHL games, evaluates your in-game strategies and buys the matching Kalshi contract —
for real (**live**) or as a simulated fill (**dry run**) — with a web UI in the Home Assistant sidebar.

Real orders need **three** things at once: the `allow_live_orders` option below, global dry run switched off in
the app's Settings, and a strategy set to live. Out of the box none of them is set.

## Installation

1. In Home Assistant open **Settings → Apps → App store**, open the ⋮ menu → **Repositories** and add
   `https://github.com/petrapa6/sports-trading`.
2. Find **Kalshi Sports Trader** in the store and click **Install**. The Supervisor builds the image on the
   device on first install (a few minutes on a Raspberry Pi 5).
3. Open the **Configuration** tab, fill in the options (see [Configuration](#configuration)); leave
   `kalshi_env: demo` and `allow_live_orders: false` for now.
4. On the **Info** tab enable **Start on boot**, **Watchdog** and **Show in sidebar**, then **Start**.
5. Open the app from the sidebar. The first visit through the sidebar shows **Set up**: create the app's single
   user (username + password). Setup is only possible through the Home Assistant sidebar, never through the
   tunnel.
6. The **Log** tab shows JSON lines; `Database ready (N migration(s) applied)` and
   `Server listening at http://0.0.0.0:8099` mean the app is up.

## Kalshi API key: generation and base64

1. Sign in at [kalshi.com](https://kalshi.com) (or [demo.kalshi.co](https://demo.kalshi.co) for the demo
   environment — demo and production keys are separate), open **Account & security → API keys** and create a
   key. For a dedicated subaccount, restrict the key to it (see
   [Dedicated subaccount and restricted API key](#dedicated-subaccount-and-restricted-api-key)).
2. Kalshi shows the **key ID** and downloads the **private key** (`key.pem`, an RSA key) exactly once. Kalshi
   cannot show it again; if it is lost, delete the key and create a new one.
3. The Configuration tab has single-line fields, so the key is entered as **one base64 line**. On Linux:

   ```bash
   base64 -w0 key.pem
   ```

   On macOS: `base64 -i key.pem | tr -d '\n'`. Paste the output into `kalshi_private_key_b64` and the key ID
   into `kalshi_key_id`, then delete `key.pem` from the computer you used (or keep it in a password manager).
4. The key never lands in the image, the database, the logs or an environment variable: at start-up `run.sh`
   (root) decodes it and hands it to the app on file descriptor 3; the app reads it once into memory and closes
   the descriptor. Only Home Assistant's own `options.json` holds it — which is why backups need a password
   (see [Backup](#backup)).

## Configuration

| Option | Description |
| --- | --- |
| `kalshi_env` | `demo` (paper money, the default — use it until everything works) or `prod` (real money). |
| `kalshi_key_id` | The API key ID from Kalshi. Use a key restricted to the subaccount in `kalshi_subaccount`. |
| `kalshi_private_key_b64` | The private key as one base64 line (`base64 -w0 key.pem`). Kept in memory only. |
| `kalshi_subaccount` | Kalshi subaccount the app trades in, `0`–`63`; `0` = the primary account. Strongly recommended: a dedicated subaccount (1–63) holding only the trading bankroll. |
| `allow_live_orders` | Outer safety lock, default `false`. While off, the app never places a real order, whatever the web UI or database says; strategies still run in dry run. Only this option can lift it — the web UI shows it read-only. |
| `log_level` | `debug`, `info` (default), `warn` or `error` — how much appears in the **Log** tab. Trading lines carry `mode` (`live` / `dry_run`). |
| `trusted_proxies` | Comma-separated IPs / CIDR ranges allowed to forward Cloudflare Tunnel traffic (`CF-Connecting-IP`). Default `172.30.32.0/23`, the Home Assistant internal network where the `cloudflared` app runs. |
| `timezone` | Optional IANA time zone, e.g. `Europe/Prague`, used for the nightly maintenance (02:30) and dates. Default: the container time zone, else UTC. |

After changing an option, restart the app. Changing `kalshi_env` or the key does not touch recorded trades;
every trade records its Kalshi environment.

## Dedicated subaccount and restricted API key

A key for the primary account can trade everything in it. Give the app a **subaccount** that holds only the
bankroll you intend to trade, and a key that can only use that subaccount: even a full compromise of the device
can then spend no more than that subaccount holds. Do this in **demo** first, then again in production.

1. **Advanced API tier.** Subaccounts need Kalshi's Advanced API tier. An account qualifies once one of its last
   100 orders was placed through the API; it is then upgraded with **one call to Kalshi's API usage-level upgrade
   endpoint** (the app's Kalshi client has it as `upgradeApiUsageLevel`, for manual use only — see
   [docs.kalshi.com](https://docs.kalshi.com/llms.txt) for the current path). In short:
   1. With a temporary key for the primary account, place one small order through the API (for example one
      contract at a price far from the market, cancelled right away).
   2. Call the upgrade endpoint once with the same key, then check the tier under **Account → API**.
   3. Delete the temporary key.
2. **Create the subaccount.** In Kalshi create a numbered subaccount (1–63) and note its number.
3. **Move the bankroll.** Transfer only the amount you are prepared to trade from the primary account into the
   subaccount. Top it up later by hand; the app has no deposit, withdrawal or transfer function at all.
4. **Restricted key.** Create a new API key **restricted to that subaccount**, and enter its key ID and base64
   private key in the Configuration tab ([above](#kalshi-api-key-generation-and-base64)).
5. **Configure.** Set `kalshi_subaccount` to the subaccount number, keep `allow_live_orders: false`, restart.
   Settings → Trading in the app shows the environment and subaccount it uses.
6. If the device is ever lost or compromised, **delete the key in Kalshi** — keys cannot be reconstructed from
   the exchange, so a new one costs nothing.

## Remote access: cloudflared app target hostname

The app has **no open port**: `8099/tcp` is unmapped, so it is reachable only through the Home Assistant sidebar
(ingress) and through a Cloudflare Tunnel running as the **cloudflared** app on the same device.

1. Install the `cloudflared` Home Assistant app and create a tunnel in the Cloudflare Zero Trust dashboard with a
   public hostname of your own (e.g. `trader.example.com`).
2. Point the hostname's **service** at `http://<repo-prefix>-kalshi-trader:8099`. The exact hostname is shown on
   this app's **Info** page: `local-kalshi-trader` when the app was installed from a local folder,
   `<hash>-kalshi-trader` when installed from this GitHub repository (for example
   `http://a0d7b954-kalshi-trader:8099`).
3. Leave `trusted_proxies` at `172.30.32.0/23` unless `cloudflared` runs elsewhere. Requests through the tunnel
   carry `CF-Connecting-IP`; the app applies login lockout per client IP and refuses `/setup` on this channel.
4. Only if `cloudflared` runs **outside** Home Assistant must the port be mapped — and then to another host port
   such as `8100`: host port 8099 on the device is already used by the Family Dashboard app.
5. In Cloudflare also turn on the WAF managed rules and **Bot Fight Mode**.

## Cloudflare Access

Strongly recommended and free: put **Cloudflare Access** in front of the tunnel hostname — a second wall before
the app's own login that also hides the login page from scanners.

1. Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**, with the tunnel
   hostname as the application domain.
2. Add a policy **Allow** with an **Include → Emails** rule listing only your address (one-time PIN by email,
   or Google login as identity provider).
3. Set a session duration (e.g. 24 hours) and save. Opening the hostname now asks Cloudflare for your email
   first, then shows the app's login.

## Score feeds

The app follows every game of the enabled leagues that Kalshi lists: it polls every **5 s** while a game is in
progress, every **60 s** in the hour before a game, and not at all otherwise. Two adapters are available under
**Settings → Feeds** (each can be switched off; **Test feed** checks both):

| Feed | Sports | Needs |
| --- | --- | --- |
| Kalshi live data | soccer, hockey | the Kalshi key (one batch request per poll for all tracked games) |
| NHL official API (`api-web.nhle.com`) | hockey | nothing (public, no key); used as the authoritative clock and to cross-check the score |

When the two feeds disagree on an NHL score for more than 20 s, entries for that game are blocked until they agree
again. While the **global kill switch** is on, no feed is polled at all and `/healthz` reports
`{"ok":true,"loop":"paused"}`; if the loop stops ticking for 2 minutes, `/healthz` answers `503` (`"loop":"stale"`)
and the Supervisor watchdog restarts the app. When a game finishes, its goal timeline is kept for backtesting.

## Strategies

**Strategies** lists every strategy with its **kill switch**, its **mode** (dry run / live) and the **effective
mode** it runs in right now, which also follows the global switches (Settings → Trading) and the
`allow_live_orders` option: a strategy set to live shows `LIVE → DRY RUN (add-on lock)` while
`allow_live_orders` is `false`, and `LIVE → DRY RUN (global)` while global dry run is on. New strategies start
with the kill switch **on** and in **dry run**. Turning a kill switch off or switching a strategy to live asks for
your password again; the way back to safety does not.

v1 has one rule, *lead at time*: the strategy may enter when a team leads by at least `minLead` goals from
`atMinute` to `atMinute + windowMinutes` (soccer match minute, stoppage counting as 45 / 90; hockey elapsed minute
1–59, overtime excluded), never during a break and never while the feeds disagree. Editing the rule, sizing,
execution or leagues creates a new version (listed in the editor); trades keep the version they fired under.
Deleting a strategy hides it but keeps its trades in the reports.

## Trades and the dry-run bankroll

The first match of a strategy on a game inserts a **trade** and makes an attempt: the app re-reads the market,
the exchange status and the orderbook, then checks the guards in order — paused, market closed, exchange paused,
stale feed (`maxFeedAgeSec`), feeds disagree, ask above `maxPrice`, ask below `minPrice`, too little depth at or
below the limit price, stake too small for one contract. A *soft* guard (exchange paused, stale feed, feeds
disagree, price, min price, depth) leaves the trade **waiting** and it is retried on every score update while the
rule still matches and the window is open; when the window closes it is **skipped** with the last reason. A *hard*
guard skips it at once.

In dry run the stake is a percentage of one **shared virtual bankroll** (Settings → Trading, default $100): the
fill is recorded at the limit price (`min(ask + maxSlippage, maxPrice)` on the market's price grid) for as many
contracts as the stake buys and the book offers at or below it; cost + fee is debited, and the payout is credited
when the market settles (checked every minute; a tie or fair-price settlement is **void**). Settings → Trading
shows the current and initial bankroll; **Reset bankroll** restores the initial value and asks for your password.
**Fee precision** is $0.0001 by default; $0.01 gives more conservative dry runs.

The **Trades** page lists everything that fired or nearly fired, with the shared filter bar, a status filter
(waiting, filled, settled, skipped by reason) and a mode badge on every row; a row expands to the trigger snapshot,
every attempt, the fill, the settlement and the audit trail. The CSV export carries `effective_mode`,
`configured_mode`, `mode_reason` and `kalshi_env`.

## Live trading

With `allow_live_orders: true`, global dry run off and a strategy set to live, an attempt that passes the guards
places a real **immediate-or-cancel** buy of YES on Kalshi at the limit price. The stake is a percentage of the
subaccount's Kalshi cash balance (minus orders of the app still in flight); the count is capped by the contracts
offered at or below the limit. The trade is recorded as **pending** before the order is sent, so a crash always
leaves a record: at the next start the app looks the order up on Kalshi and applies what actually happened. An
order that fills nothing leaves the trade waiting (retried while the window is open); a partial fill is kept as
it is; an order Kalshi rejects skips the trade (`order_rejected`). Fees are the exchange's own. When a live trade
settles, the app compares Kalshi's settlement with its own payout; a difference above $0.01 is shown as a
**reconcile** warning on the Trades page. The Kalshi balance is recorded every 15 minutes and after each live fill
or settlement (Dashboard → Balance history).

**Order group.** Every live order carries the app's Kalshi order group, created at start-up: an exchange-side
brake that rejects further orders once the contract limit (Settings → Trading, default 200 per rolling 15 s) was
matched. Settings → Trading shows its state; after the limit was hit, **Reset order group** (asks for your
password) re-enables live orders. A changed limit applies to the next group created.

**First live test.** `npm run e2e:demo` (development machine, demo key in `config.local.json`) places one real
order for 1 contract on the cheapest open demo market, records it as a live trade and prints the fee comparison.

## Historical data (Settings → Data)

Backtests (a later version) need goal timelines and Kalshi prices. **Settings → Data** collects them:

| Action | What it does |
| --- | --- |
| **Import CSV** | Goal timelines from a file with the columns `league_code, season, date, home, away, home_goals_final, away_goals_final, goal_events` (e.g. `home:23;away:67;home:90+2`). Up to 20 MB; asks for your password; an invalid row is reported with its row number and column and nothing is imported |
| **Fetch NHL season** | Every finished game of a season from the public NHL API (preseason only when ticked) |
| **Backfill settled events** | Settled Kalshi games of the enabled leagues in a date range, with their goal timelines from Kalshi's play-by-play. These games are only data: they are never tracked or traded |
| **Collect candles** | One-minute Kalshi prices of every finished game |
| **Rebuild price model** | The median ask by sport, lead and minutes left, used by modelled backtests; cells with fewer than 20 observations use a conservative built-in table |
| **Vacuum database** | Compacts the database file |

Long jobs show their progress and can be cancelled (what they already stored stays). While the global kill switch
is on they pause without making any request and continue when it is turned off.

## Outbound network access (egress)

The app only ever connects to these hosts, all over HTTPS on port 443. If your router, firewall or Pi-hole
restricts outbound traffic from the Pi, allow exactly these:

| Host | Used for | When |
| --- | --- | --- |
| `external-api.demo.kalshi.co` | Kalshi API (demo): markets, orderbooks, live data, orders, portfolio, candles | `kalshi_env: demo` |
| `external-api.kalshi.com` | Kalshi API (production), same calls | `kalshi_env: prod` |
| `api-web.nhle.com` | NHL official API: live scores and clock; season schedule and play-by-play for Settings → Data | NHL games tracked, NHL import |

Nothing else: no telemetry, no CDN (the web UI is bundled into the image), no update checks. While the global
kill switch is on the app makes **no** outgoing request at all. The planned API-Football feed and Home Assistant
notifications (T15) will add `v3.football.api-sports.io` and the internal `supervisor` host; they are not part of
1.0.0.

## Health, watchdog and maintenance

- `GET /healthz` (no login) answers `200 {"ok":true,"loop":"running"|"idle"|"paused"}` when the database opens and
  the trading loop has ticked within the last 2 minutes (`paused` = global kill switch on, which is healthy).
  Otherwise `503` — `{"ok":false,"loop":"stale"}` for a stuck loop, `{"ok":false,"db":"<code>"}` for a database
  that cannot be opened. With **Watchdog** enabled the Supervisor restarts the app on a `503`.
- If another process holds a lock on the database (for example a manual `sqlite3` session on the file) for longer
  than 5 seconds, requests answer `503 {"error":"db_busy"}` instead of failing, and work again as soon as the lock
  is released. Stop the app before editing the database by hand.
- Kalshi outages: the feeds keep polling (the NHL feed keeps the scores fresh), entry attempts are recorded as
  `error` and retried every tick while the entry window is open, and the first successful call afterwards is
  logged as `Kalshi reachable again` with the outage length.
- Every night at 02:30 (`timezone`) the app checkpoints the WAL and prunes live snapshots older than 90 days of
  games whose timeline is already archived; the Log shows
  `Maintenance done: wal_checkpoint(TRUNCATE), pruned N snapshots`. A season (≈2 000 games, 60 000 snapshots)
  takes about 45 MB.

## Container hardening

- The app process runs as the unprivileged user `trader` (uid 1000) with no Linux capabilities; only the start
  script runs as root, to read `options.json`, prepare `/data/db` and `/data/app` and hand over the key.
- The app declares no `privileged`, `host_network`, `full_access`, `hassio_api` or `homeassistant_api` access,
  maps no port (`8099/tcp` stays unmapped: reachable only through ingress and the `cloudflared` app) and runs
  under Home Assistant's default AppArmor profile.
- Local `docker compose` runs additionally use a read-only root filesystem and `no-new-privileges`; Home Assistant
  has no read-only option, so on the Pi the protections are the ones above.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The app restarts every few minutes | The Log shortly before the restart: `Database health check failed` (disk full, `/data` not writable), or a stalled trading loop (`/healthz` answered `{"ok":false,"loop":"stale"}`). |
| `kalshi_not_configured` in the UI | `kalshi_key_id` and `kalshi_private_key_b64` are both set, and the key matches `kalshi_env` (demo and prod keys differ). |
| `order_group_limit` on live trades | The exchange-side order group was triggered; reset it in Settings → Trading (password prompt). |
| The tunnel shows `403` on `/setup` | Expected: first-run setup is only possible from the Home Assistant sidebar. |
| Everything is `paused` | The global kill switch is on (Settings → Trading, or the switch in the header). |

## Data Storage

| Path | Contents |
| --- | --- |
| `/data/options.json` | The options above, written by the Supervisor (root-owned; the app process cannot write it) |
| `/data/db/trader.db` (+ `-wal`, `-shm`) | The SQLite database: strategies, trades, attempts, settings, audit log, historical goal timelines and prices |
| `/data/app/secret.key` | 32 random bytes generated on first start; signs session cookies and encrypts secret settings. Deleting it logs everyone out |
| `/data/app/cache/` | Re-creatable caches, excluded from backups |

Everything lives in the app's own `/data`; nothing is written to `/share` or `/config`. The app process runs as
the non-root user `trader` (uid 1000) and can write only `/data/db` and `/data/app`. Migrations run at start-up
and stay backward compatible for one version, so rolling back one update is possible.

## Backup

- Home Assistant includes each app's `/data` in its backups (hot backup; WAL keeps the database consistent and a
  checkpoint runs nightly at 02:30). Off-site copies are made with the **Google Drive Backup** app
  (`sabeechen/hassio-google-drive-backup`), as for the other apps on this device.
- **Backup password:** a backup of this app contains `options.json` and therefore the Kalshi private key. Set a
  **backup password** (encryption key) in the Google Drive Backup app's settings — and for Home Assistant's own
  backups under **Settings → System → Backups** — and keep it in your password manager.
- Restore: restore the app from the backup; it starts on the restored database. If the Kalshi key was ever
  exposed, delete it in Kalshi and configure a new one.
