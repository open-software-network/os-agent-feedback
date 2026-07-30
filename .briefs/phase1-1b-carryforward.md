# Chunk 1b — carry-forward notes

Chunk 1a is committed (`e0de424`, `dca6757`). Working tree was clean at start of
1b. The chunk 1b spec is in `.briefs/phase1-openapi.md` — that is the primary
brief; read it. These are additions and corrections learned during 1a review.

## Definition of done

- `KNOWN_UNANNOTATED` in `backend/src/main.rs` page_tests is **empty**, and the
  constant plus its ledger comment are removed along with any now-dead handling.
  Every served API route has a real `#[utoipa::path]`.
- Every remaining API route is registered via `.routes(routes!(handler))` rather
  than plain `.route(...)`, so the router and the spec share one registration.
- `backend/openapi.json` regenerated and committed; `make backend-openapi-check`
  green.

## Do not weaken the drift guard

The guard is fail-closed: it denies `.route_service(`, `.nest(`, `.nest_service(`,
`.merge(`, `.fallback(`, `.fallback_service(`, `.method_not_allowed_fallback(`
inside `build_app_router`, with exactly two consumed exemptions
(`.merge(non_api_routes.into())` and the `/static` `nest_service`), and fails on
any method-router expression with zero recognised methods. I verified all three
escape hatches fail live.

If 1b's restructure needs a form the scanner does not understand, **teach the
scanner** — do not add a blanket exemption and do not delete the deny-list. If
you genuinely cannot, stop and report rather than loosening it.

## Carried forward from 1a review (now in scope)

- **Nullable-but-always-present fields declared optional.** Deferred from 1a
  explicitly. Fields that are always present but nullable must be `required` with
  a nullable type, not omitted from `required`. Applies across the dashboard
  schemas you are about to add. See the minor finding in
  `.reviews/dashboard-1a-opus.md`.
- **`deny_unknown_fields` leaking into response schemas** (G4). Input structs
  carrying `#[serde(deny_unknown_fields)]` render as
  `additionalProperties: false` + `required`. Do not reuse an input struct as a
  *response* schema where the stored/returned data is not guaranteed to match
  that shape exactly — same reasoning as G4. Use output-shaped schemas.
- **`Value`-typed fields** anywhere in a response: give them a real schema via
  `#[schema(value_type = ...)]`. Do not narrow the Rust field type — those values
  come from JSONB and narrowing is a live-data regression.

## Reminders specific to 1b

- Wire format must not change. For every `json!` envelope you convert to a
  struct, the emitted JSON must be byte-identical — key names, casing, null vs
  absent. `pnpm test` asserts `backend/public/app.js` source text and the DOM
  harness drives the real dashboard against these shapes, so a casing slip breaks
  the existing dashboard.
- Add tests for envelopes that have no coverage today.
- `/mcp` is JSON-RPC with a dynamic body — document it as an opaque JSON object
  and say so in the description. Do not invent a schema.
- `/auth/start`, `/auth/callback`, `/join/{invitation_id}` are redirects that set
  cookies — document the 3xx responses and cookie behaviour, no JSON body.
- Query/path params need `IntoParams`, with the real defaults declared
  (`interaction_limit`/`report_limit` 250, `session_limit` 100).
- Declare only error responses the handler can actually return — read the handler
  and its `store.rs` callees, do not guess. Remember the 413/415/text-plain
  extractor-rejection reality from F3 applies to any handler taking `Json<...>`.
- Tag every route: dashboard / products / team / settings / ingest / auth / mcp.
  `/api/health` is already `system`.

## Gate

```
cd backend && cargo fmt --check
cd backend && cargo clippy --all-targets --locked -- -D warnings
cd backend && cargo test --locked
pnpm test
make check
```

`make check` needs Node >=22.13 <25; local default Node is 26, so use
`fnm use 22.23.1` first. Do not weaken `node-version-check`.

Report per-area when done, then stop. Do not commit — I review first.
