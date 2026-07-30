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

---

## Second pass — pre-gate resolution (Greptile P1)

Scope: **only** the delta since `10ffcc5` / `f16d0f3` —
`git diff HEAD -- .github/workflows/promote.yml`. Nothing else re-reviewed.
`actionlint .github/workflows/*.yml` re-run → **green**. No `railway` command,
no commit, no push, no edit.

Settled and not re-litigated: the `api → epode-api` / `landing → epode` mapping
(pass-1 B1 is **withdrawn** — root-caused to an unrelated API route rename), and
the missing staging `epode` service (deferred to the control pane).

Verdict on the delta: **0 blockers, 3 major, 3 minor, 2 nits.** The TOCTOU is
genuinely fixed.

### The TOCTOU fix holds (Q1)

Traced every value that determines which bits ship:

- `plan` (`:34-166`) carries **no `environment:`** key, so nothing gates it. It
  does the GHCR login (`:99-104`) and the whole resolution (`:106-166`) there.
- `deploy` (`:168`) consumes `matrix.digest` and `matrix.sha_short` only
  (`:181-182`). Both originate from `resolved_rows`, built pre-gate at `:150-155`.
- `FROM_TAG` — the only mutable-tag reference in the file — appears at
  `:44, 57, 64, 65, 90, 117, 129, 130, 159` and **nowhere inside `deploy`**
  (grep-confirmed). The deploy job no longer defines it at all; the deleted
  `Prepare verified image references` step was the only post-gate reader.
- `strategy.matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}` (`:176`) is
  evaluated from `plan`'s completed output, so the values are frozen at plan
  time regardless of how long the approval sits pending.
- `${IMAGE}:production` (`:322`) is only ever written, never read.

So the invariant "nothing that determines which bits ship executes inside a job
carrying `environment: production`" **holds**, with one residual noted as m1
below (Railway is handed a tag, not a digest).

### Major

#### S1 — no digest shape validation anywhere; two `null`s compare equal
`.github/workflows/promote.yml:123-124, 143-148`

`jq -r '.digest'` on a manifest lacking that key prints the literal string
`null` and exits 0 — it does not fail, and it does not produce an empty string
that `set -euo pipefail` would catch. If both `imagetools inspect` calls returned
a manifest without `.digest`, `sha_digest` and `digest` are both `"null"`, the
equality gate at `:145` **passes**, and `digest: "null"` is embedded into the
matrix row and reaches `deploy` as `IMAGE_DIGEST_REF=…@null`.

It still fails closed — `imagetools create` rejects `@null` at `:205-207`, before
any Railway call — but it fails *after* the human approval, with an opaque
docker error instead of a named one. The previous revision had a
`^sha256:[0-9a-f]{64}$` guard on the resolved digest; this restructure dropped
it and put nothing in its place. This is the one path where an unresolved digest
survives the equality check.

Second reason to want the guard: `digest` is currently the only registry-supplied
value that reaches a `run:` body unvalidated. It is safe *today* because
`IMAGE_DIGEST_REF` is used solely as a quoted argv (`:207`, `:323`) — but the
file also contains a nested-eval site at `:249-251` (`script --command "…"`,
whose string is re-parsed by the inner shell). `IMAGE_REF` is safe there only
because `revision` is regex-validated at `:132`. If anyone ever moves
`IMAGE_DIGEST_REF` into that command string, the missing regex becomes a command
injection. Validate it now, while it costs one line.

**Fix:** after `:144`, add
`[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::Unresolved digest for $source."; exit 1; }`
and the same for `$sha_digest` before comparing them.

#### S2 — a short `resolved_rows` produces a green run that promotes nothing
`.github/workflows/promote.yml:112-166`

The loop feed is correct and I verified the semantics rather than assuming them:
`done < <(jq -c '.[]' <<< "$ARTIFACT_ROWS")` is process substitution, so the body
runs in the **current** shell. Probed locally — `exit 1` inside the body
terminates the whole step and the code after the loop is never reached. A
`jq … | while` pipe would have run the body in a subshell and silently discarded
`resolved_rows`; that trap was avoided. Every in-loop failure path (`:118-121`,
`:132-135`, `:139-142`, `:145-148`) therefore fails the job, closed. Good.

