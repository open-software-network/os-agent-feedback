# Review — chunk 3 (biome) — grok

## Blocking
- none

## Non-blocking
- root `package.json` outside `files.includes` — `biome.json:4-20` — only `sdk/node/**/*.json` + `landing-page/**/*.json` are linted/formatted; root tooling manifest never sees `check`. Harmless today; easy miss later. [read]
- `export *` order swapped in barrel — `sdk/node/src/index.ts:1-2` — was `core` then `agent`; now `agent` then `core` (alpha). No exported name overlap between the two modules (enumerated both files), so runtime/API surface unchanged. Still a non-cosmetic source reorder from organize-imports-style formatting. [read]
- consent instruction source form changed (escapes / quote style) — `sdk/node/src/core.ts` ask_once/ask_always branches; `sdk/node/src/mcp.ts` matching tool instructions — `\"` inside templates → raw `"`; ask_always double-quoted string → single-quoted with `\'`. Runtime string values compared equal in node for all four variants (scope substituted). [ran]
- `index.ts`/import type reorder + `Array<T>`→`T[]` — `express.ts`/`fastify.ts` type-import order; `mcp.ts` `content?: Record<string, unknown>[]` via `useConsistentArrayType` — type-only / private `McpResult`. [read]
- landing-page HTML/CSS have no git diff but **are** in Biome’s file set — `pnpm exec biome check . --verbose` lists `landing-page/index.html`, `app/index.html`, `styles.css` among 26 processed files; not silently skipped. Already matched formatter. [ran]
- large `tests/*.mjs` churn is wrap-only — `git diff -w` still noisy from line splits; sampled assertion paths/regexes/`readFile` targets unchanged (e.g. `rendered-html.test.mjs`). [read]
- `noConsole` override scoped to `tests/**/*.mjs`, `sdk/node/test/**/*.mjs`, `sdk/node/src/doctor.ts` — `biome.json:54-65`. `console.*` only in `doctor.ts` under `src/` (CLI). Not over-broad. [read]
- no `// biome-ignore` anywhere in diff/tree (excl. briefs/reviews/node_modules). [ran rg]
- `@biomejs/biome@2.4.12` published `2026-04-14` (~106d before review date) — clears 7d `minimumReleaseAge`; no biome entry in `minimumReleaseAgeExclude` (MCP excludes only, pre-existing). [ran npm view + read workspace]
- `git diff -- backend/` empty; `backend/public/**` absent from verbose file list; `protocol/` + `examples/` untouched. [ran]
- config matches os-platform house style minus React-only `useExhaustiveDependencies` and tsx/jsx/`.next` — formatter quote/semi/lineWidth and remaining rules aligned. [read]

## SDK behavior audit (item 1)
Hunk-by-hunk on `sdk/node/src/*`: line wraps, paren placement, union/array multiline breaks, import compression, regexes only re-wrapped (bodies identical: `afcs1_`, topic slug, HTML script extract). No removed imports, no object-key reorder in envelope/`reportSchema` literals, no operator-precedence change beyond equivalent grouping parens on `&&` chains. Wire-facing instruction strings value-equal (see above). [read + ran]

## Not re-run
- `pnpm check` / `pnpm test` / `sdk/node` tests — orchestrator already green; budget spent on behavior/config.

## Verdict
SHIP — formatter churn is cosmetic (verified string equality + no export collisions); config coverage real including HTML/CSS; no biome-ignore papering.
