# Review — landing page joins the promote flow (`jakub/landing-promote`)

Scope reviewed: `.github/workflows/build-landing.yml` (new, untracked),
`.github/workflows/promote.yml` (modified), `.github/workflows/deploy-landing.yml`
(deleted). Baseline compared against `main`'s `build-api.yml` / `ci.yml`.

Checks run: `actionlint .github/workflows/*.yml` → **green**. No `railway`
command run, nothing committed, nothing fixed.

Verdict: **1 blocker, 4 major, 5 minor, 3 nits.**

---

## Blocker

### B1 — promote's `api` row targets a Railway service with no production domain (EPD-10)
`.github/workflows/promote.yml:70` (`"service": "epode-api"`)

The matrix row hardcodes `epode-api` as the api production service. Per the
active EPD-10 incident, the public API domain lives on **`agent-feedback-api`**;
`epode-api` has no production domain. So a promote run pins the image on
`epode-api`, the discover-freeze-poll loop finds that service's deployment, sees
`SUCCESS`, retags `:production` and reports a green production deploy — while
the service actually serving traffic was never touched. The gate is reporting
success on the wrong service, which is exactly the failure class this loop was
hardened against.

This is inherited from `main` (the pre-refactor `deploy` job already said
`epode-api`), but the refactor is the moment it becomes a data table, and
shipping a table that encodes a known-wrong topology cements it.

**Fix:** do not merge until EPD-10 settles the topology; then set the api row's
`service` to the service that actually owns the production domain
(`agent-feedback-api` on current evidence) and change `build-api.yml`'s staging
service to match whatever the staging counterpart is. Full list of every
hardcoded name to retarget in the final section.

---

## Major

### M1 — matrix job outputs: `resolve`'s per-artifact keys are load-bearing on undocumented merge behavior
`.github/workflows/promote.yml:103-107` (outputs block), `:163-164` (per-artifact
`$GITHUB_OUTPUT` keys), `:189-190` (`needs.resolve.outputs[matrix.digest_output]`)

The scheme is: each leg writes `${ARTIFACT}_digest` / `${ARTIFACT}_sha_short`,
the job declares all four keys, and `deploy` indexes the one for its own
artifact. Cross-contamination of *values* is correctly prevented — the key names
are disjoint per artifact, so the landing leg can never receive the api's SHA or
digest, and the digest cross-check at `:155-158` still runs independently inside
each leg. That part of the design is sound.

What is not sound is the merge. For the `api` leg,
`${{ steps.source.outputs.landing_digest }}` evaluates to the empty string, and
vice versa. GitHub does not merge matrix-leg outputs — the last leg to complete
writes the job's outputs. Whether an empty-string value *overwrites* a
previously-set non-empty one is not documented and has changed behavior across
runner versions; the whole "key outputs by matrix value" pattern rests on empty
values being dropped. If they are not dropped, `artifact: all` fails roughly
whenever the two legs finish in an unlucky order, and does so at
`Prepare verified image references` with "The resolved digest output for landing
is missing or invalid" — confusing, and it fails *after* the production
environment approval was granted.

Failure mode is loud, not silent — the regex guards at `:195-202` do their job —
so this is reliability, not safety.

**Fix (preferred, removes the plumbing entirely):** drop the four job outputs and
have `deploy` re-resolve for itself. It already logs in to GHCR and has Buildx;
add the same `imagetools inspect` of `${IMAGE}:${FROM_TAG}` → digest → sha tag →
digest cross-check inside `Prepare verified image references`, keeping `resolve`
as the pre-approval fail-fast gate. Deterministic, no matrix-output semantics.
**Alternative:** each `resolve` leg writes a small JSON to
`actions/upload-artifact` named `promote-${{ matrix.artifact }}`, downloaded per
leg in `deploy` — but that pulls in an action with no existing pin in this repo,
which the brief forbids without a decision.

### M2 — the outputs block is not table-driven, contradicting the brief's "adding `web` = one row"
`.github/workflows/promote.yml:103-107`

