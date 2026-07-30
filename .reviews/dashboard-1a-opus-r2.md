# Re-review (r2) — phase 1 chunk 1a, delta after F1–F7

Reviewer: `opus`. Branch `jakub/dashboard-rewrite`, uncommitted worktree.
Delta against my r1 (`.reviews/dashboard-1a-opus.md`), grok's
(`.reviews/dashboard-1a-grok.md`), and `.briefs/phase1-1a-fixes.md`.

**The blocker is genuinely fixed.** I did not take the drift guard on reading —
I copied the crate into a scratchpad, mutated it seven ways, and ran the test
each time. The canonical case fails loudly, and the reverse direction fails too.
Four bypasses survive; details and reproductions below.

---

## 1. Does the new drift guard hold?

Method: `backend/` copied to a scratchpad with a separate `CARGO_TARGET_DIR`
(the reviewed worktree was never modified). Each variant was applied to the copy,
`cargo test --locked openapi_document` run, then reverted.

| # | mutation | result |
|---|---|---|
| A | baseline, unmodified | **passes** (correct) |
| B | `.route("/api/drift-probe", get(health))` in `build_app_router` | **FAILS — caught** ✅ |
| H | delete `.route("/api/settings/policy", …)`, leave it in `KNOWN_UNANNOTATED` | **FAILS — caught** ✅ |
| C | `.route_service("/api/drift-probe", ServeDir::new("public"))` | **passes — MISSED** ❌ |
| G | `.route("/api/drift-probe", any(health))` | **passes — MISSED** ❌ |
| D4 | `.merge(drift_probe_routes())`, helper defined *after* `openapi_spec_json` | **passes — MISSED** ❌ |
| E4 | `.nest("/api/v3", drift_probe_routes())`, same helper | **passes — MISSED** ❌ |

Exact failure messages from the two that caught it:

```
B: assertion `left == right` failed: served routes and OpenAPI operations diverged
   src/main.rs:1881
H: KNOWN_UNANNOTATED contains operations the router does not serve:
   ["POST /api/settings/policy"]
```

Two intermediate variants (helper defined *between* `build_app_router` and
`openapi_spec_json`) were also caught — because that region is inside the scanned
slice. I initially mis-sited the helper there and got a false "caught"; the table
above uses the corrected placement.

**Verdict on F1:** the required property as literally stated —
*"a route registered on the axum router that has no spec operation must fail
`cargo test`"* — holds for `.route(` and `.routes(routes!(` , which is 100% of how
routes are registered today. The second sentence, *"adding a route must be
impossible to do silently,"* does not hold. See the major finding below. The
implementation follows F1's own recommended technique faithfully; the residual
holes are properties of that technique, not a deviation from it.

Also verified by reading, not probing:
- The slice is `main.rs` between `"fn build_app_router()"` and
  `"pub(crate) fn openapi_spec_json"` — lines 112–201 today. Every route
  registration in the file is inside it (`grep` for `.route(`/`.routes(`/`.nest`/
  `.merge(` returns nothing outside 131–193). `openapi_spec_json` immediately
  follows `build_app_router`, so the slice is tight.
- Moving `openapi_spec_json` above `build_app_router` makes `split_once` return
  `None` → `.expect()` panics → test fails. Fails closed. ✅
- Reformatting `.routes(routes!(x))` across lines breaks `ROUTES_MARKER`, so the
  operation drops out of `served` while staying in `spec` → `assert_eq!` fails.
  Fails closed. ✅
- `has_method_call`'s left-boundary check is correct: `forget(` is rejected
  (preceded by `r`), `axum::routing::get(` is accepted (preceded by `:`).
- `route_calls`' paren/string/escape state machine handles the multi-line
  `.route(\n "/path",\n get(a).patch(b),\n)` forms in use, and both methods of a
  chained `get(x).patch(y)` are picked up (confirmed: the spec's PATCH entries
  are all present in `served`).

