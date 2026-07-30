# Review task — chunk 2 (prune stack + pnpm workspace)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`.

## Context

Master brief `.briefs/dev-setup-overhaul.md`; chunk brief
`.briefs/chunk-02-prune-pnpm.md`. Chunk 1 (landing-page port) is committed as
`5985c6a`. Chunk 2 is uncommitted in the working tree: it deleted the entire
Cloudflare Workers + Vite + Next.js + drizzle + eslint stack, deleted both npm
lockfiles and root `public/`, rewrote root `package.json` as a private tooling
package, and adopted pnpm workspaces.

## What to review

- `git diff` (tracked changes) and `git status --short` (new files:
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `landing-page/favicon.svg`,
  `landing-page/og.png`).
- `git diff 5985c6a --stat` for the full shape.

## What matters — in priority order

1. **Supply-chain hardening was weakened.** The brief specified
   `minimumReleaseAge: 10080` (7 days) and an allowlist that "starts empty, add
   only what install proves necessary". The implementation added:
   - `minimumReleaseAgeExclude` for `@modelcontextprotocol/core@2.0.0` and
     `@modelcontextprotocol/server@2.0.0`
   - `allowBuilds`: `puppeteer@24.3.1: true`, `sharp@0.33.5: true`
     (and explicit `false` for `keytar`, `@scarf/scarf`)

   Scrutinize each one. Is it genuinely necessary, or did the implementer
   allow it to make an error message go away? Specifically: does anything the
   repo actually runs need puppeteer's Chromium download or sharp's native
   binary — and if it is `mint` (docs a11y), does `pnpm docs:a11y` actually
   fail without them? Are the release-age exclusions real (were those versions
   published <7 days ago) and are they pinned tightly enough that a new
   malicious release cannot slip in under the same exclusion? Verify by
   inspection and by running commands, not by trusting the summary.

2. **Deleted-but-still-referenced.** Anything in the repo that still points at
   a removed path or tool: `README.md`, `AGENTS.md`, `CLAUDE.md`,
   `.railwayignore`, `docs/**`, `examples/**`, `backend/**`, `protocol/**`.
   Root `public/` is gone — confirm nothing but the Next site depended on it,
   and that `backend/public/` (the real `app.epode.ai/static/...` origin) is
   untouched. Note: `.github/workflows/docs.yml` still uses `npm ci`; that is
   chunk 6's job, do not flag it as blocking.

3. **Out-of-scope edits.** The chunk brief did not authorize changes to
   `tests/docs-contract.test.mjs` or `tests/setup-page.test.mjs`, but both were
   modified. Read those diffs closely: are they necessary consequences of the
   deletions, or did assertions get weakened/deleted to make tests pass? A test
   that was made to pass by removing its assertion is a blocking finding.

4. **`tests/build-hosted-artifacts.sh`** — the npm→pnpm port. Does
   `pnpm pack` write the same filenames to the same place that
   `tests/docs-contract.test.mjs`, `docs/quickstart.mdx`, and
   `examples/*/package.json` expect (`agent-feedback-node-0.1.0.tgz` in
   `backend/public/`)? Run it if you can.

5. **`tests/setup-matrix-e2e.mjs`** — the dist/build decoupling. Was the
   build branch removed cleanly, or is there dead config / a now-unreachable
   env var left behind?

6. **Root `package.json`** — are the remaining devDeps the minimum? Is anything
   the tests import missing? Is `mint` a real published version?

7. **`.gitignore`** — over-pruned or under-pruned? `.pnpm-store/` handling.

8. **Reproducibility** — does a clean `rm -rf node_modules && pnpm install
   --frozen-lockfile` succeed, and does `pnpm test` pass (58 tests expected)?
   Actually run this; do not assume.

## Do NOT

- Do not modify any file. This is review only — report, do not fix.
- Do not review `backend/` Rust code (chunk 4), Makefile (chunk 5), or
  `.github/workflows/` (chunk 6).
- Do not touch Railway.

## Output

Write findings to the file named in the prompt that dispatched you:

```
# Review — chunk 2 (prune + pnpm) — <your reviewer name>

## Blocking
- <finding> — file:line — why it must be fixed

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Be concrete, cite file and line, report only actionable findings. State plainly
which claims you verified by running a command versus by reading. Then reply
with only the file path and your one-line verdict.
