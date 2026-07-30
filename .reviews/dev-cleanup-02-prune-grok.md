# Review — chunk 2 (prune + pnpm) — grok

## Blocking
- `puppeteer@24.3.1: true` in allowBuilds — `pnpm-workspace.yaml` — not required for the scripts this package actually runs. Read-only inspect of `@mintlify/cli` shows `mint a11y` = color contrast (`accessibilityCheck.js`) + MDX alt-text (`mdxAccessibility.js`); no puppeteer import. Puppeteer enters the tree only via `@mintlify/scraping` (dep of prebuild/link-rot). Allowing its install script downloads Chromium into the agent/user cache — high trust + fragile install surface (session saw postinstall fail on broken chrome-headless-shell cache before clean-install check was aborted). Brief: allowlist starts empty, add only what install/tests prove. Flip to `false` (or omit) unless a concrete `pnpm docs:validate` / `docs:a11y` failure proves the browser download is required.

## Non-blocking
- `sharp@0.33.5: true` — `pnpm-workspace.yaml` — pulled by `@mintlify/prebuild` / `favicons` on the `mint validate` → `validateBuild` → prebuild path. Plausible, still not proven by a failing-command log in-tree. Prefer `false` until validate breaks without the native install.
- `minimumReleaseAgeExclude` for `@modelcontextprotocol/{core,server}@2.0.0` — `pnpm-workspace.yaml` — verified needed: `npm view` publish time `2026-07-27T23:55Z` ≈2d before review date (under 10080m). Pins are version-exact so a fresh `2.0.1` cannot ride the same exclusion. Acceptable temporary hole; drop when age clears. (sdk/node devDep `^2.0.0` + lock pin `2.0.0`.)
- `allowBuilds` `@scarf/scarf@1.4.0`/`keytar@7.9.0: false` — explicit denies are finer than empty allowlist; OK. keytar is optional dep in mint tree; scarf via spectral.
- Out-of-scope test edits are necessary, not weakened:
  - `tests/docs-contract.test.mjs:165` — `public/` → `backend/public/` after root `public/` delete; assertions unchanged.
  - `tests/setup-page.test.mjs` — dropped `app/auth.ts` read + `requireAppUser(returnTo = "/")`; file deleted with Next. Remaining backend/`/auth/start` asserts stay. No remaining product assertion was hollowed out.
- `tests/setup-matrix-e2e.mjs:410` — build branch removed cleanly; `SETUP_MATRIX_SKIP_BUILD` gone from file and from `package.json` `test:docs-loop` (no dead env). Matrix now assumes committed `backend/public/` artifacts.
- `tests/build-hosted-artifacts.sh:10-11` — `pnpm pack --out "$artifacts/agent-feedback-node-0.1.0.tgz"` matches `pnpm pack --help` (`--out <path>`) and the filename expected by `docs/quickstart.mdx`, `examples/*/package.json`, `tests/docs-contract.test.mjs` (`agent-feedback-node-0.1.0.tgz` under `backend/public` / `app.epode.ai/static/...`). Did **not** execute the script (would write artifacts). Trailing `cp` to root `public/` correctly removed.
- Root `package.json` — devDeps minimal (`ajv`, `ajv-formats`, `mint@4.2.734`); `mint@4.2.734` exists on npm (verified `npm view`). Scripts drop build prerequisite. `packageManager: pnpm@11.11.0` matches `pnpm --version`.
- Stale refs after delete (docs only; not chunk-2 authorized fixes): `README.md:71` still lists `app/`; `AGENTS.md`/`CLAUDE.md` still say Next.js marketing site + `npm run test`/`eslint`. `.railwayignore` still lists `.next`/`.vinext`/`.wrangler` — harmless dead ignore.
- `.gitignore` — Next/yarn/vercel/wrangler stanzas dropped; `/.pnpm-store/` added; `**/dist/` kept. Not over-pruned for remaining stack.
- `backend/` / `backend/public/` — untouched in diff (`git diff 5985c6a --stat -- backend/` empty). Root `public/` was Next feed + artifact mirror only; canonical artifacts remain in `backend/public/`. `favicon.svg`/`og.png` moved to `landing-page/` (favicon byte-match vs old `public/favicon.svg`).
- Workspace shape — three packages, no `workspace:` cross-deps in lock importers. `allowBuilds` is the live pnpm 11.11 key (`pnpm config list`); brief’s `onlyBuiltDependencies` name is outdated.
- Test inventory by source scan: 58 `test(` calls across `tests/*.test.mjs` (matches brief expectation). Did **not** run `pnpm test`.

## Not verified
- Item 8 (`rm -rf node_modules && pnpm install --frozen-lockfile` + `pnpm test`) — skipped per orchestrator: must not touch `~/.cache` or `node_modules` (shared with another reviewer/agent). Prior in-session `pnpm install --frozen-lockfile` attempt failed on `puppeteer` postinstall (chrome-headless-shell cache path incomplete) before that instruction — further evidence browser download should not be on the critical install path.
- Did not run `pnpm docs:a11y` / `docs:validate` or `tests/build-hosted-artifacts.sh`.

## Verdict
FIX-FIRST — deny `puppeteer` build scripts until a real docs command proves Chromium download is required; rest of prune/pnpm port looks sound on read-only inspection.
