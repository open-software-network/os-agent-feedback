# Review — chunk 5 (Makefile) — opus

Method: I did not re-run the targets for their own sake. I checked what each one
actually covers (per-file Biome probes, `make -n` expansion), boundary-tested the
Node guard against 13 versions by stubbing `process.versions.node`, and audited
Make mechanics programmatically. Findings marked [ran] / [read].

Note on context: `biome.json` has been updated since chunk 3 — `landing-page/**/*.html`
is gone and root `*.json` is now included — and `package.json` `engines` is now
`>=22.13.0 <25`. Both of my chunk-2/chunk-3 findings are addressed, and the
Makefile is consistent with the current state of both.

## Blocking

None. No target masks a failure, and none is vacuous.

## Non-blocking

- **`landing-check`'s Biome half inspects two files, neither of which is the
  landing page** — `Makefile:43-45`. **[ran]** `biome check landing-page/`
  reports `Checked 2 files`; probing each path individually,
  `landing-page/styles.css` and `landing-page/package.json` are checked while
  `landing-page/index.html` and `landing-page/app/index.html` are both reported
  as ignored. That is correct given the current `biome.json` (Biome 2.4.12's
  HTML formatter is behind an experimental flag), so this is not a config bug.

  The consequence worth stating plainly: **nothing in this repo validates the
  landing page's markup.** Not Biome, and not
  `tests/rendered-html.test.mjs`, which asserts copy strings, links and the
  meta-refresh redirect — a content contract, not well-formedness or formatting.
  The target's `##` text ("Check landing-page formatting and its rendered HTML
  contract") is literally true if you read "formatting" as the CSS/JSON and
  "contract" as the test, but a CI author reading the target name will assume
  the HTML is linted. Either say so in the description, or add a real markup
  check (an HTML parse / tag-balance assertion in the test file would cost very
  little) so the name earns itself.

- **`node-version-check` runs ninth in `check`, so the gate fails after all the
  expensive work** — `Makefile:58`. **[ran]** `make -n check` shows the order:
  three `cargo` invocations, `pnpm check`, `pnpm test`, the two `landing-check`
  lines, `cd sdk/node && pnpm test`, and only *then* the Node guard, followed by
  the two docs targets. On any Node ≥25 — including the 26.5.0 in this
  environment — `make check` compiles and tests the whole backend and Node tree
  before aborting at the version gate. Making `node-version-check` a direct
  prerequisite of `check` (first in the list) would fail in under a second
  instead. Worth fixing before chunk 6 wires CI to `make check`, since the same
  wasted work would be billed on every run of a misconfigured runner.

