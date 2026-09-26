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
