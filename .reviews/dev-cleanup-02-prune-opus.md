# Review — chunk 2 (prune + pnpm) — opus

Method note: findings marked **[ran]** were verified by executing commands in
this worktree; **[read]** means inspection only. I modified no repo files.
`node_modules` was rebuilt during testing (see Verified section) — the tracked
tree is byte-identical to how I found it.

## Blocking

- **`allowBuilds: "puppeteer@24.3.1": true` is unnecessary, and it is what
  breaks `pnpm install`** — `pnpm-workspace.yaml:14`. **[ran]**

  Necessity test: `rm -rf node_modules && pnpm install --frozen-lockfile
  --ignore-scripts` (so neither puppeteer's `postinstall` nor sharp's `install`
  ever executed), then `mint validate` and `mint a11y` from `docs/` — **both
  succeed**. `mint a11y` is a static checker: it reads the theme colors for WCAG
  contrast and scans 25 MDX files for alt attributes. It never launches a
  browser. Nothing in this repo needs puppeteer's Chromium.

  Cost of having it: `pnpm install --frozen-lockfile` **fails** here —
  puppeteer's postinstall aborts on `chrome-headless-shell` and takes the whole
  install down with `[ELIFECYCLE] Command failed with exit code 1`, leaving
  `node_modules/.bin` empty. `pnpm docs:validate` then also fails, because
  `pnpm exec` re-triggers the deps check and re-runs the same failing install.
  The chunk brief's "done looks like — `pnpm install` succeeds from a clean
  state" is not met.

  Fairness: the proximate trigger is a corrupt `~/.cache/puppeteer` on this
  machine (both cache dirs are 180K/1.0M stubs from earlier failed downloads),
  so a pristine CI runner would instead succeed after pulling two full Chrome
  builds (~200MB). That is the point — the entry buys nothing and makes every
  install in this repo depend on a large third-party download that can fail
  fatally. Remove it. Installs then succeed and both docs commands still pass;
  I ran exactly that configuration.

- **`allowBuilds: "sharp@0.33.5": true` is also unnecessary** —
  `pnpm-workspace.yaml:15`. **[ran]** Covered by the same `--ignore-scripts`
  experiment above. sharp 0.33.5 resolves the prebuilt `@img/sharp-*` platform
  packages (`pnpm-lock.yaml:126-240`), and its `install` script is only
  `node install/check` — a verification step, not a build. Granting install-time
  code execution to a transitive dependency of a docs CLI, for no functional
  gain, is precisely the weakening the brief asked me to look for. Both entries
  read as "make the pnpm ignored-build-scripts warning go away", not as
  install-proven necessities.

- **`AGENTS.md` tells every agent to run scripts this chunk deleted** —
  `AGENTS.md:29-30`. **[read]** `CLAUDE.md` is a symlink to `AGENTS.md`, so this
  is the instruction file loaded at the start of every session working chunks
  3-6. It currently says `npm run lint` — eslint.` when both `eslint.config.mjs`
  and the `lint` script were deleted in this diff, and `npm run test` — builds,
  then runs...` when `test` no longer builds and the package manager is now
  pnpm. `AGENTS.md:6-7` still describes "a Next.js marketing site (`app/`)",
  which is now `landing-page/` static HTML. Blocking not because docs are stale
  but because these are the operative instructions for the four chunks that
  follow, and they will misdirect them.

## Non-blocking

- **`pnpm pack --out` hardcodes the version into the filename** —
  `tests/build-hosted-artifacts.sh:11`. **[ran]** `pnpm pack --pack-destination
  "$artifacts"` exists in pnpm 11 and writes `agent-feedback-node-0.1.0.tgz` —
  byte-for-byte the same filename npm produced from `@agent-feedback/node@0.1.0`
  (I ran both forms into a scratch dir; identical output). The implementation
  instead pins the literal name, so the day `sdk/node/package.json` goes to
  0.2.0 the script writes 0.2.0 content into a file named `...-0.1.0.tgz` and
  `tests/docs-contract.test.mjs`, `docs/quickstart.mdx`, and
  `sdk/node/README.md` all keep passing while serving a mislabelled tarball.
  Use `--pack-destination "$artifacts"`; it is the drop-in npm equivalent the
  brief asked for.

- **`pnpm install` inside `sdk/node` now installs the entire workspace** —
  `tests/build-hosted-artifacts.sh:10`. **[ran]** `cd sdk/node && pnpm install
  --ignore-scripts` reports `Scope: all 3 workspace projects`. npm scoped this
  to `sdk/node`; pnpm does not. So `pnpm run build:artifacts` — a script whose
  job is packing four SDKs — now drags in mint and its 950 transitive packages,
  and (with the puppeteer entry above still present) triggers the Chromium
  download. `--filter` or `--ignore-workspace` would restore the old scope.

- **`backend/docs/INTEGRATION_TEST_MATRIX.md:39` is now false in a way that
  hides a behavior change** — **[read]** It states "`npm run test:setup-matrix`
  rebuilds the hosted SDK artifacts". After
  `tests/setup-matrix-e2e.mjs:413`'s build branch was removed, it does not.
  The e2e now silently tests against whatever tarballs happen to be sitting in
  `backend/public/`. The decoupling itself is correct and was what the brief
  asked for, but nothing now guarantees those artifacts match current SDK
  source, and the one doc that described the guarantee still claims it holds.