---

## major — four ways to add a served route that the guard does not see

`backend/src/main.rs:1722-1839` (`route_calls`, `served_operations`)

`served_operations` is an **allow-list scanner**: it only understands the literal
tokens `.route(` and `.routes(routes!(`, and only within the textual span of
`build_app_router`. Anything else that mounts a handler is invisible. Four
confirmed, each reproduced above with a live-compiling probe:

1. **`.route_service("/path", svc)`** — `.route_service(` does not contain the
   substring `.route(` (the next char is `_`, not `(`), so it is never scanned.
   Realistic here: the file already mounts `ServeDir` via `nest_service`, so a
   second service mount is the obvious next move.
2. **Method routers outside the eight hard-coded idents** — `any(handler)`,
   `MethodRouter::new().on(MethodFilter::GET, h)`, `.fallback(h)`. The path
   parses fine, but no method ident matches, so the route contributes *zero*
   entries to `served` and vanishes silently. `any()` is the worst case: it
   serves every method on that path.
3. **`.merge(helper())`** where `helper()` is defined anywhere below
   `openapi_spec_json`.
4. **`.nest("/prefix", helper())`**, same placement.

Failure scenario, concretely: chunk 1b or a later PR groups the dashboard routes
into `fn dashboard_routes() -> Router<Arc<AppState>>` at the bottom of `main.rs`
and merges it — an ordinary, tidy refactor. All four dashboard endpoints keep
serving, `KNOWN_UNANNOTATED` still lists them, and `known_unannotated.is_subset(&served)`
now **fails**… so that particular refactor is caught by accident. But add a
*fifth* route to that helper and nothing fires: it is served, absent from the
spec, absent from the ledger, and `cargo test` is green. That is exactly the
silent-drift state F1 exists to prevent.

Suggested fix (small, and it converts the allow-list into a fail-closed one): scan
the slice for the tokens the guard *cannot* interpret and panic on sight —

```
".route_service(", ".nest(", ".nest_service(", ".merge(", ".fallback(",
".fallback_service(", ".method_not_allowed_fallback("
```

with an explicit exemption for the two known-good occurrences
(`.merge(non_api_routes.into())` and `.nest_service("/static", …)`), plus the
same treatment for a method-router expression whose recognised-method count is
zero. Message: "route registration form not understood by the coverage guard —
teach `served_operations` about it or register the route with `.route(`." That
makes the unknown-unknowns loud instead of silent, which is the property F1
actually wanted.

Labelled **major, not blocker**: every route in the codebase today uses `.route(`
or `routes!`, the canonical regression is caught, and this is a strict and large
improvement over r1. It is a hole in a guard, not a live defect.

---

## minor — `make backend-openapi` leaves `backend/openapi.json` mode 0600

`Makefile:34-39`

The F6 fix writes through `mktemp` and `mv`s into place. `mktemp` creates files
mode 0600, and `mv` preserves the mode — so the committed spec ends up
owner-only. Observed in the current worktree, and it is the only file in the tree
like this:

```
-rw-------@  backend/openapi.json     <- after make backend-openapi
-rw-r--r--@  backend/Cargo.toml
-rw-r--r--@  Makefile
```

Failure mode: git does not track the read bit, so this is invisible in review and
in the diff, and it silently flips back to 0644 for anyone who obtains the file
by clone rather than by regenerating it. That divergence is the problem — any
step that reads the file as a different user (a container build layer running as
non-root, a CI job with a distinct runner user, `make types` in a sandbox) works
on a fresh clone and fails for whoever last ran `make backend-openapi` locally.

Suggested fix: `install -m 644 "$$tmp_file" backend/openapi.json` instead of `mv`,
or `chmod 644` after the move.

## minor — `findings` now declares a strictness the JSONB column does not enforce

`backend/src/models.rs:302`, `backend/openapi.json` → `FeedbackFindingInput`

