# Review — phase 2 chunk 2c (web deploy: Dockerfile + build-web.yml + promote)

Reviewer: `opus`. Uncommitted delta on `4310686`. Reviewed against
`.briefs/phase2-deploy.md`.

**One minor finding**, in `.dockerignore`. `build-web.yml` is a byte-faithful copy
of `build-api.yml` apart from the intended differences, `promote.yml` follows the
existing pattern exactly, and the Dockerfile's runtime layer contains no source,
no dev dependencies and no secrets. Per your note I did not re-run the docker
build or re-check that the container serves; I focused on the things one local
build-and-run does not exercise.

---

## minor — `.dockerignore` does not exclude `web/.env*`

`.dockerignore:3-15`

The allowlist re-includes `!web/**` (line 8) and the later exclusions cover
`node_modules`, `.next`, `.git` and `target` — but nothing excludes env files
under `web/`. Root `.env` *is* excluded, by the leading `*`. Verified empirically
by building a replica context with the exact `.dockerignore` and listing what
arrived:

```
included: package.json  pnpm-lock.yaml  pnpm-workspace.yaml
          web/package.json  web/next.config.ts  web/app/page.tsx
          web/.env.local          <-- leaked
          web/.env.production     <-- leaked
excluded: .env  .git/  backend/target/  backend/openapi.json
          landing-page/  sdk/node/  web/node_modules/  web/.next/
```

Consequence, stated honestly: **images built by CI are unaffected** — a fresh
checkout has no env files, and `.gitignore:27` (`.env*`) guarantees none is ever
committed. The exposure is a developer running `docker build` locally with a
`web/.env.local` on disk. `next build` loads `.env.production`, `.env.local` and
`.env`, so any `NEXT_PUBLIC_*` value would be inlined into that image's client
bundle, and server-side values would silently change build behaviour relative to
CI. The files land in the builder stage, which is not published, so this is a
local-build hazard rather than a published-image leak.

Fix is one line after the re-includes, matching the shape of the existing trailing
exclusions:

```
**/.env*
!**/.env.example
```

## Checked clean

**1. `build-web.yml` vs `build-api.yml`.** Diffed with service names normalised.
The *only* differences are the two intended ones:

```
< paths: - "backend/**"          > paths: - "web/**", "package.json", "pnpm-lock.yaml",
                                          "pnpm-workspace.yaml", "backend/openapi.json",
                                          ".dockerignore"
< context: ./backend             > context: .
< file: ./backend/Dockerfile     > file: ./web/Dockerfile
```

Everything else is identical: the four pinned action SHAs (`checkout@3d3c42e5`,
`setup-buildx@8d2750c6`, `login-action@c94ce9fb`, `build-push-action@10e90e36`,
`setup-node@24997072`), `permissions` blocks at both workflow and job level,
`concurrency` with `cancel-in-progress: false`, `RAILWAY_CLI_VERSION: 5.30.1`, the
`<sha_short>` + `staging` tag pair, the OCI labels, the gha cache scoped per image,
and the entire Railway staging deploy script including the PTY workaround and the
deployment-discovery poll. Service name `epode-web` is consistent with the one
`promote.yml` declares. `context: .` matches the Dockerfile's root-context
assumption, and `.dockerignore` is at the repo root where a root context reads it.

**2. Path triggers.** The build context is exactly `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml` and `web/**` — all four are triggers, plus
`.dockerignore` (which changes what enters the context) and the workflow itself.
Nothing that can change the image is missing. It does not fire on `docs/**`,
`landing-page/**`, `sdk/**`, `tests/**`, `protocol/**` or `backend/**` other than
`openapi.json`. The `backend/openapi.json` trigger is belt-and-braces rather than
strictly necessary — the image builds from the committed
`web/lib/api/types.ts` and `backend/` is excluded from the context — but the brief
asked for it and a redundant rebuild is harmless.

**3. `.dockerignore` allowlist.** Correct apart from the finding. `*` followed by
the three manifest re-includes and `!web/`, `!web/**`; the trailing `.git`,
`**/node_modules`, `**/.next`, `backend/target`, `**/target` all come *after* the
re-includes, so last-match-wins excludes them from under `web/` too — confirmed in
the probe above. Total context for the real build is a few hundred kB.
`backend/target` is doubly covered (top-level `backend` is already excluded by
`*`).

**4. Dockerfile.** `node:22.23.1-bookworm-slim`, patch-pinned and inside the
repo's `>=22.13.0 <25` range. `corepack prepare pnpm@11.11.0` matches
`packageManager` in the root `package.json` exactly. `USER node` with
`--chown=node:node` on all three COPYs. No `ENV` secrets.

The runtime layer is genuinely clean — I built the standalone output and
inspected it rather than inferring from the COPY list:

