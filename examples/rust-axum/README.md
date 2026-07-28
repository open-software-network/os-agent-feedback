# Rust Axum example

```rust
let feedback = AgentFeedbackLayer::new(
    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)
        .include(["/api/status"]),
)?;

let app = Router::new()
    .route("/api/status", get(status))
    .layer(feedback);
```

The adapter is a normal Tower layer and leaves unbounded or streaming bodies untouched.
