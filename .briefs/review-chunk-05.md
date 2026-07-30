# Review task — chunk 5 (Makefile command hub)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`, chunk
brief `.briefs/chunk-05-makefile.md`. Chunks 1-4 committed (`5985c6a`,
`801431f`, `7694f95`, `8a882b2`, plus fix `581c37f`).

Chunk 5 adds one new untracked file: `Makefile`. That is the whole diff. Read
it, and read `/Users/jakubswierczek/code/alongside/os-platform/Makefile` for
the house conventions it is meant to match.

## Why this matters more than its size suggests

Chunk 6 will wire CI to call **make targets only** — no inline `cargo`/`pnpm`
in the workflow YAML. So this file becomes the definition of "is the repo
green". A target that silently does less than its name claims becomes a CI job
that passes without checking anything.

The orchestrator already ran every target: `help`, `backend-fmt-check`,
`backend-clippy`, `backend-test`, `biome-check`, `node-test`, `landing-check`,
`sdk-node-test` all pass; `node-version-check` correctly fails on Node 26.5.0
with an actionable message. Do not re-run those for their own sake.

## What to actually check

1. **Does each target check what its name and `##` description claim?**
   Go target by target. In particular:
   - `landing-check` runs `pnpm exec biome check landing-page/` plus
     `node --test tests/rendered-html.test.mjs`. Note that chunk 3
     deliberately removed `landing-page/**/*.html` from `biome.json`'s file set
     (Biome 2.4.12's HTML formatter is behind an experimental flag). So what
     does `biome check landing-page/` actually inspect — only `styles.css` and
     `package.json`? If so, is `landing-check` meaningfully checking the
     landing page, or does its name overpromise? Determine what it really
     covers and say so.
   - `check` aggregates nine targets. Is anything missing from it that CI will
     need — e.g. `tests/docs-contract.test.mjs`, or the setup matrix?
     Cross-reference against what `docs.yml` currently runs and against the
     master brief's CI section.
   - Is there any target whose failure would not actually fail make (a piped
     command masking a non-zero exit, a `-` prefix, a subshell swallowing
     status)?

2. **The `node-version-check` guard.** It is a `node -e` one-liner inside a
   Make recipe, so it passes through both Make's `$` escaping and the shell's
   quoting. Verify the `$$` escaping is right and that it behaves correctly for
   the boundaries: 22.12.x (should fail), 22.13.0 (pass), 24.x (pass), 25.0.0
   (fail), and when `node` is absent. Also: it is a prerequisite of
   `docs-validate` and `docs-a11y` only. Should `node-test`, `sdk-node-test`,
   or `biome-check` depend on it too, or is the narrower scope right?

3. **Correctness of Make itself.** Recipe lines are tab-indented; each line is
   its own shell so `cd X && ...` must be on one line; `.PHONY` must list every
   target (check for omissions — an omitted target breaks if a file of that
   name ever appears); `.DEFAULT_GOAL` is set. Does `make help` actually list
   every target that has a `##` comment, and does any target lack one?

4. **Parallelism and reentrancy.** Would `make -j4 check` work, or do targets
   race (two `cargo` invocations on the same target dir, two `pnpm` writes)?
   Not necessarily something to fix — but say whether `-j` is safe, since CI
   authors reach for it.

5. **Scope.** Confirm the Makefile is the only change and that nothing under
   `backend/`, `sdk/`, `tests/`, `landing-page/`, `.github/` was touched.

## Do NOT

- Do not modify any file. Report only.
- Do not run any Railway or deploy command. Do not run `make install` in a way
  that rewrites the lockfile.
- Do not touch `~/.cache` or delete `node_modules` / `backend/target`.
- Do not edit anything under `.briefs/` or `.reviews/` except your output file.

## Output

Write to the file named in the prompt that dispatched you:

```
# Review — chunk 5 (Makefile) — <your reviewer name>

## Blocking
- <finding> — file:line — why

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Cite line numbers, mark findings [ran] / [read]. Reply with only the file path
and your one-line verdict.
