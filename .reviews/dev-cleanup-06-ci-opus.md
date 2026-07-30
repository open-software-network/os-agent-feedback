# Review — chunk 6 (CI/CD) — opus

Method: I read all four workflows and the serving stack; resolved all nine
pinned action SHAs against the GitHub API; checked every `make` target
referenced in CI against the Makefile by name; and — because the orchestrator
verified status codes but not headers — built the landing image locally and
inspected response headers and the `PORT` override, then removed the container
and image. I ran no `railway` command and made no Railway MCP call. Findings
marked [ran] / [read].

## Blocking

- **Nothing in this diff disconnects Railway's existing repo auto-deploy on the
  production API service, and merging to `main` with it still connected ships
  straight to production.** [read]

  This is a merge precondition, not a defect in the files — I want to be precise
  about that. The workflows themselves are clean: `build-api.yml` targets
  `environment: staging` only, `promote.yml` is `workflow_dispatch`-only, and
  `grep` for `production` across `build-api.yml` and `ci.yml` returns nothing.
  There is no `workflow_run` chain and no push trigger that reaches production.

  But `.briefs/dev-setup-overhaul.md` states the prod service currently has repo
  auto-deploy connected (`branch main`, `/backend`, `checkSuites=false` →
  "ships straight to prod!"). If that is still true when this chunk lands, the
  first push to `main` touching `backend/**` fires `build-api.yml` (staging —
  safe) *and* Railway's own watcher (production — unreviewed, unpromoted). The
  net effect is exactly the outcome the manual-promotion design exists to
  prevent, and no file in this diff can prevent it.

  I could not verify current Railway state — the brief forbids it, correctly. So
  the actionable ask is: confirm the prod service is pinned to an image and
  disconnected from the repo **before** merging, and treat that as a gate rather
  than a follow-up. `.briefs/chunk-06-ci.md:150` asks the implementer to deliver
  that manual list in their reply; it is not in the repo, so it is not
  discoverable by whoever does the merge.

## Non-blocking

- **`ci.yml` has no aggregate gate job, so branch protection must name all five
  jobs individually** — `.github/workflows/ci.yml:15-179`. [read] Every job is
  gated on `needs.changes.outputs.X == 'true'`, so a PR touching only
  `README.md` or `.briefs/**` skips all five.

  To answer the brief's question directly: this does **not** hang and does
  **not** block vacuously. Because `ci.yml` has no workflow-level `paths:`
  filter (`:3-6`), the workflow always runs and always produces check runs, so
  you avoid the "required check stuck pending forever" trap that workflow-level
  path filtering causes. Jobs skipped via `if:` report the `skipped` conclusion,
  which branch protection treats as satisfied.

  The real cost is maintenance: with no `if: always()` summary job asserting
  that every needed job succeeded-or-skipped, the required-check list is five
  entries that must be edited by hand whenever a job is added or renamed. A
  single `ci-ok` gate job is the conventional fix and makes "is the repo green"
  one name instead of five — which matters given this chunk's stated purpose.

- **The Caddyfile sets one of the five security headers the backend already
  sets** — `landing-page/Caddyfile:13`. [ran] I verified against the running
  container: `/`, `/styles.css` and the `/app` 308 all carry
  `X-Content-Type-Options: nosniff` and nothing else. `backend/src/main.rs:268-280`
  sets `x-content-type-options`, `x-frame-options: DENY`,
  `referrer-policy: no-referrer`, a `permissions-policy`, and a full
  `content-security-policy` on every dashboard response.

  So there is an in-repo precedent the marketing origin does not match. The page
  has no JavaScript and no forms, so a strict policy is nearly free —
  `default-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'`
  plus `Referrer-Policy` and `Strict-Transport-Security` would be a handful of
  lines. Note that `auto_https off` (`:2`) means Caddy will not emit HSTS on its
  own, so if Railway's edge does not add it, nothing does.

  On the scoping the brief flagged as suspicious: it is correct, and I checked
  rather than assumed. The bare `header` at `:13` applies site-wide; the
  matcher-scoped `header @static_assets` at `:12` applies only to the three
  named assets. Both take effect, exactly as intended.

