# Phase 1 — utoipa / OpenAPI for the Rust API (chunk 1a + 1b)

You are `dash-impl`. You start blank. Read this whole file before editing.

## Where you are

- Worktree: `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dashboard-rewrite`
- Branch: `jakub/dashboard-rewrite`, freshly cut from `main`.
- Repo: `os-epode` — Rust API in `backend/` (axum 0.8, edition 2024, single bin
  crate `agent-feedback`), vanilla-JS dashboard in `backend/public/`, pnpm
  workspace at root.
- **Never touch anything outside this worktree.** In particular
  `/Users/jakubswierczek/code/alongside/os-platform` is READ-ONLY reference.
- Do not push. Do not touch Railway or GitHub settings. No `web/` directory in
  this phase.

## Why this exists

A later phase replaces `backend/public/` with a Next.js app in `web/`. That app
consumes the Rust API through generated TypeScript types
(`openapi-typescript` → `web/lib/api/types.ts`). This phase is the *only*
prerequisite: annotate the Rust API with `utoipa`, emit `backend/openapi.json`,
and wire the generation script. It ships as its own PR before any `web/` work.

## Reference implementation (READ-ONLY)

os-platform does exactly this. Read, do not modify:

- `os-platform/api/Cargo.toml` — utoipa dep versions/features.
- `os-platform/api/crates/api/src/lib.rs` — `build_api_router()`,
  `split_for_parts()`, `openapi_spec_json()`, the `/openapi.json` route test.
- `os-platform/api/crates/app/src/main.rs` — the `--print-openapi` arg branch
  and its `#[allow(clippy::print_stdout)]`.
- `os-platform/Makefile` — `api-spec` and `types` targets.
- `os-platform/web/package.json` — the `gen:types` script shape.

Deviation from os-platform: **epode uses pnpm, not bun.** Use `pnpm exec`, never
`bunx`.

## Ground rules for this repo

- `backend/Cargo.toml` lints are strict and CI runs
  `cargo clippy --all-targets --locked -- -D warnings`. `pedantic` and `nursery`
  are on; `unwrap_used`, `expect_used`, `panic`, `print_stdout`, `print_stderr`
  are all `warn` — i.e. hard errors under `-D warnings`. Where you must print,
  use an `#[allow(clippy::print_stdout, reason = "...")]` — this repo uses the
  `reason =` form, match it. Serialize with `?`, never `unwrap()`.
- `backend/src/models.rs` types are `pub(crate)`; `error.rs` has a
  crate-level `#![allow(clippy::redundant_pub_crate, reason = ...)]`. Deriving
  `ToSchema` on `pub(crate)` types inside the bin crate is fine.
- **Cross-language coupling:** `tests/*.test.mjs` assert against the *source
  text* of `backend/public/app.js`, `app.html`, `styles.css`. You are not
  changing those files, but run `pnpm test` after every backend change anyway
  to prove nothing moved.
- Commits: terse, lowercase, `type: what changed`. Try a normal commit first;
  if signing fails, use `git -c commit.gpgsign=false commit` and say so.

## Verification gate (every chunk must pass all of these)

```
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets --locked -- -D warnings
cd backend && cargo test --locked
pnpm test
make check
```

Run `make check` last — it is the umbrella target. If a new target you add
belongs in `check`, add it there.

---

# Chunk 1a — foundation

Goal: the spec pipeline exists and is drift-proof, with a handful of routes
annotated as proof. Do NOT annotate every handler in this chunk.

1. **Deps.** Add to `backend/Cargo.toml`:
   - `utoipa = { version = "5", features = ["axum_extras", "chrono", "uuid", "preserve_path_order"] }`
   - `utoipa-axum = "0.2"`
   Skip `utoipa-scalar` — no docs UI is in scope. Keep `Cargo.lock` updated and
   committed (CI uses `--locked`).

2. **Router becomes the single source of truth.** Rewrite the `Router::new()`
   block in `backend/src/main.rs` (~line 162) to build an
   `utoipa_axum::router::OpenApiRouter` with the `routes!` macro, then
   `split_for_parts()` into `(Router, OpenApi)`. Requirements:
   - Route paths, methods, layer order, `nest_service("/static", ...)`, and the
     middleware stack must be **behaviourally identical** to today. This is a
     restructure, not a behaviour change.
   - Non-API routes stay OUT of the spec: `/` (`root_page`, returns HTML) and
     `/static/*`. Register them as plain axum routes merged into the
     `OpenApiRouter`.
   - Everything under `/api/*`, `/auth/*`, `/join/{invitation_id}`,
     `/.well-known/agent-feedback-v1.json`, and `/mcp` belongs in the spec.

3. **Spec emitter.** Add a `pub(crate) fn openapi_spec_json() -> anyhow::Result<String>`
   that builds the same router tree and pretty-prints the `OpenApi` document.
   Factor the router construction into a function both `main()` and the emitter
   call so the spec can never diverge from the served routes.

