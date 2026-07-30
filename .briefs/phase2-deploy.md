# Chunk 2c — web deploy (Dockerfile + build-web.yml + promote)

**Pulled forward** from its original position at the end of phase 2. Reason: a
designer takes over UI polish as soon as the views exist, so every merge from
here on must land on a staging URL they can open. Shipping the deploy path
before the views is what makes that possible.

Chunks 2a (scaffold) and 2b (BFF proxy) are done. Read `.briefs/phase2-web.md`
and `.briefs/dashboard-rewrite.md` (Deploy section) first.

## Hard limits

- Nothing outside this worktree. `/Users/jakubswierczek/code/alongside/os-platform`
  is **READ-ONLY** reference.
- **No live infrastructure.** Do not touch Railway, GitHub settings, secrets, or
  branch protection. You are authoring workflow and Docker files only. Creating
  the `epode-web` Railway service and pointing domains is the orchestrator's/
  user's job, not yours.
- No `git push`. Do not commit — reviewed first.
- pnpm, never bun.

## 1. `web/Dockerfile`

Next standalone output (`output: "standalone"` is already set in
`web/next.config.ts`).

Reference: `os-platform/web/Dockerfile` (READ-ONLY). **It is bun-based and
single-package — you must rework it for pnpm in a workspace.** That rework is the
whole difficulty of this chunk; everything else is mechanical:

- `web/` is a pnpm **workspace member**. A correct install needs the *root*
  `pnpm-lock.yaml`, `pnpm-workspace.yaml` and root `package.json` in the build
  context, then a filtered install (`pnpm install --frozen-lockfile --filter`).
  Decide and state whether the Docker build context is the repo root or `web/` —
  it almost certainly has to be the root, which affects the `COPY` paths and the
  workflow's `context:`.
- Use a Node base image matching the repo's supported range (`>=22.13.0 <25`) —
  **not** Node 26. Pin it.
- Enable pnpm the way the repo already does elsewhere if there is a precedent
  (check `.github/workflows/*.yml` and `package.json` `packageManager`, which
  pins pnpm 11.11.0); prefer corepack or a pinned pnpm install.
- Multi-stage: deps → build → runtime. Runtime copies `.next/standalone`,
  `.next/static` and `public/` only. Do not ship source or dev dependencies.
- Run as a non-root user.
- Keep these two things from os-platform's Dockerfile, both of which are
  load-bearing on Railway and are commented there — read the comments:
  - `ENV HOSTNAME=::` — Next standalone binds `process.env.HOSTNAME`, which
    Docker sets to the container short ID; without the override Railway's edge
    gets a 502.
  - A `HEALTHCHECK`.
- `PORT` honoured from env, default 3000.
- Add a `.dockerignore` so `node_modules`, `.next`, `.git`, and `backend/target`
  never enter the build context. With a root context this matters a lot —
  `backend/target` alone is gigabytes.

**Verify by actually building it**: `docker build` from the repo root and run the
image, confirming it serves. If Docker is unavailable in your environment, say so
explicitly and do not claim it works.

## 2. `.github/workflows/build-web.yml`

Model it on the existing `.github/workflows/build-api.yml` — same shape, same
pinned action SHAs, same conventions. Per the plan:

- Trigger: push to `main` touching `web/**` (plus the workflow itself, and the
  root pnpm/workspace files and `backend/openapi.json`, since the web build
  depends on them), plus `workflow_dispatch`.
- Build and push to GHCR as `os-epode-web:<sha>` and a `staging` tag, mirroring
  how `build-api.yml` tags.
- Auto-deploy to the Railway **staging** environment the same way `build-api.yml`
  does — copy that mechanism exactly, whatever it is (do not invent a new one).
  If it needs a secret that does not exist yet, name it clearly in your report so
  the orchestrator can flag it for setup; do not invent secret names silently.

Read `build-api.yml` closely before writing anything. Consistency with it matters
more than elegance.

## 3. `promote.yml`

Add `web` as an artifact choice, following exactly how the existing choices are
declared and consumed. Do not restructure the workflow.

## Notes

- `API_URL` is how the web BFF reaches the Rust API over Railway internal
  networking. Document the env vars the image needs in your report (`API_URL`,
  `PORT`, and anything else 2b introduced) so the service can be configured. Do
  not hardcode environment-specific URLs in the image.
- Do not change the existing `ci.yml` web job — it already runs check, typecheck,
  test, types-drift and build.

## Gate

```
fnm use 22.23.1
pnpm --filter @epode/web typecheck && pnpm --filter @epode/web test && pnpm --filter @epode/web build
pnpm check
make check
docker build -f web/Dockerfile .    # from repo root, if docker is available
```

Also sanity-check the workflow YAML parses (the repo has a workflow lint job —
run whatever it runs).

Report: what you built, the gate output, the exact env vars and any secrets the
new workflow expects, and whether you were able to build the image for real.
Then stop.
