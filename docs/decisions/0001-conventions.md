# 0001 — Conventions adopted from `petrapa6/family-dashboard`

- **Status:** accepted (T01, 2026-09-25)
- **Context:** SPEC.md §14 asks the agent to read `petrapa6/family-dashboard` (`repository.yaml`,
  `config.yaml`, `Dockerfile`, `run.sh`, the code creating the DB path under `/share`, and its GitHub
  Actions workflows) before T01 and again before T05, and to mirror the conventions §11 leaves open.

## Reference repository not reachable in T01

`petrapa6/family-dashboard` was **not reachable** from the T01 session: the repository could be attached to
the session, but cloning it was refused by the session's permission policy, so none of its files were read.
Per SPEC.md §14 ("if neither is available the agent says so and proceeds from §11 alone"), every convention
below comes from SPEC.md §11 alone. **T05 must re-check `family-dashboard`** and record any difference here
and in `kalshi-trader/CHANGELOG.md`.

## Conventions (from SPEC.md §11)

| Topic | Convention | Source |
| --- | --- | --- |
| Slug | `kalshi-trader` (lower-case, hyphenated); app directory `kalshi-trader/` at the repository root; tunnel hostname `<repo-prefix>-kalshi-trader` | §11 `config.yaml`, §10 Tunnel |
| `map` entries | exactly one: `type: share`, `read_only: false` (the SQLite DB lives in `/share/kalshi-trader`, backed up nightly). No `config`, `ssl`, `addons` or `homeassistant_config` maps. | §11 `config.yaml` |
| Base image tag | `ghcr.io/home-assistant/base:<PINNED_TAG>@sha256:<DIGEST>`, the **same** pinned tag + digest for the build and runtime stages; the concrete tag/digest is chosen in T05 (it could not be copied from `family-dashboard`). Node comes from the base image's `nodejs` package and must be ≥ 22. | §11 `Dockerfile`, §4 Stack |
| DB path handling | `DB_PATH=/share/kalshi-trader/trader.db`, `DATA_DIR=/data/app`; `run.sh` (root) runs `mkdir -p /share/kalshi-trader /data/app`, `chown -R trader:trader` both, `chmod 700 /data/app`; the connection helper (T02) also creates the `DB_PATH` directory if missing. Local development: `./.local/trader.db` and `./.local/data` (git-ignored). | §11 `run.sh`, §12, T02 |
| Translations | `kalshi-trader/translations/en.yaml` with option labels and descriptions (T05) | §11 layout |
| Labels | `io.hass.version`, `io.hass.type="app"`, `io.hass.arch="aarch64\|amd64"` in the Dockerfile (T05) | §11 `Dockerfile` |
| Workflows | `.github/workflows/ci.yml` (T01: lint, typecheck, test, e2e, `npm audit --audit-level=high`, gitleaks); `image.yml` (arm64 + amd64 build, T05); optional disabled `publish.yml` | §11 layout, §12 |
| Version | `version` in `config.yaml` equals `package.json` `version` (both `0.1.0` now) | §11 Behaviour |

## Consequences

- Nothing here conflicts with SPEC.md, so there is no difference to note in `CHANGELOG.md` yet.
- T05 re-reads `family-dashboard` and may refine the base image tag, translations style, labels and workflows.