`.briefs/landing-promote.md:69-71` asks for table-driven so a third artifact is
one matrix row. As written, adding `web` requires: a row *and* two new lines in
`resolve.outputs` (`web_digest`, `web_sha_short`). Forget them and the failure is
the same post-approval "resolved digest missing" as M1 — a footgun aimed at
whoever lands the dashboard-rewrite track.

**Fix:** the M1 re-resolve fix removes the outputs block entirely and makes the
claim literally true. If M1 is fixed some other way, at minimum add a comment
above the outputs block: "one pair of keys per matrix row — keep in sync with
`artifact_rows`."

### M3 — `deploy` cannot run at all if any `resolve` leg fails, despite `fail-fast: false`
`.github/workflows/promote.yml:100-102`, `:178`, `:181-183`

`fail-fast: false` keeps the sibling leg *running*, but a matrix job whose leg
fails still fails as a whole, so `needs: [plan, resolve]` blocks **both** deploy
legs. With `artifact: all`, a missing landing staging image (very likely on the
first run, before `build-landing.yml` has ever pushed one) blocks the api
promotion too. That is arguably the safe default, but it is unstated and it is
not what `fail-fast: false` reads as.

**Fix:** either drop `fail-fast: false` (honest: one leg fails, everything stops)
or state the intent in a comment. Do not paper over it with
`if: always()` on `deploy` — a partially-resolved promotion is worse.

### M4 — `build-landing.yml` assumes a service named `epode` exists in the `staging` environment
`.github/workflows/build-landing.yml:112, 119, 126, 134, 149`

The brief puts the Railway-side staging setup on the control pane, so this may
simply be pending — but as written, if `epode` exists only in `production` (which
is what the retired `deploy-landing.yml` implies: it deployed `epode` in
`production` and there is no evidence of a staging landing service), then
`railway service list` returns nothing for the jq select, `current_image` is
empty, and `railway environment edit --service-config epode` runs against a
service that isn't there. It fails loudly, but on every push to `landing-page/**`
until the topology exists — main goes red.

**Fix:** confirm the `epode` service exists in `staging` (and gets a staging
domain) before this merges, or land `build-landing.yml` with only the build job
and add `deploy-staging` once the service exists.

---

## Minor

### m1 — `deploy` re-validates but `resolve` trusts `plan` blindly
`.github/workflows/promote.yml:110`

`FROM_TAG: ${{ needs.plan.outputs.from_tag }}` is consumed without
re-validation. It *is* validated and truncated in `plan` (`:55-64`), and job
outputs are not attacker-controllable here, so this is defense-in-depth only —
worth noting because `deploy` chose to re-validate its inputs (`:195-202`) and
`resolve` did not, so the file is inconsistent about its own trust model.

**Fix:** either re-assert `[[ "$FROM_TAG" == staging || "$FROM_TAG" =~ ^[0-9a-f]{7}$ ]]`
at the top of `Resolve source to immutable SHA tag`, or note in a comment that
`plan` is the sole validation point.

### m2 — no per-job `permissions` narrowing on `plan`
`.github/workflows/promote.yml:34-42`

Workflow-level `permissions` is `contents: read` + `packages: write`. `plan`
runs a jq script and needs neither. `build-api.yml`/`build-landing.yml` set the
precedent by narrowing `deploy-staging` to `contents: read` (`build-landing.yml:81-82`).

**Fix:** add `permissions: {}` to `plan`.

### m3 — `resolve` also needs no `packages: write`
`.github/workflows/promote.yml:96-111`

It only *reads* from GHCR (`imagetools inspect`). Only `deploy` writes (the
`imagetools create` retags at `:228` and `:344`).

**Fix:** `permissions: {contents: read, packages: read}` on `resolve`.

### m4 — `digest_output` / `sha_output` columns are derivable and duplicate the `artifact` column
`.github/workflows/promote.yml:71-72, 78-79`

