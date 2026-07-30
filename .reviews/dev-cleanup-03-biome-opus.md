# Review — chunk 3 (biome) — opus

Method: I did not re-run `pnpm check` / `pnpm test` / sdk tests for their own
sake. The SDK behavior question was answered by parsing every modified source
file with the TypeScript compiler API and comparing, in source order, every
string-literal *value* (cooked, so escape-style changes normalize away), every
regex literal, every numeric literal, every object-literal key sequence, and
every array-literal element sequence — old (HEAD) vs new. That covers the
`sdk/node/src/*.ts` diff hunk by hunk without relying on my eyes. Findings are
marked [ran] / [read].

## Blocking

- **`landing-page/**/*.html` claims coverage Biome 2.4.12 does not provide** —
  `biome.json:6`. **[ran]**

  Direct probe, no files touched:
  `printf '<div   class="x"  ><p>hi</p>   </div>' | biome format
  --stdin-file-path=landing-page/probe.html` returns the input verbatim plus
  `The content was not formatted because the formatter is currently disabled.`
  Biome 2.4.12 gates HTML behind `html.formatter.enabled` (the `html` key is in
  its `configuration_schema.json`, and it is experimental); `biome.json` never
  sets it. Confirming the same thing from the other side, `biome format
  landing-page/index.html` reports `These paths were provided but ignored`.

  So both landing-page HTML files sit inside `files.includes`, are counted in
  `Checked 26 files`, and are neither formatted nor linted. `pnpm check` returns
  green over markup it never looked at. The chunk brief anticipated exactly this
  and gave an explicit instruction: *"If it cannot format HTML reliably, scope
  Biome to CSS+JSON there and say so in your summary rather than half-enabling
  it."* This is the half-enabled state. Either drop the glob (and say so), or
  set `html.formatter.enabled: true` and accept the experimental formatter
  rewriting the hand-written landing page — but not the current silent middle.

  CSS is fine and I verified it independently: the same stdin probe with
  `landing-page/probe.css` on deliberately mangled input returns properly
  reformatted CSS, so `styles.css` is genuinely covered and genuinely already
  conformant. The gap is HTML only.

## Non-blocking

- **A lint autofix rewrote a regex literal that parses dashboard source text** —
  `tests/team-page.test.mjs:57`. **[ran]** `complexity/noAdjacentSpacesInRegex`
  turned `/…\{([\s\S]*?)\n    \}/` into `/…\{([\s\S]*?)\n {4}\}/`. I verified
  equivalence against the real target rather than assuming: running both
  patterns over `backend/public/app.js`, both match and capture group 1 is
  byte-identical at 307 characters. No behavior change.

  Reporting it anyway because of the class, not this instance: `pnpm check:fix`
  is now authorized to rewrite the *inside* of regex literals, and several test
  files use regexes to slice handler bodies out of `backend/public/app.js` and
  then assert against the captured text. A future autofix that shifts a capture
  boundary would leave the suite green while asserting against a different
  slice. Worth knowing before someone runs `check:fix` unattended.

- **Root-level JSON is outside the allowlist** — `biome.json:4-11`. **[ran]**
  `biome check package.json` → `These paths were provided but ignored`. No glob
  matches root `package.json`, `biome.json` itself, or any future root config.
  os-platform's config formats its own root manifest; this one does not. Small,
  but it means the one JSON file most likely to be hand-edited during chunks 4-6
  is the one Biome will not check.

- **The `!backend` / `!docs` / `!protocol` / `!examples` / `!sdk/{go,python,rust}`
  negations are dead weight** — `biome.json:14-20`. `files.includes` here is a
  positive allowlist (it opens with concrete patterns), so nothing under those
  trees could match anyway. They document intent, which has some value; they
  also imply a denylist model that isn't what is actually protecting those
  trees. `!**/node_modules` and `!sdk/node/dist` do real work, because
  `sdk/node/**/*.json` would otherwise reach into both.

## Verified clean — stating plainly so these are not re-audited

