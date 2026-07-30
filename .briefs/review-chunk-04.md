# Review task — chunk 4 (backend lint policy)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`, chunk
brief `.briefs/chunk-04-clippy.md`. Chunks 1-3 committed (`5985c6a`, `801431f`,
`7694f95`). Chunk 4 is uncommitted.

Review `git diff` — it touches `backend/Cargo.toml`, `backend/src/**`, and
`backend/tests/**`. It is large (~280 lint violations resolved).

## Ground rules

The orchestrator already verified, from `backend/`: `cargo fmt --check` clean,
`cargo clippy --all-targets --locked -- -D warnings` clean, `cargo test`
10 passed / 0 failed / 5 ignored (the 5 are pre-existing `#[ignore]` tests that
need a Postgres). Do not re-run those for their own sake. Spend your budget on
what green cannot tell you.

## The central question

This was supposed to be a **lint-only, behavior-preserving** change to a live
API server. Two failure modes matter, in this order:

### 1. Did any change alter runtime behavior?

Go through the `backend/src/` diff and classify every non-cosmetic hunk. The
mechanical categories (`pub` → `pub(crate)`, `r#"..."#` → `r"..."`, import
expansion) should be provably inert — but verify rather than assume,
especially:

- **Raw-string de-hashing** (77 sites). `r#"..."#` → `r"..."` is only safe if
  the literal contains no `"`. If any de-hashed literal contains a quote, the
  string changed or the code would not compile — but also check literals that
  are **SQL queries** or **JSON/JS fragments served to the dashboard**: a
  changed string here is a wire/DB change, not a lint fix.
- **`unwrap`/`expect` removals in `src/`** (non-test). The brief required these
  be *fixed*, not allowed. For each one: does the replacement preserve
  behavior, or did an error path change — e.g. a panic becoming a silent
  `unwrap_or_default()`, a `?` that now returns a different HTTP status, or an
  error swallowed into `None`? A panic converted into a wrong-but-quiet default
  is worse than the panic. This is the highest-value thing to check.
- **Numeric cast fixes.** `i64` → `usize` via `try_from` introduces a new error
  path. What happens on the `Err` branch — is it propagated, or defaulted to 0?
  A row count silently becoming 0 is a real bug.
- **`float_cmp` (deny, 2 sites).** These had to be genuinely fixed. Are the
  replacements correct, or did a comparison change meaning?
- **`option_if_let_else` / `single_match_else` / `let...else` rewrites.** These
  nursery suggestions change control flow shape. Confirm each is equivalent,
  including in the error/None branch.
- **`redundant_clone` removals.** A removed clone that was actually load-bearing
  (aliasing, drop order) is a real bug.

### 2. Was the lint policy honored, or was it defeated by allows?

- `backend/Cargo.toml` gained crate-level `allow`s beyond the four the master
  brief sanctioned (`module_name_repetitions`, `missing_errors_doc`,
  `missing_panics_doc`, `must_use_candidate`). Specifically `too_many_lines`.
  That one was explicitly sanctioned by the orchestrator as a deliberate
  deferral. Check whether **anything else** was added crate-level that was not.
- Enumerate every `#![allow(...)]` / `#[allow(...)]` added in `backend/src` and
  `backend/tests`. For each: is the scope as narrow as it could be, and is the
  stated `reason` actually true? Flag any allow whose reason is generic
  boilerplate rather than a real justification for that site.
- The `unwrap_used`/`expect_used` allows must sit **inside test modules /
  test files only**. Verify none leaked to a module that contains production
  code. Then confirm the negative: `grep` for remaining `.unwrap()` /
  `.expect(` in non-test `backend/src` code and confirm each surviving one is
  covered by a *scoped, justified* allow rather than accidentally invisible.
- `clippy::redundant_pub_crate` is allowed at several file tops with the reason
  that it conflicts with `unreachable_pub`. That conflict is real — but confirm
  it was applied only where the conflict actually occurs.
- `rust_2018_idioms` is a lint group and needs `priority = -1`. Confirm it has
  it and that the policy actually takes effect (a group without priority
  silently cannot be overridden).

## Do NOT

- Do not modify any file. Report only.
- Do not touch `~/.cache`, do not delete `node_modules` or `backend/target`.
- Do not review the Makefile (chunk 5) or `.github/workflows/` (chunk 6).
- Do not edit anything under `.briefs/` or `.reviews/` except your output file.

## Output

Write to the file named in the prompt that dispatched you:

```
# Review — chunk 4 (backend lints) — <your reviewer name>

## Blocking
- <finding> — file:line — why

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Cite file and line, mark findings [ran] / [read]. A behavior change in this
diff is blocking regardless of how small. Reply with only the file path and
your one-line verdict.
