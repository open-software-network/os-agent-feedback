# Epode for Rust

Version 0.4.0 preserves the existing Axum/Tower feedback middleware and adds a
typed, framework-neutral company-side customer-enrichment client.

Completed MCP calls can be recorded without an HTTP layer. The recorder owns the
same bounded queue and lifecycle as `AgentFeedbackLayer`; clones share sequence
numbers and shutdown state.

```rust
use agent_feedback::{AgentFeedbackRecorder, McpCompletion, McpOutcome, Options};

let recorder = AgentFeedbackRecorder::new(Options::new(product_key))?;
recorder.record_mcp_completion(
    McpCompletion::new("create_summary", McpOutcome::Success)
        .identity(trusted_product_identity)
        .session_ref(canonical_product_session),
)?;
recorder.shutdown().await?;
```

Only bounded identifiers from trusted product state belong in a completion.
Never pass tool arguments, results, prompts, errors, credentials, or transport
identifiers. Invalid optional references are omitted; invalid operation names
return `McpCompletionError::InvalidOperation`. Enable the `rmcp` feature for
`RmcpToolCompletionHandler`, a transparent wrapper around the official rmcp 3.1
API. Its trusted product-context resolver runs before and after completed calls
so create tools can link a canonical result-derived session. Intermediate
input/task responses and protocol errors are not events; tool-level `isError`
completions are recorded as errors. The wrapper forwards the complete
`ServerHandler` surface and never records raw arguments or results.

```rust
use agent_feedback::{
    CustomerContextInput, CustomerIdentity, CustomerPurpose, EnrichmentRequestInput,
    EnrichmentSurface, EpodeClient,
    EpodeClientOptions,
};

let epode = EpodeClient::new(EpodeClientOptions::from_env()?)?;
let request = epode.request_enrichment(&EnrichmentRequestInput {
    identity: CustomerIdentity {
        user_ref: Some(authenticated_user.id.clone()),
        ..Default::default()
    },
    interaction_id: interaction_id.clone(),
    operation: "/api/recommendations".into(),
    surface: EnrichmentSurface::HttpJson,
    status_code: Some(200),
    duration_ms: Some(handler_duration.as_millis() as u64),
    session_ref: Some(product_journey.id.clone()),
    runtime_hint: Some(verified_runtime_label.clone()),
    purpose: CustomerPurpose::ProductPersonalization,
    remember: true,
}).await;
let context = epode.get_customer_context(&CustomerContextInput {
    identity: CustomerIdentity {
        user_ref: Some(authenticated_user.id.clone()),
        ..Default::default()
    },
    interaction_id: None,
    purpose: CustomerPurpose::ProductPersonalization,
}).await;
let result = if context.available {
    personalize(normal_result, &context.items)
} else {
    normal_result
};
```

`request_enrichment`, `get_customer_context`,
`record_personalization_decision`, and `track_personalization_outcome` reject
redirects, use strict time budgets, and fail open. Use `anonymous_ref` for a
product-owned pre-login identifier, or `interaction_id` alone for
interaction-only context. Mount `relay` at `CUSTOMER_CONTEXT_RELAY_PATHS`; it
validates bounded agent answers before forwarding the short-lived handle and
never exposes the company key.

`EnrichmentSurface::HttpJson` is the default surface; use `Html` or `Mcp` when appropriate.
The optional status, duration, session, and runtime fields describe this same product call.
Session references must be product-issued and runtime hints bounded, non-sensitive server-observed
labels—never prompts, tool arguments, raw customer content, or regulated traits.

## Existing feedback middleware

Axum/Tower middleware using the same protocol and conformance vectors as Node, Python, and Go.

```rust
use agent_feedback::{AgentFeedbackLayer, Options};

let feedback = AgentFeedbackLayer::new(
    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)
        .include(["/search", "/docs/**"])
        .account_ref(|request| {
            request.extensions().get::<AuthenticatedAccount>().map(|account| account.id.clone())
        })
        .user_ref(|request| {
            request.extensions().get::<AuthenticatedUser>().map(|user| user.id.clone())
        })
        .customer_ref(|request| {
            request.extensions().get::<AuthenticatedAccount>().map(|account| account.id.clone())
        }),
)?;

let app = Router::new()
    .route("/search", get(search))
    .layer(feedback.clone())
    .layer(auth_layer);
```

The last Axum layer added executes first, so authentication and authorized tenant selection run
before Epode. Never derive `customer_ref` from a caller-controlled raw header, cookie, query value,
email, or name.

Use `.account_ref`, `.user_ref`, and `.anonymous_ref` for authenticated account/user context and a
product-owned first-party pre-login identifier. They travel only in background telemetry and never
enter the agent-visible capability. Co-supplying an anonymous reference after authentication
authorizes a deterministic progressive link; Epode never infers verified identity.

Finite Axum JSON and HTML bodies are instrumented. Bodies without an exact bounded size—including streams—are left untouched. If a body that advertised a safe exact size fails while being read, middleware returns an explicit non-empty `500` instead of disguising the failure as an empty success. Telemetry enqueue is bounded, carries a monotonic process-local sequence, and never blocks the product response. Background delivery uses a 30-second request deadline and six bounded transient attempts; `shutdown` has a shared 10-second deadline, cancels in-flight delivery, reports terminal failure, and flushes every queued batch on success. Construct `AgentFeedbackLayer` inside a Tokio runtime; construction returns `Error::MissingTokioRuntime` otherwise.

The default `HttpCacheMode::Safe` leaves explicitly shared-cacheable responses completely unchanged. Use `.cache_mode(HttpCacheMode::Request)` to instrument only requests carrying `Agent-Feedback-Request: 1`; both variants use `Vary` and eligible ordinary 2xx `GET`/`HEAD` responses carry a same-path-and-query discovery `Link`. Use `HttpCacheMode::Private` when every included response is intentionally private. Every instrumented response becomes `Cache-Control: private, no-store` because its capability is unique.

`feedback_from_response` and `submit_product_feedback` provide the deterministic, allow-listed customer-agent path.

Use `FeedbackMode::AskOnce` with a stable opaque `customer_ref`. HTTP responses never wait for Epode: middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive an answer-first decision contract; Epode remembers `approved|declined` and approval reveals a separate report contract. Approved and declined responses include a scoped `manageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `FeedbackMode::AskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