- **No behavior change anywhere in `sdk/node/src/`.** **[ran]** Across
  `core.ts`, `agent.ts`, `mcp.ts`, `express.ts`, `fastify.ts`, `doctor.ts` —
  494 string literals, 21 regex literals, 70 numeric literals, 90 object
  literals and 29 array literals — every value and every ordering is identical
  to HEAD. Specifically covering the hazards the brief named:
  - *Template/string contents altered:* no. The `instruction` strings in
    `core.ts:302-307` and `mcp.ts:60-62` changed quoting (`"…\"…\"…"` →
    `'…"…"…'`, and `\"` → `"` inside template literals) — Biome minimizing
    escapes. The cooked values are unchanged. I also confirmed this end-to-end
    by compiling both revisions and calling `AgentFeedbackRuntime.prepare()` for
    all four modes (`never_ask`, `ask_once`, `ask_always`, `off`): the emitted
    envelope JSON is identical in every field.
  - *Reordered object keys where order is observable:* no. `impacts` and
    `findingKinds` in the wire `reportSchema` were exploded across lines with
    trailing commas added, but element order is unchanged in both the tuple type
    (`core.ts:47-62`) and the emitted value (`core.ts:334-349`).
  - *Removed "unused" side-effecting import:* no. The only import removal in the
    whole diff is `tests/setup-page.test.mjs:2`, where two separate
    `from "node:fs/promises"` statements (`readFile`, `access`) were **merged**
    into one — nothing dropped.
  - *ASI hazards / changed precedence from re-wrapping:* no. `semicolons:
    "always"` is set, and the re-wrapped conditionals (`doctor.ts:68-75`,
    `core.ts:284`, `express.ts:128`) are the same expressions with the operator
    moved to the following line; tsc's emit for these differs only in
    parenthesization it adds itself.
  - *Regex literal touched in the SDK:* no — all 21 SDK regexes are byte-identical.
    The one regex change in the whole diff is the test file above.

- **`sdk/node/src/index.ts` export reorder is safe.** **[ran]** `export *
  from "./core.js"` and `"./agent.js"` swapped. I checked for the two ways that
  could matter: (a) name collisions — `core.ts` exports 17 names, `agent.ts`
  exports 13, **overlap is zero**, so nothing can shadow anything; (b)
  evaluation order — `agent.ts` imports from `./core.js`, so core evaluates
  first regardless of the re-export order. The package is real ESM
  (`"type": "module"`, `module: NodeNext`), where `export *` ambiguity is
  order-independent anyway; the first-wins hazard would only exist under a CJS
  `__exportStar` emit, which this package does not produce.

- **No `// biome-ignore` comments anywhere.** **[ran]** `git grep biome-ignore`
  outside the lockfile returns nothing. Zero diagnostics was reached by fixing
  code and by one scoped config override, as the brief required.

- **Zero diagnostics is real, not warning-hidden.** **[ran]** `noConsole`,
  `noExplicitAny` and `noNonNullAssertion` are set to `warn`, and `biome check`
  does not fail on warnings by default — so I re-ran with
  `--error-on-warnings`: still `Checked 26 files… No fixes applied`, exit 0.
  Nothing is being suppressed by severity choice.

- **The `noConsole` override is scoped exactly right, not over-broad** —
  `biome.json:47`. **[ran]** `grep -rn "console\." sdk/node/src/` returns seven
  hits and **all seven are in `doctor.ts`** — the CLI where printing is the
  output. No other SDK source prints, so the override grants nothing extra.

- **`backend/`, `protocol/`, `examples/`, `docs/`, `landing-page/`, and
  `sdk/{go,python,rust}` are untouched.** **[ran]** `git diff --name-only HEAD`
  restricted to those paths is empty. `backend/public/**` in particular is
  unmodified, so the source-text dashboard assertions are safe.

- **`@biomejs/biome@2.4.12` clears the release-age gate with room to spare.**
  **[ran]** Published 2026-04-14 — 106.6 days ago, against a 7-day
  `minimumReleaseAge`. `pnpm-workspace.yaml` is unmodified in this diff and its
  `minimumReleaseAgeExclude` still lists only the two `@modelcontextprotocol`
  entries; no exclusion was added for Biome.

- **No literal or key-order change in any of the nine modified `.mjs` files**
  beyond the two benign import edits already described (the merge in
  `setup-page.test.mjs`, and an import-source reorder in `setup-matrix-e2e.mjs`
  from `organizeImports`) and the proven-equivalent regex in `team-page.test.mjs`.
  **[ran]**

## Verdict

FIX-FIRST — one line: `landing-page/**/*.html` promises coverage Biome 2.4.12
does not deliver, which the brief specifically told this chunk not to leave
half-enabled; the formatter itself is clean, with every SDK literal, regex, key
order and emitted envelope verified byte-identical to HEAD.