Every row's values are mechanically `<artifact>_digest` / `<artifact>_sha_short`.
Three columns that must agree is three chances to typo; a typo here resolves to
an empty output and fails post-approval (same class as M1).

**Fix:** drop both columns and index with
`needs.resolve.outputs[format('{0}_digest', matrix.artifact)]`. Moot if M1's
re-resolve fix lands.

### m5 — the `production` environment gate now fires once per matrix leg
`.github/workflows/promote.yml:180-183`

If `production` has required reviewers configured, `artifact: all` produces two
independent approval prompts and a promoter can approve one and not the other,
leaving api and landing at different revisions with a green-ish run. Not wrong,
but it is a behavior change from the single-approval model on `main` and nothing
records it.

**Fix:** document it in the workflow header comment, or add an explicit
`approve-all` gate job that both deploy legs depend on.

---

## Nits

### n1 — step-summary interpolates the raw artifact key
`.github/workflows/promote.yml:170`, `:351` — `### ${ARTIFACT} promotion source`
renders as "### api promotion source". Lowercase in a heading. Cosmetic;
`${ARTIFACT^^}` or a display-name column would read better.

### n2 — `resolve` still emits the now-unused generic `digest` / `sha_short` outputs
`.github/workflows/promote.yml:161-162`. They are read only by the summary step
(`:172-173`), which could use the artifact-scoped ones. Harmless duplication that
invites someone to wire `needs.resolve.outputs.digest` later — which would be the
genuinely cross-contaminating read this refactor exists to prevent. Worth a
comment saying "step output only — never promote to a job output".

### n3 — nothing documents the new flow
Brief item 5 asked to touch README/docs "if anywhere". Confirmed: `README.md`
contains no deploy/CI section and `docs/` is product documentation only, so
there is genuinely nothing to update — item 5 is vacuously satisfied. But the
promote model (main → GHCR → staging auto → manual promote, for two artifacts
now) is recorded nowhere outside `.briefs/`. Consider a short
`docs/agents/`-adjacent note. Out of the brief's scope; flagging as a gap, not a
defect.

---

## Confirmed-correct (checked, no action)

- **Deployment-tracking loop, `build-landing.yml`** — `diff` against
  `main:build-api.yml` shows the *only* deltas are name/path/image/service
  substitutions. Discovery predicate (`id != previous` ∧ `meta.image == IMAGE_REF`
  ∧ `createdAt > mutation_started_at`), the freeze-then-poll structure, the
  in-loop image re-check, the `SUCCESS` / `FAILED|CRASHED|REMOVED` cases, the
  60×10s bound and the timeout exit are all verbatim. `previous_id` is captured
  before the mutation and `mutation_started_at` after both list calls, so the
  ordering that makes the predicate sound is preserved. No subtly-broken copy.
- **Same loop parameterized in `promote.yml`** — every `epode-api` literal became
  `"$SERVICE"` and the jq name filter became `--arg service "$SERVICE"` with
  `select(.name == $service)` (`:257-258`), which is the *correct* way to get a
  shell value into jq (no string-interpolated jq program). `IMAGE_REF` is
  per-leg, so the in-loop image check at `:318` genuinely re-verifies the right
  image for that artifact.
- **Digest cross-check gates each artifact independently** — `:149-158` runs
  inside each leg against that leg's `IMAGE`, and the retag at `:228-230` /
  `:344-346` uses `IMAGE_DIGEST_REF` built from the same leg's `IMAGE`. No path
  by which the api digest can pin the landing tag or vice versa.
- **Injection safety** — `inputs.artifact` and `inputs.from-tag` reach shell only
  via job-level `env:` (`:41-42`), never inline `${{ }}` in a `run:` body. Both
  are validated before use (`:48-58`); `artifact` additionally constrained by
  `type: choice`. The `$GITHUB_OUTPUT` writes at `:91-94` are post-validation and
  `jq -c` guarantees single-line, so no output-injection via newline. `matrix.*`
  values inlined into `env:` originate from a constant jq literal, not user
  input. The `script --command` string at `:273` expands `"$SERVICE"` from that
  same constant table.