The gap is the feed itself. A failure of the process substitution — malformed
`ARTIFACT_ROWS`, jq missing, jq erroring — is caught by neither `set -e` nor
`pipefail`. The loop simply runs zero times, `resolved_rows` stays `[]`, and
`:165` emits `{"include":[]}` as a perfectly valid matrix. Depending on runner
version that either skips `deploy` outright or errors on an empty vector; in the
skip case the workflow ends **green having promoted nothing**, which an operator
will read as a successful promotion.

**Fix:** after the loop, assert the count round-trips:

```bash
if [[ "$(jq 'length' <<< "$resolved_rows")" -ne "$(jq 'length' <<< "$ARTIFACT_ROWS")" ]]; then
  echo "::error::Resolved $(jq 'length' <<< "$resolved_rows") of $(jq 'length' <<< "$ARTIFACT_ROWS") requested artifacts."
  exit 1
fi
```

That single check also makes the "no empty digest reaches deploy" property
structural rather than incidental.

#### S3 — `deploy` matrix defaults to `fail-fast: true`, so a failing api leg cancels landing mid-Railway-poll
`.github/workflows/promote.yml:175-176`

Outside the literal delta (it was already so at `HEAD`), but it is the direct
answer to Q6 and it is a real hazard for `artifact: all`. There is no `fail-fast`
key on the `deploy` strategy, so the default `true` applies: if the api leg exits
non-zero, GitHub **cancels** the in-flight landing leg. The landing leg's Railway
mutation at `:238-252` has already been issued by then; only the tracking loop at
`:260-313` is killed. Result: production landing has a new image, no
success/failure verdict, no `Retag verified image as production` (`:318-323`), no
step summary — the exact blind spot the freeze-poll loop exists to eliminate.

The narrower question — can one artifact's failure make the *other* deploy a
**wrong image**? — is **no**. Each leg's `IMAGE`, `IMAGE_REF` and
`IMAGE_DIGEST_REF` derive from its own matrix row (`:179-182`), and a resolution
failure aborts `plan` before any matrix exists, so nothing deploys at all. The
isolation is sound; the cancellation behavior is not.

**Fix:** add `fail-fast: false` under `strategy` on `deploy` (as `plan`'s
predecessor jobs had in the first revision). A promotion already in flight should
be allowed to report its outcome.

### Minor

#### s1 — Railway still resolves a mutable tag post-gate (residual, tiny window)
`.github/workflows/promote.yml:202-207, 250`

`Pin verified SHA tag` re-points `${IMAGE}:${sha_short}` at the verified digest,
then Railway is given `source.image = "$IMAGE_REF"` — a **tag**. The bits Railway
pulls are whatever that tag resolves to at pull time, not the digest this
workflow verified. The pin immediately precedes the mutation so the window is
seconds wide, and the only writer of that tag is a build of the identical commit,
so this is genuinely minor and it is inherited from `main` rather than introduced
here. It is, however, the last indirect mutable-tag dependency in the shipped
path, so it belongs in the answer to Q1.

**Fix (optional):** set `source.image` to `"$IMAGE_DIGEST_REF"` and compare
`current_image` / `.meta.image` against the same digest ref. Keep the SHA-tag pin
for human legibility. Worth confirming Railway's UI renders a digest ref
acceptably before making the change.

#### s2 — `GITHUB_ENV` write of `FROM_TAG` is shadowed by the job-level `env:` of the same name
`.github/workflows/promote.yml:44` vs `:90`

`FROM_TAG` is declared at job level from the raw input (`:44`), and the
normalized 7-char value is written to `$GITHUB_ENV` (`:90`). Environment-file
variables sit *below* workflow/job `env:` blocks in the runner's precedence
order, so the later `Resolve source images` step very likely reads the
**untruncated** input, not the truncation. Consequence: dispatching a 40-char SHA
— explicitly advertised by the input description at `:16` — builds
`source=…:<40 chars>`, which was never pushed, so the run dies at `:119` with
"Image … does not exist". Fails closed, and `api`/`staging`/7-char paths are
unaffected, so this is a usability defect, not a safety one. Inherited shape
(`main` carried the same reliance with a comment claiming it worked), so I flag
it as needing one empirical confirmation rather than asserting it outright.

Note the delta also removed the old resolve job's defensive re-check
("Resolved from-tag must be 'staging' or a 7-character…"), which is what would
have caught this loudly.

