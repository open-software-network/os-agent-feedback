# Chunk 5 — Makefile command hub

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Master brief `.briefs/dev-setup-overhaul.md`.
Chunks 1-4 committed. This is chunk 5 of 6. Do ONLY chunk 5.

## Goal

A root `Makefile` that is the single command hub for this repo. Chunk 6's CI
workflows will call **make targets only** — no inline `cargo`/`pnpm` in YAML.
So every check CI needs must exist here, and each target must be runnable on a
clean checkout.

## Reference

`/Users/jakubswierczek/code/alongside/os-platform/Makefile` — read it first and
match its conventions: `.PHONY` listing all targets, `.DEFAULT_GOAL := help`,
and the self-documenting `help` target that greps `## ` comments. Every target
gets a `## ` description. Keep the section-comment style (`# --- API ---`).

Do NOT copy its docker/compose/db/observability machinery — os-epode has no
local compose dev loop in scope for this chunk.

## Targets required by the master brief

- `backend-fmt-check` — `cd backend && cargo fmt --check`
- `backend-clippy` — `cd backend && cargo clippy --all-targets --locked -- -D warnings`
- `backend-test` — `cd backend && cargo test --locked`
- `landing-check` — the landing page has no build step, so this is: Biome over
  `landing-page/` plus `node --test tests/rendered-html.test.mjs`. Make it a
  real check, not a no-op.
- `sdk-node-test` — `cd sdk/node && pnpm test` (builds via tsc, then its 16 tests)
- `docs-validate` — `pnpm run docs:validate`
- `docs-a11y` — `pnpm run docs:a11y`
- `node-test` — `pnpm test` (the 58 root tests)
- `install` — install everything a fresh checkout needs. Split it the way
  os-platform does (`install: node-install backend-install` or similar):
  - node side: `pnpm install --frozen-lockfile`. Use `--frozen-lockfile` for
    the same reason os-platform does — CI and fresh checkouts must fail loudly
    when `package.json` and the lockfile drift.
  - backend side: the rustup components clippy and rustfmt.

Add a `check` (or `verify`) aggregate target that runs everything, so a human
can run one command before pushing. Say in its `##` comment what it covers.

Also add `biome-check` / `biome-fix` (or fold into `node-lint`) — chunk 3 added
`pnpm check` / `pnpm check:fix` and CI will need the check form.

## Constraints that will bite you

1. **Node version.** `mint` refuses to run on Node 25+; root `package.json`
   pins `engines: ">=22.13.0 <25"`. The developer machine here defaults to Node
   26.5.0, so `make docs-validate` will fail locally for the wrong reason. Do
   NOT hardcode a path to anyone's fnm/nvm install. Instead make the docs
   targets fail with a clear, actionable message when the active Node is out of
   range — a short guard that checks `node -v` and tells the user to switch —
   rather than dying inside mint with a confusing error. Keep it simple.
2. Each recipe line runs in its own shell, so `cd backend` on one line does not
   persist to the next. Use `cd X && ...` on a single line (os-platform's
   convention) — do not rely on `.ONESHELL`.
3. Tabs, not spaces, for recipe lines.
4. Do not add a target that shells out to Railway or performs any deploy.

## Do NOT

- Do not touch `.github/workflows/` — chunk 6 wires CI to these targets.
- Do not modify `backend/`, `sdk/`, `tests/`, `landing-page/`, `biome.json`, or
  `package.json` — with one exception: if a target genuinely needs a script
  that does not exist yet, add it to `package.json` and say so.
- Do not touch Railway. Do not commit.
- Do not edit anything under `.briefs/` or `.reviews/`.

## Done looks like

Run each of these and report the result:
- `make help` — lists every target with its description
- `make backend-fmt-check`, `make backend-clippy`, `make backend-test` — pass
- `make node-test` — 58 pass
- `make sdk-node-test` — 16 pass
- `make landing-check` — passes
- `make biome-check` — clean
- `make docs-validate`, `make docs-a11y` — either pass, or fail with your clear
  node-version guard message (say which happened and on what node version)
- `make install` — succeeds

Reply with the target list, the guard approach you chose for the node version,
and the output of each command.