- **Two example Dockerfiles can no longer build** —
  `examples/node-fastify/Dockerfile:4` and `examples/node-mcp/Dockerfile:4`.
  **[read]** Both run `cd sdk/node && npm ci`, and `sdk/node/package-lock.json`
  was deleted in this chunk; `npm ci` hard-fails without a lockfile. Not a live
  CI break — I checked, nothing builds these (the setup matrix uses
  `examples/setup-matrix-node-*` and its own `npm install`, and no workflow
  references them) — but they are the runnable references linked from the docs
  site. `examples/node-express/Dockerfile` is unaffected; it has its own
  lockfile.

- **`engines.node` is unbounded but the pinned toolchain is not** —
  `package.json:6`. **[ran]** `>=22.13.0` admits Node 26, and on Node 26.5.0
  `pnpm docs:validate` dies with `mintlify is not supported on node versions
  25+`. `mint@4.2.734`'s own `engines` claims `>=18.0.0`, so neither pnpm nor
  npm will warn — the failure only shows up at runtime. CI pins Node 22 so this
  does not break the pipeline, but it breaks the docs scripts for anyone on a
  current Node. Since this chunk chose the engines range and pinned mint,
  bounding it (`>=22.13.0 <25`) belongs here.

- **The `minimumReleaseAgeExclude` entries are genuinely necessary today, and
  tightly pinned — but permanently encode a temporary need** —
  `pnpm-workspace.yaml:8-10`. **[ran]** I checked the registry:
  `@modelcontextprotocol/core@2.0.0` and `@modelcontextprotocol/server@2.0.0`
  were both published 2026-07-27, i.e. 2.3 days ago, so they genuinely fall
  inside the 7-day window. The exclusions are exact `name@version` pins, so a
  later `2.0.1` would not inherit the exemption — that part is correct and I
  want to be clear it is not the sloppy `name`-only form. Two residual concerns:
  (a) both entries become no-ops on 2026-08-03 and nothing will ever remove
  them, so the file accretes permanent exemptions; (b) exempting 2-day-old
  `@modelcontextprotocol/*` releases is exempting exactly the package family and
  exactly the age window the quarantine exists to defend. Pinning `mint` to a
  build whose deps have all aged out is the alternative that preserves the
  policy; worth a deliberate decision rather than a default.

- **`mint@4.2.734` is 7.3 days old — 0.3 days inside the policy** —
  `package.json:23`. **[ran]** mint publishes several times a day (4.2.759
  through 4.2.762 all landed within 0.3 days). Any future bump will land inside
  `minimumReleaseAge` and force either a 7-day wait or another permanent
  exclusion. Not wrong today; flagging that this dependency and this policy are
  structurally in tension and will generate recurring friction.

- **The `false` entries in `allowBuilds` are inert** —
  `pnpm-workspace.yaml:12-13`. `@scarf/scarf@1.4.0` and `keytar@7.9.0` are
  already denied by default. They document intent, which has some value, but
  they are version-pinned and will silently stop matching on any bump, at which
  point they read as protection that is not there.

- **`.railwayignore:3-4` still excludes `.vinext` and `.wrangler`** — dead
  entries for deleted tooling. Cosmetic; noting it only because `.railwayignore`
  governs the `railway up` upload that chunk 6 will wire to `landing-page/`.

- **`/.pnpm-store/` in `.gitignore:5` is speculative** — pnpm's store is global
  (`~/Library/pnpm/store`) unless someone sets `store-dir`, which nothing here
  does. Harmless, but it is a rule for a directory that will never exist.

## Verified clean — stating plainly so these are not re-audited

- **`tests/setup-page.test.mjs` is not a weakened test.** **[read]** The removed
  `assert.match(appAuth, /requireAppUser\(returnTo = "\/"\)/)` asserted against
  `app/auth.ts`, which the master brief deletes along with the ChatGPT auth
  path. The subject of the assertion no longer exists, so the deletion is a
  necessary consequence, not a way to make a test pass. The four backend-side
  assertions that carry the "root URL is the canonical signed-in app" contract
  are all intact.
- **`tests/docs-contract.test.mjs:165` repoint is correct.** **[ran]**
  `tests/build-hosted-artifacts.sh:5` sets `artifacts="$repo_root/backend/public"`,
  so `backend/public/` was always the real output; the deleted `cp` lines only
  mirrored copies into the Next site's `public/`. `backend/public/` is untouched
  and still holds all five artifacts.
- **Root `public/` had no non-Next consumer.** **[ran]** After the change,
  `git grep` for `../public/`, `repo_root/public`, and `public/agent` across the
  tree returns exactly one hit: the corrected `backend/public/` path.
- **`SETUP_MATRIX_SKIP_BUILD` was removed completely.** **[ran]** `git grep`
  returns nothing outside `.briefs/`. The env var is gone from
  `tests/setup-matrix-e2e.mjs` and from the `test:docs-loop` script — no dead
  config, no unreachable branch.
- **`npm install` at `tests/setup-matrix-e2e.mjs:348` is correct, not a missed
  port.** It installs the packed tarball into generated example projects the way
  the docs tell customers to. Converting it to pnpm would make the e2e stop
  testing the documented path.
- **58/58 tests pass** via `pnpm test`, twice, with no build step and no
  `dist/`. **[ran]**
- **`pnpm install --frozen-lockfile` succeeds and is reproducible** once the
  puppeteer postinstall is neutralised — 952 packages, lockfile unchanged, no
  tracked-file drift. **[ran]**

## Verdict

FIX-FIRST — the two `allowBuilds: true` entries are provably unnecessary (mint
validate and a11y both pass from a clean install with zero build scripts) and
the puppeteer one currently makes `pnpm install --frozen-lockfile` fail, which
is the chunk's own definition of done; everything else in the prune is correct,
including the parts the brief flagged as suspect.