**Fix:** stop round-tripping through `GITHUB_ENV`. Emit
`from_tag=$FROM_TAG` as a step output from `select`, and scope it to the
consuming step where precedence is unambiguous:

```yaml
      - name: Resolve source images
        env:
          ARTIFACT_ROWS: ${{ steps.select.outputs.rows }}
          FROM_TAG: ${{ steps.select.outputs.from_tag }}
```

Then drop `FROM_TAG` from the job-level `env:` block, leaving `select` to read
`${{ inputs.from-tag }}` via its own step `env:`.

#### s3 — empty-matrix path is unguarded at the consumer too
`.github/workflows/promote.yml:176`

Complementary to S2: `fromJSON` of `{"include":[]}` is valid input. If S2's count
check is added this is unreachable, but a `needs.plan.outputs.matrix != '{"include":[]}'`
condition on `deploy` would make the intent explicit. Optional.

### Nits

#### n4 — `contents: read` on `plan` is above the minimum (Q5)
`.github/workflows/promote.yml:37-39`

The widening from `permissions: {}` is justified: `imagetools inspect` against
GHCR needs `packages: read`, and `plan` correctly does **not** take
`packages: write` (it pushes nothing — both `imagetools create` calls live in
`deploy`, `:205` and `:321`). But `plan` has no `actions/checkout` step and reads
no repository content, so `contents: read` is unused. `packages: read` alone is
the true minimum. Harmless; noting for exactness since the question was asked.

#### n5 — the approval comment is accurate; it also corrects pass-1's m5
`.github/workflows/promote.yml:172-173`

"One GitHub approval covers all jobs queued for this environment in a run; only
an individually re-run matrix leg gets its own approval." Both clauses check out:
pending deployments are keyed by (run, environment), so approving `production`
releases every job waiting on it at that moment — including all matrix legs, which
queue together the instant `plan` completes — and re-running a single failed job
creates a fresh pending deployment needing its own approval. The one nuance the
sentence does not cover: a job that reaches the same environment *later* in the
same run, after it resumed, does re-prompt. No such job exists here, and the word
"queued" already carries the qualifier, so the comment is fine as written.

This **supersedes pass-1 finding m5**, which asserted `artifact: all` would
produce two separate approval prompts. That was wrong; one approval covers both
legs. Since both legs' digests are frozen pre-gate, a single approval covering
both is the correct semantics, not a gap.

### Resolved by this delta (Q4 and pass-1 carryover)

- **Pass-1 M1 (matrix job-output merge hazard) — fully resolved.** The
  `api_digest` / `landing_digest` / … output keys are gone; per-artifact data now
  rides inside the matrix rows themselves (`:150-155`), so there is no
  last-leg-wins merge to reason about at all. This is a better fix than either
  option I proposed.
- **Pass-1 M2 (not actually table-driven) — resolved.** Adding `web` is now
  literally one row at `:68-79`; nothing else in the file enumerates artifacts.
- **Pass-1 m1 (inconsistent validation trust model) — resolved.** Validation and
  consumption now live in the same job.
- **Pass-1 m4 (`digest_output` / `sha_output` columns) — resolved.** Columns
  deleted.
- **No dangling references.** Grepped: `needs.` appears only at `:176`
  (`needs.plan.outputs.matrix`); no `needs.resolve` survives. `plan`'s removed
  `from_tag` output has no remaining consumer. `steps.select.outputs.rows`
  (`:109`) and `steps.resolve.outputs.matrix` (`:41`) both resolve to live step
  ids. `REGISTRY` is used at `:102`, `:116`, `:191`; workflow-level
  `packages: write` is still required by `deploy`'s two `imagetools create` calls.
  No orphaned env or permissions beyond n4.
- **jq construction is injection-safe (Q3).** `artifact_rows` (`:68-79`) is a
  constant literal. Every dynamic value enters jq via `--arg` / `--argjson`
  (`:83-86`, `:150-155`) — never string-interpolated into a jq program — so a
  hostile digest is JSON-escaped, and `jq -c` guarantees the single line that
  makes the `$GITHUB_OUTPUT` writes at `:93`, `:166` injection-proof. `${{ matrix.digest }}`
  at `:182` interpolates into a YAML **value** position evaluated after parsing,
  so it cannot break out of the `env:` block, and it is never `eval`'d — it is
  read only as `"$IMAGE_DIGEST_REF"` in quoted argv position. Safe today; see S1
  for why I still want the regex.
