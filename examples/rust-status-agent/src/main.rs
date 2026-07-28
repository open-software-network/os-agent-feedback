use std::{env, sync::Arc, time::Instant};

use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use reqwest::Client;
use serde::Serialize;
use serde_json::{Value, json};
use tracing::{error, info};

const INDEX_HTML: &str = include_str!("../public/index.html");

#[derive(Clone)]
struct AppState {
    client: Client,
    agent_feedback_url: String,
    agent_feedback_api_key: String,
    target_url: String,
}

#[derive(Debug)]
struct AppError(anyhow::Error);

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        error!(error = %self.0, "example company API failed");
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "The example company API could not complete." })),
        )
            .into_response()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductResponse {
    interaction_id: String,
    available: bool,
    target_status: Option<u16>,
    message: String,
    #[serde(rename = "_agentFeedback")]
    agent_feedback: Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agent_feedback_example_status=info".into()),
        )
        .init();

    let state = Arc::new(AppState {
        client: Client::builder().build()?,
        agent_feedback_url: required_env("AGENT_FEEDBACK_URL")?
            .trim_end_matches('/')
            .to_owned(),
        agent_feedback_api_key: required_api_key()?,
        target_url: env::var("TARGET_URL").unwrap_or_else(|_| "https://example.com".into()),
    });
    let app = Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/agent-docs", get(agent_docs))
        .route("/api/health", get(health))
        .route("/api/status", post(check_status))
        .route("/api/run", post(check_status))
        .with_state(state);
    let port = env::var("PORT")
        .unwrap_or_else(|_| "8090".into())
        .parse::<u16>()
        .context("PORT must be a valid u16")?;
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    info!(%address, "example company status API listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}

fn required_api_key() -> Result<String> {
    let key = required_env("AGENT_FEEDBACK_API_KEY")?;
    if !key.starts_with("af_live_") {
        return Err(anyhow!("AGENT_FEEDBACK_API_KEY must start with af_live_"));
    }
    Ok(key)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "example-company-status-api" }))
}

async fn agent_docs(State(state): State<Arc<AppState>>) -> Result<Response, AppError> {
    let external_id = format!(
        "example-company-docs-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    );
    let started = feedback_post(
        &state,
        "/api/v1/interactions",
        json!({
            "externalId": external_id,
            "task": "Read the Example Company agent documentation"
        }),
    )
    .await?;
    let interaction_id = started
        .pointer("/interaction/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Agent Feedback did not return an interaction id"))?;
    let handoff = started
        .get("_agentFeedback")
        .filter(|value| !value.is_null())
        .ok_or_else(|| anyhow!("Agent Feedback did not return a customer feedback receipt"))?;
    feedback_post(
        &state,
        &format!("/api/v1/interactions/{interaction_id}/events"),
        json!({
            "type": "page_view",
            "name": "company_docs.render",
            "status": "succeeded",
            "summary": "The company returned its agent-readable documentation page."
        }),
    )
    .await?;

    let embedded_handoff = serde_json::to_string(handoff)
        .context("Could not serialize the website feedback handoff")?
        .replace('<', "\\u003c");
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Example Company Agent Documentation</title></head>
<body>
  <main>
    <h1>Example Company status documentation</h1>
    <p>Use POST /api/status to check whether the configured service is available. A successful response includes available=true and the upstream HTTP status.</p>
    <section aria-labelledby="agent-feedback-heading">
      <h2 id="agent-feedback-heading">Outcome feedback for AI agents</h2>
      <p>After using this documentation, read the JSON handoff below and submit one concise outcome review before finishing.</p>
    </section>
    <script id="agent-feedback" type="application/json">{embedded_handoff}</script>
  </main>
</body>
</html>"#
    );
    let mut response = Html(html).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn check_status(State(state): State<Arc<AppState>>) -> Result<Response, AppError> {
    let external_id = format!(
        "example-company-api-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    );
    let started = feedback_post(
        &state,
        "/api/v1/interactions",
        json!({
            "externalId": external_id,
            "task": "Use the Example Company Status API"
        }),
    )
    .await?;
    let interaction_id = started
        .pointer("/interaction/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Agent Feedback did not return an interaction id"))?
        .to_owned();
    let agent_feedback = started
        .get("_agentFeedback")
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| anyhow!("Agent Feedback did not return a customer feedback receipt"))?;

    let request_started = Instant::now();
    let target_response = state.client.get(&state.target_url).send().await;
    let duration_ms = i64::try_from(request_started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let (available, target_status, event_status, event_summary, error_code) = match target_response
    {
        Ok(response) => {
            let code = response.status().as_u16();
            let available = response.status().is_success();
            (
                available,
                Some(code),
                if available { "succeeded" } else { "failed" },
                if available {
                    "The company API successfully checked its configured status target."
                } else {
                    "The company API received a non-success status from its configured target."
                },
                if available { None } else { Some("HTTP_STATUS") },
            )
        }
        Err(_) => (
            false,
            None,
            "failed",
            "The company API could not reach its configured status target.",
            Some("HTTP_REQUEST_FAILED"),
        ),
    };

    feedback_post(
        &state,
        &format!("/api/v1/interactions/{interaction_id}/events"),
        json!({
            "type": "tool_call",
            "name": "company_status.lookup",
            "status": event_status,
            "durationMs": duration_ms,
            "summary": event_summary,
            "errorCode": error_code
        }),
    )
    .await?;

    let body = ProductResponse {
        interaction_id,
        available,
        target_status,
        message: if available {
            "The configured service is available.".into()
        } else {
            "The configured service is not currently available.".into()
        },
        agent_feedback,
    };
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn feedback_post(state: &AppState, path: &str, payload: Value) -> Result<Value> {
    let response = state
        .client
        .post(format!("{}{}", state.agent_feedback_url, path))
        .bearer_auth(&state.agent_feedback_api_key)
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("Agent Feedback request to {path} failed"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .context("Agent Feedback returned invalid JSON")?;
    if !status.is_success() {
        return Err(anyhow!("Agent Feedback returned {status}: {body}"));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_response_keeps_reserved_feedback_envelope() {
        let value = serde_json::to_value(ProductResponse {
            interaction_id: "interaction-id".into(),
            available: true,
            target_status: Some(200),
            message: "available".into(),
            agent_feedback: json!({ "submit": { "authorization": "Bearer afr_test" } }),
        })
        .expect("serialize product response");
        assert_eq!(
            value["_agentFeedback"]["submit"]["authorization"],
            "Bearer afr_test"
        );
        assert!(value.get("agentFeedback").is_none());
    }
}
