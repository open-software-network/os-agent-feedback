# Review — phase 1 chunk 1b (annotate all remaining handlers)

Reviewer: `opus`. Uncommitted delta on top of `dca6757`. Reviewed against
`.briefs/phase1-openapi.md` chunk 1b, `.briefs/phase1-1b-carryforward.md`, and the
standing brief `.briefs/phase1-review.md`.

Two findings, both minor/nit, both in test coverage rather than in shipped
behaviour. Wire format, spec accuracy, the drift guard and all four carry-forward
items came out clean — and clean under adversarial testing, not just under
reading. Details of what I actually ran are in `## Verification`.

---

## minor — the `setup-page.test.mjs` edits dropped path and method pinning, and nothing else pins them

`tests/setup-page.test.mjs:225,229-232,241-244`

The `routes!` migration rewrote three assertions. Before → after:

```js
// pinned path + method + handler:
/\.route\("\/api\/team", patch\(rename_team_handler\)\)/
/"\/api\/products\/\{product_id\}"[\s\S]*patch\(rename_product_handler\)/
/patch\(rename_product_handler\)\.delete\(delete_product_handler\)/
// now pins the handler name only:
/\.routes\(routes!\(rename_team_handler\)\)/
/\.routes\(routes!\(rename_product_handler, delete_product_handler\)\)/
```

The rewrite itself is the right mechanical response — the old regexes reference a
registration form that no longer exists. **They are not masking a behaviour
change:** I diffed the emitted spec against 1a's and all three routes are
byte-identical (`PATCH /api/team`, `PATCH /api/products/{product_id}`,
`DELETE /api/products/{product_id}`), and the handlers' bodies are unchanged.

The problem is what is left guarding them. After 1b, path and method live *only*
in `#[utoipa::path]`, and the Rust drift guard derives **both** of its sides from
that same annotation — `served` from `.routes(routes!(handler))` resolved through
`operation_id`, and `spec` from the generated document. A path rename moves both
sides together, so `assert_eq!(spec, served_that_require_spec)` cannot see it. The
guard is a *coverage* check, not a *path* check; that is by construction and is
fine, but it means these three routes now have no pin at all.

Failure scenario: someone edits `path = "/api/team"` → `path = "/api/teams"` in
`rename_team_handler`'s annotation (a plausible slip during a tidy-up, or a
find/replace on "team"). Then:

- `cargo test` — green. Both sides of the drift assert moved together.
- `pnpm test` — green. The new regex only asserts `routes!(rename_team_handler)`.
- `make backend-openapi-check` — green *after* `make backend-openapi`, which the
  same dev would run to fix the drift complaint.
- Live dashboard — `backend/public/app.js` still calls `PATCH /api/team`, gets a
  404, and team rename silently breaks.

The only remaining signal is a human noticing the `backend/openapi.json` diff in
review. Before this edit, `pnpm test` caught it. That is a real regression in
coverage introduced by this chunk, even though the chunk changed no behaviour.

Suggested fix: re-pin path and method, but against the committed
`backend/openapi.json` rather than against `main.rs` source text. The spec
document is a generated artifact that is checked in and drift-checked, so an
assertion on it survives any future registration-form migration and is strictly
stronger than the source-text form it replaces — e.g. parse `openapi.json` in the
.mjs suite and assert `paths["/api/team"].patch` exists, likewise
`paths["/api/products/{product_id}"].patch` and `.delete`. That also gives the
`tests/*.test.mjs` suite a durable hook on the API surface for phase 2.

*(Category: this is "violates the brief" only indirectly — the brief asked for the
migration, not for the pinning to survive it. Reporting it because the standing
review brief's item 9 is specifically about the cross-language coupling these
tests provide.)*

## nit — envelope key assertions cover only the top level

`backend/src/api_types.rs:288-387`

`assert_keys` serializes the envelope and compares `value.as_object().keys()` —
one level deep. So `ProductCreatedResponse` is asserted to emit exactly
`{product, environment, apiKey, secret, shownOnce}`, but nothing asserts the keys
*inside* `product`, `environment`, or `apiKey`.

No live risk in this diff: the nested types (`Product`, `ProductEnvironment`,
`ApiKeyPublic`, `TeamMember`, `TeamInvitation`, `Workspace`,
`ProductFeedbackReportWithInteraction`, `ProductInteraction`) gained only
`ToSchema` and `#[schema(...)]` attributes, both of which are inert to serde — I
verified their `#[serde(rename_all = "camelCase")]` and field lists are unchanged
from `HEAD`. Flagging it because the test reads as a wire-format guarantee and the
nested layer is where a future `rename_all` slip would actually land.