F5's `#[schema(value_type = Vec<FeedbackFindingInput>)]` is the right call and is
wire-inert (proven below). But `FeedbackFindingInput` carries
`#[serde(deny_unknown_fields)]`, which utoipa renders as
`additionalProperties: false` plus `required: [kind, topic, detail]`. The 200 body
of `POST /api/v2/reports` therefore declares that every element of `findings`
matches that shape exactly — a guarantee the JSONB column does not make, which is
the exact reasoning F5 used to *reject* narrowing the Rust type.

Demonstrated: I constructed a `ProductFeedbackReport` whose `findings` holds
`[{"kind":…,"legacyExtra":42}, {"totally":"unexpected"}]` and confirmed it
serializes verbatim — so a legacy row is returned to the client while violating
the declared schema.

Failure mode is narrower than a wire break: `openapi-typescript` does not emit
runtime validation, so the phase-2 client is unaffected. It bites a spec-validating
consumer — a contract test, a mock server, an SDK generated by a validating
generator — which rejects a real 200 response as schema-invalid.

Suggested fix: keep `value_type` but point it at an output-shaped schema that does
not inherit `deny_unknown_fields` (a `FeedbackFinding` output struct, or
`#[schema(additional_properties = true)]` on a wrapper). Alternatively accept it
and note the constraint in the response description. Low urgency — flagging it so
the trade-off is deliberate rather than inherited from `deny_unknown_fields`.

## nit — `backend-openapi`'s temp file still lands inside the repo tree

`Makefile:36` — `tmp_file=$$(mktemp backend/openapi.json.XXXXXX)`

F6 asked for the temp file to live outside the repo. `backend-openapi-check` no
longer has one at all (command substitution — good, and the trailing-newline
round-trip is correct since `$( )` strips and `printf '%s\n'` restores exactly
one). But `backend-openapi` introduced a new one, in `backend/`. The `trap … EXIT`
does not run on SIGKILL, so a hard-killed build leaves `backend/openapi.json.aBc123`
untracked and un-ignored, where `git add -A` will pick it up. `mktemp -t epode-openapi`
plus `install -m 644` fixes this and the mode nit together.

## nit — `.pnpm-store/` is untracked and not git-ignored

An 8 KB `.pnpm-store/v11/index.db` is present at the repo root, untracked, and
`git check-ignore` reports it is not ignored — `.gitignore` covers `.pnpm-debug.log*`
but no store directory. Whatever created it, it is now a `git add -A` hazard in a
worktree that is about to be committed. Either add `.pnpm-store/` to `.gitignore`
or remove it before committing.

## nit — the source scanner reads comments, and `.nest()` reports a wrong path

`backend/src/main.rs:1722-1809`

Two cosmetic sharp edges, both fail-closed so neither can hide drift:

- `route_calls` has no comment handling, so a commented-out `.route("/x", get(h))`
  inside the slice counts as served and fails the test with a route that is not
  served. Confusing, not dangerous.
- Probe E2 (`.nest("/api/v3", Router::new().route("/widgets", get(health)))` with
  the inner `.route(` inside the slice) correctly failed, but reported
  `GET /widgets` — the un-prefixed inner path. A dev fixing that by pasting the
  reported string into `KNOWN_UNANNOTATED` would silence the test while the real
  served path (`/api/v3/widgets`) stays undocumented. The `.nest(` deny-list from
  the major finding also closes this.

---

## 2. Is the emitted document valid and honest?

Yes, on both counts.

Four operations, no placeholders, `PENDING_API_OPERATIONS` and
`add_pending_api_operations` fully removed (`grep` finds no residue, and the
`OperationBuilder`/`ResponsesBuilder`/`HttpMethod` imports went with them).

