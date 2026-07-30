# Review — phase 2 chunk 2a (`web/` Next.js scaffold)

Reviewer: `opus`. Uncommitted delta on `4bbe629` (root config diff + untracked
`web/`). Reviewed against `.briefs/phase2-web.md` chunk 2a.

**One finding**, and it is arguably 2e's to fix. Everything the brief asked for in
2a works: the gate is green end to end on Node 22.23.1, the committed
`types.ts` is byte-identical to a fresh regeneration, `output: "standalone"`
produces a real server bundle, and nothing from the skip list leaked in.

---

## minor — `web/` has zero CI coverage; a web-only PR runs no checks at all

`.github/workflows/ci.yml:28-78` (the `changes` path filters), and no web job anywhere

`grep -rn "web" .github/workflows/` returns nothing. So:

- No CI job runs `web-check`, `web-typecheck`, `web-test`, or `web-build`. Those
  four targets exist only in `make check`, and **no CI job runs `make check`** —
  CI invokes the individual targets (`backend-fmt-check`, `biome-check`,
  `node-test`, `landing-check`, `sdk-node-test`, `docs-*`).
- The `node` job's path filter (which runs `make biome-check`, the one thing that
  now does lint `web/**`) does not list `web/**`.

Failure scenario: after this chunk lands, a PR that touches only
`web/app/page.tsx` matches no filter, every job is skipped, the `workflows`
aggregate gate goes green, and a type error or lint failure merges to `main`.
Verified concretely — `make web-typecheck` and `make web-check` both exist and
exit 0 locally, but nothing invokes them on CI.

