# Chunk 1a — round 2 fixes (dash-impl)

Both reviewers re-reviewed the delta. Verdicts: `ship with fixes` (grok),
see `.reviews/dashboard-1a-grok-r2.md` and `.reviews/dashboard-1a-opus-r2.md`.

F1–F7 are confirmed resolved. I independently verified the F1 negative probe
myself: adding `.route("/api/drift-probe", get(health))` fails
`openapi_document_covers_every_api_route_and_method` with a legible diff, and it
goes green again on removal. I also verified F6: appending a syntax error to
`main.rs` and running `make backend-openapi` leaves the committed spec intact
(21862 bytes, unchanged hash) with no leftover temp file.

Read both r2 reports before starting. Fix the following.

## G1 (major, both reviewers) — make the drift guard fail-closed

`served_operations` / `route_calls` is an **allow-list** scanner: it understands
only `.route(` and `.routes(routes!(`, only inside the `build_app_router` textual
span. Everything else that mounts a handler is invisible. Confirmed holes, each
reproduced by opus with a compiling probe:

- `.route_service("/path", svc)` — the substring `.route(` does not occur
  (next char is `_`), so it is never scanned. Realistic: the file already mounts
  `ServeDir` via `nest_service`.
- Method routers outside the eight hard-coded idents: `any(handler)`,
  `MethodRouter::new().on(MethodFilter::GET, h)`, `.fallback(h)`. The path parses
  but no method ident matches, so the route contributes **zero** entries and
  vanishes. `any()` is worst — it serves every method on that path.
- `.merge(helper())` / `.nest("/prefix", helper())` where the helper is defined
  outside the scanned span.

The realistic trigger: chunk 1b or a later PR tidies the dashboard routes into
`fn dashboard_routes() -> Router<Arc<AppState>>` and merges it. Add a fifth route
to that helper and it is served, absent from the spec, absent from the ledger,
and `cargo test` is green.

**Fix — invert the default.** Scan the span for registration forms the guard
cannot interpret and fail loudly on sight:

```
".route_service(", ".nest(", ".nest_service(", ".merge(",
".fallback(", ".fallback_service(", ".method_not_allowed_fallback("
```

with an explicit narrow exemption for the two known-good occurrences
(`.merge(non_api_routes.into())` and `.nest_service("/static", ...)`) — match
them precisely enough that a *different* `.merge(` or `.nest_service(` still
trips. Apply the same treatment to any method-router expression whose recognised
method count is zero.

Failure message should say what to do, e.g. *"route registration form not
understood by the coverage guard — teach `served_operations` about it or register
the route with `.route(`"*.

Both reviewers independently proposed this same fix. It turns unknown-unknowns
loud, which is the property F1 actually wanted.

Also fix the two cosmetic scanner edges while you are in there (both fail-closed
today, so neither can hide drift — but both mislead):
- `route_calls` has no comment handling, so a commented-out `.route(...)` inside
  the span counts as served and fails the test with a route that is not served.
- A `.nest("/api/v3", Router::new().route("/widgets", ...))` reports the
  un-prefixed inner path `GET /widgets`. Someone pasting that into
  `KNOWN_UNANNOTATED` would silence the test while the real served path stays
  undocumented. The `.nest(` deny-list entry closes this.

**Prove it again:** for each denied form, add it temporarily, show `cargo test`
fails, remove it. Report the outputs. At minimum cover `.route_service(`,
`any(...)`, and a `.merge(helper())` with an extra route.

## G2 (minor) — `make backend-openapi` writes the spec mode 0600

`mktemp` creates 0600 and `mv` preserves it, so the committed spec ends up
owner-only. Git does not track the read bit, so this is invisible in review and
flips back to 0644 for anyone who obtains the file by clone — meaning it works on
a fresh clone and fails for whoever last regenerated it locally (a container
build layer running as non-root, a CI job with a different runner user,
`make types` in a sandbox).