- **`index.html` and `/app/index.html` get no `Cache-Control` at all** —
  `landing-page/Caddyfile:11-12`. [ran] Confirmed empirically: `curl -I /`
  returns `Content-Type` and `nosniff` but no `Cache-Control`, because
  `@static_assets` matches only `/styles.css`, `/favicon.svg`, `/og.png`. With
  no directive, browsers and any intermediary apply heuristic freshness to the
  HTML — so a deploy can go out and clients may keep serving the previous page
  for an unpredictable interval. The backend's own convention for this case is
  `public, max-age=0, must-revalidate` (`backend/src/main.rs:264-266`); applying
  something equivalent to the HTML would make deploys deterministic. Worth
  noting the current split is backwards from the usual pattern: the immutable-ish
  assets get a *shorter*-lived policy than the document that references them.

- **`.dockerignore` is a denylist over `COPY . /srv`, so the default for any new
  file in `landing-page/` is "published"** — `landing-page/.dockerignore:5-9`,
  `landing-page/Dockerfile:7`. [read] The current five entries are right and the
  comments are unusually good about *why* `Caddyfile` is excluded from the list
  and deleted in the image instead. The structural point is that adding a file
  to `landing-page/` publishes it at the web root unless someone remembers to
  edit this file.

  Two things sharpen it: `railway up ./landing-page --path-as-root`
  (`deploy-landing.yml:50-51`) uploads working-tree contents, not just tracked
  files, and there is no `landing-page/.railwayignore` — the root
  `.railwayignore` almost certainly does not apply once `--path-as-root` moves
  the root. So a stray untracked file in that directory reaches the image. An
  allowlist (`COPY index.html styles.css favicon.svg og.png app/ /srv/`, or a
  `*` + un-ignore `.dockerignore`) inverts the default to fail-closed. The new
  test at `tests/rendered-html.test.mjs:133-143` guards three of the five
  entries, which helps but is also a denylist.

- **`/app/index.html` is still directly reachable and now redundant** — [ran]
  `curl /app/index.html` → `200`, while `/app` and `/app/` → `308`. The
  meta-refresh page is a second, unadvertised copy of the same redirect. It is
  harmless (same target, and the test at `:104` asserts the two agree, plus
  `noindex`), and keeping it as the no-JS fallback body is defensible — but the
  308 now does the real work, so this is a maintenance seam where the two could
  drift. `/app/deep/link` correctly 404s.

- **CI pins Rust 1.95 while the production image builds on 1.97** —
  `.github/workflows/ci.yml:87` vs `backend/Dockerfile:1`. [ran] `make
  backend-clippy` runs `-D warnings` under 1.95 in CI; the shipped binary is
  compiled by 1.97. Nothing breaks today (the Docker build does not run clippy),
  but the compiler that gates the code is not the compiler that ships it, and
  there is no single source of truth — no `rust-toolchain.toml`, and no
  `rust-version` in `backend/Cargo.toml` (also noted in my chunk-4 review). A
  `rust-toolchain.toml` that both the workflow and the Dockerfile read would
  close it.

- **`dtolnay/rust-toolchain` is the only action pin without a version comment** —
  `.github/workflows/ci.yml:85`. [ran] The SHA
  `4cda84d5c5c54efe2404f9d843567869ab1699d4` is real and is the tip of
  `refs/heads/stable` — the idiomatic way to pin that action, so the pin is
  correct. But every other pin carries `# v3` / `# v6` / `# v7`, and this one
  carries nothing, so a reader cannot tell what they are on. `# stable` would
  make it consistent.

- **`deploy-landing.yml` has no deployment-status wait, unlike the two API
  deploys** — `.github/workflows/deploy-landing.yml:50-56`. [read]
  `build-api.yml:135-166` and `promote.yml:179-210` both poll
  `railway deployment list` until a new deployment reports `SUCCESS`, and fail
  on `FAILED|CRASHED|REMOVED`. The landing deploy just calls `railway up … --ci`
  and finishes. I did not run `railway --help` to confirm whether `--ci`
  propagates a post-upload build failure, since the brief bars running the CLI —
  so this is "worth confirming" rather than a stated defect. If `--ci` returns
  on upload rather than on build completion, a broken Caddyfile would produce a
  green workflow and a dead marketing site. Given the two sibling workflows
  already contain the polling pattern, reusing it here would remove the doubt.

