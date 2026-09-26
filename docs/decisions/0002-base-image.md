# 0002 — Pinned Home Assistant base image

- **Status:** accepted (T05, 2026-09-26)
- **Context:** SPEC.md §11 builds and runs the app from the **same** pinned `ghcr.io/home-assistant/base`
  tag + digest (no `build.yaml`, no `BUILD_FROM` since Supervisor 2026.04). T05 picks it: the tag must exist for
  both arches (`aarch64` = `linux/arm64`, `amd64`) and its Alpine must ship `nodejs` ≥ 22 (§4 Stack). The
  reference app (Family Dashboard) uses `node:20-alpine`, so there was no tag to copy (§14).

## Decision

`ghcr.io/home-assistant/base:3.22-2026.08.0@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63`
for both stages of `kalshi-trader/Dockerfile`.

| Check | Result (2026-09-26) |
| --- | --- |
| Tag exists, digest | `docker buildx imagetools inspect ghcr.io/home-assistant/base:3.22-2026.08.0` → index `sha256:0eda502b…6373f63` |
| `linux/amd64` | `sha256:9ab2a1d5c8399ae3c38e1828bf56abccd8db4a3e56410b956169b8fc21fc806e` |
| `linux/arm64` | `sha256:bfa5fb9fb71e9442bd9fb3a9539f53fcf8845b64e3624b2c7e155d0b1283877a` |
| `nodejs` ≥ 22 | Alpine 3.22 ships `nodejs` 22.x (the LTS line used in development and CI); asserted on every image build by `npm run verify:T05` (`node --version` in the built image, recorded in `docs/verification/T05.md`) |

## Why 3.22 and not 3.23 / 3.24

- The newest HA base tags at the time were `3.24-2026.08.0`, `3.23-2026.08.0` and `3.22-2026.08.0` (all
  published the same day, all multi-arch). Alpine 3.22 packages `nodejs` from the 22.x line; newer Alpine
  releases follow newer Node LTS lines.
- Node 22 is the version the project is developed, tested and type-checked against (`engines: >=22`,
  `@types/node` 22, CI `node-version: 22`), so 3.22 keeps the container on the same major as every test run and
  as the native-module ABI `better-sqlite3` and `argon2` are compiled for in CI. Alpine 3.22 is supported until
  2027-05; Node 22 until 2027-04.
- Revisit (a one-line change of tag + digest, both stages) when moving the project to Node 24; T14 re-checks
  for a newer `3.22-*` release before v1.0.0.

## Consequences

- Build and runtime stages are byte-identical bases, so `better-sqlite3` compiled in the build stage matches the
  runtime Node and musl exactly.
- The digest pins the whole multi-arch index; the Supervisor on the Pi resolves the `arm64` entry.
