# Review — phase 1 chunk 1a (utoipa/OpenAPI foundation)

Reviewer: `opus`. Branch `jakub/dashboard-rewrite`, uncommitted worktree state.
Reviewed against `.briefs/phase1-openapi.md` chunk 1a.

Router behaviour equivalence and wire-format preservation both came out **clean**
(details in `## Checked and clean`). The findings below are all about the spec
being dishonest and the drift guard not guarding.

---

## blocker — the path-coverage test is vacuous for the exact case it exists to catch

`backend/src/main.rs:1707-1725` (test `openapi_document_covers_every_api_route_and_method`)

The test builds the router, extracts the *generated document's* paths into
`actual`, and compares them to a hardcoded `expected` array literal. It never
touches the axum `Router` half of `split_for_parts()`. Both sides of the
`assert_eq!` are therefore independent of whether a route is actually served:

- `actual` is fed by `routes!(...)` registrations **and** by
  `PENDING_API_OPERATIONS` (`main.rs:115-154`), a second hand-maintained list.
- `expected` is a third hand-maintained list.

Concrete failure, adding a route the way every existing unannotated route was
added:

```rust
.route("/api/settings/retention", post(update_retention_handler))
```

`actual` does not change (no `#[utoipa::path]`, not in `PENDING_API_OPERATIONS`).
`expected` does not change. `cargo test` is green, `make check` is green,
`make backend-openapi` regenerates a byte-identical `openapi.json`, and
`web/lib/api/types.ts` has no entry for the endpoint. The frontend hand-rolls the
call and the guard whose whole purpose was to prevent that never fires.

The reverse drifts silently too: delete `.route("/api/team/ownership/{os_user_id}", ...)`
from the router and leave the entry in `PENDING_API_OPERATIONS` — the spec keeps
advertising a 404 endpoint, and the test still passes because it only ever
compares list-to-list.

This directly violates brief step 9: *"It must fail if a route is added to the
router without a spec entry."* It cannot.

Suggested fix — one side must be derived from the router, not typed by hand.
axum does not expose `Router`'s route table, so the honest options are:

1. Drop `PENDING_API_OPERATIONS` and register every in-spec route through
   `routes!` with a real `#[utoipa::path]`. Then `actual` is genuinely
   router-derived and the `expected` list becomes a real tripwire. This is chunk
   1b's work pulled forward, and it also fixes the two findings below.
2. Make `PENDING_API_OPERATIONS` load-bearing for *both* halves: pair each entry
   with its handler and register the axum route from the same table, so a route
   added without a table entry does not exist at all. Requires a
   `MethodRouter`-per-entry table; more machinery, but a route cannot escape it.
3. If neither is in scope for 1a, black-box the built `Router` with
   `oneshot`: for each expected path, assert a request does not 404, and for each
   unexpected method assert 405-not-404. This reads the real route table.
   Blocked today by `with_state` needing a `PgPool` in `AppState`, so it needs a
   test-only state constructor.

Whatever is chosen, the current test should not be left as-is: it reads as a
coverage guarantee and provides none.

---

## major — the committed spec declares 24 operations that describe nothing and assert no authentication

`backend/src/main.rs:115-216` (`PENDING_API_OPERATIONS` / `add_pending_api_operations`),
`backend/openapi.json`

24 of the 28 operations in the committed document are synthesised stubs:
`tags: none`, `security: none`, `parameters: []`, no `requestBody`, and a single
contentless `default` response. Because the document declares no global
`security`, `security: none` on an operation is not "unknown" — in OpenAPI it
means **this operation requires no authentication**.

Concretely: `GET /api/dashboard`, `PATCH /api/team/members/{os_user_id}`,
`DELETE /api/settings/api-keys/{key_id}` all require the `af_oa_access` session
cookie and return 401 without it. The `session_cookie` scheme is declared in
`components.securitySchemes` and then referenced by zero operations. Anything
reading the spec as truth — codegen, a spectral ruleset, a future auth-coverage
lint, a human — concludes the entire dashboard and team-management surface is
open.

