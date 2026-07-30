# Phase 2 chunk 2a review — `web/` Next.js scaffold

Reviewer: grok. Uncommitted worktree on `jakub/dashboard-rewrite`.
Against `.briefs/phase2-web.md` chunk 2a and `.briefs/dashboard-rewrite.md`.

Scope: real defects only (broken, insecure, CI/Docker fail, brief violation).

---

## Findings

No defects found.

---

## Checks (brief checklist)

| Check | Result |
|---|---|
| `web` in `pnpm-workspace.yaml`, `@epode/web` private | yes |
| Root `pnpm check` covers web (biome includes) | yes — 39 files incl. web |
| `make check` wires `web-check` `web-typecheck` `web-test` | yes; `web-build` intentionally out (documented) |
| `web/lib/api/types.ts` ↔ `backend/openapi.json` | regen identical; 24 paths |
| `tsc --noEmit` includes generated types | pass |
| `output: "standalone"` | set; build emits `.next/standalone/` |
| Skip list (Storybook / OTel / tiptap / Playwright) | not in `web/package.json`; lock only optional peer mentions from next/vitest |
| No bun | none in web/Makefile/package scripts |
| Node 22.13–24 | gate run on 22.23.1; all green |
| `minimumReleaseAge` (7d) | resolved lock versions all published ≥7d before 2026-07-30 |
| `.gitignore` | `web/.next/`, `web/out/`, `**/*.tsbuildinfo`, `**/node_modules/`; artifacts show as ignored |
| Stack present | Next 16.2.4 app router, TS, Tailwind 4, Base UI, TanStack Query, RHF/zod, vitest/RTL/jsdom |
| One real RTL test | `page.test.tsx` renders heading |
| No 2a out-of-scope (proxy/auth/design/views) | placeholder page only |

---

## Verification

```
fnm use 22.23.1                         → v22.23.1
pnpm install                            → Already up to date, exit 0
pnpm --filter @epode/web typecheck      → 0
pnpm --filter @epode/web test           → 1 file / 1 test pass
pnpm --filter @epode/web build          → Next 16.2.4 standalone OK
pnpm --filter @epode/web check          → biome 11 files, 0
pnpm check                              → biome 39 files, 0
pnpm run gen:types && diff types        → identical to committed types.ts
make check                              → 0 (backend + openapi + node + web + docs)
```

## Verdict
ship