4. **`--print-openapi`.** `main()` currently goes straight to
   `dotenvy::dotenv()`, tracing init, then pool creation. Add an argv check
   **before any of that** (no DB, no env, no telemetry required) that prints the
   spec and exits 0. Match os-platform's shape.

5. **Spec metadata.** Give the document a sane `info`: title
   `Epode Agent Feedback API`, version from `env!("CARGO_PKG_VERSION")`, and a
   one-line description. Declare the security schemes the API actually uses so
   generated types and future clients are honest: the `x-api-key` header, the
   `Authorization: Bearer` token, and the session cookie
   (see `backend/src/security.rs` and `os_accounts.rs` for the real names).

6. **Error schema.** `backend/src/error.rs` renders every failure as
   `{"error": "<message>"}`. Add a `ToSchema` type for that envelope and use it
   as the declared error response body from here on. Do not change the wire
   format.

7. **Proof annotations (this chunk only).** Annotate exactly these with
   `#[utoipa::path]`, including real response bodies:
   - `GET /api/health`
   - `GET /.well-known/agent-feedback-v1.json`
   - `POST /api/v2/telemetry/batches`
   - `POST /api/v2/reports`
   These are the machine-facing SDK endpoints, so they are the ones worth
   getting exactly right first. Request bodies already have types
   (`TelemetryBatchInput`, `ProductFeedbackReportInput` in `models.rs`) — derive
   `ToSchema` on them and reference them.

8. **Commit `backend/openapi.json`.** Generated, checked in, regenerable.

9. **Drift guards — both of these:**
   - A Rust test in `backend/` asserting the generated document contains every
     expected path + method. It must fail if a route is added to the router
     without a spec entry.
   - A `make` target that regenerates the spec into a temp file and diffs it
     against the committed `backend/openapi.json`, failing on any difference.
     Wire it into `make check`.

10. **Make + pnpm wiring.** Following the existing `Makefile` conventions
    (`.PHONY` list, `##` help comments, `backend-*` prefix for Rust targets):
    - a target that regenerates `backend/openapi.json`
    - the drift-check target from step 9
    - a types-generation target/script running `openapi-typescript` over
      `backend/openapi.json` → `web/lib/api/types.ts`, creating the directory if
      absent. `web/` does not exist yet, so this target is **not** part of
      `make check` and is expected to be unused until phase 2 — but it must be
      correct now. Add `openapi-typescript` as a root `devDependency` (pin an
      exact version, matching how the other root devDeps are pinned) and a root
      `package.json` script for it. Note `pnpm-workspace.yaml` sets
      `minimumReleaseAge: 10080` (7 days) — pick a version older than that.
    - Run `pnpm install` and commit the lockfile change.

Then: run the full verification gate, report, and STOP. Reviewers run before the
commit is finalized.

---

# Chunk 1b — annotate the remaining handlers

Do NOT start this until told. Goal: every in-spec route has a complete,
accurate `#[utoipa::path]`, and every success body is a real schema.

- Remaining handlers are all in `backend/src/main.rs` (dashboard, products,
  team, settings/api-keys, policy, auth, join, mcp).
- **Success bodies:** most handlers today build ad-hoc `json!({...})`
  envelopes (e.g. `json!({ "report": report })`,
  `json!({ "updated": true })`, the `create_product_handler` five-field
  envelope). For every fixed-shape envelope, introduce a
  `#[derive(Serialize, ToSchema)]` struct — put them in a new
  `backend/src/api_types.rs` — and have the handler serialize that struct
  instead of the `json!` macro. **The JSON wire format must not change**;
  `serde` attributes (`rename_all = "camelCase"` etc.) exist to preserve it.
  Prove it: the existing `cargo test` suite and `pnpm test` must stay green,
  and add tests where an envelope has no coverage today.
- `/mcp` is JSON-RPC passthrough with a dynamic body — document it as an opaque
  JSON object rather than inventing a fake schema, and say so in the path
  description.
- `/auth/start`, `/auth/callback`, `/join/{invitation_id}` return redirects and
  set cookies — document the 3xx responses and the `Set-Cookie` behaviour; they
  have no JSON success body.
- Query/path params: `DashboardQuery`, `DashboardDetailQuery`, and friends need
  `IntoParams`. Declare defaults where the handler applies them
  (`interaction_limit`/`report_limit` default 250, `session_limit` 100) so
  clients see the real behaviour.
- Declare the error responses each handler can actually return (401/403/404/409/
  410/400/500 as applicable — read the handler and its `store.rs` callees; do
  not guess).
- Every route must carry a `tag` grouping it (dashboard / products / team /
  settings / ingest / auth / mcp) so the generated client is navigable.
- Regenerate `backend/openapi.json`; the drift check and the path-coverage test
  must pass.

Then: run the full verification gate, report, and STOP.

---

## Reporting

When a chunk is done, report concisely: files changed, what you did, the exact
output of each verification command, and anything you deliberately left out or
were unsure about. Do not commit until the orchestrator tells you findings are
resolved. If you hit a decision this brief does not answer, state the options
and your recommendation instead of silently picking.