The brief (chunk 1a step 7) says annotate exactly four handlers and explicitly
*"Do NOT annotate every handler in this chunk"*; chunk 1b then does the rest.
Nothing asked for placeholder operations. Omitting a path from the spec claims
nothing and is honest for an incomplete spec; a stub that says "no auth, no
params, no body" is a lie, and per the brief's own framing a spec that lies is
worse than no spec. It also destroys a free drift signal — the path count would
otherwise grow monotonically as 1b lands, making incomplete coverage visible.

This is *violates the brief* (unrequested addition that breaks the chunk's stated
goal), not a stylistic preference.

Suggested fix: delete `PENDING_API_OPERATIONS` and `add_pending_api_operations`;
let the spec contain only the four honestly annotated operations until 1b fills
in the rest. If a placeholder is genuinely wanted, it must at minimum carry the
real `security` requirement and real path parameters, at which point writing the
actual `#[utoipa::path]` is barely more work.

---

## major — the emitted document is not valid OpenAPI 3.1: templated paths with no parameter objects

`backend/openapi.json` (8 paths), root cause `backend/src/main.rs:156-176`

OpenAPI 3.1 requires that every template variable in a path have a corresponding
`parameter` object with `in: path` and `required: true`. These eight have none:

```
/join/{invitation_id}
/api/dashboard/reports/{report_id}
/api/dashboard/interactions/{interaction_id}
/api/dashboard/sessions/{session_id}
/api/products/{product_id}
/api/team/invitations/{invitation_id}
/api/team/members/{os_user_id}
/api/team/ownership/{os_user_id}
/api/settings/api-keys/{key_id}      (+ .../{key_id}/rotate)
```

Verified downstream failure — running the committed `gen:types` pipeline
(`openapi-typescript 7.13.0`, output inspected) produces:

```ts
"/api/dashboard/reports/{report_id}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: { parameters: { ..., path?: never, ... }; requestBody?: never;
           responses: { default: { ..., content?: never } } };
```

`path?: never` means the phase-2 client literally cannot type-check passing
`report_id`. Any spec validator (spectral, `openapi-generator validate`,
`swagger-cli validate`) fails the document outright, so wiring spec validation
into CI later will require fixing this first.

Suggested fix: same as the finding above — removing the fabricated operations
removes the invalid paths. If they are kept, each must declare its path
parameters (`invitation_id`/`report_id`/... as `type: string, format: uuid`,
`os_user_id` as plain `string` — check the handler signatures, they are not all
`Uuid`).

---

## major — declared 400 error body is wrong, and 413/415 are undeclared, on both annotated ingest endpoints

`backend/src/main.rs:1194-1213` and `1157-1178`; handlers at `1179`, `1216`

Both handlers take `Json(value): Json<Value>`. Axum's `JsonRejection` fires
*before* the handler body, so it never goes through `ApiError`/`ApiErrorEnvelope`.
Real responses:

| input | status | body |
|---|---|---|
| `{"summary":` (truncated JSON) | 400 | `text/plain`: `Failed to parse the request body as JSON: ...` |
| no/wrong `Content-Type` | 415 | `text/plain` |
| body > 64 KiB (`DefaultBodyLimit`, `main.rs:257`) | 413 | `text/plain` |

The spec declares 400 as `application/json` → `ApiErrorEnvelope`, and does not
mention 413 or 415 at all.

Failure mode: generated TS types say the 400 body is `{ error: string }`. A client
does `const { error } = await res.json()` on a 400 and throws `SyntaxError:
Unexpected token 'F'` on the plain-text body — so a malformed-payload bug in an
SDK surfaces as a client-side JSON crash instead of a readable message. 413 is
the likely one in practice: `TelemetryBatchInput` allows 100 events, and a batch
of 100 events with `customerRef`/`runtimeHint` populated can exceed 64 KiB, so a
real SDK hits an undocumented 413.