Fix with `install -m 644 "$$tmp_file" backend/openapi.json` instead of `mv`.

## G3 (nit, both) — temp file still inside the repo tree

`mktemp backend/openapi.json.XXXXXX` puts it in `backend/`. `trap ... EXIT` does
not run on SIGKILL, so a hard-killed build leaves an untracked, un-ignored
`backend/openapi.json.aBc123` that `git add -A` will pick up. Use `mktemp -t`
(or `$TMPDIR`). Combined with G2: `mktemp -t` + `install -m 644`.

`backend-openapi-check` is correct as-is — command substitution, no temp file,
and the trailing-newline round-trip is right. Leave it alone.

## G4 (minor) — `deny_unknown_fields` leaks into the response schema

My F5 call was right that `#[schema(value_type = Vec<FeedbackFindingInput>)]` is
wire-inert — opus confirmed that. But `FeedbackFindingInput` carries
`#[serde(deny_unknown_fields)]`, which utoipa renders as
`additionalProperties: false` plus `required: [kind, topic, detail]`. So the 200
body of `POST /api/v2/reports` now declares that every `findings` element matches
that shape *exactly* — a guarantee the JSONB column does not make. Opus
demonstrated a `ProductFeedbackReport` whose `findings` holds
`[{"kind":…,"legacyExtra":42}, {"totally":"unexpected"}]` serializing verbatim.

That is the same class of dishonesty we deleted the stub operations for: the spec
asserting something stricter than reality. It does not affect the phase-2 client
(`openapi-typescript` emits no runtime validation) but it breaks any
spec-validating consumer — contract tests, mock servers, validating generators.

Fix: keep `value_type`, point it at an **output-shaped** schema that does not
inherit `deny_unknown_fields` — a dedicated `FeedbackFinding` / `FeedbackWorkaround`
output struct used for the schema only. Do **not** change the Rust field types;
they stay `Value` / `Option<Value>` for the reasons in F5.

## G5 (minor, opus r1, still open) — no test covers the discovery document rewrite

`feedback_discovery_v2` was rewritten from a `json!` literal into ~15 nested
structs with hand-written `rename_all` attributes, and nothing asserts the
output. It is a **public protocol document** (`/.well-known/agent-feedback-v1.json`)
that SDKs read. Both reviewers checked the key names by eye and found them
correct, but eyeballing is not a regression guard.

Add a golden test asserting the serialized document equals the exact expected
JSON — including the mixed casing that makes it easy to get wrong
(`feedbackModes` object whose *keys* are `never_ask`/`ask_once`/`ask_always`/`off`,
alongside camelCase `feedbackSubmission`/`requiredFields`/`askOnceScope`).

## G6 (nit) — `.pnpm-store/`

An 8 KB `.pnpm-store/` sits untracked at the repo root and is not git-ignored
(`.gitignore` covers `.pnpm-debug.log*` only). It is a `git add -A` hazard in a
worktree about to be committed. Add `.pnpm-store/` to `.gitignore`.

## Explicitly out of scope for 1a — do not fix now

- Nullable-but-always-present fields declared optional rather than `required`
  (opus r1 minor). Fold into 1b when the dashboard schemas are done properly.
- `openapi-typescript`'s transitive `typescript` peer — phase 2.
- Converting the `Json<Value>` extractors to rejection-mapping wrappers — that is
  a behaviour change and needs its own chunk. F3 documented reality instead.

## Gate

```
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets --locked -- -D warnings
cd backend && cargo test --locked
pnpm test
make backend-openapi-check
```

Plus the G1 negative probes, and `ls -l backend/openapi.json` showing 0644.

Note: `make check` in full may fail locally at `node-version-check` depending on
the local Node version — that gate is environmental, not a code problem. Run it,
and if it fails there, say so explicitly and report the constituent targets
instead. Do not "fix" it by weakening the check.

Do not commit — report and stop.