`nullable_dashboard_fields_remain_present_as_null` does reach into the nested
layer for null-presence, so the gap is narrower than it first looks.

---

## 1. Wire format

**Clean.** Every one of the 17 converted envelopes emits byte-identical JSON. I
extracted each `json!` from `HEAD:backend/src/main.rs` and compared keys and
values against the new struct plus its `serde` attributes:

| old `json!` (HEAD) | new type | keys |
|---|---|---|
| `{"authenticated": false}` | `AuthenticationStateResponse` | ✅ |
| `{"report": report}` | `DashboardReportResponse` | ✅ |
| `{"updated": true}` | `UpdatedResponse` | ✅ |
| `{"interaction": interaction}` | `DashboardInteractionResponse` | ✅ |
| `{product, environment, apiKey, secret, shownOnce}` | `ProductCreatedResponse` | ✅ camelCase preserved |
| `{"product": product}` | `ProductResponse` | ✅ |
| `{"workspace": workspace}` | `WorkspaceResponse` | ✅ |
| `{"deleted": true, "product": product}` | `ProductDeletedResponse` | ✅ |
| `{apiKey, secret, shownOnce}` | `ApiKeyCreatedResponse` | ✅ |
| `{apiKey, secret, shownOnce, predecessorExpiresAt}` | `ApiKeyRotatedResponse` | ✅ |
| `{"environment": environment}` | `EnvironmentResponse` | ✅ |
| `{"invitation": …, "joinPath": …}` | `TeamInvitationCreatedResponse` | ✅ |
| `{"member": member}` | `TeamMemberResponse` | ✅ |
| `{"removed": true}` / `{"transferred": true}` / `{"revoked": true}` ×2 | `RemovedResponse` / `TransferredResponse` / `RevokedResponse` | ✅ |
| `{name, transport, endpoint, authentication, privacy}` | `McpInfoResponse` | ✅ values also verbatim |

The `rename_all = "camelCase"` placement is correct and *selective* — it is on
exactly the five structs with multi-word fields (`ProductCreatedResponse`,
`ApiKeyCreatedResponse`, `ApiKeyRotatedResponse`, `TeamInvitationCreatedResponse`,
`ProductFeedbackAcceptedResponse`) and absent from the single-word ones where
adding it would have been a no-op but also where omitting it is required
(`McpInfoResponse`). No envelope gained or lost a key.

Against the live dashboard: `backend/public/app.js`, `app.html` and `styles.css`
are untouched (`git status`), and the envelope keys it actually reads —
`.workspace`, `.secret`, `.report`, `.apiKey`, `.interaction`, `.environment`,
`.product`, `.joinPath` — are all preserved. `pnpm test` 63/63 including the DOM
harness.

Success **status codes** are unchanged too, which was the other way this could
have broken silently: the three `201`s (`create_product_handler`,
`create_api_key_handler`, `create_team_invitation_handler`) are real
`StatusCode::CREATED` returns that already existed at `HEAD` — they appear as
unchanged context lines in the diff, not as additions. `dashboard_response` still
just calls `body.into_response()` with no status override.

## 2. Spec accuracy

**Clean, and researched rather than guessed.** 28 operations, every one tagged
(`system`/`auth`/`dashboard`/`products`/`team`/`settings`/`ingest`/`mcp`), every
non-public one carrying `security(("session_cookie" = []))`.

The discriminations that would have been easy to get wrong are all right:

- **422 is declared exactly where it is reachable.** The dashboard/products/team/
  settings handlers take typed `Json<T>`, so `JsonDataError` → 422 genuinely
  fires; they declare it. The two ingest handlers and `mcp_handler` take
  `Json<Value>` + `safe_input`, where 422 is unreachable because any valid JSON
  deserializes into `Value` — and they correctly omit it. This matches what I
  measured against a live axum server in the 1a review. Handlers with no request
  body (`rotate`, `revoke`, `transfer_ownership`, the DELETEs on invitations and
  api-keys) correctly omit 413/415/422 entirely.
