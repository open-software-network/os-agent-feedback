# EPD-5 — Is reading part of the protocol, or a product API?

## 1. Verdict

**Product API.** The read path is a feature of epode's hosted service, exposed as read tools on the hosted `/mcp` endpoint behind the `af_read_` key. Protocol v1 stays emit-only. Do not add a read half to `protocol/v1/`, the `.well-known` descriptor's protocol surface, the five SDKs, or the conformance suite. Document the read API openly (Sentry-style: open ingest spec, documented-but-non-normative read API) so third parties aren't stranded, and leave the door open for a future additive `read` section if a second implementer ever materialises.

## 2. Why

**What v1 actually claims to be.** `protocol/v1/README.md:3` opens: "This protocol is the source of truth for every Agent Feedback SDK. It is deliberately small enough to implement with a language's standard HTTP, JSON, HMAC-SHA256, UUID, and base64url libraries." Every section is emit-side: capability signing (`afr2_` HMAC recipe), the `_agentFeedback` response envelope (`envelope.schema.json`), telemetry batching (`telemetry-batch.schema.json`, `POST /api/v2/telemetry/batches`), outcome submission (`outcome.schema.json`, `POST /api/v2/outcomes` — "Only `outcome` and `note` are allowed"), and the MCP 2026-07-28 binding whose only mandated tool is `report_product_outcome`. All eight conformance requirements (README §Conformance) test emission, preservation, and non-blocking delivery. The descriptor's own `purpose` field (`backend/src/main.rs:295`): "Collect one compact product-outcome review from a customer's independent agent." Nothing forbids a read path; nothing anticipates one either. It is a wire format for emitting receipts, not a service contract.

**The parties don't line up.** The protocol binds two parties: the product's server (via SDK middleware — `sdk/node/src/express.ts`, `sdk/go/agentfeedback.go` etc. are request/response instrumentation) and the customer's agent (submits one outcome). The read path serves a third party — the product owner's own repo agent — querying *epode's aggregated store*. Aggregated feedback at rest is inherently the host's data; a third-party implementer of the emit protocol stores its own outcomes and would design its own query surface anyway. Forcing a query contract into v1 would constrain implementers on the one thing that is legitimately theirs.

**SDK shape.** The SDKs have zero read code (`grep` for read/query surfaces: none; all API references are `POST /api/v2/outcomes|telemetry/batches`). They are server middleware installed *inside the product*; a read client for a repo agent doesn't belong in that package. The already-decided delivery mechanism — MCP tools over static bearer config (`docs/mcp-client-config.md`) — needs no SDK at all.

**Reversibility is cheap in this direction only.** The descriptor is `"version": 1` with additive JSON; a future `read` section or a `protocol/v1/read.schema.json` is a non-breaking addition once a real second implementer exists. The reverse — shipping read as protocol-mandatory, then discovering no third party wants to implement pagination/filter semantics — bakes dead surface into the conformance suite permanently.

**What would change my mind.** (a) A concrete third-party implementer (or credible design partner) who needs interoperable *read* — e.g. a repo-agent tool that must work identically against epode and a self-hosted implementation. (b) A decision to open-source the backend as the reference implementation, making "the hosted service" and "the protocol" the same artifact. (c) The read path moving off `/mcp` onto a REST surface that SDKs would wrap — then SDK/protocol coupling returns.

## 3. What changes under Product API (chosen)

- `backend/src/main.rs` — the whole change lives here:
  - `mcp_tools()` (line 1232): add read tools (e.g. `list_feedback`, `get_feedback_summary`) alongside the three write tools.
  - `mcp_handler` `tools/call` arm (line 1164): dispatch the new tools; auth currently goes through `agent_workspace` (write-key path) — add the `af_read_` path with per-tool scope enforcement (`af_read_` → read tools only, `af_live_` stays write-only per the EPD decision).
  - Key issuance: `create_api_key_handler` (line 149) + `store.rs` (prefix check at `store.rs:503` is hardcoded `af_live_`) + a new migration adding `kind` to `api_keys` (not yet present — checked `backend/migrations/`, nothing beyond 0011).