Note this PR itself *is* covered: 2a touches `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `biome.json`, and `Makefile`, all of which are in the
`node` filter, so `make biome-check` will lint `web/` on this PR. The hole opens
for *subsequent* web-only changes.

This does not violate 2a's stated brief — the brief assigns workflows to 2e
("Dockerfile + `build-web.yml` + `promote.yml` web artifact") and asks only that
`web/` be covered by `pnpm check` from the root, which it is. Flagging it because
the gap is created by this chunk and is easy to lose track of: 2e's brief mentions
`build-web.yml` for artifact building, not a `web` entry in `ci.yml`'s path
filters plus a job running the cheap web targets.

Suggested fix (2e, or a one-liner now): add a `web` filter (`web/**`,
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `biome.json`, `Makefile`)
and a job running `make web-check web-typecheck web-test`. Also add `web/**` to
the existing `node` filter so root Biome runs on web-only changes.

---

## Checked clean

**1. Workspace membership and check coverage.** `web` added to
`pnpm-workspace.yaml` packages; `pnpm install` reports "Scope: all 4 workspace
projects". `@epode/web` is `private: true`, no dependency on `sdk/node` or
`landing-page`. Root `pnpm check` now checks **39** files (was 28), i.e. it picks
up the 11 web files; `pnpm --filter @epode/web check` independently checks 11 —
Biome resolves the root config correctly from the `web/` cwd, so `web-check` is
not vacuous. `biome.json`'s new excludes (`web/.next`, `web/coverage`,
`web/lib/api/types.ts`) are all generated output; nothing previously covered was
dropped.

**2. `web/lib/api/types.ts` matches `backend/openapi.json`.** Regenerated with the
repo's own pinned `openapi-typescript@7.13.0` into a scratchpad and diffed:
**identical, zero lines of difference**. `openapi-typescript` emitted no warnings
about the document. The file is inside `tsconfig.json`'s `include` (`**/*.ts`,
`exclude` is only `node_modules`) and `tsc --noEmit` passes, so it genuinely
typechecks rather than merely existing. The root `gen:types` script writes to
exactly this path.

**3. `output: "standalone"` is set** in `next.config.ts`, and it works, not just
declared — the build produced `web/.next/standalone/web/server.js` plus a traced
`node_modules`. `outputFileTracingRoot` is pinned to the repo root, which is what
makes tracing work for a workspace member. Worth knowing for 2e: the standalone
entrypoint is nested at `.next/standalone/web/server.js`, not
`.next/standalone/server.js`, because of that tracing root.

**4. Skip list is clean.** No Storybook, tiptap, OpenTelemetry or Playwright in
`web/package.json`, and **nothing installed** (`ls node_modules/.pnpm` finds none
of them). The `@opentelemetry/api`, `@playwright/test` and
`@vitest/browser-playwright` strings that appear in `pnpm-lock.yaml` are *optional
`peerDependenciesMeta` declarations* belonging to `next@16.2.4` and `vitest@4.1.10`
— lockfile metadata for peers that are not installed, not dependencies of this
repo. No `*.stories.tsx` anywhere.

**5. No bun.** Grepped `web/`, `Makefile`, `package.json` and `.github/workflows/`
for `bunx` / `bun run` / `bun install` — nothing. All new Makefile targets use
`pnpm --filter @epode/web`.

**6. Versions work on Node 22 and satisfy `minimumReleaseAge`.** Whole gate run
under `fnm use 22.23.1`. `next@16.2.4` declares `engines: node >=20.9.0`,
`vitest@4.1.10` declares `^20.0.0 || ^22.0.0 || >=24.0.0` — both satisfy the repo's
`>=22.13.0 <25`, and `web/package.json` repeats that range, matching root. On
release age, I checked the *per-version* publish timestamps from the registry (not
`time.modified`, which reports the package's most recent publish of any version
and is misleading here — `next` shows `2026-07-30` there):

```
next 16.2.4              2026-04-15   105.7d      @base-ui/react 1.6.0      2026-06-18    42.1d
vitest 4.1.10            2026-07-06    24.4d      @tanstack/react-query     2026-04-19   102.2d
jsdom 29.0.2             2026-04-07   114.5d      tailwindcss 4.1.18        2025-12-11   230.9d
react/react-dom 19.2.4   2026-01-26   184.9d      typescript 5.9.3          2025-09-30   302.7d
@testing-library/react   2026-01-19   192.2d      react-hook-form 7.72.1    2026-04-03   118.3d
zod 3.25.76              2025-07-08   387.3d
```

All comfortably over the 7-day floor. No new entries were added to
`minimumReleaseAgeExclude` — the only change to `pnpm-workspace.yaml` is the
`- "web"` line. `@base-ui/react` is the legitimate MUI package (v1 rename of
`@base-ui-components/react`), not a typosquat.

**7. `.gitignore` and build artifacts.** `web/.next/`, `web/out/` and
`**/*.tsbuildinfo` added; `git check-ignore` confirms `web/.next`,
`web/node_modules` and `web/tsconfig.tsbuildinfo` are all ignored. `git status
--untracked-files=all web/` lists exactly 12 source files — no `.next`, no
`node_modules`, no `tsbuildinfo`. `next-env.d.ts` is committed, which is standard
Next practice.

**Also checked and fine:**

- `tsc --noEmit` passes on a *clean* tree with no `.next/` present — I tested this
  in a scratchpad copy, because `next-env.d.ts` contains
  `import "./.next/types/routes.d.ts"` and `web-typecheck` is in `make check`
  while `web-build` is not. `skipLibCheck: true` suppresses the unresolved import,
  so a fresh clone typechecks without building first. Exit 0.
- `web-install`'s `pnpm --filter @epode/web install --frozen-lockfile` runs
  cleanly (exit 0).
- `@hookform/resolvers@5.4.0` declares only a `react-hook-form` peer, no `zod`
  peer, so pairing it with `zod@3.25.76` is not a conflict.
- The vitest test is a real assertion (renders the component, queries by role and
  text) rather than a placeholder, per brief item 6. All five required scripts
  (`dev`/`build`/`check`/`typecheck`/`test`) are present.
- `web-build` deliberately kept out of `make check` with the reasoning stated in a
  Makefile comment, as brief item 7 asked.
- Nothing from the "Do NOT do in 2a" list appeared: no `app/api/[...path]/route.ts`,
  no middleware, no auth, no design tokens, no views.

## Verification

Read-only. Nothing edited, staged, committed or pushed; `os-platform` untouched.
The clean-tree typecheck ran on a copy in the scratchpad.

```
$ eval "$(fnm env)" && fnm use 22.23.1        Using Node v22.23.1  (pnpm 11.11.0)
$ pnpm install                                Scope: all 4 workspace projects — Already up to date
$ pnpm --filter @epode/web typecheck          exit 0
$ pnpm --filter @epode/web test               Test Files 1 passed (1) | Tests 1 passed (1)
$ pnpm --filter @epode/web build              ✓ Compiled successfully in 1621ms
                                              ✓ Generating static pages (3/3)
                                              Route (app): ○ /   ○ /_not-found      exit 0
$ pnpm check                                  Checked 39 files. No fixes applied.
$ make check                                  full run to completion — backend fmt/clippy/test,
                                              openapi drift, biome, node tests, landing, sdk,
                                              web-check/web-typecheck/web-test, docs validate + a11y
                                              (docs a11y ends "success no accessibility issues found")
$ make web-check / web-typecheck / web-test   exit 0, exit 0, exit 0

$ pnpm exec openapi-typescript backend/openapi.json -o <scratchpad>/types-regen.ts
$ diff -u web/lib/api/types.ts <scratchpad>/types-regen.ts
                                              IDENTICAL

$ ls web/.next/standalone/web                 node_modules  package.json  server.js
$ ls node_modules/.pnpm | grep -iE "otel|opentelemetry|playwright|storybook|tiptap"
                                              (none installed)
$ git status --porcelain -uall web/           12 source files, no build output
$ grep -rn "web" .github/workflows/           (no matches — the finding above)

--- clean-tree typecheck (scratchpad copy, .next removed) ---
$ tsc --noEmit                                TSC_EXIT=0
```

## Verdict

**ship** — the one finding is a CI wiring gap that the brief assigns to a later
chunk. Worth fixing in 2e at the latest, and worth not forgetting: as written,
`build-web.yml` alone would not close it, because the cheap web targets still need
a `web` path filter and a job of their own.