- **Production is pinned by SHA *tag*, not by digest** —
  `.github/workflows/promote.yml:112,175`. [read] The resolution job does
  excellent work: it inspects the source, extracts
  `org.opencontainers.image.revision`, derives the 7-char tag, and refuses to
  proceed unless `IMAGE:<sha>` resolves to the *same digest* as the requested
  tag (`:79-88`). That satisfies the master brief's requirement ("exact SHA tag,
  never the mutable `staging` tag") and I confirmed `deploy-staging` uses
  `sha_short` too (`build-api.yml:86`), never `:staging`.

  The residual point is that a tag is mutable in principle — and this very
  workflow proves it, by rewriting `$IMAGE_REF` at `:135-137`. Railway is handed
  `IMAGE_REF`; `IMAGE_DIGEST_REF` is already computed one line away. Pinning
  `source.image` to the digest would make the deploy immutable by construction
  rather than by convention. Relatedly, that `imagetools create` step at
  `:132-137` is a no-op given the digest equality already asserted at `:85-88`.

- **`from-tag` accepts 8-40 character SHAs that can never resolve** —
  `.github/workflows/promote.yml:7,38`. [read] The regex allows
  `^[0-9a-f]{7,40}$` and the input description advertises "7-40 character", but
  images are only ever tagged with `--short=7` (`build-api.yml:37`). A full
  40-char SHA passes validation and then fails at `:58` with "Image … does not
  exist" — a confusing error for a plausible input. Either narrow the regex to
  `{7}` or truncate to 7 before building `$source`.

  Rollback itself works: I traced a 7-char historical tag through the whole
  resolve path — validation passes, the image exists, the revision label yields
  the same 7 chars, digests match, and the deploy proceeds.

## Verified clean — stating plainly so these are not re-audited

- **No path in any workflow auto-deploys the API to production.** [ran]
  `promote.yml:3-4` is `workflow_dispatch` only; `build-api.yml` contains no
  occurrence of the string `production`; there is no `workflow_run` trigger
  anywhere. `deploy-landing.yml` does deploy production on push to `main`, which
  is what `.briefs/dev-setup-overhaul.md` specifies for the *landing page* — the
  asymmetry with the API is intentional, not a violation.

- **Every `make` target referenced in CI exists.** [ran] All ten —
  `backend-fmt-check`, `backend-clippy`, `backend-test`, `node-install`,
  `biome-check`, `node-test`, `landing-check`, `sdk-node-test`, `docs-validate`,
  `docs-a11y` — match a target definition in the Makefile by name. No typos.

- **All nine pinned action SHAs exist and match their version comments.** [ran]
  Resolved via the GitHub tags API: `actions/checkout` → v7 (v7.0.1),
  `actions/setup-node` → v6 (v6.5.0), `actions/cache` → v5 (v5.1.0),
  `docker/setup-buildx-action` → v3 (v3.12.0), `docker/login-action` → v3
  (v3.7.0), `docker/build-push-action` → v6 (v6.19.2), `dorny/paths-filter` →
  v3, `pnpm/action-setup` → v6, and `dtolnay/rust-toolchain` → tip of `stable`.
  No wrong-SHA hard failure awaits the first run.

- **No local composite actions are referenced.** [ran] `grep 'uses: \./'`
  across all four workflows returns nothing, so the os-platform pattern was
  correctly adapted rather than copied.

- **Node is 22 in all seven `setup-node` steps** across the four workflows.
  [ran] `mint` cannot run on 25+, and nothing here would give it 25+.

- **pnpm setup ordering is correct in all four Node jobs.** [read]
  `pnpm/action-setup` precedes `setup-node` with `cache: pnpm` in each of
  `node`, `landing`, `sdk-node`, `docs` (`ci.yml:112-117, 132-137, 150-155,
  168-173`), so the cache step will find pnpm rather than failing.