Suggested fix (spec-only, no behaviour change): add `413` and `415` responses,
and either declare 400's content as `text/plain` in addition to the JSON
envelope, or split it — 400 `ApiErrorEnvelope` for validation failures plus a
separate note that extractor rejections return plain text. Converting the
extractor to a rejection-mapping wrapper so `ApiError` really is the only error
shape would be cleaner, but that is a behaviour change and belongs in its own
chunk.

---

## minor — `/api/v2/reports` also accepts the capability via `x-api-key`, spec declares only `bearer_auth`

`backend/src/main.rs:1221`, `backend/src/security.rs:99-116`

`product_feedback_handler` calls `bearer_token(&headers)`, which falls back to the
`x-api-key` header when `Authorization: Bearer` is absent. So
`x-api-key: afr2_...` authenticates successfully. The annotation declares only
`("bearer_auth" = [])`.

`POST /api/v2/telemetry/batches` uses the same `bearer_token()` extraction (via
`agent_product_auth`, `store.rs:607-616`) and correctly declares both
`api_key` and `bearer_auth` — so the two endpoints are described inconsistently
despite identical auth code.

Failure mode: an SDK author reading the generated spec concludes `x-api-key` works
for telemetry but not for reports and implements two header strategies; or a
future "does every auth path have a declared scheme" audit passes while a real
accepted header is undocumented.

Suggested fix: add `("api_key" = [])` to the `/api/v2/reports` security list, or
(if `x-api-key` for capability tokens is unintended) tighten the handler — but
that is a behaviour change, so document reality here.

---

## minor — always-present nullable fields are declared optional; `findings` is untyped

`backend/src/models.rs:293-305`, `backend/openapi.json` → `ProductFeedbackReport`

`impact: Option<String>`, `confidence: Option<f64>`, `workaround: Option<Value>`
have no `skip_serializing_if`, so the wire **always** contains those keys (as
`null` when absent). The generated schema leaves them out of `required`, producing
`impact?: string | null`.

Failure mode: a consumer that round-trips the type — reads a report, re-serializes
it from the generated TS interface — drops the keys entirely, changing the wire
shape for anything downstream that distinguishes `null` from absent (the dashboard
currently does not, but the SDK contract tests in `sdk/*` assert on key presence
in adjacent payloads). Also `'impact' in report` narrowing behaves differently
from reality.

Separately, `findings: Value` and `workaround: Option<Value>` emit `{}` —
unconstrained. `findings` is always an array of `FeedbackFindingInput`-shaped
objects (`store.rs:2331`, `serde_json::to_value(findings)`), and that schema is
already in `components`. Brief step 7 asked for *"real response bodies"*; `unknown`
in the generated client is not one.

Suggested fix: add `required` via utoipa (`#[schema(required = true)]` on the
nullable fields, or `#[serde(skip_serializing_if = "Option::is_none")]` if the
keys are genuinely meant to be absent — that *is* a wire change, so prefer the
former), and type `findings` as `Vec<FeedbackFindingInput>` in the schema
annotation.

---

## minor — the discovery document's `json!` → struct rewrite has zero test coverage

`backend/src/main.rs:420-565`, `backend/src/models.rs:14-110`

The largest wire-format change in this chunk — a ~40-key nested `json!` envelope
converted to nine typed structs with hand-placed `rename_all = "camelCase"`
attributes (three of the nine deliberately omit it to keep snake_case keys) — has
no test asserting the emitted JSON. `grep` across `tests/`, `backend/src`, and
`sdk/` finds no assertion on `GET /.well-known/agent-feedback-v1.json`'s body;
the SDKs only emit a `Link` header pointing at it.

I diffed all 40 keys by hand against the pre-change `json!` and they match
(`FeedbackModesDiscovery`/`TelemetryDiscovery`/`FeedbackRequiredFieldsDiscovery`/
`ClassificationDiscovery`/`IntegrationsDiscovery`/`ReliabilityDiscovery`
correctly have no `rename_all`; the other three correctly do). So this is a
missing guard, not a live bug.