- **`RAILWAY_TOKEN` step-scoped** — `build-landing.yml:96-97` and
  `promote.yml:234-235`, both on the deploy step only, never job-level; the
  `npm install --global @railway/cli` steps run without it, matching
  `build-api.yml` and the retired `deploy-landing.yml`.
- **Action pins** — every `uses:` in `build-landing.yml` reuses a SHA already
  present in the repo's workflows and listed in the brief's orchestrator notes
  (checkout `3d3c42e5…`, setup-node `24997072…`, buildx `8d2750c6…`, login
  `c94ce9fb…`, build-push `10e90e36…`). `promote.yml` adds no new `uses:`. No
  third-party actions introduced.
- **`ci.yml` untouched** — its `workflows` filter is `- ".github/workflows/**"`
  (`ci.yml:77-78`), which already covers `build-landing.yml`. Brief item 4
  correctly verified rather than churned.
- **`actionlint` green** including shellcheck over every `run:` body.
- **Scope** — nothing beyond the brief. The one behavioral change not literally
  specified — tightening the revision fallback regex from `^[0-9a-f]{7,40}$` to
  `^[0-9a-f]{7}$` (`:139`) — is correct and required, since `plan` now truncates
  `FROM_TAG` to 7 chars before `resolve` ever sees it.

---

## Hardcoded Railway service names

Every occurrence in the working tree, for retargeting once EPD-10 settles the
topology. Environment is listed because a name may be correct in one environment
and wrong in another.

### In this diff — `.github/workflows/build-landing.yml` (new file), service `epode`, env `staging`

| Line | Context |
|---|---|
| 112 | `--service epode` — `railway deployment list` for `previous_id` |
| 119 | `jq -r '.[] \| select(.name == "epode") \| .source.image'` — current image lookup |
| 126 | `--service epode` — `railway redeploy` (same-image path) |
| 134 | `--service-config epode` — `railway environment edit` inside the PTY shim |
| 149 | `--service epode` — `railway deployment list` inside the poll loop |
| 206 | `- **Service:** \`epode\`` — step summary string |

### In this diff — `.github/workflows/promote.yml` (matrix table), env `production`

| Line | Context |
|---|---|
| 70 | `"service": "epode-api"` — api row. **Wrong per EPD-10** (see B1); production domain is on `agent-feedback-api`. |
| 77 | `"service": "epode"` — landing row. Matches the retired `deploy-landing.yml` target; believed correct. |

Everything downstream in `promote.yml` reads `$SERVICE` from these two rows
(`:250, 258, 265, 273, 288, 352`), so retargeting promote is a **two-line**
change. That is the refactor working as intended.

### Not in this diff but same topology — `.github/workflows/build-api.yml` (on `main`), service `epode-api`, env `staging`

Lines **112, 119, 126, 134, 149, 206** — identical six sites to the
`build-landing.yml` table above. If EPD-10 renames the api service, these must
move in lockstep with `promote.yml:70`, or staging and production will pin
different services.

### Removed by this diff — `.github/workflows/deploy-landing.yml` (deleted)

Formerly `--service epode` at `:53` and `epode` in the summary at `:64`, env
`production`. Gone; no retargeting needed.

### Recommendation

`build-api.yml` and `build-landing.yml` each repeat their service name six times
in one job. Hoist it to a job-level `env: SERVICE: epode` (or `epode-api`) and
use `"$SERVICE"` throughout — matching what `promote.yml` now does — so a future
retarget is one line per file instead of six. That also makes the two build
workflows and the promote workflow structurally identical, which is the stated
goal of this branch.

### Not a service name (no action)

`RAILWAY_PROJECT_ID` comes from `vars.RAILWAY_PROJECT_ID` in all three workflows
and is already externalized. Environment names (`staging` / `production`) are
hardcoded throughout by design.