```
GET  /api/health                          tags=[system]  sec=none   resp=200,500
GET  /.well-known/agent-feedback-v1.json  tags=[ingest]  sec=none   resp=200
POST /api/v2/telemetry/batches            tags=[ingest]  sec=[api_key|bearer_auth]
                                                          resp=202,400,401,413,415,500
POST /api/v2/reports                      tags=[ingest]  sec=[bearer_auth|api_key]
                                                          resp=200,400,401,403,409,410,413,415,500
```

- **Valid 3.1:** no templated paths remain, so the path-parameter violation from
  r1 is structurally gone. `openapi: 3.1.0`, `info.version: 0.1.0` (still correct
  after the `clone_into` line was dropped — utoipa's derive defaults it to
  `CARGO_PKG_VERSION`).
- **Honest security:** the two operations with `security: none` are
  `/api/health` and the discovery document, both genuinely unauthenticated. No
  operation now claims open access to something that 401s. `session_cookie` stays
  declared and unreferenced, which is correct — brief step 5 asked for the schemes
  the API uses, and 1b will reference it.
- **Downstream:** regenerated `web/lib/api/types.ts` into the scratchpad (not the
  worktree) — clean, e.g. `post: operations["product_feedback_handler"]`, and no
  `path?: never` anywhere because no templated paths remain.
- Committed `backend/openapi.json` is byte-identical to a fresh `--print-openapi`
  under `env -i`.

## 3. Are the 413/415/text-plain declarations accurate, and did `value_type` change the wire?

**The declarations are exactly right.** I did not reason about axum's rejection
behaviour — I stood up a real server on a real socket, in the scratchpad copy,
with the same axum version, the same `Json<Value>` extractor, and the same
`DefaultBodyLimit::max(64 * 1024)`:

```
valid json                 | 200 OK                     | text/plain; charset=utf-8 | ok
malformed json             | 400 Bad Request            | text/plain; charset=utf-8 | Failed to parse the request body as JSON: summary: EOF while…
no content-type            | 415 Unsupported Media Type | text/plain; charset=utf-8 | Expected request with `Content-Type: application/json`
wrong content-type         | 415 Unsupported Media Type | text/plain; charset=utf-8 | Expected request with `Content-Type: application/json`
body over 64KiB            | 413 Payload Too Large      | text/plain; charset=utf-8 | Failed to buffer the request body: length limit exceeded
json type mismatch (null)  | 200 OK                     | text/plain; charset=utf-8 | ok
```

Every declared code matches: 400 with both `application/json` (`ApiErrorEnvelope`,
from `safe_input`) and `text/plain` (syntax rejection), 413 `text/plain`, 415
`text/plain`. `text/plain` vs the actual `text/plain; charset=utf-8` is correct —
OpenAPI content keys are media types and the charset parameter is not part of the
key.

Notably, **422 is correctly absent**. Axum's `JsonDataError` → 422 is unreachable
here because `Json<Value>` accepts any syntactically valid JSON — confirmed by the
last row, where `null` reaches the handler as 200 rather than being rejected.
Declaring 422 would have been the easy over-correction; it was avoided.

**`schema(value_type)` did not touch the wire or deserialization.** `#[schema(…)]`
is inert to serde and the field types are still `Value` / `Option<Value>`.
Verified rather than assumed — I serialized a `ProductFeedbackReport` carrying a
deliberately non-conforming legacy JSONB payload:

```
findings: [{"kind":"strength","topic":"t","detail":"d","severity":null,"legacyExtra":42},
           {"totally":"unexpected"}]
workaround: {"used":true,"detail":"d","unknown":1}
→ findings serialize verbatim, workaround's unknown key survives
→ keys: confidence, createdAt, findings, id, impact, interactionId, source,
        summary, workaround, workspaceId   (unchanged from r1)
```

So the live-data regression F5 was written to avoid did not happen. The schema now
references `FeedbackFindingInput` and `FeedbackWorkaroundInput`, both present in
`components.schemas`. (The flip side is the `additionalProperties: false` minor
above — the same probe that proves the wire is safe proves the schema is stricter
than the data.)

