# Phase 1 chunk 1b review — annotate remaining handlers

Reviewer: grok. Uncommitted delta on top of merged 1a (`e0de424` / `dca6757`).
Against `.briefs/phase1-openapi.md` chunk 1b, `.briefs/phase1-1b-carryforward.md`,
`.briefs/phase1-review.md`.

---

## blocker / major
None found.

---

## minor — `GET /auth/callback` declares a plain-text 400 that the query type cannot produce
file: backend/src/main.rs:562-586

`AuthCallbackQuery` is only `code: Option<String>` and `state: Option<String>`.
Axum’s `Query` extractor does not 400 on missing/extra string query keys for that
shape; invalid auth is handled inside the handler as a **303** redirect via
`auth_failure`.

Failure mode: generated clients branch on 400 for “bad callback” and never hit
it; real failures look like 303 to `/?auth=failed`. Spec overclaims.

Suggested fix: drop the 400 response, or document only if a typed field that can
fail deserialization is added later.

---

## nit — envelope wire tests cover top-level keys only
file: backend/src/api_types.rs:303-387

`fixed_response_envelopes_preserve_wire_keys` asserts envelope key sets
(`apiKey`, `shownOnce`, `joinPath`, …) and
`nullable_dashboard_fields_remain_present_as_null` covers Option null presence
on interaction/report. Nested body field casing relies on pre-existing model
`rename_all` (unchanged types). Adequate for this chunk given nested structs
were not rewritten; a full golden JSON per envelope would still be stronger.

---

## Priorities checked

### (1) Wire format
- Every fixed dashboard/settings/team envelope moved from `json!` → `api_types`
  struct with matching serde names (`camelCase` where the old keys were camelCase;
  snake single-token keys left bare).
- Compared HEAD `json!({ "apiKey": …, "shownOnce": … })` etc. to
  `ProductCreatedResponse` / `ApiKeyCreatedResponse` / `ApiKeyRotatedResponse` /
  `TeamInvitationCreatedResponse` / `McpInfoResponse` / bool envelopes — keys
  match; mcp_info string values unchanged.
- `DashboardData` / session detail still serialize the same model types.
- MCP JSON-RPC still `json!` (dynamic; brief allows opaque).
- `api_types` tests + discovery golden + `pnpm test` (app.js source + DOM harness)
  green.

### (2) Spec accuracy (sample + store cross-check)
- **28 operations / 24 paths** — full former surface; tags on every op
  (`dashboard` / `products` / `team` / `settings` / `ingest` / `auth` / `mcp` /
  `system`).
- Auth redirects: `Redirect::to` → **303** + `Location` / `Set-Cookie` headers
  documented; join path UUID → plain 400; auth_start/callback/join no JSON body.
- Dashboard/session cookie only (`session_cookie` / `af_oa_access`) — matches
  `OsAccountsClient::resolve` (cookies only).
- Query defaults: `interactionLimit`/`reportLimit` 250, `sessionLimit` 100 in
  OpenAPI and `unwrap_or` in handler.
- Path params keep axum names (`report_id`, …); query params camelCase via serde.
- Json body handlers: 413/415 plain + 422 plain + 400 dual (JSON envelope /
  plain) where typed `Json<T>` is used; ingest still `Json<Value>` (no 422).
- Error codes spot-checked against `store.rs` (`create_product` 404/409,
  `create_api_key` 409, `transfer` 409, team member 403/404, reports 404, etc.).
- **410** on session-auth routes is reachable: `dashboard_auth` →
  `resolve_workspace_access` → `accept_matching_invitations` → `accept_invitation`
  race returns `ApiError::gone` — not a pure invention.
- `/mcp` POST: opaque request/response, optional security `()` | bearer | api_key
  (initialize/discover unauthenticated; tools auth) — matches handler.
- Ingest proof ops from 1a retained (including 413/415/x-api-key on reports).

### (3) Drift guard not weakened
- `KNOWN_UNANNOTATED` **removed**; coverage is `spec == served \ {GET /}`.
- `ALLOWED_REGISTRATION_FORMS`: exactly
  `.merge(non_api_routes.into())` and
  `.nest_service("/static", ServeDir::new("public"))` (count === 1 each).
- `DENIED_REGISTRATION_FORMS` intact
  (`.route_service(`, `.nest(`, `.nest_service(`, `.merge(`, fallbacks…).
- Zero-method method-router assert + ban on `any`/`on`/`MethodFilter` intact.
- Comment stripping + scanner unit test present.
- All API handlers via `.routes(routes!(…))`; sole `.route` is `GET /`.

### (4) Carryforward
- Nullable-but-always-present: `#[schema(required = true, nullable)]` on Option
  fields across dashboard models (`ProductInteraction`,
  `ProductFeedbackReport*`, `ApiKeyPublic`, `CurrentUser`, `Insights`,
  `DashboardData.currentProduct`, …); verified required lists include them.
- No `*Input` schema used as a **2xx** response body; response findings use
  separate `FeedbackFinding` / `FeedbackWorkaround` (no `deny_unknown_fields`).
- `Value` fields keep Rust `Value`; schema via
  `#[schema(value_type = Vec<FeedbackFinding>)]` /
  `Option<FeedbackWorkaround>` only.
- Input `additionalProperties: false` only on real request structs.

### (5) `tests/setup-page.test.mjs`
- Diff only retargets source-text assertions:
  - `json!` apiKey/secret → `Json(ProductCreatedResponse { … api_key, secret`
  - `.route(...patch(rename...))` → `.routes(routes!(rename_product_handler,
    delete_product_handler))`
- No app.js / behaviour contract change; suite 22/22 and full `pnpm test` 63/63.

---

## Checked clean (brief DoD)

| Item | Result |
|---|---|
| Every API route `#[utoipa::path]` + `routes!` | yes |
| `backend/openapi.json` fresh | regen diff empty |
| `api_types.rs` envelopes | yes |
| `cargo fmt` / clippy `-D warnings` / `cargo test --locked` | 0 / 0 / 15 pass + 5 ignored |
| `pnpm test` | 63 pass |
| Scope | no `web/`, no public asset edits beyond test source pins |

`make check` full umbrella not run (local Node 26 vs engine gate); constituents
that this delta can break were run.

---

## Verification

```
cd backend && cargo fmt --check                         → 0
cd backend && cargo clippy --all-targets --locked -- -D warnings → 0
cd backend && cargo test --locked                       → 15 passed, 5 ignored
pnpm test                                               → 63 passed
diff openapi.json <(--print-openapi)                    → identical
```

## Verdict
ship