- **`cancel-in-progress` is right for every workflow.** [read] `ci.yml:13`
  cancels only on `pull_request` (`${{ github.event_name == 'pull_request' }}`),
  so main-branch runs queue. `build-api.yml:17`, `promote.yml:18` and
  `deploy-landing.yml:15` are all `false` — no half-finished image push or
  in-flight deploy gets cancelled.

- **`permissions:` are minimal and correctly placed.** [read] `ci.yml:8-9` is
  `contents: read` only. `build-api.yml:11-13` grants `packages: write` at
  workflow level for the push, and `deploy-staging` narrows itself back to
  `contents: read` (`:81-82`) — good least privilege. `promote.yml:12-14` needs
  `packages: write` in both jobs because the `deploy` job retags `:production`
  (`:215-217`). `deploy-landing.yml:10-11` is `contents: read`.

- **The `node` filter genuinely covers the Rust↔JS coupling.** [read]
  `ci.yml:42` includes `backend/**`, which covers the `backend/src/store.rs`
  and `backend/src/main.rs` reads in `tests/setup-page.test.mjs` — the exact
  coupling that commit `581c37f` had to fix on this branch. It also covers
  `backend/public/*` for the dashboard suites.

- **Every check `docs.yml` ran survived into `ci.yml`, with wider path
  coverage.** [ran] The deleted workflow ran `docs:validate`, `docs:a11y`, and
  `node --test tests/docs-contract.test.mjs`. The first two are the `docs` job;
  the third is covered by the `node` job, because `make node-test` globs
  `tests/*.test.mjs` and that file matches. All five of the old trigger paths
  (`docs/**`, `sdk/**`, `protocol/**`, `backend/public/app.js`,
  `tests/docs-contract.test.mjs`) are present in the `node` filter, three of
  them via supersets (`backend/**`, `tests/**`). Nothing lost. The old workflow
  also used `npm ci` against a deleted lockfile, so it could not have run at all
  after chunk 2 — deleting it was necessary, not just tidy.

- **`:{$PORT:8080}` is correct for Railway's injected port.** [ran] I ran the
  image with `-e PORT=3000` and `/` returned 200 on 3000, then with
  `PORT=8080` and it returned 200 on 8080. The default fallback works and the
  override works.

- **`healthcheckPath: "/"` is sensible** — `landing-page/railway.json:8`. [ran]
  `/` serves `index.html` with a 200, so the check exercises both Caddy and the
  document root. `healthcheckTimeout: 120` with `ON_FAILURE` / 3 retries is
  reasonable for a static image.

- **`deploy-landing.yml`'s path filter covers the new config files.** [read]
  `Caddyfile`, `Dockerfile`, `.dockerignore` and `railway.json` all live inside
  `landing-page/`, which `:7` matches as `landing-page/**` — so a Caddyfile-only
  change does trigger a redeploy. The workflow deploys this image:
  `railway up ./landing-page --path-as-root` (`:50-51`) makes that directory the
  build root, and `railway.json` selects `DOCKERFILE` / `Dockerfile`.

- **Missing secrets fail loudly, not silently.** [read] All three deploy jobs
  check `RAILWAY_TOKEN` and `RAILWAY_PROJECT_ID` and emit `::error::` with an
  explicit message before doing anything (`build-api.yml:98-105`,
  `promote.yml:142-149`, `deploy-landing.yml:41-48`). Since the staging
  environment and the token do not exist yet, this is the right first-run
  behaviour.

- **Scope is clean.** [ran] `git status --short` shows changes confined to
  `.github/workflows/` (four added, `docs.yml` deleted), `landing-page/` (four
  added), and `tests/rendered-html.test.mjs`. No tracked file outside those
  three areas changed. There is no evidence in the repo of Railway CLI runs,
  variable writes, or service changes; the only Railway artifact added is the
  declarative `landing-page/railway.json`. I ran no Railway command myself.

## Verdict

FIX-FIRST — the workflow files are careful, correct, and verifiably safe
(manual-only API promotion, exact-SHA pinning, all pins and make targets
resolved, headers and `$PORT` confirmed against the built image); what blocks is
outside the diff: Railway's existing repo auto-deploy on the production API
service must be disconnected before this merges, or the first `backend/**` push
to `main` ships to production unpromoted.