## 4. Did anything earlier-clean regress?

No.

- **Router structure** (`main.rs:112-199`): route list, paths and methods
  identical to the version cleared in r1. Layer order still
  `DefaultBodyLimit(64 KiB)` → `cors` → `CompressionLayer` → `TraceLayer` →
  `from_fn(security_headers)`, still applied once to the fully-merged router.
  `non_api_routes` (`GET /` + `nest_service("/static")`) still merged *before* the
  layer chain, so `/` and `/static/*` remain inside all five. `main()` still does
  `split_for_parts()` then `.with_state(state)` (`main.rs:298-299`), and the
  `--print-openapi` branch is still first in `main()` (`main.rs:217`).
- **Wire format:** `models.rs` diff is identical to r1 except the two `#[schema]`
  lines; `error.rs` unchanged. The discovery structs' `rename_all` placement — the
  thing I audited key-by-key in r1 — is untouched.
- **Cross-language:** `backend/public/app.js`, `app.html`, `styles.css` still
  untouched; `pnpm test` 63/63.
- No new `#[allow]`, no new clippy suppressions, no new dependencies.
- `make types` gained `node-version-check` (F7) — correct, and it still is not
  part of `make check`.

---

## Prior findings, one by one

### From my r1

| r1 finding | status |
|---|---|
| **blocker** — path-coverage test vacuous | **resolved** for the required property; verified by probe B and H. Residual bypasses are the new major above. |
| **major** — 24 fabricated operations, `security: none` | **resolved** — removed entirely, 4 honest operations remain |
| **major** — invalid 3.1, templated paths w/o parameters | **resolved** — no templated paths remain; TS regen clean |
| **major** — 400 body wrong, 413/415 undeclared | **resolved** — verified against a live axum server, all six cases match |
| **minor** — `/api/v2/reports` accepts `x-api-key` | **resolved** — `("api_key" = [])` added |
| **minor** — nullable fields optional; `findings` untyped | **partial** — `findings`/`workaround` now typed (F5). The `required` half is unchanged: `impact`, `confidence`, `workaround` are always emitted on the wire but still absent from `required`, so codegen still produces `impact?: string \| null`. Not in the fixes brief, so not expected — still open, still minor. |
| **minor** — discovery document has no test coverage | **not addressed** — not in the fixes brief. The 40-key `json!`→struct rewrite still has no assertion; a stray `rename_all` on `FeedbackModesDiscovery` would still silently rewrite the public protocol document. Recommend folding into 1b, which already mandates tests for uncovered envelopes. |
| **minor** — `make backend-openapi` truncates on failure | **resolved** — temp-file + `mv`. Introduced the 0600 mode nit above. |
| **nit** — temp file inside repo tree | **partial** — gone from `backend-openapi-check`, reintroduced in `backend-openapi` |
| **nit** — `types` skips `node-version-check` | **resolved** |
| **nit** — undocumented metadata fiddling | **resolved** — `clone_into` dropped (version still correct via the derive), `license = None` now carries an explanatory comment |

### From grok's r1

| grok finding | status |
|---|---|
| **blocker** — drift test never inspects the router | **resolved** as above |
| **major** — path inventory is a parallel hand list | **resolved** — `PENDING_API_OPERATIONS` gone. `KNOWN_UNANNOTATED` is still hand-written, but it is now checked in both directions against a source-derived `served` set, so it cannot rot silently: a stale entry fails (probe H), and an entry that becomes annotated fails the `is_disjoint` assert. Materially different from the r1 situation. |
| **major** — committed `openapi.json` dishonest for ~20 path items | **resolved** — grok's preferred option (a), omit until 1b |
| **minor** — `ProductFeedbackReport` loses findings/workaround shape | **resolved**, via `value_type` rather than grok's suggested type change — correctly, since narrowing the Rust type would have broken legacy JSONB rows (proven by my wire probe: `{"totally":"unexpected"}` round-trips today) |
| **minor** — reports security omits `x-api-key` | **resolved** |
| **nit** — health tagged `ingest` | **resolved** — now `system` |

