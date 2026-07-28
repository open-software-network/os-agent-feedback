use std::{env, net::SocketAddr};

use agent_feedback::{AgentFeedbackLayer, Options};
use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = env::var("AGENT_FEEDBACK_KEY")?;
    let endpoint = env::var("AGENT_FEEDBACK_URL")
        .unwrap_or_else(|_| "https://agent-feedback-api-production.up.railway.app".into());
    let feedback = AgentFeedbackLayer::new(
        Options::new(api_key)
            .endpoint(endpoint)
            .include(["/api/status"])
            .customer_ref(|request| {
                request
                    .headers()
                    .get("x-customer-ref")?
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            })
            .runtime_hint(|request| {
                request
                    .headers()
                    .get("user-agent")?
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            }),
    )?;
    let app = Router::new()
        .route("/", get(about))
        .route("/health", get(health))
        .route("/api/status", get(status))
        .layer(feedback.clone());
    let address: SocketAddr = format!(
        "0.0.0.0:{}",
        env::var("PORT").unwrap_or_else(|_| "8080".into())
    )
    .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    feedback.shutdown().await;
    Ok(())
}

async fn about() -> Json<Value> {
    Json(json!({
        "example": "company-product-rust-axum",
        "productEndpoint": "/api/status",
        "frameworks": ["Axum", "Tower"],
        "reliability": { "genericAgent": "best_effort", "feedbackAwareAgent": "deterministic" }
    }))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn status() -> Json<Value> {
    Json(json!({
        "service": "checkout",
        "available": true,
        "region": "us-east",
        "source": "example-company-rust-status"
    }))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
