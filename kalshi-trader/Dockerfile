# Kalshi Sports Trader — Home Assistant app image (SPEC.md §11), aarch64 + amd64.
# Both stages use the SAME pinned base: Home Assistant base 3.22-2026.08.0 (Alpine 3.22, nodejs 22.x),
# chosen in T05 — see docs/decisions/0002-base-image.md.
FROM ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63 AS build
RUN apk add --no-cache nodejs npm python3 make g++
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/ .
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
RUN apk add --no-cache nodejs su-exec \
 && adduser -D -u 1000 trader
WORKDIR /app
COPY --from=build --chown=trader:trader /app/dist ./dist
COPY --from=build --chown=trader:trader /app/node_modules ./node_modules
# Drizzle migrations are read at start-up (src/db/migrate.ts: <app>/migrations); see SPEC.md T05 notes.
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
