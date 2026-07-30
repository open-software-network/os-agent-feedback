# Chunk 2 — prune the Cloudflare/Next/Vite/drizzle stack, adopt pnpm workspaces

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Read `.briefs/dev-setup-overhaul.md` first — it is the
master brief. This is chunk 2 of 6. Chunk 1 (landing-page port) is already
committed. Do ONLY chunk 2.

## Delete

- Cloudflare/Vite: `worker/`, `vite.config.ts`, `build/sites-vite-plugin.ts`
  (and `build/` if it empties), `dist/`, `.wrangler/` if present.
- Next.js: `app/`, `next.config.ts`, `postcss.config.mjs`, `tsconfig.json`
  (it is a Next/React tsconfig; `sdk/node` has its own).
- drizzle: `drizzle/`.
- eslint: `eslint.config.mjs`.
- npm lockfiles: root `package-lock.json`, `sdk/node/package-lock.json`.
- Root `public/`: this directory only existed to feed the Next site. The
  canonical hosted SDK artifacts live in `backend/public/` and are served at
  `https://app.epode.ai/static/...` — those stay. Before deleting root
  `public/`, move `favicon.svg` and `og.png` into `landing-page/` (chunk 1
  created it) and fix the landing page's references. `file.svg`, `globe.svg`,
  `window.svg` are unused Next boilerplate — delete them.
- In `tests/build-hosted-artifacts.sh`, delete the two trailing `cp` lines that
  mirror artifacts into `$repo_root/public/`, and switch the `npm install
  --ignore-scripts` / `npm pack` block in `sdk/node` to the pnpm equivalents
  (`pnpm install --ignore-scripts`, `pnpm pack --out ...` — verify the actual
  pnpm 11 flag by running it, do not guess).

## Root `package.json` — rewrite as a private tooling package

Keep only what the remaining tooling actually needs:
- `"private": true`, `"type": "module"`, `"packageManager": "pnpm@11.11.0"`
  (confirm with `pnpm --version`), `engines.node >= 22.13.0`, repository field.
- devDependencies: `ajv`, `ajv-formats` (used by `tests/setup-matrix-e2e.mjs`),
  `mint` pinned to a real published version (replaces `npx --yes mint`).
  Add nothing else unless install or a test proves it necessary.
- Scripts:
  - `test`: `node --test tests/*.test.mjs` — NO build prerequisite.
  - `docs:validate`: `cd docs && pnpm exec mint validate`
  - `docs:a11y`: `cd docs && pnpm exec mint a11y`
  - keep `build:artifacts`, `test:setup-matrix`, `test:docs-loop` (port their
    inner `npm run` calls to `pnpm`).
  - drop `dev`, `build`, `start`, `lint`, `db:generate`.
- Drop the `overrides` block (postcss/sharp) — both were Next-only.

## `pnpm-workspace.yaml`

```yaml
packages:
  - "."
  - "landing-page"
  - "sdk/node"

minimumReleaseAge: 10080
minimumReleaseAgeIgnoreMissingTime: false
onlyBuiltDependencies: []
```

Use the correct pnpm 11 key for the build-script allowlist — check
`pnpm install` output; if a package genuinely needs a build script, add ONLY
that package to the allowlist, one at a time, and say why in your summary.
No cross-workspace dependencies between the three packages.

## Other

- `tests/setup-matrix-e2e.mjs`: remove the dist/build coupling. The
  `SETUP_MATRIX_SKIP_BUILD` path already exists — make the no-dist path the
  only path and delete the branch that builds/imports from `dist/`.
- `.gitignore`: drop the now-dead next.js/vercel/yarn/wrangler stanzas, keep
  node_modules/target/dist/env rules. Do not over-prune.
- `sdk/node/package.json`: change `test`/`prepack` scripts from `npm run` to
  `pnpm run`. Leave its deps and code otherwise unchanged.

## Do NOT

- Do not touch `backend/` (chunk 4 owns it), `docs/`, `protocol/`,
  `sdk/{go,python,rust}`, `backend/public/`.
- Do not touch `.github/workflows/` — chunk 6 owns CI. `docs.yml` will break on
  `npm ci` until then; that is expected and fine.
- Do not add a Makefile (chunk 5) or biome config (chunk 3).
- Do not touch Railway or run any deploy.
- Do not commit. The orchestrator commits.

## Done looks like

- `pnpm install` succeeds from a clean state (`rm -rf node_modules`).
- `pnpm test` passes — all of `tests/*.test.mjs`, no build step.
- `git grep -n "wrangler\|vinext\|cloudflare\|drizzle\|eslint\|next"` outside
  `docs/`, `backend/`, `sdk/`, `.briefs/`, `.reviews/` returns nothing
  meaningful. Report any remaining hit you deliberately kept.

Reply with a summary of what you deleted/changed, the `pnpm install` and
`pnpm test` output, and anything the brief did not anticipate.
