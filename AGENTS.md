# os-epode — Agent Instructions

## Project

Agent Feedback: structured product feedback from customer agents. Rust backend
(`backend/`) serving a vanilla-JS dashboard (`backend/public/`), SDKs (`sdk/`),
and the public protocol (`protocol/v1/`).

## OS Platform (shared brain)

Platform-enabled repo — Product `epode`, Team `os-core`, Issue prefix `EPD`.
Use the `os_platform_*` MCP tools (https://platform-api.opensoftware.co/mcp);
REST fallback `https://app.opensoftware.co/api` + `Authorization: Bearer
$OS_PLATFORM_API_KEY`. Never print or store credentials.

**Before work that will produce a branch** (skip for Q&A, typos, exploration, CI):
1. `os_platform_get_product{handle:"epode"}` — response embeds the Product
   Memory index; `os_platform_get_memory` only entries whose description touches
   your task.
2. Find-or-create the Issue: `os_platform_search_product_issues` first; create
   only if no open Issue matches the outcome. One Issue per independently
   reviewable outcome; reuse it across sessions.
3. Set the Issue `in_progress` (`os_platform_set_issue_status` with the Product
   handle, Issue number, and status), branch `EPD-<number>-<slug>`, and
   put `EPD-<number>` in commit subjects and the PR title/body. PR-Links
   advances in_review/completed automatically where installed; if it doesn't,
   set them yourself. Leave unfinished work in its true status.

**After the work lands**: for each durable fact (decision, convention, gotcha
that cost >10 min) — check the memory index, then `os_platform_create_memory` or
`os_platform_update_memory` the existing slug; never a near-duplicate, never
secrets, never a local notes file.

**Posts** (`os_platform_create_post{team:"os-core"}`): only when a teammate
would act differently for reading it — blocked and stopping, a decision that
changes someone's work, a shipped result the derived events don't convey, or a
start of cross-person/cross-session work. Normally ≤1 per Issue per day. Read
`os_platform_get_team_timeline` before asking anyone "what's the status?".

**No access** (no MCP tools, no key): say once — "OS Platform not configured;
see README → OS Platform" — then work normally, fully offline. No local memory
substitute; put durable learnings in the PR description. At handoff, state
"platform sync skipped"; never imply the platform steps ran.

## Agent skills

### Issue tracker

Issues live on the Open Software platform (os-platform), Product `epode` — not
GitHub Issues. Primary interface is the OS Platform MCP
(`mcp__claude_ai_OS_Platform__fellow_*`); the vendored `os-platform` skill
script is the shell fallback and cannot set labels, parents, or relations.
Bodies are append-only, writes are probe-then-verify. See
`docs/agents/issue-tracker.md`.

That doc's **Wayfinding operations** section defines how the `wayfinder` skill
maps onto this tracker. Parent/child, labels, and assignment are native;
**blocking is not** — relation kinds are only `related` / `duplicate_of`, so
blocking is a body convention and the frontier must be computed client-side
and narrated.

## Local development

- Treat the root `Makefile` as the executable source of truth. Inspect `make help` and follow the next-step commands printed by Make instead of duplicating or inventing orchestration.
- Preserve existing local environment files. Do not enable developer authentication automatically or generate or rotate local secrets.
- Docker-backed `docker-compose` is the default. When the developer explicitly uses rootless Podman, pass `DEV_CONTAINER_RUNTIME=podman` to every Make invocation that manages PostgreSQL.
- Never persist `DOCKER_HOST`, guess Podman socket paths, or commit machine-specific host networking or Compose overrides.
- Bootstrap does not seed data, run a separate migration command, or start long-running backend and web processes. Backend startup owns local migrations.

## Verification

- `pnpm test` — runs `node --test tests/*.test.mjs`.

The dashboard test suite asserts against the **source text** of
`backend/public/app.js`, `app.html`, and `styles.css`, plus a DOM harness in
`tests/dashboard-runtime.test.mjs`. Asset URLs in `app.html` are cache-busted
(`?v=YYYYMMDD-<name>`) and the version string is asserted by the tests — bump
both the file and the assertion together.

## Web UI

- Use shadcn/Base UI components as the primitive layer; shadcn does not define Epode's product workflows or API model.
- Use the Central Icon System outlined Radius 3 / Stroke 2 package through the `central-icons` alias. Import individual icons from `central-icons/IconName`; do not add new Lucide imports.
- Keep `CENTRAL_LICENSE_KEY` in the developer or deployment environment only. Never commit the key.
