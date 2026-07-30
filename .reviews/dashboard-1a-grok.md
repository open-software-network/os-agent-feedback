# Phase 1 chunk 1a review — utoipa/OpenAPI foundation

## blocker — Rust drift test does not fail when a router route lacks a spec entry
file: backend/src/main.rs:116-178, backend/src/main.rs:267, backend/src/main.rs:1707-1765

`openapi_document_covers_every_api_route_and_method` only compares `OpenApi.paths` to a hardcoded `expected` set. It never inspects the axum router built by `build_app_router()`.

Almost all API routes are registered with plain `.route(...)` (no `#[utoipa::path]` / `routes!`). Spec coverage for those is injected afterward by `add_pending_api_operations(PENDING_API_OPERATIONS)`, a second hand-maintained list.

Failure mode: add `.route("/api/v2/widgets", post(widget_handler))` and change nothing else.

- router serves the new path
- OpenAPI document does not include it (no `routes!`, not in `PENDING_API_OPERATIONS`)
- test still passes (`actual == expected`, both omit the route)
- `make backend-openapi-check` still passes (regen matches committed file; both omit the route)

Symmetric hole: delete a `.route(...)` but leave `PENDING_API_OPERATIONS` + `expected` alone → openapi.json and the test still claim the path exists while the server no longer serves it.

This violates the brief: the test “must fail if a route is added to the router without a spec entry,” and router construction was supposed to be the single source of truth so “the spec can never diverge from the served routes.”

Suggested fix: drive API registration only through `routes!(...)` (minimal `#[utoipa::path]` stubs ok for 1b-pending handlers), drop `PENDING_API_OPERATIONS`, and assert coverage by deriving the expected path/method set from the same registration path the router uses — or otherwise walk/compare served routes vs `OpenApi.paths` rather than a third hardcoded list. The `expected` array must not be independently editable without failing when the router changes.

## major — openapi path inventory is a parallel hand list, not the router
file: backend/src/main.rs:116-178, backend/src/main.rs:206-268

Brief step 2/3: factor one router builder so emitter and server cannot diverge; API paths belong in the spec via that tree.

Current shape:

1. `routes!` → 4 annotated handlers (real ops)
2. plain `.route` → remaining API handlers (router only)
3. `PENDING_API_OPERATIONS` → stub ops stamped into OpenAPI after the fact
4. test `expected` → fourth copy of the inventory

`openapi_spec_json()` / committed `backend/openapi.json` therefore describe “PENDING ∪ annotated,” not “what `split_for_parts().0` serves.” That is a brief violation (single source of truth), not a style preference.

Suggested fix: same as blocker — one registration path feeds both router and OpenAPI; stubs if needed must come from `#[utoipa::path]` on the actual handlers, not a side table.

## major — committed openapi.json is dishonest for ~20 of 24 path items
file: backend/openapi.json (e.g. `/auth/start`, `/api/dashboard`, `/mcp`, …), backend/src/main.rs:157-177

Non-proof routes are published as real operations with only:

```json
"responses": { "default": { "description": "Response contract pending chunk 1b." } }
```

No status codes, no bodies, no params, no security. `make types` / `pnpm gen:types` will emit TypeScript that treats these as documented endpoints with empty contracts. Review brief: a lying spec is worse than no spec because generated clients trust it.

Chunk 1a allows deferring full annotations, but shipping those paths in the committed artifact without marking them non-public / incomplete in a machine-readable way (or omitting them until 1b) still poisons the generation pipeline the phase exists to enable.

Suggested fix: either (a) omit unannotated paths from the emitted/committed document until 1b, keeping the drift test scoped to “every *served API* route must appear once annotations exist via `routes!`,” or (b) keep inventory stubs but mark them so generators cannot treat them as complete (and do not claim they match production behaviour). Prefer (a) plus a real router↔spec guard.

## minor — `ProductFeedbackReport` success schema loses findings/workaround shape
file: backend/src/models.rs:293-306, backend/openapi.json components.schemas.ProductFeedbackReport

`findings: Value` and `workaround: Option<Value>` become empty schemas (`{}`) in OpenAPI. `POST /api/v2/reports` is a proof annotation whose 200 body is exactly this type; generated clients get no array/object structure for the fields SDKs already send/receive.

