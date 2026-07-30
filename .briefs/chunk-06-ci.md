# Chunk 6 — trunk-based CI/CD workflows

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md` —
re-read its "Trunk-based CI/CD" and "Railway" sections. Chunks 1-5 are
committed. This is the final chunk.

## HARD LIMIT — read this first

**Workflow FILES only. Do not touch live Railway infrastructure.**
No creating environments, no creating/modifying services, no setting variables,
no tokens, no `railway up`, no `railway link`, no MCP calls to Railway. The
staging environment and the `RAILWAY_TOKEN` secret **do not exist yet** — Jakub
creates those separately. Your job is to write workflows that will work once he
does, and to state clearly in your summary exactly what he must create.

Also: do not push, do not open a PR, do not commit.

## Reference

`/Users/jakubswierczek/code/alongside/os-platform/.github/workflows/` —
`api.yml`, `build-api.yml`, `promote.yml`. Read them for shape: path filtering,
per-ref concurrency groups, pinned action SHAs, GHCR login, `sha_short` tagging,
`staging` GitHub environment binding, step summaries.

**Adapt, do not copy.** os-platform uses Blacksmith runners
(`blacksmith-4vcpu-ubuntu-2404`) and local composite actions
(`./.github/actions/setup-rust`, `railway-deploy`, `changed-paths`). os-epode
has **none** of those. Use `ubuntu-latest` and write the steps inline. Do not
invent references to composite actions that do not exist in this repo — a
workflow referencing a missing local action fails immediately.

## Workflows to write

### 1. `ci.yml` — PR + main checks
- Triggers: `pull_request`, and `push` to `main`.
- Per-ref concurrency group, `cancel-in-progress: true` for PRs.
- `permissions: contents: read`.
- Path-filtered jobs. Use `dorny/paths-filter` (pin to a SHA) or the
  `paths:`/`paths-ignore:` trigger keys — pick one and be consistent.
- **CI must call `make` targets only.** Chunk 5 built the Makefile for exactly
  this: `make backend-fmt-check`, `make backend-clippy`, `make backend-test`,
  `make biome-check`, `make node-test`, `make landing-check`,
  `make sdk-node-test`, `make docs-validate`, `make docs-a11y`. No inline
  `cargo` or `pnpm` invocations in the YAML.
- Node setup: **Node 22** (`actions/setup-node`). `engines` is
  `>=22.13.0 <25` and `mint` refuses Node 25+. Use pnpm via
  `pnpm/action-setup` reading `packageManager` from `package.json`, and cache
  the pnpm store. Install with `--frozen-lockfile` (that is what `make
  node-install` does).
- Rust setup: install the toolchain plus `clippy` and `rustfmt`, and cache
  `~/.cargo` + `backend/target`. `backend/Cargo.toml` now declares
  `rust-version = "1.95"`.
- Note: 5 backend tests are `#[ignore]`d because they need Postgres. Do not add
  a database service to make them run — that is out of scope. Leave them
  ignored.

### 2. `build-api.yml`
- On push to `main` touching `backend/**` or this workflow; plus
  `workflow_dispatch` as an escape hatch.
- Build `backend/Dockerfile`, push to
  `ghcr.io/open-software-network/os-epode-api` tagged with the 7-char short SHA
  **and** `staging`.
- `permissions: contents: read, packages: write`; login with
  `secrets.GITHUB_TOKEN`.
- Then a `deploy-staging` job bound to the GitHub `staging` environment that
  points the staging `agent-feedback-api` service at the **exact SHA tag**
  (never `staging`, so the deployment records the commit). Use the Railway CLI
  inline. It will not run until Jakub creates the environment and token —
  that is expected.
- `concurrency: cancel-in-progress: false` (never cancel a half-finished push).

### 3. `promote.yml`
- `workflow_dispatch` **only**. Never automatic — the master brief is explicit.
- Inputs: `from-tag` (default `staging`, or a short SHA for rollback).
- Resolve the source tag to a concrete SHA tag, retag to `production`, and
  point the production `agent-feedback-api` service at the **exact SHA image**.
- Bind to a `production` GitHub environment so Jakub can attach an approval
  rule.
- `concurrency: group: promote-production, cancel-in-progress: false`.

### 4. `deploy-landing.yml`
- On push to `main` touching `landing-page/**` or this workflow → `railway up`
  to the `epode` service, production environment. Needs `RAILWAY_TOKEN`.

### 5. `docs.yml` — port the existing file
- It currently uses `npm ci` / `npm run docs:validate` / `npm run docs:a11y` /
  `node --test tests/docs-contract.test.mjs`. Port to pnpm + make targets.
- Decide whether it should be **merged into `ci.yml`** rather than kept
  separate — `ci.yml` already needs docs jobs and the path filters overlap.
  Merging is probably right; if you merge, delete `docs.yml` and say so. If you
  keep it separate, justify why.
- Its current path filter includes `backend/public/app.js` and
  `tests/docs-contract.test.mjs` — preserve that coverage wherever the job ends
  up. Note that `tests/docs-contract.test.mjs` is one of the 58 tests
  `make node-test` already runs.

## Two carried-forward findings to resolve here

These came out of the chunk 1 review and were deliberately deferred to chunk 6:

1. **`/app` is a 200 + `<meta http-equiv="refresh">`, not an HTTP redirect.**
   Browsers follow it; `curl`, crawlers, and non-browser agents — the very
   clients this product exists to serve — do not. Fix it at the host layer:
   serve `landing-page/` with a config that issues a real **308** for `/app` to
   `https://app.epode.ai/auth/start`, keeping `landing-page/app/index.html` as
   the fallback body.
2. **`landing-page/` has no static-serving config at all.** Its `package.json`
   has no scripts and no deps, so Railway's builder has nothing to detect, and
   `/styles.css`, `/favicon.svg`, and the `/app` directory-index resolution all
   assume the doc root is `landing-page/`. The deploy target is currently
   unproven.

   Solve both together: add a small static-server config to `landing-page/`
   (a `Caddyfile` is the natural fit — it gives you the doc root, the 308, and
   sane caching headers in a few lines) plus whatever `railway.json` /
   builder hint Railway needs to use it. Verify the config is syntactically
   valid locally if you can do so without network access or installing
   anything heavyweight; if you cannot verify it, say so plainly rather than
   claiming it works.

   Then add an assertion to `tests/rendered-html.test.mjs` that the redirect
   config exists and points at the right URL, so the two files cannot drift.

## Do NOT

- Do not touch Railway live infrastructure (see HARD LIMIT above).
- Do not modify `backend/src`, `sdk/`, `biome.json`, or the Makefile — except
  that you MAY add a Makefile target if a workflow needs one that is missing.
  Say so if you do.
- Do not edit anything under `.briefs/` or `.reviews/`.
- Do not commit, do not push.

## Done looks like

- All workflow YAML parses. Validate it — `actionlint` if available, otherwise
  a YAML parse plus a careful read. Say which you did.
- Every `run:` line in CI calls a `make` target that actually exists in the
  Makefile. Check each one against the Makefile; a typo here is a CI break that
  only shows up after merge.
- Every referenced action is pinned and actually exists (no local composite
  actions).
- `make check` still passes locally, and `pnpm test` is 58/58 (or higher if you
  added the redirect-config assertion).

## Report

Reply with: the workflow files you created, whether you merged `docs.yml`, how
you solved the `/app` 308 and the static-serving config, how you validated the
YAML, and — as an explicit list — **everything Jakub must create in Railway and
in GitHub settings (environments, secrets, variables) before any of these
workflows can succeed.**