- **`GET /api/dashboard` declares 400 as `text/plain` only**, while the other
  dashboard GETs declare both `text/plain` and `ApiErrorEnvelope`. That looked
  like an oversight until I traced it: `dashboard_handler` takes the team from
  `query.workspace_id`, so it never calls `requested_workspace_id(&headers)?` and
  therefore cannot emit the JSON `bad_request("Invalid team identifier")`; its only
  400 is the axum `Query` rejection. The other three do call it. The asymmetry is
  correct.
- **`/mcp` errors are declared as `OpaqueJsonObject`, not `ApiErrorEnvelope`** —
  right, because `mcp_error_response` emits JSON-RPC `{"jsonrpc","id","error":{…}}`
  envelopes, not the `{"error": …}` shape. Declaring the house error type there
  would have been the natural copy-paste mistake.
- **`/mcp` POST declares optional auth** (`security((), (bearer_auth), (api_key))`)
  — honest: `tools/list` and the discovery paths answer unauthenticated, tool
  calls do not.
- **Redirects:** `auth_start`, `auth_callback`, `join_team_handler` declare 303
  with `Location` and `Set-Cookie` headers and no JSON body. `axum::response::Redirect::to`
  is 303 See Other, so the codes are right.
- **Params:** `DashboardQuery` declares `#[param(default = 250)]` on
  `interaction_limit`/`report_limit` and `100` on `session_limit`, matching the
  handler's `unwrap_or(250)`/`unwrap_or(100)` exactly. The `x-workspace-id` header
  is declared on precisely the handlers that read it.

Error codes spot-checked into `store.rs` rather than taken on trust — 404 "Team
not found" (`store.rs:689,737`), 409 "already has 25 products" (`696,744`), 409
ownership conflicts (`545,555`), 410 invitation-gone (`217,238`), 410
cursor-outside-retention (`1061`). All declared where reachable.

## 3. Drift guard — not weakened; materially strengthened

`KNOWN_UNANNOTATED` and its ledger comment are **gone** (`grep` finds no residue),
every API route is registered via `.routes(routes!(…))`, and `NON_API_ROUTES`
still holds only `GET /`.

The deny-list is intact and now *tighter* than the carry-forward required. I
re-ran my r2 mutation matrix against it plus four new cases:

| mutation | result |
|---|---|
| `.route("/api/drift-probe", get(health))` | **FAILS — caught** ✅ |
| `.route_service("/api/drift-probe", …)` | **FAILS — caught** ✅ *(was a hole in 1a)* |
| `.route("/api/drift-probe", any(health))` | **FAILS — caught** ✅ *(was a hole)* |
| `.merge(helper())`, helper defined outside the slice | **FAILS — caught** ✅ *(was a hole)* |
| `.nest("/api/v3", helper())`, same | **FAILS — caught** ✅ *(was a hole)* |
| a **second** `.nest_service("/assets", …)` | **FAILS — caught** ✅ |
| deleting the `.merge(non_api_routes.into())` exemption | **FAILS — caught** ✅ |
| a commented-out `.route(…)` | passes — correct, a comment serves nothing |

All four bypasses I found in r2 are closed. No blanket exemption was added:
`ALLOWED_REGISTRATION_FORMS` still holds exactly two entries, each asserted to
appear **exactly once** and consumed via `replacen` before the deny-list runs — so
a second copy of either is caught, and deleting one is caught. Beyond the
carry-forward's requirements, this chunk also added `MethodRouter::new(` /
`MethodFilter::` / `.on(` denial, a `recognized_method_count > 0` assertion, a
string-literal assertion on route paths with proper escape handling, comment
stripping (`strip_rust_comments`), and a unit test for the stripper
(`route_scanner_ignores_commented_registrations`) — which closes the false-positive
nit from r2.

## 4. Carry-forward items

All four done.

- **Nullable-but-always-present → required.** Swept every schema reachable from a
  response body: `ProductInteraction` 17/17 required, `ApiKeyPublic` 9/9,
  `CurrentUser` 4/4, `DashboardData` 16/16 — zero optional properties anywhere in
  the response graph except the two deliberate cases below. The `#[schema(required
  = true, nullable)]` annotations emit correctly as `required` + `"type": [...,
  "null"]`. `api_types::tests::nullable_dashboard_fields_remain_present_as_null`
  locks the runtime side down for 21 fields.