- **`make -j` is only conditionally safe; CI should not reach for it** —
  `Makefile:58`. **[read] + [ran]** Two distinct hazards:
  - The three backend targets all invoke `cargo` against `backend/target`
    (present). Cargo takes an advisory lock on the build directory, so
    concurrent invocations *block* ("Blocking waiting for file lock on build
    directory") rather than corrupt — safe, but you get serialization with no
    speedup, plus interleaved output. I did not run `-j4 check`; this is from
    cargo's documented locking behaviour.
  - The six `pnpm` targets are safe **when `node_modules` is already current**.
    I verified this rather than assuming: `pnpm test` on an up-to-date tree goes
    straight to the script with no install step. On a stale tree (fresh clone, or
    immediately after a lockfile change) pnpm's deps-status check can trigger an
    install, and several targets doing that concurrently would write the same
    `node_modules`. Since CI will run `make install` first, this is unlikely
    there — but `-j` is not unconditionally safe, and a one-line comment saying
    so would stop the next person from adding it.

- **`pnpm`'s engine mismatch is a warning, not an error, so four Node targets
  run outside the declared range** — `Makefile:34,40,43,47`. **[ran]** Running
  `pnpm test` on Node 26.5.0 emits
  `[WARN] Unsupported engine: wanted {"node":">=22.13.0 <25"} (current v26.5.0)`
  and then passes.

  To answer the brief's question directly: **the narrow gate scope is right.**
  Only `mint` hard-fails on Node ≥25, and `biome-check` / `node-test` /
  `landing-check` / `sdk-node-test` genuinely work on 26 (the full suite passed
  during this review). Adding the gate to them would block work that functions
  fine. The residual note is just that `engines` is advisory for those four, so
  "the repo is green" can be established on a Node the manifest disowns.

- **`check` runs `tests/rendered-html.test.mjs` twice** — `Makefile:41` and
  `Makefile:45`. **[ran]** `node-test` is `pnpm test` = `node --test
  tests/*.test.mjs`, which already includes `rendered-html.test.mjs`;
  `landing-check` runs it again explicitly. Costs about 25ms, so this is tidiness
  rather than performance — but it means `make check` and `make landing-check`
  overlap, and if the file is ever renamed only one of the two call sites will
  break loudly.

- **`backend-fmt-check` omits `--locked` while its two siblings have it** —
  `Makefile:25` vs `:28,:31`. **[read]** Harmless in substance: `cargo fmt`
  doesn't resolve dependencies, so there is no lockfile to freeze. Flagging only
  because the three lines read as a set and the inconsistency invites someone to
  "fix" the wrong one.

- **Nothing guards `rustup`'s presence the way `node`'s is guarded** —
  `Makefile:16-17`. **[read]** `backend-install` runs `rustup component add
  clippy rustfmt`, which both requires rustup on PATH and mutates the user's
  global toolchain. Compare `node-version-check:20`, which gives an actionable
  message when `node` is missing. A matching `command -v rustup` guard would make
  `make install` fail informatively on a machine with a distro-packaged Rust.

## Verified clean — stating plainly so these are not re-audited

- **Make mechanics are correct.** **[ran]** All 16 targets are in `.PHONY`, with
  nothing listed that isn't defined; every one of the 16 carries a `##` comment;
  every target name matches the `help` regex `^[a-zA-Z0-9_-]+:`; and `make help`
  in fact prints all 16. `.DEFAULT_GOAL := help` is set (`Makefile:3`). All
  three `cd X && …` recipes are single-line (`:25,:28,:31,:48`), so no
  directory change is lost between shells.

- **No target can pass while failing.** **[ran]** The only pipeline in the file
  is in `help` (`Makefile:6-8`), which is informational — nowhere else does a
  pipe mask a non-zero status. There are no `-` recipe prefixes and no subshell
  wrappers swallowing exit codes. `Makefile:20`'s `… || { echo …; exit 1; }`
  propagates correctly, and I confirmed empirically that when it fires the second
  recipe line never runs and make exits non-zero (2).

- **The `$$` escaping is right.** **[ran]** `make -n node-version-check` shows
  the shell receives `` `Node ${process.versions.node} is unsupported…` `` —
  Make collapsed `$$` to `$`, and the surrounding single quotes keep the shell
  from expanding it, so Node sees a proper template literal.

- **Every version boundary behaves correctly.** **[ran]** Stubbing
  `process.versions.node` and running the exact post-Make script:
  20.19.0 ✗, 22.9.0 ✗, 22.12.0 ✗, 22.12.9 ✗, **22.13.0 ✓**, 22.13.1 ✓,
  22.20.0 ✓, 23.11.0 ✓, 24.0.0 ✓, 24.9.9 ✓, **25.0.0 ✗**, 26.5.0 ✗
  (and a `23.0.0-nightly…` pre-release string passes, which is the right call).
  With `node` absent from PATH the guard prints
  `Node.js is required; install Node >=22.13.0 <25 and retry.` and make fails.
  The predicate is minor-granular rather than patch-granular, which is
  indistinguishable from `engines` in practice because the floor is `.0`.

- **The guard matches `package.json` `engines` exactly** — both are
  `>=22.13.0 <25`. **[ran]** No drift between the manifest and the gate.

- **`check` is not missing anything CI needs.** **[ran]** It covers every target
  the master brief's CI section names (backend fmt/clippy/test with `--locked`
  on the two that need it, Biome check, `node --test`, docs validate + a11y).
  `tests/docs-contract.test.mjs` — which the brief asked about specifically — is
  already covered, because `pnpm test` globs `tests/*.test.mjs` and that file
  matches (7 files total). `tests/setup-matrix-e2e.mjs` is correctly excluded:
  it is not a `*.test.mjs` and it needs a live backend plus a disposable
  Postgres, so it belongs to `test:setup-matrix`, not to a PR gate.

- **Every target the master brief specified exists** — `backend-fmt-check`,
  `backend-clippy`, `backend-test`, `landing-check`, `sdk-node-test`,
  `docs-validate`, `docs-a11y`, `node-test`, and install targets — plus
  `biome-check` / `biome-fix` / `check`, and the house `help` +
  `.DEFAULT_GOAL` shape copied from os-platform's `Makefile:15-18`. **[read]**

- **Scope is clean.** **[ran]** `git status --short` shows exactly one added
  file (`Makefile`) plus this review's brief. Nothing under `backend/`, `sdk/`,
  `tests/`, `landing-page/`, or `.github/` was touched, and there is no tracked
  diff at all.

## Verdict

SHIP — the Makefile is mechanically sound and no target passes while failing;
the two things worth fixing before chunk 6 leans on it are moving
`node-version-check` to the front of `check` so it fails in a second rather than
after a full cargo run, and making `landing-check`'s description admit that its
Biome half never looks at the HTML.