Failure mode: the next edit to any of these structs — adding a field, renaming
one, adding a `rename_all` to a struct that must stay snake_case — silently
changes the public protocol discovery document with a green test suite. `off`,
`never_ask`, `ask_once`, `ask_always` in `FeedbackModesDiscovery` are one
`#[serde(rename_all = "camelCase")]` away from becoming `neverAsk` etc., and
nothing would catch it.

Suggested fix: a `cargo test` asserting `serde_json::to_value(FeedbackDiscoveryResponse{..})`
has the expected key set (or a golden-JSON comparison). Brief chunk 1b already
mandates *"add tests where an envelope has no coverage today"* — this envelope
should not wait, since 1a is where it changed.

---

## minor — `make backend-openapi` truncates the committed spec when the build fails

`Makefile:34-35`

```make
cd backend && cargo run --quiet --bin agent-feedback -- --print-openapi > openapi.json
```

The shell sets up `> openapi.json` before `cargo run` executes, so any compile
error leaves `backend/openapi.json` at 0 bytes. The sibling `backend-openapi-check`
target correctly writes to a temp file first.

Failure mode: dev edits `main.rs`, runs `make backend-openapi`, compile fails →
committed spec is now empty. `make check` then fails with a 28-operation diff that
looks like catastrophic drift rather than "you truncated the file", and
`git add -A` before noticing commits an empty spec.

Suggested fix: mirror the check target — write to a temp file, `mv` into place
only on success.

---

## nit — `backend-openapi-check` puts its temp file inside the repo tree

`Makefile:37-41`

`tmp_file=$$(mktemp backend/openapi.json.XXXXXX)` creates
`backend/openapi.json.aBc123` inside the working tree. The `trap ... EXIT` cleans
it up normally, but a SIGKILLed `make` (or an aborted `make -j`) leaves an
untracked file that is not in `.gitignore` and matches nothing that would exclude
it from `git add -A`. Prefer `mktemp -t epode-openapi` so the file lands in
`$TMPDIR`.

## nit — `types` target skips `node-version-check`

`Makefile:72-73`

Every other pnpm-invoking target (`node-test`, `docs-validate`, `docs-a11y`)
depends on `node-version-check`; `types` does not. The brief asked to follow
existing `Makefile` conventions. Low stakes — `openapi-typescript` is not one of
the Node-25-hostile tools — but it is an inconsistency in a file whose whole
convention is that gate.

## nit — `openapi-typescript`'s `typescript` peer is satisfied only transitively

`package.json:29`, `pnpm-lock.yaml:23-25`

Root adds `openapi-typescript: 7.13.0` but not `typescript`. The lockfile resolves
it as `openapi-typescript@7.13.0(typescript@5.9.3)`, with `typescript` coming from
`mint`'s dependency tree / `sdk/node`'s devDeps — root declares nothing. It works
today (verified: `pnpm exec openapi-typescript` runs). If `mint` is dropped or
bumped past a typescript major, `pnpm install` re-resolves and the peer can go
unmet, breaking `make types` for reasons unrelated to the change that caused it.
Consider pinning `typescript` as a root devDependency alongside it.

## nit — undocumented spec-metadata fiddling

`backend/src/main.rs:236-238`

```rust
env!("CARGO_PKG_VERSION").clone_into(&mut api_document.info.version);
api_document.info.license = None;
```

The first line duplicates what utoipa's `#[derive(OpenApi)]` already does (it
defaults `info.version` to `CARGO_PKG_VERSION`). The second exists because
`backend/Cargo.toml` has no `license` field, so the derive emits
`"license": {"name": ""}` — stripping it is correct, but nothing says so, and the
next person will either delete the line or "fix" the missing license. A one-line
comment on each would stop that.

Also: the document declares no `servers` block, so a generated client has no base
URL. The brief did not ask for one; noting it because phase 2 will want it.

---

## Checked and clean

**Router behaviour equivalence (brief priority 1) — equivalent.** Read the old
and new construction side by side:

