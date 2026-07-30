# Phase 2 chunk 2c review — web deploy

Reviewer: grok. Uncommitted: `web/Dockerfile`, `.dockerignore`,
`.github/workflows/build-web.yml`, `promote.yml` delta.
Against `.briefs/phase2-deploy.md`. Docker run success already verified by
orchestrator — not re-run.

---

## minor — `.dockerignore` allowlist re-includes `web/.env*`
file: .dockerignore:1-15

Pattern is `*` then `!web/**`, then only strips `node_modules` / `.next` /
`target`. Root `.env` stays out; **`web/.env`, `web/.env.local`,
`web/.env.production`, etc. are not denied** and are copied by
`COPY web ./web` whenever present on the builder machine.

Failure mode: local `docker build` with a developer env file puts secrets into
BuildKit context/cache and the builder layer. CI clean checkouts are fine
(repo gitignores `.env*`). Brief explicitly asked to keep `.env` files out of
context.

Suggested fix: after the allowlist, add e.g. `**/.env` and `**/.env.*` (and
optionally `!**/.env.example` if needed later).

---

## Checked clean

### build-web.yml vs build-api.yml
- Same pinned SHAs: checkout@3d3c42e, setup-buildx@8d2750c, login@c94ce9f,
  build-push@10e90e3, setup-node@2499707.
- Same permissions (`contents:read` + `packages:write` build; deploy
  `contents:read` only).
- Same tagging: `os-epode-web:<sha7>` + `:staging`.
- Same Railway staging mechanism: `RAILWAY_CLI_VERSION: 5.30.1`,
  `secrets.RAILWAY_TOKEN`, `vars.RAILWAY_PROJECT_ID`, PTY
  `environment edit` / `redeploy`, deployment discovery poll — only service
  name → `epode-web` and image name differ (as required).
- `context: .` + `file: ./web/Dockerfile` matches root-context Dockerfile.
- No invented secret names.

### Path triggers
Fires on `web/**`, root `package.json` / `pnpm-lock.yaml` /
`pnpm-workspace.yaml`, `backend/openapi.json`, `.dockerignore`, workflow self,
plus `workflow_dispatch`. Dockerfile covered via `web/**`. Not over-broad.

### Dockerfile
- Node `22.23.1-bookworm-slim` (in `>=22.13 <25`), pnpm `11.11.0` via corepack.
- Multi-stage deps → build → runtime; runtime is standalone + `web/.next/static`
  + `web/public`, `USER node`, `HOSTNAME=::`, `PORT=3000`,
  `CMD ["node","web/server.js"]`.
- No secrets/URLs baked; `API_URL` is runtime-only (BFF).
- HEALTHCHECK: `fetch('http://localhost:$PORT/')` — Node fetch follows redirects;
  unauthenticated `/` → `/auth/signin` → 200, so `r.ok` is a real liveness signal
  (not stuck on 3xx). Does not prove API_URL; fine for process liveness.

### promote.yml
`web` in choice options, validation case, and artifact_rows
(`os-epode-web` / `epode-web`). Consumed by existing matrix deploy path like
api/landing.

### Gates
```
actionlint build-web.yml promote.yml  → 0
fnm use 22.23.1 && make check         → 0
```
(Docker build/run not re-done per instructions.)

## Verdict
ship with fixes

Only the `.dockerignore` `.env*` hole; rest matches build-api and the brief.
