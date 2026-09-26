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
6. The **Log** tab shows JSON lines; `Server listening` means the app is up.

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

## Data Storage

| Path | Contents |
| --- | --- |
| `/data/options.json` | The options above, written by the Supervisor (root-owned; the app process cannot write it) |
| `/data/db/trader.db` (+ `-wal`, `-shm`) | The SQLite database: strategies, trades, attempts, settings, audit log |
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
