use agent_feedback::{AgentFeedbackLayer, Options};
use axum::{
    Json, Router,
    body::Body,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::env;

#[derive(Clone)]
struct AccountId(String);

async fn authenticate(mut request: Request<Body>, next: Next) -> Response {
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some((payload, signature)) = token.and_then(|value| value.split_once('.')) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
            .into_response();
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(
        env::var("SETUP_MATRIX_PRODUCT_AUTH_SECRET")
            .unwrap_or_default()
            .as_bytes(),
    ) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.decode(signature).unwrap_or_default();
    let account_id = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|value| String::from_utf8(value).ok());
    let Some(account_id) = account_id.filter(|value| valid_account_id(value)) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
            .into_response();
    };
    if mac.verify_slice(&signature).is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
            .into_response();
    }
    request.extensions_mut().insert(AccountId(account_id));
    next.run(request).await
}

fn valid_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.:-".contains(character))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut options = Options::new(env::var("AGENT_FEEDBACK_KEY")?)
        .include(["/search", "/docs/*"])
        .customer_ref(|request| {
            request
                .extensions()
                .get::<AccountId>()
                .map(|account| account.0.clone())
        });
    if let Ok(endpoint) = env::var("AGENT_FEEDBACK_URL") {
        options = options.endpoint(endpoint);
    }
    let feedback = AgentFeedbackLayer::new(options)?;
    let app = Router::new()
        .route("/search", get(|| async { Json::<Value>(json!({"stack":"rust","answer":"rust-result"})) }))
        .route("/docs/test", get(|| async { Html("<!doctype html><html><head><title>Rust docs</title></head><body>rust-docs-result</body></html>") }))
        .route("/health", get(|| async { "ok" }))
        .layer(feedback.clone())
        .layer(middleware::from_fn(authenticate));
    let listener = tokio::net::TcpListener::bind(format!(
        "127.0.0.1:{}",
        env::var("PORT").unwrap_or_else(|_| "4106".into())
    ))
    .await?;
    axum::serve(listener, app).await?;
    feedback.shutdown().await;
    Ok(())
}
