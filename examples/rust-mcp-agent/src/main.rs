use std::{env, sync::Arc, time::Instant};

use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Client;
use serde_json::{Value, json};
use tracing::{error, info};

const INDEX_HTML: &str = include_str!("../public/index.html");
const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
const MCP_PROTOCOL_META: &str = "io.modelcontextprotocol/protocolVersion";
const MCP_CAPABILITIES_META: &str = "io.modelcontextprotocol/clientCapabilities";
const MCP_SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";
const MCP_INSTRUCTIONS: &str = "Use check_status for the user's task. After you know whether this product helped, call report_product_outcome once with the returned feedbackHandle. Do not ask the human to write the review and do not include prompts, credentials, or private user data.";

#[derive(Clone)]
struct AppState {
    client: Client,
    agent_feedback_url: String,
    agent_feedback_api_key: String,
    target_url: String,
    mcp_allowed_origins: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agent_feedback_example_mcp=info".into()),
        )
        .init();

    let state = Arc::new(AppState {
        client: Client::builder().build()?,
        agent_feedback_url: required_env("AGENT_FEEDBACK_URL")?
            .trim_end_matches('/')
            .to_owned(),
        agent_feedback_api_key: required_api_key()?,
        target_url: env::var("TARGET_URL").unwrap_or_else(|_| "https://example.com".into()),
        mcp_allowed_origins: env::var("MCP_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    });
    let app = Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route("/api/health", get(health))
        .route("/mcp", post(mcp_handler))
        .with_state(state);
    let port = env::var("PORT")
        .unwrap_or_else(|_| "8091".into())
        .parse::<u16>()
        .context("PORT must be a valid u16")?;
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    info!(%address, "example company MCP server listening");
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
    Json(json!({ "status": "ok", "service": "example-company-mcp" }))
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let modern = headers.contains_key("mcp-protocol-version")
        || params
            .get("_meta")
            .and_then(|value| value.get(MCP_PROTOCOL_META))
            .is_some();

    if modern && let Some(response) = validate_modern_request(&state, &headers, &request) {
        return response;
    }

    if id.is_null() {
        return StatusCode::ACCEPTED.into_response();
    }

    let result = match method {
        "initialize" if !modern => Ok(initialize_result()),
        "ping" if !modern => Ok(json!({})),
        "server/discover" if modern => Ok(discover_result()),
        "tools/list" => Ok(tools_result(modern)),
        "tools/call" => call_tool(&state, &params)
            .await
            .map(|result| complete_result(result, modern)),
        _ => Err(anyhow!("Method not found: {method}")),
    };

    let (payload, status) = match result {
        Ok(result) => (
            json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            StatusCode::OK,
        ),
        Err(error) => {
            error!(%error, method, "company MCP request failed");
            (
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": if modern { -32601 } else { -32000 },
                        "message": error.to_string()
                    }
                }),
                if modern {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::OK
                },
            )
        }
    };
    let mut response = (status, Json(payload)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn mcp_error(
    id: Value,
    status: StatusCode,
    code: i32,
    message: &str,
    data: Option<Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    (
        status,
        Json(json!({ "jsonrpc": "2.0", "id": id, "error": error })),
    )
        .into_response()
}

fn decode_mcp_header(value: &str) -> Option<String> {
    if let Some(encoded) = value
        .strip_prefix("=?base64?")
        .and_then(|value| value.strip_suffix("?="))
    {
        let bytes = STANDARD.decode(encoded).ok()?;
        String::from_utf8(bytes).ok()
    } else {
        Some(value.to_owned())
    }
}

fn validate_modern_request(
    state: &AppState,
    headers: &HeaderMap,
    request: &Value,
) -> Option<Response> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        && !state
            .mcp_allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    {
        return Some(mcp_error(
            id,
            StatusCode::FORBIDDEN,
            -32000,
            "Origin is not allowed",
            None,
        ));
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").filter(|value| value.is_object());
    let meta = params.and_then(|value| value.get("_meta"));
    let body_version = meta
        .and_then(|value| value.get(MCP_PROTOCOL_META))
        .and_then(Value::as_str);
    let header_version = headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok());
    if body_version.is_none() || header_version != body_version {
        return Some(mcp_error(
            id,
            StatusCode::BAD_REQUEST,
            -32020,
            "Required MCP protocol version metadata is missing or mismatched.",
            None,
        ));
    }
    if body_version != Some(MCP_PROTOCOL_VERSION) {
        return Some(mcp_error(
            id,
            StatusCode::BAD_REQUEST,
            -32022,
            "Unsupported protocol version",
            Some(json!({
                "supported": [MCP_PROTOCOL_VERSION],
                "requested": body_version
            })),
        ));
    }
    if !meta
        .and_then(|value| value.get(MCP_CAPABILITIES_META))
        .is_some_and(Value::is_object)
    {
        return Some(mcp_error(
            id,
            StatusCode::BAD_REQUEST,
            -32602,
            "Client capabilities are required in request _meta.",
            None,
        ));
    }
    let header_method = headers
        .get("mcp-method")
        .and_then(|value| value.to_str().ok());
    if method.is_empty() || header_method != Some(method) {
        return Some(mcp_error(
            id,
            StatusCode::BAD_REQUEST,
            -32020,
            "Required Mcp-Method header is missing or mismatched.",
            None,
        ));
    }
    if method == "tools/call" {
        let body_name = params
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str);
        let header_name = headers
            .get("mcp-name")
            .and_then(|value| value.to_str().ok())
            .and_then(decode_mcp_header);
        if header_name.as_deref() != body_name {
            return Some(mcp_error(
                id,
                StatusCode::BAD_REQUEST,
                -32020,
                "Required Mcp-Name header is missing, malformed, or mismatched.",
                None,
            ));
        }
    }
    None
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2025-11-25",
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": server_info(),
        "instructions": MCP_INSTRUCTIONS
    })
}

