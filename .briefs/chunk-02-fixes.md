# Chunk 2 — review fixes

Both reviewers returned FIX-FIRST on the uncommitted chunk 2 working tree.
Read `.reviews/dev-cleanup-02-prune-grok.md` and
`.reviews/dev-cleanup-02-prune-opus.md` in full — they contain the evidence and
the exact commands that were run. Apply the fixes below. Do not commit.

## Blocking

1. **Drop both `allowBuilds: true` entries** — `pnpm-workspace.yaml`.
   Proven unnecessary: a clean `pnpm install --frozen-lockfile --ignore-scripts`
   followed by `mint validate` and `mint a11y` from `docs/` both succeed with
   zero build scripts executed (opus ran this; orchestrator independently
   confirmed both docs commands pass with `PUPPETEER_CACHE_DIR` pointed at a
   nonexistent path). The puppeteer entry additionally makes
   `pnpm install --frozen-lockfile` fail outright on this machine, violating the
   chunk's own definition of done.

   Replace the whole `allowBuilds` map with an empty one and a short comment
   saying it is deliberately empty and that entries require a demonstrated
   failing command. Also drop the two inert `false` entries (`keytar`,
   `@scarf/scarf`) — they are already the default and are version-pinned, so
   they silently stop matching on any bump.

   After the change, verify from a genuinely clean state:
   `rm -rf node_modules sdk/node/node_modules landing-page/node_modules`
   then `pnpm install --frozen-lockfile`, then `pnpm test` (expect 58 pass).
   Do NOT delete or modify anything under `~/.cache` — it is shared.

2. **`AGENTS.md` is stale and will misdirect chunks 3-6** (`CLAUDE.md` is a
   symlink to it, so it is loaded at the start of every session). Update:
   - the project description: it is no longer "a Next.js marketing site
     (`app/`)" — it is `landing-page/`, hand-written static HTML/CSS.
   - the Verification section: `npm run test` → `pnpm test`, and it no longer
     builds first. Remove `npm run lint` — eslint (both the script and
     `eslint.config.mjs` are gone). Biome arrives in chunk 3 — do not document
     it yet, just remove the eslint line.
   - Keep the dashboard cache-busting note about `backend/public/` — still true.
   Keep the edit tight; do not restructure the file.

## Non-blocking — apply all of these too

3. `tests/build-hosted-artifacts.sh:11` — use
   `pnpm pack --pack-destination "$artifacts"` instead of the hardcoded
   `--out "$artifacts/agent-feedback-node-0.1.0.tgz"`. The pinned filename
   silently mislabels the tarball the day `sdk/node` version bumps. Verify the
   flag exists in pnpm 11 and produces `agent-feedback-node-0.1.0.tgz`.

4. `tests/build-hosted-artifacts.sh:10` — `cd sdk/node && pnpm install` now
   installs all 3 workspace projects (npm scoped it to `sdk/node`). Restore the
   narrow scope with `--ignore-workspace` (or an equivalent `--filter` form);
   pick whichever actually works and say which you used.

5. `package.json` — bound the engines range: `">=22.13.0 <25"`. `mint` refuses
   to run on Node 25+ ("mintlify is not supported on node versions 25+") but
   declares `>=18.0.0` itself, so nothing warns; on Node 26 `pnpm docs:validate`
   just dies.

6. `backend/docs/INTEGRATION_TEST_MATRIX.md:39` — it still claims
   `npm run test:setup-matrix` rebuilds the hosted SDK artifacts. After the
   dist decoupling it does not; it tests against whatever is already in
   `backend/public/`. Correct the sentence and say explicitly that
   `pnpm run build:artifacts` must be run first if the SDK source changed.
   This is a doc-only edit inside `backend/docs/` — do not touch Rust.

7. `examples/node-fastify/Dockerfile:4` and `examples/node-mcp/Dockerfile:4`
   run `cd sdk/node && npm ci`, which hard-fails now that
   `sdk/node/package-lock.json` is deleted. Switch them to `npm install`.
   (`examples/node-express/Dockerfile` has its own lockfile — leave it.)

8. `.railwayignore` — drop the dead `.vinext` / `.wrangler` / `.next` entries.
   Chunk 6 wires `railway up` against this file, so it should be accurate.

9. `.gitignore` — drop `/.pnpm-store/`. pnpm's store is global
   (`~/Library/pnpm/store`) and nothing here sets `store-dir`, so it is a rule
   for a directory that will never exist.

10. `pnpm-workspace.yaml` — keep the two `minimumReleaseAgeExclude` entries
    (both verified genuinely needed: `@modelcontextprotocol/{core,server}@2.0.0`
    published 2026-07-27, inside the 7-day window; both are exact `name@version`
    pins so a later `2.0.1` cannot inherit the exemption). Add a comment
    recording *why* they exist and that they become no-ops after 2026-08-03 and
    should be deleted then.

## Do NOT

- Do not touch `.github/workflows/` (chunk 6), the Makefile (chunk 5), biome
  (chunk 3), or `backend/src` / `backend/Cargo.toml` (chunk 4).
- Do not touch Railway. Do not commit.

## Done looks like

- `rm -rf node_modules */node_modules && pnpm install --frozen-lockfile`
  succeeds with no build scripts run.
- `pnpm test` → 58 pass.
- `pnpm docs:validate` and `pnpm docs:a11y` both pass. NOTE: they need Node
  22-24; this machine's default is Node 26. Use
  `~/.local/share/fnm/node-versions/v22.23.1/installation/bin` on PATH.

Reply with what you changed, the commands you ran, and their output.