Wire JSON is unchanged (still serde `Value`). Failure mode is bad generated types, not runtime break.

Suggested fix: type `findings` as `Vec<FeedbackFindingInput>` (or a dedicated output struct) and `workaround` as `Option<FeedbackWorkaroundInput>` for both serde and `ToSchema`, matching what `submit_product_feedback` already serializes into the DB/response.

## minor — `POST /api/v2/reports` security omits `x-api-key` path that the handler accepts
file: backend/src/main.rs:1212-1214, backend/src/security.rs:102-117

Handler auth is `bearer_token(&headers).filter(|t| t.starts_with("afr2_"))`. `bearer_token` accepts `Authorization: Bearer …` **or** `x-api-key`. Spec only declares `bearer_auth`.

Failure mode: client generated from the spec only sends Bearer; a caller using `x-api-key: afr2_…` works today but is undocumented. Inverse: tooling may reject api-key-only calls as “not in contract.”

Suggested fix: mirror telemetry — `security(("bearer_auth" = []), ("api_key" = []))` — or document only Bearer if api-key-for-capabilities is accidental and should be closed.

## nit — health tagged `ingest`
file: backend/src/main.rs:484

`GET /api/health` is not an ingest endpoint. Harmless until tags are used for client navigation in 1b; use `meta` / `system` or leave untagged until tag taxonomy is applied.

---

## Checked clean (no finding)

- **Behaviour surface:** same path/method set as pre-change `Router::new()` block; `/` + `/static` kept out of OpenAPI; layer order unchanged (`DefaultBodyLimit` → CORS → compression → trace → `security_headers`); `with_state` after `split_for_parts`.
- **Proof handlers wire format:** `HealthResponse`, discovery structs (`rename_all` nesting matches old `json!` keys including mixed `feedbackModes` + `never_ask`), `TelemetryBatchResult`, `ProductFeedbackAcceptedResponse` (`interactionId`), `ApiErrorEnvelope` (`error`) — serde attributes preserve prior JSON.
- **Proof status/auth (annotated four):** health 200/500; discovery 200; telemetry 202 + 400/401/500 + api_key|bearer; reports 200 + 400/401/403/409/410/500 + capability Bearer — match handler/store.
- **`backend/openapi.json` freshness:** regen via `--print-openapi` diffs equal to committed file.
- **`make backend-openapi-check`:** exists, diffs temp regen vs committed, wired into `make check`. This guard works for “committed file stale”; it does **not** fix the router↔spec hole above.
- **`--print-openapi`:** argv branch before `dotenvy` / tracing / pool; works under `env -i` (PATH/rustup only).
- **Lint/CI:** `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked` green; `Cargo.lock` has utoipa/utoipa-axum; clippy allow uses `reason =`; deps match brief (no utoipa-scalar).
- **pnpm:** `openapi-typescript` exact `7.13.0` (>7d old vs `minimumReleaseAge`); lockfile updated; `gen:types` + `make types` present and **not** in `make check`.
- **Scope:** no `web/` tree, no `backend/public/*` edits; `pnpm test` 63/63.
- **Missing brief items:** none beyond the drift-guard effectiveness hole (targets/scripts/deps/emitter/metadata/error schema/four proof annotations are present).

## Verification

```
cd backend && cargo fmt --check
→ exit 0

cd backend && cargo clippy --all-targets --locked -- -D warnings
→ exit 0

cd backend && cargo test --locked
→ 11 passed, 5 ignored (DB), 0 failed
  (includes openapi_document_covers_every_api_route_and_method ok)

pnpm test
→ 63 passed

make backend-openapi-check
→ exit 0

env -i PATH=… CARGO_HOME=… RUSTUP_HOME=… \
  cargo run --quiet --bin agent-feedback -- --print-openapi
→ exit 0, OpenAPI JSON on stdout (no DATABASE_URL/env)

diff -u backend/openapi.json <(cargo run --quiet --bin agent-feedback -- --print-openapi)
→ empty (match)

Reasoning probe (not a committed test): add plain `.route` without PENDING/expected
→ openapi + unit test + openapi-check would stay green (blocker above)
```

## Verdict
do not ship
