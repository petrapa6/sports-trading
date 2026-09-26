# HAOS hand-over checklist — Kalshi Sports Trader 1.0.0

The manual deployment of the app to the Raspberry Pi 5 running Home Assistant OS (SPEC.md §14 T14). Everything
before this point was verified on a development machine (`npm run verify:T01` … `verify:T14`); these steps need the
real Home Assistant, the real Kalshi account and a real game. Work through them in order, and write what you saw
in the **Observed** line of each step (date, values, screenshots if useful). Stop at the first step that does not
behave as described.

Reference: `kalshi-trader/DOCS.md` (the app's Documentation tab) explains every option and screen used below.

---

1. **Kalshi: subaccount, bankroll, API tier, restricted key (demo first).** In the Kalshi **demo** environment
   (`demo.kalshi.co`) create a dedicated **subaccount**, transfer only the trading bankroll to it, upgrade to the
   **Advanced API tier** if subaccounts ask for it (DOCS.md → _Dedicated subaccount and restricted API key_), and
   create an **API key restricted to that subaccount**. Save the key ID and the downloaded `key.pem`; encode the
   key as one line with `base64 -w0 key.pem` (macOS: `base64 -i key.pem | tr -d '\n'`).
   - Expected: a subaccount number between 1 and 63 holding only the bankroll; a key ID; a one-line base64 string.
   - Observed:

2. **Add the repository and install.** In Home Assistant: **Settings → Apps → App store → ⋮ → Repositories**, add
   `https://github.com/petrapa6/sports-trading`, then install **Kalshi Sports Trader** (the Supervisor builds the
   image on the Pi; a few minutes).
   - Expected: the app page shows version `1.0.0`.
   - Observed:

3. **Configure and start.** On the **Configuration** tab set `kalshi_key_id`, `kalshi_private_key_b64` (the base64
   line), `kalshi_env: demo`, `kalshi_subaccount: <the subaccount number>`, `allow_live_orders: false`; keep the
   other options at their defaults. On the **Info** tab enable **Start on boot**, **Watchdog** and **Show in
   sidebar**, then **Start**.
   - Expected in the **Log** tab: `Database ready (N migration(s) applied)` (migrations applied) and
     `Server listening at http://0.0.0.0:8099` (listening on 8099); no `ERROR` / `fatal` line; the key does not
     appear anywhere in the log.
   - Observed:

4. **Open via the sidebar, set up, log in.** Open the app from the Home Assistant sidebar (ingress). The first
   visit shows **Set up**: create the app's user. Log out and log in again. Open **Settings → Trading**.
   - Expected: global **dry run on**, global **kill switch off**, and the add-on lock read-only as
     `allow_live_orders: false (read-only; no real order can be sent)` — the status strip shows
     _Add-on live lock: locked (no live orders)_.
   - Observed:

5. **Backup contains the database; backup password set.** Create a backup (**Settings → System → Backups**, or
   wait for the next Google Drive Backup run) that includes the Kalshi Sports Trader app. Set a **backup password**
   (Home Assistant's backup encryption key and the Google Drive Backup app's password) and store it in your
   password manager.
   - Expected: the backup lists the Kalshi Sports Trader app, and its app data contains `db/trader.db`; the backup
     is password-protected (it also contains `options.json` with the key).
   - Observed:

6. **Cloudflare Tunnel.** In the `cloudflared` app, point the public hostname at the service shown on this app's
   **Info** page — `http://<prefix>-kalshi-trader:8099` (e.g. `http://a0d7b954-kalshi-trader:8099`; DOCS.md →
   _Remote access_). Enable **Cloudflare Access** for the hostname (DOCS.md → _Cloudflare Access_).
   - Expected: the hostname first shows Cloudflare Access, then the app's **login page**; `https://<hostname>/setup`
     returns **403**; logging in through the tunnel works.
   - Observed:

7. **Kalshi connection and discovery.** **Settings → Diagnostics → Test Kalshi connection**; then
   **Settings → Leagues → Run discovery now**.
   - Expected: the connection test succeeds against the demo environment; discovery lists upcoming
     games of the enabled leagues, with **no NHL preseason** games.
   - Observed:

8. **A live NHL evening in dry run.** Create a dry-run strategy (e.g. NHL, 2-goal lead at minute 50), switch its
   kill switch off, and leave everything else as is.
   - Expected: on the next NHL evening the Dashboard game cards update live; the strategy fires and later settles,
     with **`DRY RUN`** badges on the trade, in the Trades page, the charts and the log lines (`"mode":"dry_run"`).
     Record the app's **RAM** from the Info tab during the games (SPEC.md §11 expects ~150 MB idle).
   - Observed (trade id, P&L, RAM):

9. **Global kill switch on a live game.** During a live game turn the global **kill switch** on.
   - Expected: the status strip / Dashboard show the loop as **paused**, the game cards stop updating, the Log shows
     `Polling paused: the global kill switch is on` and no further Kalshi or NHL requests; turn it **off** again
     (password prompt): `Polling resumed: the global kill switch is off` and the cards update again.
   - Observed:

10. **Production, a week of dry run, then one small live strategy.** Create a key in Kalshi **production**
    restricted to the production subaccount (as in step 1). Change the options to `kalshi_env: prod` with that
    key and `kalshi_subaccount`, restart, and keep everything in **dry run for at least a week**. Only then set
    `allow_live_orders: true` (restart), turn **global dry run off** in Settings → Trading (password prompt), and
    enable **one** live strategy with `maxStakeUsd` ≤ 5.
    - Expected: the first live trade shows a `LIVE` badge with environment `prod`, its fill matches the Kalshi
      portfolio of the subaccount, and its fee matches the §2 fee formula (see `docs/verification/T13.md`, _Fee
      check_).
    - Observed:

---

If something goes wrong at any point: turn the global kill switch on (it stops every outgoing request at once),
or set `allow_live_orders: false` and restart (no real order can be sent). If the Pi is ever lost, delete the API
key in Kalshi.