---

## Verification

Read-only throughout. Nothing in the worktree was edited, staged, committed, or
pushed; `os-platform` was not touched. All mutation testing happened on a copy at
`<scratchpad>/probe` with `CARGO_TARGET_DIR=<scratchpad>/target`, and the copy was
reverted to pristine after each variant.

```
$ cd backend && cargo fmt --check
fmt OK (exit 0)

$ cd backend && cargo clippy --all-targets --locked -- -D warnings
Finished `dev` profile — no warnings

$ cd backend && cargo test --locked
11 passed; 0 failed; 5 ignored (require DATABASE_URL)
  incl. page_tests::openapi_document_covers_every_api_route_and_method ... ok

$ pnpm test
tests 63 | pass 63 | fail 0

$ pnpm check                     # biome, part of make check
Checked 28 files in 145ms. No fixes applied.

$ make backend-openapi-check
(no diff — committed spec matches regenerated)

$ cd /tmp && env -i <abs>/backend/target/debug/agent-feedback --print-openapi
exit 0, 21862 bytes — no DB, no env, no .env, no telemetry
$ diff -q that backend/openapi.json
identical

$ pnpm exec openapi-typescript backend/openapi.json -o <scratchpad>/types2.ts
ok — 450 lines, post: operations["product_feedback_handler"], no `path?: never`
(written to scratchpad, NOT to web/)

--- mutation testing (scratchpad copy) ---
baseline                                              -> passes
B  .route("/api/drift-probe", get(health))            -> FAILS (caught)
H  delete route still listed in KNOWN_UNANNOTATED     -> FAILS (caught)
C  .route_service("/api/drift-probe", ServeDir::…)    -> passes (MISSED)
G  .route("/api/drift-probe", any(health))            -> passes (MISSED)
D4 .merge(helper()) defined below openapi_spec_json   -> passes (MISSED)
E4 .nest("/api/v3", helper()) same placement          -> passes (MISSED)
D2/D3/E2/E3 (helper inside the scanned slice)         -> FAILS (caught)

--- axum rejection probe (real server, real socket, same axum version) ---
6 cases recorded; table reproduced in section 3

--- wire probe ---
ProductFeedbackReport with non-conforming legacy JSONB serializes verbatim

$ ls -l backend/openapi.json
-rw-------   <- 0600, see the minor finding

$ git status --short
identical to session start, plus the pre-existing untracked .pnpm-store/
```

Not run end-to-end: `make check`. Every component that this change can affect was
run individually above; `landing-check`, `sdk-node-test`, `docs-validate` and
`docs-a11y` are untouched by it, and the docs targets hard-fail on this machine's
Node 26 via the pre-existing `node-version-check` gate.

## Verdict

**ship with fixes** — up from `do not ship`.

The blocker is genuinely resolved and I have watched the guard fail, which is the
thing F1 asked for and the thing that was missing in r1. F2, F3, F4, F5 and the
F7 nits are all correctly done, and F3 in particular is accurate to axum's real
behaviour rather than to a plausible guess about it.

Before commit I would take:

- the **guard deny-list** (major) — cheap, and it is the difference between "this
  catches the mistake we made" and "this catches the mistakes we have not made
  yet";
- the **0600 mode** (minor) — one-word fix, `install -m 644` for `mv`, which also
  moves the temp file out of the tree;
- `.pnpm-store/` into `.gitignore` or off disk, so it does not ride along in the
  commit.

The `additionalProperties: false` trade-off, the `required` omission on
always-present nullable fields, and the untested discovery document are all fine
to carry into 1b — but the discovery test should not slip further, since 1a is
where that envelope changed.
