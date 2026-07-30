# Chunk 1b — review fixes (dash-impl)

Both reviewers returned **ship**: `.reviews/dashboard-1b-opus.md`,
`.reviews/dashboard-1b-grok.md`. Wire format, spec accuracy, the drift guard and
all carry-forward items were verified clean — opus confirmed the guard was
materially strengthened, not weakened, and that the `setup-page.test.mjs` edits
mask no behaviour change (it diffed the emitted spec against 1a's).

Three fixes before commit. Nothing else — do not restructure anything.

## H1 (minor, must fix) — restore path/method pinning, against the spec

The `routes!` migration rewrote three assertions in `tests/setup-page.test.mjs`
from pinning *path + method + handler* to pinning the **handler name only**:

```js
/\.route\("\/api\/team", patch\(rename_team_handler\)\)/            // was
/\.routes\(routes!\(rename_team_handler\)\)/                         // now
```

The rewrite was the correct mechanical response — the old form no longer exists.
The problem is what is left guarding those routes. Path and method now live only
in `#[utoipa::path]`, and the Rust drift guard derives **both** of its sides from
that same annotation, so a path rename moves both together and the
`assert_eq!` cannot see it. That guard is a coverage check, not a path check —
by construction, and fine — but it means these three routes now have no pin at
all.

Concrete failure: someone changes `path = "/api/team"` to `"/api/teams"` (a
find/replace on "team", say). `cargo test` green, `pnpm test` green,
`make backend-openapi-check` green after the regen they would naturally run.
`backend/public/app.js` still calls `PATCH /api/team`, gets a 404, and team
rename silently breaks. Before this chunk, `pnpm test` caught that.

**Fix:** re-pin path and method in the `.mjs` suite, but assert against the
committed `backend/openapi.json` rather than `main.rs` source text. The spec is a
generated, checked-in, drift-checked artifact, so an assertion on it survives any
future registration-form migration and is strictly stronger than the source-text
form it replaces. At minimum:

- `paths["/api/team"].patch` exists
- `paths["/api/products/{product_id}"].patch` and `.delete` exist

Keep the existing handler-name and `require_workspace_editor` assertions — they
guard authorization and are still meaningful. This also gives the `tests/*.mjs`
suite a durable hook on the API surface for phase 2, so prefer a small shared
helper that loads and parses `backend/openapi.json` once.

While you are there, check whether any *other* assertion in the `tests/*.mjs`
suite lost path/method pinning in this migration, and re-pin those the same way.

## H2 (minor) — `GET /auth/callback` declares a 400 its query type cannot produce

`backend/src/main.rs` (see grok's report for the exact lines). The declared
plain-text 400 is unreachable for that handler's query extractor. Remove it, or
if you believe it *is* reachable, say precisely how and leave it. Do not
add a speculative response.

## H3 (nit, do it) — envelope key assertions are one level deep

`backend/src/api_types.rs` — `assert_keys` compares only top-level
`value.as_object().keys()`. So `ProductCreatedResponse` is pinned to
`{product, environment, apiKey, secret, shownOnce}` while nothing asserts the
keys *inside* `product`, `environment`, or `apiKey`.

No live risk in this diff — opus verified the nested types gained only `ToSchema`
and `#[schema(...)]` attributes, which are inert to serde. Worth closing anyway:
the test reads as a wire-format guarantee, and the nested layer is exactly where a
future `rename_all` slip would land. Phase 2's typed client will consume these
shapes directly, so pinning them now has leverage.

Extend the assertions one level into the nested objects for the envelopes that
carry them.

## Gate

```
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets --locked -- -D warnings
cd backend && cargo test --locked
pnpm test
make check
```

`make check` needs Node >=22.13 <25 — `fnm use 22.23.1` first (local default is
Node 26). Regenerate `backend/openapi.json` if H2 changes it.

Report per-finding, then stop. Do not commit.
