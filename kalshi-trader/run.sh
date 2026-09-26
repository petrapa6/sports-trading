#!/usr/bin/env bashio
set -e
export KALSHI_ENV="$(bashio::config 'kalshi_env')"
export KALSHI_KEY_ID="$(bashio::config 'kalshi_key_id')"
export KALSHI_SUBACCOUNT="$(bashio::config 'kalshi_subaccount')"
export ALLOW_LIVE_ORDERS="$(bashio::config 'allow_live_orders')"
export LOG_LEVEL="$(bashio::config 'log_level')"
export TRUSTED_PROXIES="$(bashio::config 'trusted_proxies')"
if bashio::config.has_value 'timezone'; then export TZ="$(bashio::config 'timezone')"; fi
export DATA_DIR=/data/app DB_PATH=/data/db/trader.db PORT=8099
mkdir -p /data/db /data/app
chown -R trader:trader /data/db /data/app
chmod 700 /data/db /data/app
exec su-exec trader:trader node /app/dist/server/main.js --kalshi-private-key-fd=3 \
  3< <(bashio::config 'kalshi_private_key_b64' | base64 -d)
