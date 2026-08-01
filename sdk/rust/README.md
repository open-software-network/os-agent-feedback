# `agent-feedback` for Rust

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

Finite Axum JSON and HTML bodies are instrumented. Bodies without an exact bounded size—including streams—are left untouched. If a body that advertised a safe exact size fails while being read, middleware returns an explicit non-empty `500` instead of disguising the failure as an empty success. Telemetry enqueue is bounded, carries a monotonic process-local sequence, and never blocks the product response. Background delivery has a 10-second request deadline; `shutdown` has a two-second bound, reports delivery failure, and flushes every queued batch on success. Construct `AgentFeedbackLayer` inside a Tokio runtime; construction returns `Error::MissingTokioRuntime` otherwise.

The default `HttpCacheMode::Safe` leaves explicitly shared-cacheable responses completely unchanged. Use `.cache_mode(HttpCacheMode::Request)` to instrument only requests carrying `Agent-Feedback-Request: 1`; both variants use `Vary` and eligible ordinary 2xx `GET`/`HEAD` responses carry a same-path-and-query discovery `Link`. Use `HttpCacheMode::Private` when every included response is intentionally private. Every instrumented response becomes `Cache-Control: private, no-store` because its capability is unique.

`feedback_from_response` and `submit_product_feedback` provide the deterministic, allow-listed customer-agent path.

Use `FeedbackMode::AskOnce` with a stable opaque `customer_ref`. HTTP responses never wait for Epode: middleware signs a subject-bound capability locally, reads only process-local cached consent, and refreshes that cache in the background after an eligible response. Epode Companion verifies the capability and resolves the authoritative remembered decision before it asks or reports. Unknown customers receive an answer-first decision contract; Epode remembers `approved|declined` and approval reveals a separate report contract. Approved and declined responses include a scoped `manageConsent` action so an explicit user request can reverse the saved choice; declined responses remain quiet otherwise. `FeedbackMode::AskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