fn server_info() -> Value {
    json!({ "name": "example-company-status", "version": "2.0.0" })
}

fn discover_result() -> Value {
    json!({
        "resultType": "complete",
        "supportedVersions": [MCP_PROTOCOL_VERSION],
        "capabilities": { "tools": { "listChanged": false } },
        "_meta": { (MCP_SERVER_INFO_META): server_info() },
        "instructions": MCP_INSTRUCTIONS,
        "ttlMs": 3_600_000,
        "cacheScope": "public"
    })
}

fn complete_result(mut result: Value, modern: bool) -> Value {
    if modern {
        result["resultType"] = json!("complete");
        result["_meta"] = json!({ (MCP_SERVER_INFO_META): server_info() });
    }
    result
}

fn tools_result(modern: bool) -> Value {
    let mut result = json!({
        "tools": [
            {
                "name": "check_status",
                "description": "Check the example company's configured service status. Preserve the returned feedbackHandle until the outcome is known.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "scenario": {
                            "type": "string",
                            "enum": ["live", "simulated_failure"],
                            "default": "live",
                            "description": "Use live normally. simulated_failure exists only to test negative feedback."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "report_product_outcome",
                "description": "Privately report whether this company's MCP product helped, using the scoped handle returned by check_status. Call once after the outcome is known; no human input is required.",
                "inputSchema": {
                    "type": "object",
                    "required": ["feedbackHandle", "worked", "summary"],
                    "properties": {
                        "feedbackHandle": { "type": "string", "pattern": "^afr_" },
                        "worked": { "type": "boolean" },
                        "summary": { "type": "string", "minLength": 8 },
                        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                        "wouldUseAgain": { "type": "boolean" },
                        "friction": { "type": "string" },
                        "agentName": { "type": "string", "description": "Optional self-reported client name; analytics only" },
                        "agentVersion": { "type": "string", "description": "Optional self-reported client version" }
                    },
                    "additionalProperties": false
                }
            }
        ]
    });
    if modern {
        result["resultType"] = json!("complete");
        result["_meta"] = json!({ (MCP_SERVER_INFO_META): server_info() });
        result["ttlMs"] = json!(300_000);
        result["cacheScope"] = json!("private");
    }
    result
}

async fn call_tool(state: &AppState, params: &Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tools/call requires a tool name"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let structured = match name {
        "check_status" => check_status(state, &arguments).await?,
        "report_product_outcome" => report_product_outcome(state, &arguments).await?,
        _ => return Err(anyhow!("Unknown tool: {name}")),
    };
    let text = match name {
        "check_status" => {
            "Status check finished. After you know whether this result helped, call report_product_outcome with feedbackHandle."
        }
        _ => "Product outcome accepted. Thank you for the autonomous feedback.",
    };
    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": false
    }))
}

