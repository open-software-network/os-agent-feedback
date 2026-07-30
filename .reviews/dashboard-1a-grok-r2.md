# Phase 1 chunk 1a re-review (r2) — post F1–F7 fixes

Reviewer: grok. Uncommitted worktree on `jakub/dashboard-rewrite`.
Against `.briefs/phase1-openapi.md` chunk 1a, `.briefs/phase1-review.md`, `.briefs/phase1-1a-fixes.md`.
Prior reports: `.reviews/dashboard-1a-grok.md`, `.reviews/dashboard-1a-opus.md`.

---

## Prior findings — disposition

### grok r1

| # | Finding | Status |
|---|---|---|
| blocker | vacuous path-coverage test | **mostly resolved** — see residual holes below |
| major | PENDING parallel inventory | **resolved** — deleted |
| major | dishonest stub ops in openapi.json | **resolved** — 4 ops only |
| minor | findings/workaround `{}` schema | **resolved** — `#[schema(value_type = …)]` |
| minor | reports missing `api_key` security | **resolved** |
| nit | health tagged `ingest` | **resolved** — `tag = "system"` |

### opus r1 (not in grok r1)

| # | Finding | Status |
|---|---|---|
| blocker | same vacuous test | **mostly resolved** |
| major | stubs assert no auth | **resolved** |
| major | invalid OAS 3.1 path params on stubs | **resolved** (stubs gone) |
| major | 400/413/415 honesty on ingest | **resolved** |
| minor | reports `x-api-key` | **resolved** |
| minor | nullable fields not `required` | **still open** — not in F1–F7; not a 1a ship blocker |
| minor | discovery wire golden test missing | **still open** — not in F1–F7; risk remains |
| minor | `make backend-openapi` truncates on fail | **resolved** (temp then `mv`) |
| nit | check temp inside repo | **resolved** for check (no file); **partial** for `backend-openapi` |
| nit | `types` skips node-version-check | **resolved** |
| nit | typescript peer transitive | **open / phase 2** — F7 allowed decline |
| nit | license/version fiddling undocumented | **partial** — license comment added; version left to utoipa default |

---

## major — source-scan drift guard still has silent escape hatches
file: backend/src/main.rs:1712-1839

F1 required property: any served route without a spec op (and not on `KNOWN_UNANNOTATED`) must fail `cargo test`.

Implementation matches the recommended approach for the **idiomatic** style this file uses (`.route("…", get|post|patch|delete(…))` + `.routes(routes!(handler))` inside `build_app_router`). Offline probe of the same algorithm:

| registration | scanner result |
|---|---|
| `.route("/api/drift-probe", get(health))` | **caught** → `GET /api/drift-probe` |
| multiline `.route(` + chained methods | **caught** (current dashboard routes) |
| string escapes / balanced parens | handled |
| `.route_service("/api/drift-probe", …)` | **MISS** |
| `.route("/api/drift-probe", any(health))` | **MISS** |
| `.route(..., on(MethodFilter::GET, …))` | **MISS** |
| routes only inside a helper merged in (`.merge(extra())` where `extra` has `.route`) | **MISS** — scan window is only `build_app_router` body, not whole `main.rs` / other modules |
| `.route(concat!("/api/", "drift-probe"), get(health))` | **wrong** → `GET /api/` only |
| `get(health), // post(x)` comment inside call | **false POST** (noise, not a miss) |

Concrete silent-add failure (helper merge):

```rust
fn extra_routes() -> Router<Arc<AppState>> {
    Router::new().route("/api/drift-probe", get(health))
}
// inside build_app_router:
.merge(extra_routes().into())
```

Served. Not in OpenAPI. Not in `KNOWN_UNANNOTATED`. Test stays green. Same for `.route_service("/api/…", …)`.

Also: F1 said scan “this module's own source”; code only slices `build_app_router`…`openapi_spec_json`. Helpers in the same file outside that window are invisible.

Why it matters: the original blocker is fixed for copy-paste `.route` next to existing ones (the realistic 1a/1b path). It is **not** fixed against ordinary axum composition. Next refactor that extracts route groups silently disables the guard.

Suggested fix (describe only):
1. Scan full `include_str!("main.rs")` (or all `backend/src/**/*.rs`) for `.route(`, not just the builder slice; and/or
2. Fail the test if builder (or crate) source matches escape APIs without a corresponding documented path: `.route_service(`, `.nest(`, `\bany(`, `MethodFilter`, `on(`; and/or
3. Longer-term: register every API route only via `routes!` so OpenAPI and router share one path.

