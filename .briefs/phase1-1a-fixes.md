# Chunk 1a — review fixes (dash-impl)

Two independent reviewers reviewed your chunk 1a work. Both returned **do not
ship**, and both landed on the same blocker. Full reports:

- `.reviews/dashboard-1a-opus.md`
- `.reviews/dashboard-1a-grok.md`

Read both before starting. Your router restructure, wire-format preservation,
`--print-openapi` wiring, Make/pnpm targets and the four proof annotations were
all reviewed clean — do not redo them. Everything below is scoped to the spec
being honest and the drift guard actually guarding.

Same limits as before: nothing outside this worktree, `os-platform` is
read-only, no push, do not commit until I say so.

---

## F1 (blocker) — the path-coverage test must actually fail on an unannotated route

`openapi_document_covers_every_api_route_and_method` compares the generated
document's paths to a hardcoded `expected` literal. Both sides are hand-typed, so
adding `.route("/api/whatever", post(h))` changes neither and the test stays
green. That is the one case the brief required it to catch.

**Required property:** a route registered on the axum router that has no spec
operation must fail `cargo test`. Adding a route must be impossible to do
silently.

`axum::Router` exposes no route table, so you cannot introspect it directly.
Recommended approach — a source-derived guard:

- `include_str!` this module's own source in the test, scan it for every route
  registration (`.route("<path>", ...)` with its `get(`/`post(`/`patch(`/
  `delete(` method idents, and every `routes!(handler)`), and build the served
  set from that.
- Assert every served path/method appears in the generated document, **except**
  those in an explicit `KNOWN_UNANNOTATED` constant.
- `KNOWN_UNANNOTATED` is the chunk 1b ledger: it starts as the ~20 routes not yet
  annotated and must be empty when 1b is done. Add a comment saying exactly that.
- Also assert the reverse: no spec operation exists for a path the router does
  not serve (catches deleting a route and leaving the annotation).
- Assert `KNOWN_UNANNOTATED` contains no entry that is already annotated, so the
  ledger cannot rot into a permanent excuse list.

There is precedent for source-text assertions in this repo — `tests/*.test.mjs`
assert against `backend/public/app.js` source. This is the same technique.

If you can see a way to derive the served set from the real router rather than
from source text, prefer it — state what you did and why. Do not use a
`connect_lazy` pool plus `oneshot` probing of matched routes: matched routes run
the handler and would touch the database.

**Prove it works.** Temporarily add a throwaway route
(`.route("/api/drift-probe", get(health))`), run `cargo test`, and confirm the
test *fails*. Then remove it and confirm green again. Report both outputs. A
guard you have not seen fail is not a guard.

## F2 (major) — delete the fabricated placeholder operations

Remove `PENDING_API_OPERATIONS` and `add_pending_api_operations` entirely. The
committed `backend/openapi.json` must contain only the four operations you
actually annotated.

Why, since it looks like a regression in coverage: those 24 stubs each declare
`security: none`, no parameters, no request body, and a single contentless
`default` response. With no global `security` in the document, `security: none`
does not mean "unknown" — in OpenAPI it means **this operation needs no
authentication**. The committed spec therefore states that `GET /api/dashboard`,
`PATCH /api/team/members/{os_user_id}` and `DELETE /api/settings/api-keys/{key_id}`
are unauthenticated, when all three require the session cookie and 401 without
it. `session_cookie` is declared in `components.securitySchemes` and referenced
by zero operations.

It also emits an invalid OpenAPI 3.1 document: eight templated paths
(`/api/dashboard/reports/{report_id}` and friends) have no `parameter` objects,
which OpenAPI 3.1 requires. Opus confirmed the downstream effect by running the
`gen:types` pipeline — those paths generate `path?: never`, so the phase-2 client
could not type-check passing `report_id` even if it wanted to.

An omitted path claims nothing. A stub claims something false. Omission is
correct for an intentionally incomplete spec, and it gives a free progress
signal: the path count grows monotonically as 1b lands.

Nothing in the brief asked for placeholders — chunk 1a step 7 said annotate
exactly four handlers.

## F3 (major) — do not declare a JSON error envelope for plain-text responses

