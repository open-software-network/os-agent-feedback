# Landing page joins the promote flow — brief

Goal: landing deploys stop bypassing the promotion model. Same trunk shape
as the API: main → GHCR image → staging auto-deploy; production ONLY via
manual promote. One mental model for every artifact.

## Changes (all in .github/workflows/ + docs touchups)

1. NEW `build-landing.yml` — clone the structure of `build-api.yml`:
   - Trigger: push to main touching `landing-page/**` or the workflow file;
     workflow_dispatch.
   - docker build `landing-page/` (Caddy Dockerfile already there) → push
     ghcr.io/open-software-network/os-epode-landing tagged `<short-sha>` +
     `staging` (same label/caching conventions as build-api.yml).
   - Deploy to Railway staging: service `epode`, environment `staging`,
     image pin via the same `railway environment edit --service-config`
     PTY-shim pattern + discover-freeze-poll deployment tracking EXACTLY as
     build-api.yml does it (copy the hardened loop verbatim, adjust names).
   - RAILWAY_TOKEN step-scoped (never job-level). RAILWAY_PROJECT_ID from
     vars. GitHub environment: staging.
2. EXTEND `promote.yml`:
   - `artifact` input (choice): `api` (default) | `landing` | `all`.
     Resolve/retag/pin/poll per artifact; `all` does both. Keep the
     existing digest-verification logic; parameterize image name
     (os-epode-api / os-epode-landing) and Railway service name
     (epode-api / epode).
   - Landing production target: service `epode`, environment `production`.
3. DELETE `deploy-landing.yml` (the railway-up path is retired).
4. Update ci.yml ONLY if its `workflows` filter/lint doesn't already cover
   the new file (it globs .github/workflows/** — it does; verify, don't
   churn).
5. Touch README/docs where the deploy flow is described, if anywhere.

## Constraints
- actionlint (with shellcheck) must pass: CI runs it via the Workflow lint
  job. Run `actionlint .github/workflows/*.yml` locally before each commit.
- Follow existing pinned-action-SHA style; reuse the exact pins already in
  the repo's workflows. No new third-party actions.
- Injection safety: any workflow_dispatch input goes through env: vars and
  is validated (copy from-tag validation pattern).
- Do NOT touch live infra; do NOT push; commits terse lowercase
  `type: what changed`; if commit signing fails use
  `git -c commit.gpgsign=false commit`.
- Verify: actionlint green + `pnpm test` (nothing should break, but the
  suite is cheap) before declaring done.

## Out of scope
- web/ artifact (arrives with the dashboard-rewrite track; promote.yml's
  artifact parameterization should make adding it trivial — keep it table
  driven).
- Railway-side changes (staging domain, first image pin, service source
  flip): handled by the control pane.

## Orchestrator notes (verified before dispatch)

- `ci.yml` line 77-78: the `workflows` filter is `- ".github/workflows/**"`.
  It ALREADY covers `build-landing.yml`. Step 4 = verified, do NOT edit ci.yml.
- `actionlint 1.7.12` + `shellcheck` are on PATH locally. Baseline
  `actionlint .github/workflows/*.yml` is GREEN on this worktree — keep it green.
- Existing action SHA pins to reuse verbatim (do not invent new ones):
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`
  - `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6`
  - `docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3`
  - `docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3`
  - `docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6`
- `RAILWAY_CLI_VERSION: 5.30.1` — same value in every workflow.
- Service name mapping: api -> `epode-api`, landing -> `epode`.
  Image mapping: api -> `os-epode-api`, landing -> `os-epode-landing`.
- Table-driven means: a `plan` job that turns the `artifact` input into a JSON
  matrix (one row per artifact, carrying image name + service name), consumed by
  `strategy.matrix` on the resolve/deploy jobs. Adding `web` later = one row.
  Rename the workflow `name:` from "Promote API" to something artifact-neutral
  and update the step-summary/error strings that hardcode "API"/`epode-api`.
- Do NOT commit and do NOT push — the orchestrator commits.
- Do NOT run any `railway` command. No live infra.
