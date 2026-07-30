# Review task — chunk 6 (CI/CD workflows + landing-page serving)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`, chunk
brief `.briefs/chunk-06-ci.md`. Chunks 1-5 committed. This is the final chunk,
uncommitted.

Changes: four new workflows (`ci.yml`, `build-api.yml`, `promote.yml`,
`deploy-landing.yml`), `docs.yml` deleted (merged into `ci.yml`), and a new
`landing-page/` serving stack (`Caddyfile`, `Dockerfile`, `.dockerignore`,
`railway.json`) plus assertions in `tests/rendered-html.test.mjs`.

## Already verified — do not redo

The orchestrator ran these:
- `caddy validate` against the Caddyfile in the real `caddy:2.10.2-alpine`
  image: **Valid configuration**.
- Built the image and exercised the running container: `/` `/styles.css`
  `/favicon.svg` `/og.png` → 200; `/app` and `/app/` → **308** with
  `Location: https://app.epode.ai/auth/start`; `/Caddyfile` `/Dockerfile`
  `/railway.json` `/package.json` → 404 after the `.dockerignore` +
  `rm -f /srv/Caddyfile` fix.
- `pnpm test` 62/62, `pnpm check` clean.

## What to actually check

This is the chunk where mistakes reach production, so weight accordingly.

1. **Deployment safety.** Read `build-api.yml` and `promote.yml` closely.
   - Does anything auto-deploy **production**? The master brief is emphatic:
     production moves only via `workflow_dispatch`. Confirm no path — including
     `workflow_run` chaining, a `push` trigger, or a job in `build-api.yml` —
     can reach production.
   - Does staging deploy pin the **exact SHA tag**, never the mutable `staging`
     tag? A service pinned to `staging` silently redeploys on someone else's
     build.
   - In `promote.yml`, is the `from-tag` → SHA resolution correct, and can a
     rollback to an older SHA actually work?
   - Is `cancel-in-progress` correct per workflow? Cancelling a half-finished
     image push or a deploy is worse than queueing.
   - Are `permissions:` minimal and correct per workflow (`packages: write`
     only where an image is pushed)?

2. **Does CI actually gate anything?** For each job in `ci.yml`:
   - Every `run:` must call a make target that **exists** in the Makefile.
     Check each against the Makefile by name — a typo only surfaces after merge.
   - The `changes` job gates every other job with
     `if: needs.changes.outputs.X == 'true'`. What happens on a PR that touches
     none of the filters — do all jobs skip, and would a required-status-check
     rule then pass vacuously or hang? Note that a skipped job reports
     "skipped", not "success", which matters for branch protection.
   - The `node` filter includes `backend/**` and `docs/**`. That looks
     deliberate (the JS suite asserts against `backend/public/*` and
     `backend/src/*` source text — a `pub`→`pub(crate)` change in Rust already
     broke a Node test once in this very branch, see commit `581c37f`). Confirm
     the filter genuinely covers that coupling, including
     `tests/setup-page.test.mjs`'s reads of `backend/src/store.rs` and
     `backend/src/main.rs`.
   - `docs.yml` was deleted. Did every check it ran survive into `ci.yml`,
     including its path coverage (`backend/public/app.js`,
     `tests/docs-contract.test.mjs`, `protocol/**`, `sdk/**`)?

3. **Will it actually run?** Pinned action SHAs: confirm each referenced action
   and ref plausibly exists and that the SHA matches the commented version tag
   (a wrong SHA is a hard failure on first run). Confirm no reference to a local
   composite action (`./.github/actions/...`) — this repo has none. Confirm the
   Node version is 22 everywhere (mint hard-fails on 25+) and that pnpm setup
   ordering is right (`pnpm/action-setup` before `setup-node` with
   `cache: pnpm`, otherwise the cache step fails).

4. **The landing-page serving stack.** The behavior is proven; review the
   remaining judgment:
   - `Caddyfile` binds `:{$PORT:8080}` — is that how Railway provides the port?
   - `railway.json` sets `healthcheckPath: /`. Sensible?
   - Security headers: only `X-Content-Type-Options` is set, scoped oddly
     (a bare `header` inside the site block vs the `@static_assets` matcher just
     above it — check the scoping is what was intended). Is anything important
     missing for a static marketing page?
   - `Cache-Control` is only applied to three named assets. What about
     `index.html` and `/app/index.html`?
   - Does `deploy-landing.yml` actually deploy this image, and does its path
     filter cover the new config files (a Caddyfile change must trigger a
     redeploy)?

5. **Scope.** Confirm nothing outside `.github/workflows/`, `landing-page/`, and
   `tests/rendered-html.test.mjs` changed, and that **no live Railway
   infrastructure was touched** — no evidence of `railway` CLI runs, MCP calls,
   variable writes, or service changes. This was a hard limit.

## Do NOT

- Do not modify any file. Report only.
- Do not run any `railway` command or Railway MCP call. Do not deploy anything.
- Do not push. Do not touch `~/.cache`, `node_modules`, or `backend/target`.
- Do not edit anything under `.briefs/` or `.reviews/` except your output file.

## Output

Write to the file named in the prompt that dispatched you:

```
# Review — chunk 6 (CI/CD) — <your reviewer name>

## Blocking
- <finding> — file:line — why

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Cite file and line, mark findings [ran] / [read]. Anything that could deploy
the wrong thing to production is blocking. Reply with only the file path and
your one-line verdict.
