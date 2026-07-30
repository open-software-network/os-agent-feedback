# `agent-feedback` for Rust

Axum/Tower middleware using the same protocol and conformance vectors as Node, Python, and Go.

```rust
use agent_feedback::{AgentFeedbackLayer, Options};

let feedback = AgentFeedbackLayer::new(
    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)
        .include(["/search", "/docs/**"])
        .customer_ref(|request| {
            request.headers().get("x-account-id")?.to_str().ok().map(str::to_owned)
        }),
)?;

let app = Router::new()
    .route("/search", get(search))
    .layer(feedback.clone());
```

Finite Axum JSON and HTML bodies are instrumented. Bodies without an exact bounded size—including streams—are left untouched. If a body that advertised a safe exact size fails while being read, middleware returns an explicit non-empty `500` instead of disguising the failure as an empty success. Telemetry enqueue is bounded, carries a monotonic process-local sequence, and never blocks the product response. Background delivery has a 10-second request deadline; `shutdown` has a two-second bound, reports delivery failure, and flushes every queued batch on success. Construct `AgentFeedbackLayer` inside a Tokio runtime; construction returns `Error::MissingTokioRuntime` otherwise.

`feedback_from_response` and `submit_product_feedback` provide the deterministic, allow-listed customer-agent path.

Use `FeedbackMode::AskOnce` with a stable opaque `customer_ref`. Unknown customers receive only a question-first decision contract; Epode remembers `approved|declined` and approval reveals a separate report contract. `FeedbackMode::AskAlways` repeats that two-step flow for each report. Agents store no preference, and reports contain no consent fields.