- **No `deny_unknown_fields` input struct reused as a response schema.** Verified
  by transitive closure over the response graph: 51 response-reachable schemas,
  **zero** with `additionalProperties: false`, **zero** named `*Input`. The 11
  `*Input` schemas are request-body-only.
- **`Value` fields given `schema(value_type)` without narrowing.** Both
  `findings`/`workaround` pairs in `ProductFeedbackReport` and
  `ProductFeedbackReportWithInteraction` are still `Value`/`Option<Value>` in Rust
  with `value_type` pointing at the new schema-only `FeedbackFinding` /
  `FeedbackWorkaround`. Those two types are permissive by design (all fields
  optional, no `deny_unknown_fields`) with a doc comment and an
  `#[allow(dead_code, reason = …)]` explaining why — which is the correct
  resolution of the `additionalProperties: false` trade-off I raised in r2, and it
  is reasoned in the code rather than inherited by accident. The third
  `Value`-bearing struct, `FeedbackReportItem` (`models.rs:463`), has no `ToSchema`
  and is correctly absent from the spec: it only ever appears inside `/mcp` tool
  results, which are documented as opaque.
- Zero response-reachable properties emit an empty `{}` schema.

Also landed unprompted and worth noting: a new
`page_tests::feedback_discovery_document_matches_the_public_wire_contract` test,
which closes the "discovery document has no test coverage" finding I filed in r1
and deferred in r2. Test count 11 → 15.

---

## Verification

Read-only. Nothing edited, staged, committed or pushed; `os-platform` untouched.
Mutation testing ran on a throwaway copy at `<scratchpad>/probe1b` with a separate
`CARGO_TARGET_DIR`, reverted after each variant.

```
$ cd backend && cargo fmt --check                          FMT OK
$ cd backend && cargo clippy --all-targets --locked -- -D warnings
  Finished — no warnings
$ cd backend && cargo test --locked
  15 passed; 0 failed; 5 ignored (require DATABASE_URL)
  new: api_types::tests::fixed_response_envelopes_preserve_wire_keys
       api_types::tests::nullable_dashboard_fields_remain_present_as_null
       page_tests::route_scanner_ignores_commented_registrations
       page_tests::feedback_discovery_document_matches_the_public_wire_contract
$ pnpm test                                                63/63
$ make backend-openapi-check                               no drift
$ pnpm exec openapi-typescript backend/openapi.json -o <scratchpad>/types1b.ts
  ok — 3208 lines (was 450 in 1a)   [scratchpad, not web/]

--- spec audit (python over backend/openapi.json) ---
28 operations, all tagged, all params/security populated
51 response-reachable schemas: 0 with additionalProperties:false,
                               0 named *Input, 0 with empty {} schemas,
                               0 with non-required properties
                               (except FeedbackFinding / FeedbackWorkaround, deliberate)

--- wire format (old vs new, HEAD:main.rs vs worktree) ---
17 json! envelopes extracted from HEAD and compared key-by-key and value-by-value
StatusCode::CREATED ×3 confirmed present at HEAD (context lines, not additions)
backend/public/{app.js,app.html,styles.css} unmodified

--- guard mutation matrix (scratchpad copy) ---
8 variants, table in section 3; 7 caught, 1 correct pass (commented-out route)

--- handler/store tracing ---
dashboard_auth, dashboard_with_limits, create_product_with_default_key,
rename_workspace, transfer_ownership, submit_product_feedback callees read for
reachable status codes; extractor signatures diffed against HEAD (unchanged)
```

Not run end-to-end: `make check`. Every component it runs that this diff can
affect was run individually above; the docs targets need Node 22 and the local
default is Node 26, gated by the pre-existing `node-version-check`. Worth running
once under `fnm use 22.23.1` before commit, per the carry-forward's gate.

## Verdict

**ship with fixes**

The chunk does what 1b asked for and does it carefully. The parts most likely to
break something quietly — wire format on 17 envelopes, the 422-vs-`Json<Value>`
distinction, the `/mcp` error shape, the `/api/dashboard` 400 asymmetry — are all
correct, and correct for the right reasons rather than by luck. The drift guard
came out of the migration stronger than it went in, and it holds under every
bypass I could construct.

The one thing I would fix before commit is the lost path/method pinning in
`setup-page.test.mjs` — re-point those assertions at the committed
`backend/openapi.json` instead of at `main.rs` source text. It is a small change,
it restores coverage the migration removed, and it will not need rewriting the
next time the registration form changes.
