# Dev setup overhaul — brief

Scope: build/dev/deploy cleanup only. Dashboard rewrite to Next.js (`web/`) is
NEXT PHASE — do not touch `backend/public/` beyond what tests require.

## Remove
- wrangler, vinext, @cloudflare/vite-plugin, @vitejs/*, vite, `worker/`,
  `vite.config.ts`, `dist/`, `build/sites-vite-plugin.ts`
- Next.js entirely: `app/`, `next.config.ts`, react, react-dom, tailwindcss,
  @tailwindcss/postcss, `postcss.config.mjs`, sharp/postcss overrides
- ChatGPT auth: `app/auth.ts`, `app/chatgpt-auth.ts` (die with `app/`)
- drizzle: drizzle-orm, drizzle-kit, `drizzle/`, `db:generate` script
- eslint + eslint-config-next + `eslint.config.mjs` → replaced by Biome
- npm: root `package-lock.json`, `sdk/node/package-lock.json`

## New layout
- `landing-page/` — hand-written static HTML/CSS. Port content from
  `app/page.tsx` (landing) and `app/app/page.tsx` (`/app` → meta-refresh
  redirect to https://app.epode.ai/auth/start). Minimal own package.json.
- `sdk/node/` — unchanged code; becomes workspace member, loses lockfile.
- root — private tooling package: `tests/`, biome, docs scripts, pinned
  `mint` devDep (replace `npx --yes mint` with `pnpm exec mint`).
- `pnpm-workspace.yaml`: packages `.`, `landing-page`, `sdk/node`. NO
  cross-dependencies. os-june hardening: `minimumReleaseAge: 10080`,
  `minimumReleaseAgeIgnoreMissingTime: false`, `allowBuilds` allowlist
  (start empty, add only what install proves necessary). `packageManager`
  pinned in root package.json.
- `biome.json` — os-platform style; format + lint for tests/, landing-page/,
  sdk/node/.
- `backend/Cargo.toml` `[lints]` — copy from os-platform
  `api/Cargo.toml` [workspace.lints]: rust: unsafe_code=forbid,
  missing_debug_implementations=warn, rust_2018_idioms=warn,
  unreachable_pub=warn, unused_lifetimes=warn; clippy: pedantic+nursery
  warn (priority -1), unwrap_used/expect_used/panic/todo/unimplemented/
  dbg_macro/print_stdout/print_stderr warn, await_holding_lock/float_cmp/
  mem_forget deny, wildcard_imports/redundant_clone/inefficient_to_string
  warn, module_name_repetitions/missing_errors_doc/missing_panics_doc/
  must_use_candidate allow. Fix or explicitly allow resulting violations —
  no blanket crate-level allows.
- `Makefile` command hub (os-platform pattern): backend-fmt-check,
  backend-clippy, backend-test, landing-check, sdk-node-test, docs-validate,
  docs-a11y, node-test, install targets. CI calls make targets only.

## Trunk-based CI/CD (copy os-platform shape)
- `ci.yml` (or split like os-platform api.yml/web.yml): path-filtered PR +
  main checks. Jobs: backend fmt/clippy/test (cargo, --locked), pnpm
  biome check + node --test, docs validate/a11y. Concurrency group per ref,
  cancel-in-progress on PRs.
- `build-api.yml`: on main push touching backend → docker build
  `backend/Dockerfile` → push ghcr.io/open-software-network/os-epode-api
  tagged `<short-sha>` + `staging` → deploy to Railway staging env
  (image-pinned service).
- `promote.yml`: workflow_dispatch, retag staging-or-sha → production,
  point prod `agent-feedback-api` at exact SHA image. Never auto.
- `deploy-landing.yml`: on main push touching landing-page/ → `railway up`
  to `epode` service, production env. Needs RAILWAY_TOKEN secret (Jakub
  provides).
- Keep existing `docs.yml`, port npm→pnpm.

## Railway (project agent-feedback / 09147183-65c9-4891-8895-86be6026b003)
- Create new `staging` environment; new Postgres in it (NOT shared with
  v2-canary). Copy backend env vars, staging values.
- `agent-feedback-api` staging: image-based from GHCR, auto-deployed by
  build-api.yml.
- Production cutover LAST, only after staging green: disconnect repo
  auto-deploy (currently branch main, /backend, checkSuites=false → ships
  straight to prod!) and pin to promoted image.
- `v2-canary` env: DO NOT TOUCH.
- `epode` service (epode.ai landing): deployed via railway up from action.

## Test adjustments
- `tests/rendered-html.test.mjs`: currently imports built worker from
  dist/server — rewrite to assert against `landing-page/*.html` source.
- `tests/setup-matrix-e2e.mjs`: remove dist/build coupling
  (SETUP_MATRIX_SKIP_BUILD path already exists).
- Dashboard tests (source-text of backend/public/*) unchanged.
- `npm run test` → `pnpm test` = `node --test tests/*.test.mjs` (no build
  prerequisite once worker tests are rewritten).

## Decisions log
- Railway over Cloudflare everywhere; Cloudflare removed now.
- Next.js removed this phase; returns only with `web/` dashboard rewrite.
- staging = new env + new DB; v2-canary untouched.
- GHCR under this repo's namespace.
- Prod flip after staging green. Manual SDK publishing. mint pinned devDep.

## Out of scope
- Dashboard → Next.js `web/` rewrite (next phase)
- SDK publish automation
- Backend code changes beyond lint fixes
