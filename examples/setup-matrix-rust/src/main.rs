use std::env;
use agent_feedback::{AgentFeedbackLayer, Options};
use axum::{Json, Router, response::Html, routing::get};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut options = Options::new(env::var("AGENT_FEEDBACK_KEY")?).include(["/search", "/docs/*"]);
    if let Ok(endpoint) = env::var("AGENT_FEEDBACK_URL") { options = options.endpoint(endpoint); }
    let feedback = AgentFeedbackLayer::new(options)?;
    let app = Router::new()
        .route("/search", get(|| async { Json::<Value>(json!({"stack":"rust","answer":"rust-result"})) }))
        .route("/docs/test", get(|| async { Html("<!doctype html><html><head><title>Rust docs</title></head><body>rust-docs-result</body></html>") }))
        .route("/health", get(|| async { "ok" }))
        .layer(feedback.clone());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", env::var("PORT").unwrap_or_else(|_| "4106".into()))).await?;
    axum::serve(listener, app).await?;
    feedback.shutdown().await;
    Ok(())
}
