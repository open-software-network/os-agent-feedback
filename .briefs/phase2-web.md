# Phase 2 — Next.js dashboard in `web/`

You are `dash-impl`. You start blank. Read this whole file before editing.

Phase 1 (utoipa/OpenAPI) is merged to `main` and this branch is rebased onto it.
`backend/openapi.json` is committed, complete (24 paths / 28 operations / 65
schemas), and drift-checked by `make check`.

## Where you are

- Worktree: `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dashboard-rewrite`
- Branch: `jakub/dashboard-rewrite`
- Overall plan: `.briefs/dashboard-rewrite.md` — read it, it is the source of
  truth for architecture and scope.

## Hard limits

- **Nothing outside this worktree.**
- `/Users/jakubswierczek/code/alongside/os-platform` is **READ-ONLY** reference.
  Copy from it; never write to it.
- No `git push`. No Railway, no GitHub settings, no live infrastructure.
- Do not commit — the orchestrator reviews each chunk first.
- `pnpm`, never `bun`, despite os-platform using bun throughout.

## Chunking

Phase 2 ships as sequential chunks. **Do only the chunk you are told to do**,
then run the gate, report, and stop.

- **2a** — `web/` scaffold (this chunk)
- **2b** — BFF proxy + auth plumbing
- **2c** — design system copy + app shell
- **2d** — the six-view parity port
- **2e** — Dockerfile + `build-web.yml` + `promote.yml` web artifact

---

# Chunk 2a — scaffold

Goal: a `web/` workspace member that installs, typechecks, lints, tests and
builds. No views, no proxy, no design system yet.

1. **Workspace member.** Add `web` to `pnpm-workspace.yaml`. `web/package.json`
   is private, name it something sane (`@epode/web` or `epode-web`). No
   cross-dependencies with `sdk/node` or `landing-page`.

2. **Stack**, per `.briefs/dashboard-rewrite.md`: Next (app router, newest
   stable) + TypeScript + Tailwind + Base UI + TanStack Query +
   react-hook-form/zod + vitest/RTL.
   **Explicitly skip**: Storybook, OpenTelemetry, tiptap, Playwright. Do not copy
   os-platform's `*.stories.tsx`, its OTel deps, or its editor stack.
   Read `os-platform/web/package.json` for known-good version pairings, but take
   only what this list calls for.

3. **`next.config.ts`** — `output: "standalone"` (2e's Dockerfile needs it). See
   os-platform's for the shape. Skip `htmlLimitedBots` and the GitHub avatar
   `remotePatterns` unless something here actually needs them.

4. **Biome.** The repo has a root `biome.json`. Follow the existing convention —
   check whether `landing-page`/`sdk/node` extend the root config or carry their
   own, and match that. `web/` must be covered by `pnpm check` from the root.

5. **Typegen.** Phase 1 added a root `gen:types` script writing
   `backend/openapi.json` → `web/lib/api/types.ts`, and a `make types` target.
   Now that `web/` exists, run it, commit the generated `web/lib/api/types.ts`,
   and confirm the output typechecks. If `openapi-typescript` reports anything
   about the document, report it rather than hand-editing the output.
   Note: `openapi-typescript`'s `typescript` peer was only transitively satisfied
   before — `web/` should now depend on `typescript` directly.

6. **Tests.** vitest + RTL + jsdom configured and runnable, with one real test
   proving the harness works (not a placeholder assertion). `web/package.json`
   needs `test`, `typecheck`, `build`, `dev`, `check` scripts.

7. **Makefile.** Add `web-*` targets following existing conventions (`.PHONY`,
   `##` help comments, prefix grouping): install/check/typecheck/test/build.
   Wire the cheap ones into `make check`. Think about whether `web-build`
   belongs in `check` — state your reasoning either way.

8. **Node version.** The repo requires Node `>=22.13.0 <25`; the local default is
   Node 26, so use `fnm use 22.23.1` before any pnpm/make command. Whatever Next
   version you pick must work on Node 22 — verify, do not assume.

9. `.gitignore` — make sure `web/.next/`, `web/node_modules/`, and build output
   are ignored. Do not commit build artifacts.

## Do NOT do in 2a

No `app/api/[...path]/route.ts`, no middleware, no auth, no design tokens, no
views. A minimal placeholder root page is fine — it exists only to make `build`
meaningful and will be replaced in 2c/2d.

## Gate

```
fnm use 22.23.1
pnpm install
pnpm --filter <web-pkg-name> typecheck
pnpm --filter <web-pkg-name> test
pnpm --filter <web-pkg-name> build
pnpm check
make check
```

Report the exact output of each. `pnpm-lock.yaml` will change — that is expected;
commit-ready but do not commit.

---

## Reference notes gathered by the orchestrator (use these, they are verified)

### The Rust API already auto-refreshes — relevant to 2b, useful context now

`.briefs/dashboard-rewrite.md` flags an impl-time fact-check: *does Rust
`resolve()` auto-refresh the token pair on every request?* **It does.**
`backend/src/os_accounts.rs` `OsAccountsClient::resolve()` reads the refresh
cookie, calls `/auth/refresh`, and returns `rotated_tokens`, which
`dashboard_response` writes back as fresh cookies. So epode does **not** need
os-platform's BFF refresh machinery.

### Two divergences from os-platform that will bite in 2b

1. **Cookies, not bearer.** os-platform's proxy *strips* the `cookie` header and
   injects `Authorization: Bearer <sessionToken>`. Epode's Rust API reads the
   `af_oa_access` / `af_oa_refresh` cookies **directly**
   (`backend/src/os_accounts.rs`). Copying os-platform's header policy verbatim
   would break authentication completely. Epode's proxy must **forward cookies**.
2. **`Set-Cookie` must be forwarded back.** Because the Rust API rotates tokens
   mid-request, the proxy has to pass upstream `Set-Cookie` headers through to
   the browser. Drop them and sessions silently stop refreshing and users get
   logged out.

Do not act on these in 2a; they are recorded so they are not rediscovered late.

### Useful os-platform files (read-only)

- `web/package.json` — version pairings
- `web/next.config.ts` — standalone output
- `web/app/api/[...path]/route.ts` — the BFF catch-all (416 lines; 2b)
- `web/lib/api/proxy-auth.ts` — auth resolution (2b; epode's needs differ, above)
- `web/proxy.ts` — cookie-presence middleware + auth allowlist (2b)
- `web/app/globals.css` — Tailwind 4 design tokens (2c)
- `web/components/ui/` — Base UI component layer (2c; skip `*.stories.tsx`)
- `web/Dockerfile` — standalone runtime; **bun-based, must be reworked for pnpm
  in a workspace** (2e). A workspace member needs the root `pnpm-lock.yaml` and
  `pnpm-workspace.yaml` in the build context plus a `--filter` install; this is
  the non-obvious part of 2e.

## Reporting

Report what you built, the gate output, every dependency you added and why, and
anything you deliberately skipped. If a decision is not covered here, state the
options and your recommendation rather than silently picking.