- `backend/public/` dashboard — settings UI to mint read keys (adjacent EPD ticket, but it's the same effort).
- `docs/` — a read-API reference (tool names, arguments, response shapes), companion to the existing `docs/mcp-client-config.md`. This is the "document openly, don't mandate" piece.
- Tests — backend-side coverage for the new tools/auth (Rust tests in `main.rs`/`store.rs`, plus `tests/agent-playground.test.mjs`-style coverage if the playground grows read).
- **Untouched**: `protocol/v1/*` (all 4 files), all 5 SDKs, `tests/cross_language_conformance.sh`, `tests/setup-matrix-e2e.mjs`, all 9 `examples/setup-matrix-*` apps, both `.well-known` descriptors.

### Q3: must the descriptor advertise read? No.

`/.well-known/agent-feedback-v1.json` (`feedback_discovery_v2`, `main.rs:292–336`) advertises: telemetry URL + auth, outcome-submission URL + auth, classification rules, MCP transport requirements, and SDK tarball links. Its consumers are customer agents and generic-agent discovery — every SDK emits a `Link` header pointing at it (`sdk/go/agentfeedback.go:452`, `sdk/node/src/express.ts:73`) so an uninstrumented agent can learn how to *submit*. The read audience (repo agents) never sees that Link header; they get the endpoint + key from their own product's config. Discovery for MCP tools is `tools/list` — the transport is self-describing, so a descriptor entry is redundant. If it's ever advertised, put it under a clearly-namespaced non-protocol key (e.g. `"hostedService": { "read": ... }`) so it can't be mistaken for a conformance requirement; the top-level `"version": 1` needn't bump for an additive key. The old `/.well-known/agent-feedback.json` is `deprecated: true` (`main.rs:283`) — never touch it.

## 4. What changes under Protocol (rejected) — the cost delta

- `protocol/v1/README.md` — new Read section: query semantics, auth model (`af_read_`), filtering/pagination, privacy rules for returned notes; plus MCP-binding additions mandating the read tools.
- New `protocol/v1/read.schema.json` (feedback list/summary response shapes) and read vectors in `conformance.json`.
- `.well-known/agent-feedback-v1.json` (`main.rs:292`) — normative `read` section; the envelope's `"v": 1` const and descriptor versioning story get re-litigated.
- All five SDKs grow a read client half: `sdk/node/src/` (+ new module beside `core.ts`/`mcp.ts`), `sdk/python/src/agent_feedback/`, `sdk/go/agentfeedback.go`, `sdk/rust/src/lib.rs`, and the MCP server helpers — despite being server middleware with no natural home for a repo-agent read client.
- `tests/cross_language_conformance.sh` — read-conformance tests in each of the four language suites; the "hosted backend acceptance suite" (README conformance item 8) grows read checks.
- `tests/setup-matrix-e2e.mjs` (434 lines) and the 9 `examples/setup-matrix-*` apps — e2e assertions that read works against each installed adapter's product.
- Ongoing: every future read-surface change (new filter, new field) becomes a 5-SDK + conformance + descriptor change instead of one `main.rs` edit. That's the real cost — not the initial build, the permanent amplification factor.

## 5. Prior art

The industry pattern is uniform: **open push/ingest protocol, proprietary or merely-documented read API.**

- **OpenTelemetry / OTLP** — the strongest parallel. The [OTLP spec](https://opentelemetry.io/docs/specs/otlp/) defines exactly one request type, `Export` (traces/metrics/logs/profiles); it is a pure push protocol with no query operation. Querying is entirely vendor territory (Datadog, Grafana, Chronosphere each have their own read APIs). OTel has thrived for years without a standard read path.
- **Sentry** — the [envelope ingest format](https://develop.sentry.dev/sdk/data-model/envelopes/) is openly specified for SDK authors (`POST /api/{project_id}/envelope/`); reading events goes through the separate Sentry Web API, documented but not part of the SDK wire contract. This is the "document openly, don't mandate" model to copy.
- **PostHog** — [public unauthenticated capture endpoints](https://posthog.com/docs/api/capture) (`/i/v0/e`, project token, no rate limit) vs the [private Query API](https://posthog.com/docs/api/queries) (personal API key with explicit Query-Read permission, 2400/hr rate limit). Write and read are different auth regimes and different contract tiers.
- **Statsig** — closest match for the *key* design: SDK server keys hit evaluation/logging endpoints only, while reading experiments requires a separate [Console API key](https://docs.statsig.com/access-management/api-keys). Directly validates the `af_live_` / `af_read_` split.

OTLP is the right analogy for the *contract* question; Statsig/PostHog for the *key-scoping* question. No counter-example found of a small ingest protocol that mandates a query surface.

## 6. Unverified

- `af_read_` key / `kind` column: **not yet in code** (no migration past `0011_shareable_team_invites.sql`, `store.rs:503` hardcodes `af_live_`). Treated as decided-but-unbuilt per the brief.
- The "hosted backend acceptance suite" named in README conformance item 8 — not located as a distinct artifact in the repo; assumed to be the backend's own test surface.
- Whether any third-party implementer of the emit protocol exists today — nothing in the repo suggests one; the stranding risk is therefore currently theoretical.
- PostHog/Statsig details come from their docs via search summaries, not exhaustive primary-source reads; the OTLP export-only claim was verified against the spec page directly.
- Read-tool auth wiring (`agent_workspace` vs a new read-auth path) is inferred from `main.rs` structure; exact shape is the implementing ticket's call.