- Paths and methods: identical. All 24 previously-plain `.route()` calls are
  unchanged; the four annotated handlers moved to `routes!(...)`, which derives the
  axum path/method from `#[utoipa::path]` — the emitted spec confirms
  `GET /api/health`, `GET /.well-known/agent-feedback-v1.json`,
  `POST /api/v2/telemetry/batches`, `POST /api/v2/reports`, all matching the
  originals byte-for-byte. `/mcp` keeps `get(mcp_info).post(mcp_handler)` on one
  `MethodRouter`.
- Layer order: unchanged and still applied once, to the fully-assembled router —
  `DefaultBodyLimit::max(64 * 1024)` → `cors` → `CompressionLayer` →
  `TraceLayer` → `from_fn(security_headers)`. Same five, same order, same
  position relative to route registration. `OpenApiRouter::layer` delegates to
  `Router::layer`, so there is no wrapping-scope change.
- `nest_service("/static", ServeDir::new("public"))`: moved from inline-last into
  `non_api_routes`, which is `merge`d in **before** the `.layer()` chain. Route
  registration order is not significant for axum matching, and because the merge
  happens before the layers, `/static/*` and `/` still sit *inside* all five
  layers exactly as before. This was the specific regression risk (a `/static`
  that escaped `security_headers` or the body limit); it did not happen.
- `with_state`: still applied after all layers —
  `build_app_router().split_for_parts().0.with_state(state)`.
- `/` and `/static/*` are correctly absent from the spec; everything under
  `/api/*`, `/auth/*`, `/join/{...}`, `/.well-known/...`, `/mcp` is present (as
  stubs — see the major findings).

**Wire format (brief priority 3) — preserved.** Every `json!` → struct conversion
audited key-by-key against the deleted code:

- `ApiErrorEnvelope` → `{"error": "..."}`, no `rename_all`, unchanged.
- `HealthResponse` → `status`/`service`/`database`, all `"ok"`/`"agent-feedback"`.
- `TelemetryBatchResult` → `accepted`/`dropped` (it already existed and was
  already `camelCase`; the handler now returns it directly instead of
  re-wrapping the two fields, same output).
- `ProductFeedbackAcceptedResponse` → `accepted`/`interactionId`/`report`.
- The nine discovery structs → all 40 keys match, including the three structs
  that correctly keep snake_case. No test proves it (see the minor finding).
- `Cache-Control: private, no-store` on `/api/v2/reports` still set post-`json!`
  removal (undeclared in the spec, but the header is intact).

**Brief compliance:** deps at the exact versions/features requested (step 1);
shared `build_app_router()` so `main()` and the emitter cannot diverge (step 3);
`--print-openapi` genuinely first in `main()` — proven with `env -i`, no DB, no
`.env`, no telemetry (step 4); `info` title/version/description and all three
security schemes declared, `session_cookie` correctly `af_oa_access` from
`os_accounts.rs:18` and `api_key` correctly `x-api-key` from `security.rs:107`
(step 5); `ApiErrorEnvelope` with unchanged wire format (step 6); exactly the four
requested annotations (step 7); `openapi.json` present and regenerable (step 8);
drift-check make target wired into `make check` (steps 9b, 10);
`openapi-typescript` pinned exactly `7.13.0` matching the other root devDeps and
old enough for `minimumReleaseAge: 10080` — `pnpm install` accepted it with no
`minimumReleaseAgeExclude` entry (step 10). Declared response statuses for the two
ingest endpoints were traced into `store.rs` and are all reachable and correct:
telemetry 400 (`store.rs:2075`, `2102`) / 401 (`store.rs:630`, `634`) / 500;
reports 400 (`store.rs:2219`+) / 401 (`store.rs:2348`, `security.rs`) / 403
(`store.rs:2360`, `2379`) / 409 (`store.rs:2406`) / 410 (`store.rs:2353`) / 500.

**No scope creep** beyond the fabricated spec operations: no `web/` directory,
`backend/public/app.js`, `app.html`, `styles.css` untouched (`git status`), no
unrelated refactors. Putting the discovery structs in `models.rs` rather than a
new `api_types.rs` is fine — that instruction is chunk 1b's.

