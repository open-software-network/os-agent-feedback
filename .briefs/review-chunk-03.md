# Review task — chunk 3 (Biome replaces eslint)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`,
chunk brief `.briefs/chunk-03-biome.md`. Chunks 1-2 are committed (`5985c6a`,
`801431f`). Chunk 3 is uncommitted in the working tree.

Review `git diff` plus the new untracked `biome.json`.

## Ground rules for this review

`pnpm check` already exits clean, `pnpm test` is 58/58, and
`cd sdk/node && pnpm test` is 16/16 — the orchestrator ran all three. Do not
spend your budget re-running those. Spend it on the two things a green build
cannot tell you:

1. **Did the formatter change behavior anywhere?** This diff reformats
   `sdk/node/src/*.ts` — shipped SDK code that customers install from
   `app.epode.ai/static/agent-feedback-node-0.1.0.tgz`. Go through the
   `sdk/node/src/` diff hunk by hunk and confirm every change is purely
   cosmetic. Look specifically for: template-literal or string contents
   altered, ASI hazards from moved semicolons, changed operator precedence from
   re-wrapping, reordered object keys where order is observable (JSON emitted
   on the wire against `protocol/v1/*.schema.json`), removed "unused" code that
   was actually a side-effecting import, and any regex literal touched. A
   behavior change here ships to customers.

2. **Is the config sound, or was it shaped to make diagnostics disappear?**
   - `biome.json` `files.includes` is an explicit allowlist. Is anything that
     should be linted silently outside it? Check for `.mjs`/`.ts`/`.json` files
     in `tests/`, `landing-page/`, `sdk/node/` that no glob matches.
   - `backend/public/**` MUST NOT be formatted — the dashboard test suite
     asserts against its source text. Confirm it is genuinely excluded and that
     `git diff -- backend/` is empty.
   - `protocol/` holds published JSON schemas and `examples/` are
     customer-facing reference projects; confirm both are untouched.
   - The `overrides` block disables `noConsole` for `tests/**`,
     `sdk/node/test/**`, and `sdk/node/src/doctor.ts`. Is that scoped
     correctly, or does it cover source that should not be printing?
   - Are there any `// biome-ignore` comments in the diff? The brief forbade
     reaching zero diagnostics that way. Grep for them.
   - `@biomejs/biome` is pinned to `2.4.12`. Confirm it is older than the
     workspace's 7-day `minimumReleaseAge` gate and that no
     `minimumReleaseAgeExclude` entry was added for it.

3. **HTML/CSS coverage.** `landing-page/**/*.html` and `**/*.css` are in
   `files.includes`, but `git status` shows no changes under `landing-page/`.
   Determine whether Biome 2.4.12 actually formats HTML/CSS here or is
   silently skipping those files (`biome check --verbose`, or check which of
   the "Checked 26 files" they are). If they are being silently skipped, the
   config is claiming coverage it does not have — say so.

## Do NOT

- Do not modify any file. Report only.
- Do not review `backend/` Rust (chunk 4), Makefile (chunk 5), or
  `.github/workflows/` (chunk 6).
- Do not edit anything under `.briefs/` or `.reviews/` except your own output
  file. Do not touch `~/.cache`, and do not delete `node_modules`.

## Output

Write to the file named in the prompt that dispatched you:

```
# Review — chunk 3 (biome) — <your reviewer name>

## Blocking
- <finding> — file:line — why

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Cite file and line. Mark each finding [ran] or [read]. Reply with only the file
path and your one-line verdict.