```
standalone/            -> node_modules/ (.pnpm layout), web/
standalone/web/        -> .next/  node_modules/  package.json  server.js
runtime deps present   : next@16.2.4, react@19.2.4, react-dom@19.2.4
dev deps present       : none (vitest, typescript, jsdom, @testing-library,
                         @biomejs, tailwindcss all absent)
source/tests/env       : no *.tsx, no *.test.*, no tsconfig.json, no .env*
size                   : 37M standalone + 644K static
```

Layout matches the Dockerfile: `COPY .next/standalone ./` puts `server.js` at
`/app/web/server.js`, which is what `CMD ["node", "web/server.js"]` runs;
`.next/static` and `public/` are copied to `./web/.next/static` and `./web/public`,
the paths that `server.js` resolves from `/app/web`. The `mkdir -p web/public`
before the build is needed because `public/` is empty and not in git. `ENV
HOSTNAME=::`, `ENV PORT=3000` and the explanatory comment are all present.

The `COPY web ./web` in the builder stage does not clobber the `web/node_modules`
copied from `deps` — COPY merges, and `**/node_modules` keeps the source tree's
copy out of the context entirely.

**5. HEALTHCHECK.** Ran the exact command against the standalone server:

```
GET /                               -> 307, Location: /auth/signin
healthcheck command                 -> exit 0   (final url /auth/signin, 200, ok)
healthcheck with the app down       -> exit 1
```

Node's `fetch` follows redirects by default, so the 307 resolves to the static
`/auth/signin` page and reports healthy; a dead port reports unhealthy. No false
signal in either direction for the current app. Worth knowing rather than fixing:
it is a shallow liveness probe — `/auth/signin` is statically prerendered and makes
no API call, so the container stays "healthy" if `API_URL` is misconfigured and
every proxied request 502s. That is normal for a liveness check and probing the
API would make web flap whenever the API restarts. The one latent coupling is that
the probe assumes unauthenticated `/` resolves to a 2xx; if a later chunk makes
`/` return 401 instead of redirecting, this reports unhealthy on a working
container.

**6. `promote.yml`.** `web` added in all four places the existing choices appear:
the `type: choice` options, the validation `case`, the error message, and
`artifact_rows` as `{artifact: web, image: os-epode-web, service: epode-web}`. The
downstream `deploy` job consumes rows generically through the matrix
(`matrix.image`, `matrix.service`, `matrix.sha_short`, `matrix.digest`), so no
further wiring was needed and none was added. `all` now includes web. No
restructuring.

**7. Secrets and env.** `build-web.yml` references exactly the same three names as
`build-api.yml` and `promote.yml` — `secrets.GITHUB_TOKEN`,
`secrets.RAILWAY_TOKEN`, `vars.RAILWAY_PROJECT_ID`. No new secret names invented.
`RAILWAY_TOKEN` stays step-scoped with the same comment. The only application env
var the image needs is `API_URL` (`web/lib/api/bff.ts:175`, defaulting to
`http://localhost:8080`), plus `PORT`/`HOSTNAME`/`NODE_ENV` which the Dockerfile
sets — the report's claim matches the code. Nothing environment-specific is
hardcoded in the image.

One operational note, not a defect: `API_URL` has a silent default, so a
`epode-web` service created without it will start, pass the healthcheck, and 502
every proxied API call. Worth setting at service-creation time.

## Verification

Read-only. Nothing edited, staged, committed or pushed; no Railway or GitHub
settings touched; `os-platform` untouched. The `.dockerignore` probe ran against a
synthetic replica in the scratchpad, not the repo. The local `next build` I ran
only wrote to gitignored paths; final `git status` is unchanged.

```
$ actionlint (v1.7.10, same version ci.yml pins)          exit 0, no findings
$ diff <(build-api.yml normalised) <(build-web.yml normalised)
                                                           only the 2 intended deltas
$ eval "$(fnm env)" && fnm use 22.23.1                     v22.23.1
$ pnpm --filter @epode/web typecheck                       exit 0
$ pnpm --filter @epode/web test                            3 files, 14 tests passed
$ pnpm --filter @epode/web build                           ✓ compiled
$ pnpm check                                               Checked 50 files, no fixes
$ make check                                               MAKE_CHECK_EXIT=0

--- .dockerignore context probe (synthetic replica, docker build) ---
web/.env.local, web/.env.production   present in context   <- the finding
.env, .git/, backend/target/, backend/openapi.json,
landing-page/, sdk/node/, web/node_modules/, web/.next/    excluded

--- standalone contents (what the runtime stage copies) ---
no source, no tests, no tsconfig, no .env; no dev deps; next/react/react-dom only

--- HEALTHCHECK, exact command, against the standalone server ---
running app -> exit 0 (307 followed to /auth/signin, 200)
dead port   -> exit 1
```

## Verdict

**ship** — the finding does not affect any CI-built image and is a one-line
addition to `.dockerignore` whenever convenient. Nothing here blocks the designer.
