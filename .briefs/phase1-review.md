# Phase 1 review brief — utoipa/OpenAPI chunk

You are a reviewer on the `os-epode` dashboard-rewrite track. You start blank.

## Context

- Worktree: `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dashboard-rewrite`,
  branch `jakub/dashboard-rewrite`, cut from `main` (`2483868`).
- The implementation brief you are reviewing against is
  `.briefs/phase1-openapi.md`. **Read it first** — it is the spec. Findings must
  be judged against it, not against your own preferred design.
- The overall track plan is `.briefs/dashboard-rewrite.md` (background only;
  phase 1 is deliberately backend-only, there is no `web/` yet and its absence
  is not a finding).
- The diff to review is the uncommitted work in this worktree:
  `git status --short` and `git diff` (plus `git diff --cached` and any
  untracked files — check them, new files are part of the change).

## Hard limits

- **Read-only review.** Do not edit, stage, commit, or revert anything. Do not
  run formatters or `--fix` commands. You report; someone else fixes.
- Do not push. Do not touch anything outside this worktree.
- `/Users/jakubswierczek/code/alongside/os-platform` is READ-ONLY reference —
  useful for comparing against the pattern being copied, never to be modified.
- You may run read-only verification commands (`cargo fmt --check`,
  `cargo clippy`, `cargo test`, `pnpm test`, `make check`,
  `cargo run -- --print-openapi`). These build into `backend/target/`, which is
  fine.

## What to look for, in priority order

1. **Behaviour drift.** The router was restructured from `Router::new()` into
   `utoipa_axum::router::OpenApiRouter`. Verify the served surface is
   byte-for-byte equivalent: same paths, same HTTP methods per path, same
   middleware/layer order (`DefaultBodyLimit`, CORS, compression, trace,
   `security_headers`), same `nest_service("/static", ...)`, same
   `with_state`. Layer order changes are silent security regressions — check it
   carefully rather than trusting it.
2. **Spec accuracy.** For every annotated route, does `#[utoipa::path]` match
   what the handler actually does — the real status codes, the real response
   body shape, the real params, the real auth requirement? A spec that lies is
   worse than no spec, because it becomes generated TypeScript that the frontend
   trusts. Cross-check response bodies against the handler's `json!`/struct and
   against `backend/src/store.rs` where the data comes from.
3. **Wire-format changes.** If any `json!({...})` envelope was replaced by a
   typed struct, the emitted JSON must be identical — key names, casing,
   nullability, field presence/absence. Verify `serde` attributes actually
   preserve it. This is the highest-risk category: it silently breaks the
   existing `backend/public/app.js` dashboard and the SDKs.
4. **Drift guards actually guard.** The brief requires (a) a Rust test asserting
   every router path/method appears in the spec and (b) a `make` target diffing
   the regenerated spec against committed `backend/openapi.json`, wired into
   `make check`. Confirm both exist AND that they genuinely fail when violated —
   reason about whether a newly added unannotated route would really be caught,
   or whether the assertion is vacuous.
5. **`backend/openapi.json` freshness.** Regenerate it yourself and confirm the
   committed file matches.
6. **Lint/CI compliance.** `backend/Cargo.toml` lints `pedantic` + `nursery`,
   and `unwrap_used`/`expect_used`/`panic`/`print_stdout`/`print_stderr` as
   warnings; CI runs clippy with `-D warnings`, so any of those is a build
   failure. Also check `Cargo.lock` was updated (CI uses `--locked`), the
   `pnpm-lock.yaml` change is consistent, and any new `#[allow]` uses this
   repo's `reason = "..."` form and is genuinely necessary rather than papering
   over a real problem.
7. **`--print-openapi` is dependency-free.** It must work with no database, no
   env vars, no telemetry — the argv branch has to run before
   `dotenvy::dotenv()`, tracing init, and pool creation. Prove it by running it.
8. **Scope creep.** Phase 1 is OpenAPI only. Flag any `web/` scaffolding,
   dashboard changes, or unrelated refactors. Conversely flag anything the brief
   required that is missing.
9. **Cross-language coupling.** `tests/*.test.mjs` assert against the *source
   text* of `backend/public/app.js`, `app.html`, `styles.css`. Confirm
   `pnpm test` passes and that those files were not touched.

## Output

Write your findings to the file path given in your dispatch message
(`.reviews/dashboard-<chunk>-<you>.md`). Nothing else — do not also paste the
full report into the terminal; just confirm the path when done.

Format: one section per finding, ordered most severe first.

```
## <severity: blocker | major | minor | nit> — <one-line claim>
file:line
What's wrong, concretely.
Why it matters — the actual failure mode, with inputs/state if it's a bug.
Suggested fix (describe it; do not apply it).
```

Then a `## Verification` section with the exact commands you ran and their
results, and a `## Verdict` line: `ship` / `ship with fixes` / `do not ship`.

Rules for findings:
- Be specific and adversarial. No praise, no summary of what the code does.
- Every finding needs a concrete failure scenario. If you cannot describe how it
  breaks, it is a nit — label it as one.
- Do not invent findings to fill space. "No blockers found" is a valid and
  useful report. Say what you checked and found clean, briefly.
- Distinguish "violates the brief" from "I would have done it differently". Both
  can be reported; label which it is.
