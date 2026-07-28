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

Finite Axum JSON and HTML bodies are instrumented. Bodies without an exact bounded size—including streams—are left untouched. Telemetry uses a bounded Tokio queue and never blocks the product response.

`feedback_from_response` and `submit_product_outcome` provide the deterministic, allow-listed customer-agent path.
