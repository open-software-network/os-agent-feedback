# Chunk 3 — Biome (replaces the deleted eslint)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`.
Chunks 1 (landing-page) and 2 (prune + pnpm workspace) are committed —
`5985c6a`, `801431f`. This is chunk 3 of 6. Do ONLY chunk 3.

## Reference

Copy the os-platform house style from
`/Users/jakubswierczek/code/alongside/os-platform/web/biome.json` — read it
first. It is a Next.js/React config, so adapt: drop the React-specific rules
that have no subject here (`useExhaustiveDependencies`), drop the `!.next` /
`!out` excludes, and drop `.tsx`/`.jsx` from `files.includes` (no JSX left in
this repo). Keep its formatter settings, quote style, semicolons, and the rest
of its `linter.rules` shape verbatim so the two repos read the same.

os-platform pins `@biomejs/biome` as a devDependency and exposes
`check` / `check:fix` scripts. Match that.

## Scope

1. Root `biome.json`. It must cover exactly three trees:
   - `tests/` — `.mjs` and `.sh`-adjacent JS (Biome only handles the JS/JSON;
     leave shell scripts alone)
   - `landing-page/` — `.html`, `.css`, `.json`. Check what Biome 2.x actually
     formats: HTML support may still be partial/behind a flag. If it cannot
     format HTML reliably, scope Biome to CSS+JSON there and say so in your
     summary rather than half-enabling it.
   - `sdk/node/` — `.ts` source and its `test/*.test.mjs`

   Explicitly EXCLUDE, and be careful here:
   - `backend/public/**` — the dashboard's `app.js` / `app.html` / `styles.css`.
     The test suite asserts against the **source text** of these files
     (`tests/dashboard-runtime.test.mjs`, `tests/observability-ui.test.mjs`,
     and others). Reformatting them will break those tests, and the master
     brief says do not touch `backend/public/` beyond what tests require.
   - `node_modules`, `sdk/node/dist`, `docs/` (Mintlify MDX), `protocol/`
     (published JSON schemas — do not reformat published contract files),
     `examples/` (customer-facing reference projects with their own lockfiles),
     `backend/`, `sdk/{go,python,rust}`.

2. Add `@biomejs/biome` pinned as a root devDependency. NOTE: the workspace
   sets `minimumReleaseAge: 10080` — pick a version published more than 7 days
   ago, or the install will refuse it. Do not add a
   `minimumReleaseAgeExclude` entry to work around this; choose an older
   version instead.

3. Root `package.json` scripts: `check` (`biome check .`) and
   `check:fix` (`biome check --fix .`).

4. Run `pnpm check:fix` and commit the resulting formatting churn as part of
   this chunk. Then make `pnpm check` pass cleanly with **zero** diagnostics.

## Judgment call — read this

The formatter will want to reformat `sdk/node/src/*.ts` and `tests/*.mjs`.
That is expected and fine. But:

- If a lint rule fires on real code in `sdk/node/src`, prefer fixing the code
  over disabling the rule. If a rule is genuinely wrong for this repo, disable
  it in `biome.json` with a comment explaining why — do NOT scatter
  `// biome-ignore` comments through the source to reach zero diagnostics.
- `noConsole` will likely fire on `tests/*.mjs` and on the SDK's `doctor.js`
  CLI, where printing is the entire point. Handle that with a scoped override
  in `biome.json` (per-glob rule override), not by downgrading the rule
  globally.
- Do not let the formatter change behavior. If `check:fix` touches anything
  outside formatting — reordering, removing "unused" code — inspect it.

## Do NOT

- Do not touch `backend/` (chunk 4 owns `Cargo.toml`; nothing else),
  `.github/workflows/` (chunk 6), or add a Makefile (chunk 5).
- Do not touch Railway. Do not commit.
- Do not edit `.briefs/dev-setup-overhaul.md` or any file under `.briefs/` or
  `.reviews/` — those are the orchestrator's.

## Done looks like

- `pnpm check` exits 0 with no diagnostics.
- `pnpm test` → 58 pass.
- `cd sdk/node && pnpm test` → its 16 tests pass (the formatter touched its
  source, so this is the real regression check).
- `pnpm install --frozen-lockfile` still succeeds with no build scripts.

Reply with: the biome version you pinned and why, what you excluded and why,
any rule you disabled with its justification, and the command output.
