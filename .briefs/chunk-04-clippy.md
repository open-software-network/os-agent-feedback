# Chunk 4 — backend lint policy (`[lints]` + fix the violations)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`.
Chunks 1-3 are committed. This is chunk 4 of 6 and the largest. Do ONLY chunk 4.

## Goal

Add a `[lints]` section to `backend/Cargo.toml` matching the os-platform house
policy, then fix or explicitly justify every resulting violation.

Reference: `/Users/jakubswierczek/code/alongside/os-platform/api/Cargo.toml`,
`[workspace.lints]`. Read it. Note that os-epode's backend is a **single
non-workspace crate**, so the section is `[lints]`, not `[workspace.lints]`.

The exact policy from the master brief:

- `[lints.rust]`: `unsafe_code = "forbid"`, `missing_debug_implementations =
  "warn"`, `rust_2018_idioms = "warn"`, `unreachable_pub = "warn"`,
  `unused_lifetimes = "warn"`
- `[lints.clippy]`: `pedantic = { level = "warn", priority = -1 }`,
  `nursery = { level = "warn", priority = -1 }`, then
  `unwrap_used`/`expect_used`/`panic`/`todo`/`unimplemented`/`dbg_macro`/
  `print_stdout`/`print_stderr` = warn; `await_holding_lock`/`float_cmp`/
  `mem_forget` = deny; `wildcard_imports`/`redundant_clone`/
  `inefficient_to_string` = warn; `module_name_repetitions`/
  `missing_errors_doc`/`missing_panics_doc`/`must_use_candidate` = allow.

`rust_2018_idioms` is a lint *group* — it needs `priority = -1` too, or the
individual lints in it cannot be overridden. Check this.

## What you are up against — measured, do not re-derive

The orchestrator already ran the baseline. Expect roughly 280 violations:

- **~110 `unreachable_pub`** — this is a single-binary crate, so most `pub` in
  modules is crate-internal. Mechanical `pub` → `pub(crate)` sweep.
- **77 `unnecessary hashes around raw string literal`** (`r#"..."#` → `r"..."`).
  Mechanical. `cargo clippy --fix` handles most of these — use it, then review
  the diff.
- **~31 `unwrap_used` / `expect_used` / `unwrap_err`** — concentrated in
  `backend/tests/` and the helper bins.
- **7 `print_stdout` / `print_stderr`** — in the `setup_matrix_db` and
  `provision_agent_playground` bins, where printing is the entire purpose.
- **~22 numeric cast lints** (`cast_possible_truncation`, `cast_sign_loss`,
  `cast_precision_loss` on `i64`→`usize`/`f64`).
- **11 `too_many_lines`** — handlers of 106 to 274 lines.
- A handful of `needless_pass_by_value`, `wildcard_imports`, `single_match_else`,
  `option_if_let_else`, `redundant_closure`, `float_cmp`.

## How to resolve them — this is the part that matters

Order of preference, always:
1. **Fix the code** where the lint is pointing at something real.
2. **Scoped `#[allow(..., reason = "...")]`** on the specific item/module where
   the lint is wrong *for that code*.
3. **A crate-level `allow` in `[lints]`** only where the lint is wrong for the
   whole crate as a policy decision — and only with a comment saying why.

The master brief forbids "blanket crate-level allows". Concretely:

- **`unwrap_used` / `expect_used` / `panic` in tests**: idiomatic. Do NOT fix
  these by rewriting assertions. Put a scoped `#![allow(clippy::unwrap_used,
  clippy::expect_used, reason = "...")]` at the top of each test module /
  `backend/tests/*.rs` file. Never turn them off crate-wide — the whole point
  is catching them in `src/`.
- **`unwrap`/`expect` in `src/`**: fix them. Each one is a real panic path in a
  server. If a specific one is genuinely unreachable, `expect("...")` with a
  message explaining the invariant plus a scoped allow-with-reason.
- **`print_stdout`/`print_stderr` in the helper bins**: scoped
  `#![allow(...)]` at the top of those two bin files with a reason. They are
  CLIs; printing is their output.
- **Numeric casts**: do not blanket-allow. Look at each. Several are
  `i64`→`usize` for row counts and `i64`→`f64` for metrics; prefer
  `usize::try_from(...)` with real error handling, or `f64::from` where the
  range is provably safe. Where a lossy cast is genuinely intended (e.g. a
  metric average), a scoped allow with a reason is fine.
- **`too_many_lines`**: the master brief's Out-of-scope section says "Backend
  code changes beyond lint fixes". Splitting eleven 100-270 line handlers is a
  refactor, not a lint fix, and it is out of scope for this chunk. Set
  `too_many_lines = "allow"` in `[lints]` with a comment recording that it is a
  deliberate deferral and why, not an oversight. Do NOT refactor the handlers.
- **`float_cmp` is `deny`** per policy and there are 2 violations. Those must be
  actually fixed (epsilon comparison or restructure), not allowed.
- **`wildcard_imports`**: fix by expanding the globs. The clippy suggestion
  lists the full symbol set; some are 40+ names. If expanding makes a file
  materially worse to read, a scoped allow on that one `use` with a reason is
  acceptable — say which you chose and why.

## Do NOT

- Do not change backend behavior. This is a lint chunk. Every change must be
  provably behavior-preserving; `cargo test` is the check.
- Do not touch `backend/public/` (dashboard assets — asserted by the JS test
  suite as source text), `backend/migrations/`, or `backend/Dockerfile`.
- Do not touch `.github/workflows/` (chunk 6), the Makefile (chunk 5),
  `biome.json`, or any JS.
- Do not touch Railway. Do not commit.
- Do not edit anything under `.briefs/` or `.reviews/`.

## Done looks like

Run all four from `backend/`:
- `cargo fmt --check` — clean
- `cargo clippy --all-targets --locked -- -D warnings` — clean
- `cargo test` — all pass (note: some tests may need a database; if so, run
  what you can and report exactly which tests you could not run and why)
- `cargo build --locked` — succeeds

Also confirm `git diff --stat -- backend/public backend/migrations` is empty.

## Report

Reply with: the counts you started from and ended at, every `allow` you added
with its scope and justification, every place you fixed real code rather than
allowing, and the four command outputs. Be explicit about anything you allowed
that you think a reviewer will push back on.