I did **not** mutate the worktree to run the F1 negative `cargo test` (read-only). Offline probe is equivalent for the scan logic; impl should still have recorded the live fail/green pair in their report.

---

## minor — `make backend-openapi` still drops temp files inside `backend/`
file: Makefile:34-39

F6: write temp outside the repo; only `mv` into place on success.

Current:

```make
tmp_file=$$(mktemp backend/openapi.json.XXXXXX);
…
mv "$$tmp_file" backend/openapi.json
```

Truncate-on-compile-failure is fixed. Temp still under `backend/`; SIGKILL leaves `openapi.json.*` untracked (same nit opus had on the check target). Check target itself no longer uses an in-tree temp (good).

Suggested fix: `mktemp -t epode-openapi` (or `$TMPDIR`) then `mv`.

---

## nit — comment/`concat!` quirks in the scanner
file: backend/src/main.rs:1767-1807, 1785-1790

- A `// … post(…)` (or `get(`) inside the method-router expression can invent a method.
- Non-literal paths (`concat!`, consts) panic or mis-parse.

Failure mode is noisy false fail / wrong path, not silent miss. Fine for current code style; document or strip comments if the scanner stays.

---

## Checked clean this round

### (1) Drift guard — what holds
- Plain `.route("/path", get|post|patch|delete(…))` added in `build_app_router` without annotation and without `KNOWN_UNANNOTATED` → `served \ known` ⊈ `spec` → assert fails. **This was the r1 blocker.**
- Reverse: ghost spec op (annotated/`routes!` without registration) → `spec != served_that_require_spec`.
- `KNOWN_UNANNOTATED` entry not served → fail.
- `KNOWN_UNANNOTATED` entry already in spec → fail (ledger cannot rot into permanent excuse).
- `GET /` excluded via `NON_API_ROUTES`; `/static` is `nest_service` (not claimed as API).

### (2) `KNOWN_UNANNOTATED` honesty
- 24 entries; comment: “Chunk 1b route ledger; empty when 1b complete.”
- Exact match to every non-`routes!` API method currently registered in `build_app_router` (verified set equality `route_api == known`).
- Disjoint from the four documented ops.
- No extras, no missing current routes.

### (3) Four-op `openapi.json` + F3/F4/F5 accuracy
- Paths: only `GET /api/health`, `GET /.well-known/agent-feedback-v1.json`, `POST /api/v2/telemetry/batches`, `POST /api/v2/reports`.
- Regen == committed (diff empty).
- Ingest 400: dual `application/json` (`ApiErrorEnvelope`) + `text/plain` — matches axum `JsonSyntaxError` (400 plain) + `safe_input`/`ApiError` (400 JSON). Handlers are `Json<Value>`, so `JsonDataError` (422) is not a realistic path.
- 413 `text/plain`, 415 `text/plain` — match axum-core `LengthLimitError` / `MissingJsonContentType` (verified in axum 0.8.9 / axum-core 0.5.6 sources).
- Reports security: `bearer_auth` | `api_key`.
- `ProductFeedbackReport.findings` → array of `FeedbackFindingInput`; `workaround` → `FeedbackWorkaroundInput | null`; both schemas present in `components`. Rust fields remain `Value` / `Option<Value>` (no live-data regression).
- Health tag `system`.
- No fabricated ops; no false “security: none” on dashboard routes.

### (4) No behaviour regression vs r1 clean set
- Router paths/methods/layers/`nest_service`/`with_state` unchanged in structure from post-1a rewrite.
- Wire structs + proof handlers unchanged in substance from r1 (plus schema annotations only on report Value fields).
- `PENDING_*` gone; no `web/`; `backend/public/*` untouched.
- `--print-openapi` still first in `main`, dependency-free (regen under clean env OK).

### Gates
```
cargo fmt --check                          → 0
cargo clippy --all-targets --locked -D warnings → 0
cargo test --locked                        → 11 passed, 5 ignored
pnpm test                                  → 63 passed
make backend-openapi-check                 → 0
diff committed openapi.json vs --print-openapi → empty
```
`make check` full umbrella not run (Node 26 local would fail `node-version-check` before docs; constituents that matter for this delta are green).

---

## Verdict
ship with fixes

Must-fix before ship: residual drift-guard escape hatches (major) — at least ban/detect `.route_service` / out-of-builder `.route` / `any`/`on` so the F1 property holds beyond the happy-path registration style.

Optional before/with 1b: in-tree `mktemp` for `backend-openapi`; discovery golden JSON test; nullable `required` on report optionals (opus minor).