Both ingest handlers take `Json(value): Json<Value>`. Axum's `JsonRejection`
fires *before* the handler body, so it never passes through `ApiError` /
`ApiErrorEnvelope`. Reality:

| input | status | body |
|---|---|---|
| malformed JSON | 400 | `text/plain` |
| missing/wrong `Content-Type` | 415 | `text/plain` |
| body > 64 KiB (`DefaultBodyLimit`) | 413 | `text/plain` |

The spec currently declares 400 as `application/json` → `ApiErrorEnvelope` and
omits 413 and 415. A client doing `const { error } = await res.json()` on a 400
throws `SyntaxError: Unexpected token 'F'` — a malformed-payload bug surfaces as
a client-side JSON crash instead of a readable message. 413 is realistic:
`TelemetryBatchInput` permits 100 events, and 100 events with `customerRef` and
`runtimeHint` populated can exceed 64 KiB.

Fix **spec-only, no behaviour change**: declare 413 and 415, and make the 400
declaration honest about the plain-text extractor-rejection case alongside the
JSON envelope that `safe_input` validation failures do return. Do not convert the
extractors to rejection-mapping wrappers — that is a behaviour change and belongs
in its own chunk. Note it as a follow-up in your report instead.

## F4 (minor) — `/api/v2/reports` accepts `x-api-key` too

`product_feedback_handler` uses `bearer_token(&headers)`, which falls back to the
`x-api-key` header (`backend/src/security.rs`). So `x-api-key: afr2_...`
authenticates. The annotation declares only `bearer_auth`, while
`/api/v2/telemetry/batches` — identical auth code path — correctly declares both.
Add `("api_key" = [])` to `/api/v2/reports`. Document reality; do not tighten the
handler here.

## F5 (minor) — type the `ProductFeedbackReport` schema without changing deserialization

`findings: Value` and `workaround: Option<Value>` emit empty schemas (`{}`), so
the 200 body of a proof-annotated endpoint is structurally useless to codegen.

Both reviewers suggested changing the field types to `Vec<FeedbackFindingInput>` /
`Option<FeedbackWorkaroundInput>`. **Do not do that** — those values are read back
from a JSONB column, so narrowing the Rust type makes any stored row that does not
match fail to deserialize at runtime, where today it passes through untouched.
That is a live-data regression hiding behind a schema improvement.

Instead use utoipa's annotation-only escape hatch on the existing `Value` fields:
`#[schema(value_type = Vec<FeedbackFindingInput>)]` and
`#[schema(value_type = Option<FeedbackWorkaroundInput>)]`. Identical generated
schema, zero change to serde or to the wire format. Confirm the referenced
schemas actually land in `components.schemas`.

## F6 (minor) — `make backend-openapi` truncates the committed spec on failure

`cargo run ... > openapi.json` — the shell truncates `openapi.json` before cargo
runs, so any compile error leaves the committed spec empty. Write to a temp file
and move it into place only on success. Apply the same care to
`backend-openapi-check`, and put its temp file outside the repo tree (currently
`mktemp backend/openapi.json.XXXXXX` litters inside `backend/`, and a hard kill
leaves an untracked `openapi.json.*` behind).

## F7 (nits) — take or explicitly decline, your call, but state which

- `GET /api/health` is tagged `ingest`. It is not an ingest endpoint. Pick a
  `system`/`meta` tag or leave it untagged until 1b applies the tag taxonomy.
- `make types` skips `node-version-check` unlike the other pnpm-driven targets.
- `api_document.info.license = None` and the `clone_into` version assignment are
  undocumented spec-metadata fiddling — either use `info(version = ...)` in the
  derive and drop the fiddling, or add a one-line comment saying why it is needed.
- `openapi-typescript`'s `typescript` peer dependency is only satisfied
  transitively. Harmless until `web/` exists; note it for phase 2.

---

## Gate

Re-run all of it and report the exact output of each:

```
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets --locked -- -D warnings
cd backend && cargo test --locked
pnpm test
make check
```

Plus the F1 negative-test proof (test failing with the probe route, green after
removing it), and regenerate `backend/openapi.json`.

Report: what you changed per finding, anything you declined and why, and any
follow-up you think belongs in 1b or a later chunk. Do not commit — I review
first. If you disagree with a finding, say so with your reasoning rather than
implementing something you think is wrong.