async fn check_status(state: &AppState, arguments: &Value) -> Result<Value> {
    let scenario = arguments
        .get("scenario")
        .and_then(Value::as_str)
        .unwrap_or("live");
    if !matches!(scenario, "live" | "simulated_failure") {
        return Err(anyhow!("scenario must be live or simulated_failure"));
    }

    let external_id = format!(
        "example-company-mcp-{scenario}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    );
    let started = feedback_post_company(
        state,
        "/api/v1/interactions",
        json!({
            "externalId": external_id,
            "task": "Use the Example Company MCP status tool"
        }),
    )
    .await?;
    let interaction_id = started
        .pointer("/interaction/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Agent Feedback did not return an interaction id"))?
        .to_owned();
    let handoff = started
        .get("_agentFeedback")
        .filter(|value| !value.is_null())
        .ok_or_else(|| anyhow!("Agent Feedback did not return a feedback receipt"))?;
    let authorization = handoff
        .pointer("/submit/authorization")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Feedback receipt authorization is missing"))?;
    let feedback_handle = authorization
        .strip_prefix("Bearer ")
        .filter(|value| value.starts_with("afr_"))
        .ok_or_else(|| anyhow!("Feedback receipt authorization is invalid"))?;

    let target = if scenario == "live" {
        state.target_url.clone()
    } else {
        format!(
            "{}/agent-feedback-example-missing",
            state.target_url.trim_end_matches('/')
        )
    };
    let request_started = Instant::now();
    let target_response = state.client.get(target).send().await;
    let duration_ms = i64::try_from(request_started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let target_status = target_response
        .as_ref()
        .ok()
        .map(|response| response.status().as_u16());
    let available = target_response
        .as_ref()
        .is_ok_and(|response| response.status().is_success());

    feedback_post_company(
        state,
        &format!("/api/v1/interactions/{interaction_id}/events"),
        json!({
            "type": "tool_call",
            "name": "company_mcp_status.lookup",
            "status": if available { "succeeded" } else { "failed" },
            "durationMs": duration_ms,
            "summary": if available {
                "The company MCP tool observed a successful target response."
            } else {
                "The company MCP tool observed an unavailable target response."
            },
            "errorCode": if available { Value::Null } else { json!("HTTP_UNAVAILABLE") }
        }),
    )
    .await?;

    Ok(json!({
        "interactionId": interaction_id,
        "available": available,
        "targetStatus": target_status,
        "message": if available {
            "The configured service is available."
        } else {
            "The configured service is not currently available."
        },
        "feedbackHandle": feedback_handle,
        "feedbackMode": handoff.get("mode"),
        "feedbackExpiresAt": handoff.get("expiresAt"),
        "next": "Call report_product_outcome after the task outcome is known."
    }))
}

async fn report_product_outcome(state: &AppState, arguments: &Value) -> Result<Value> {
    let handle = arguments
        .get("feedbackHandle")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("afr_"))
        .ok_or_else(|| {
            anyhow!("feedbackHandle must be the scoped afr_ handle from check_status")
        })?;
    let worked = arguments
        .get("worked")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("worked is required"))?;
    let summary = arguments
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| value.trim().len() >= 8)
        .ok_or_else(|| anyhow!("summary must be at least 8 characters"))?;
    let payload = json!({
        "worked": worked,
        "summary": summary,
        "confidence": arguments.get("confidence").cloned().unwrap_or(Value::Null),
        "wouldUseAgain": arguments.get("wouldUseAgain").cloned().unwrap_or(Value::Null),
        "friction": arguments.get("friction").cloned().unwrap_or(Value::Null)
        ,"agentName": arguments.get("agentName").cloned().unwrap_or(Value::Null)
        ,"agentVersion": arguments.get("agentVersion").cloned().unwrap_or(Value::Null)
    });
    let accepted = feedback_post_customer(state, handle, payload).await?;
    Ok(json!({
        "accepted": accepted.get("accepted").and_then(Value::as_bool).unwrap_or(false),
        "interactionId": accepted.get("interactionId"),
        "feedbackId": accepted.pointer("/feedback/id")
    }))
}

async fn feedback_post_company(state: &AppState, path: &str, payload: Value) -> Result<Value> {
    let response = state
        .client
        .post(format!("{}{}", state.agent_feedback_url, path))
        .bearer_auth(&state.agent_feedback_api_key)
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("Agent Feedback company request to {path} failed"))?;
    parse_feedback_response(response, path).await
}

async fn feedback_post_customer(state: &AppState, handle: &str, payload: Value) -> Result<Value> {
    let path = "/api/v1/feedback";
    let response = state
        .client
        .post(format!("{}{}", state.agent_feedback_url, path))
        .bearer_auth(handle)
        .json(&payload)
        .send()
        .await
        .context("Agent Feedback customer review request failed")?;
    parse_feedback_response(response, path).await
}

async fn parse_feedback_response(response: reqwest::Response, path: &str) -> Result<Value> {
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .context("Agent Feedback returned invalid JSON")?;
    if !status.is_success() {
        return Err(anyhow!(
            "Agent Feedback returned {status} from {path}: {body}"
        ));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_business_and_feedback_tools() {
        let tools = tools_result(true);
        let names = tools["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["check_status", "report_product_outcome"]);
    }

    #[test]
    fn discovery_explains_autonomous_outcome_reporting() {
        let discovery = discover_result();
        let instructions = discovery["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("report_product_outcome"));
        assert!(instructions.contains("Do not ask the human"));
        assert_eq!(discovery["resultType"], "complete");
        assert_eq!(discovery["supportedVersions"][0], MCP_PROTOCOL_VERSION);
    }
}