**Lint/CI:** `cargo fmt --check` and `cargo clippy --all-targets --locked -D warnings`
both clean. The single new `#[allow]` uses the repo's `reason = "..."` form, is
scoped to one function, and is genuinely necessary (`print_stdout` is `warn`).
`Cargo.lock` updated with exactly `utoipa`, `utoipa-axum`, `utoipa-gen`, `paste`,
`regex`. `pnpm-lock.yaml` consistent with `package.json`. `backend/openapi.json`
is not matched by `biome.json`'s `includes` (`"*.json"` is root-level only), so
there is no formatter conflict.

---

## Verification

All commands read-only; nothing edited, staged, committed, or pushed.
`git status --short` at the end is identical to the start.

```
$ cd backend && cargo fmt --check
(no output, exit 0)

$ cd backend && cargo clippy --all-targets --locked -- -D warnings
Finished `dev` profile — no warnings, no errors

$ cd backend && cargo test --locked
test result: ok. 11 passed; 0 failed; 5 ignored
  (incl. page_tests::openapi_document_covers_every_api_route_and_method ... ok
   — passes, but see the blocker: it passes unconditionally)
src/bin/provision_agent_playground.rs: 0 tests
src/bin/setup_matrix_db.rs: 0 tests

$ pnpm test
tests 63 | pass 63 | fail 0

$ pnpm check          # biome, part of make check
Checked 28 files in 384ms. No fixes applied.

$ make backend-openapi-check
(no diff output, exit 0 — committed spec matches regenerated)

$ cargo build --locked --bin agent-feedback
$ cd /tmp && env -i backend/target/debug/agent-feedback --print-openapi > /tmp/spec.json
EXIT=0, 27070 bytes
  -> proves the argv branch needs no env, no .env file, no DATABASE_URL, no telemetry

$ diff -q /tmp/spec.json backend/openapi.json
(identical — committed openapi.json is fresh)

$ pnpm exec openapi-typescript backend/openapi.json -o <scratchpad>/types.ts
openapi-typescript 7.13.0 -> ok, 148.8ms
  -> inspected output; confirms `path?: never` on all templated paths
  (written to scratchpad, NOT to web/ — the repo tree was not modified)

$ python3 -c "<summarise backend/openapi.json>"
28 operations across 28 path/method pairs; 4 with real contracts, 24 stubs with
security=None, parameters=0, responses=['default']; openapi 3.1.0;
info.version 0.1.0; 21 component schemas; 3 securitySchemes
(api_key/x-api-key, bearer_auth, session_cookie/af_oa_access)

$ pnpm ls typescript
typescript@5.9.3 — devDependency of sdk/node only, not root

$ git status --short
unchanged from session start (8 modified, 4 untracked; no temp files left by make)
```

Not run: `make check` end-to-end. Its constituent parts were all run individually
above except `landing-check`, `sdk-node-test`, `docs-validate`, `docs-a11y`, which
this change cannot affect (and `docs-*` hard-fail on this machine's Node 26 —
`node-version-check` would reject the whole target before reaching them, which is
a pre-existing local-environment issue, not a finding against this change).

## Verdict

**do not ship** — two things must change first, both small:

1. The drift guard does not guard (blocker). Whatever fix is chosen, the current
   test must not stay as-is; it advertises a guarantee it does not provide, which
   is worse than having no test, because the next person will trust it.
2. The 24 fabricated spec operations must go (or be completed honestly). They
   assert "no authentication" over the entire dashboard/team/settings surface and
   make the document invalid OpenAPI. Deleting `PENDING_API_OPERATIONS` and
   `add_pending_api_operations` fixes both majors at once and *also* makes the
   coverage test's `expected` list a real tripwire — so it is plausibly the single
   change that resolves all three top findings.

The 400/413/415 mismatch on the ingest endpoints should be fixed in the same pass
— those four endpoints are the ones the brief says are worth getting exactly
right, and they are what phase 2 and the SDKs will trust.

Everything else — router equivalence, layer order, wire format, `--print-openapi`
independence, spec freshness, lint/CI, lockfiles, scope — is clean.
