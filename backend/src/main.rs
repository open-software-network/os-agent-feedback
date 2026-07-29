mod error;
mod models;
mod os_accounts;
mod security;
mod store;

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{Next, from_fn},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{delete, get, patch, post},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    error::ApiError,
    models::*,
    os_accounts::{
        ACCESS_COOKIE, OsAccountsClient, PKCE_COOKIE, REFRESH_COOKIE, STATE_COOKIE, TokenPair,
    },
    security::{bearer_token, clear_cookie, cookie, http_only_cookie, reject_sensitive_fields},
    store::*,
};

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    public_base_url: String,
    secure_cookies: bool,
    accounts: OsAccountsClient,
    v1_writes_enabled: bool,
}

const TEAM_INVITE_COOKIE: &str = "af_team_invite";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let production = env::var("RAILWAY_ENVIRONMENT").is_ok()
        || env::var("APP_ENV").as_deref() == Ok("production");
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "agent_feedback=info,tower_http=info".into());
    if production {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let database_url =
        env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);
    let public_base_url =
        env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://localhost:{port}"));
    let accounts = OsAccountsClient::from_env(&public_base_url)?;
    let state = Arc::new(AppState {
        secure_cookies: public_base_url.starts_with("https://"),
        public_base_url,
        pool,
        accounts,
        v1_writes_enabled: env::var("V1_WRITES_ENABLED").as_deref() == Ok("true"),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-api-key"),
            header::HeaderName::from_static("x-workspace-id"),
        ]);

    let app = Router::new()
        .route("/", get(root_page))
        .route("/app", get(legacy_dashboard_redirect))
        .route("/api/health", get(health))
        .route("/.well-known/agent-feedback.json", get(feedback_discovery))
        .route(
            "/.well-known/agent-feedback-v1.json",
            get(feedback_discovery_v2),
        )
        .route("/auth/start", get(auth_start))
        .route("/auth/callback", get(auth_callback))
        .route("/join/{invitation_id}", get(join_team_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/dashboard", get(dashboard_handler))
        .route("/api/products", post(create_product_handler))
        .route(
            "/api/team/invitations",
            post(create_team_invitation_handler),
        )
        .route(
            "/api/team/invitations/{invitation_id}",
            delete(revoke_team_invitation_handler),
        )
        .route(
            "/api/team/members/{os_user_id}",
            patch(update_team_member_handler).delete(remove_team_member_handler),
        )
        .route("/api/settings/api-keys", post(create_api_key_handler))
        .route(
            "/api/settings/api-keys/{key_id}",
            delete(revoke_api_key_handler),
        )
        .route("/api/settings/policy", post(update_policy_handler))
        .route("/api/v2/telemetry/batches", post(telemetry_batch_handler))
        .route("/api/v2/outcomes", post(product_outcome_handler))
        .route("/api/v1/sessions", post(start_session_handler))
        .route("/api/v1/interactions", post(start_session_handler))
        .route(
            "/api/v1/sessions/{session_id}/events",
            post(record_event_handler),
        )
        .route(
            "/api/v1/interactions/{session_id}/events",
            post(record_event_handler),
        )
        .route(
            "/api/v1/sessions/{session_id}/complete",
            post(complete_session_handler),
        )
        .route("/api/v1/feedback", post(customer_agent_feedback_handler))
        .route("/mcp", get(mcp_info).post(mcp_handler))
        .nest_service("/static", ServeDir::new("public"))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(from_fn(security_headers))
        .with_state(state);

    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "agent feedback server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let static_asset = request.uri().path().starts_with("/static/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if static_asset {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=0, must-revalidate"),
        );
    }
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
    response
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler")
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[derive(Deserialize)]
struct RootPageQuery {
    auth: Option<String>,
}

async fn root_page(headers: HeaderMap, Query(query): Query<RootPageQuery>) -> Html<String> {
    let page = if cookie(&headers, ACCESS_COOKIE).is_some()
        || cookie(&headers, REFRESH_COOKIE).is_some()
    {
        "public/app.html"
    } else {
        "public/index.html"
    };
    let mut html = read_page(page, "Agent Feedback").await;
    if page == "public/index.html" && query.auth.as_deref() == Some("failed") {
        html = reveal_auth_error(html);
    }
    Html(html)
}

fn reveal_auth_error(html: String) -> String {
    html.replace(
        "id=\"auth-error\" class=\"auth-error\" hidden",
        "id=\"auth-error\" class=\"auth-error\"",
    )
}

async fn legacy_dashboard_redirect(OriginalUri(uri): OriginalUri) -> Redirect {
    let target = uri
        .query()
        .map(|query| format!("/?{query}"))
        .unwrap_or_else(|| "/".into());
    Redirect::to(&target)
}

async fn read_page(path: &str, fallback: &str) -> String {
    tokio::fs::read_to_string(path)
        .await
        .unwrap_or_else(|_| format!("<!doctype html><title>{fallback}</title><h1>{fallback}</h1>"))
}

async fn health(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(
        json!({ "status": "ok", "service": "agent-feedback", "database": "ok" }),
    ))
}

async fn feedback_discovery(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "name": "Agent Feedback",
        "version": "1",
        "deprecated": true,
        "writesEnabled": state.v1_writes_enabled,
        "replacement": format!("{}/.well-known/agent-feedback-v1.json", state.public_base_url)
    }))
}

async fn feedback_discovery_v2(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "name": "Agent Feedback Protocol",
        "version": 1,
        "purpose": "Collect one compact product-outcome review from a customer's independent agent.",
        "telemetry": {
            "url": format!("{}/api/v2/telemetry/batches", state.public_base_url),
            "authentication": "Bearer af_live_... company product key",
            "delivery": "bounded, asynchronous, and non-blocking"
        },
        "outcomeSubmission": {
            "url": format!("{}/api/v2/outcomes", state.public_base_url),
            "authentication": "Bearer afr2_... short-lived interaction capability",
            "requiredFields": {
                "outcome": ["success", "partial", "failure"],
                "note": "one short sentence, at most 500 characters"
            }
        },
        "classification": {
            "http": "unclassified until an outcome is submitted",
            "mcp": "confirmed immediately by protocol tool use"
        },
        "integrations": {
            "node": format!("{}/static/agent-feedback-node-0.1.0.tgz", state.public_base_url),
            "python": format!("{}/static/agent_feedback-0.1.0-py3-none-any.whl", state.public_base_url),
            "go": format!("{}/static/agent-feedback-go-0.1.0.tar.gz", state.public_base_url),
            "rust": format!("{}/static/agent-feedback-rust-0.1.0.tar.gz", state.public_base_url),
            "protocol": format!("{}/static/agent-feedback-protocol-v1.zip", state.public_base_url)
        },
        "reliability": {
            "http": "best effort for generic agents; deterministic with a feedback-aware runtime",
            "mcp": "protocol-backed explicit outcome tool"
        },
        "identity": "Agent identity is neither required nor claimed. customerRef and runtime hints are optional opaque context.",
        "privacy": "Never submit prompts, transcripts, secrets, credentials, personal data, customer content, or raw tool payloads."
    }))
}

async fn auth_start(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let (verifier, oauth_state, login_url) =
        state.accounts.new_flow().map_err(ApiError::internal)?;
    let mut response = Redirect::to(login_url.as_str()).into_response();
    append_cookie(
        &mut response,
        http_only_cookie(PKCE_COOKIE, &verifier, 600, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        http_only_cookie(STATE_COOKIE, &oauth_state, 600, state.secure_cookies),
    )?;
    Ok(response)
}

#[derive(Deserialize)]
struct AuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

async fn auth_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthCallbackQuery>,
) -> Result<Response, ApiError> {
    let verifier = cookie(&headers, PKCE_COOKIE);
    let expected_state = cookie(&headers, STATE_COOKIE);
    let valid = query.code.is_some()
        && verifier.is_some()
        && expected_state.is_some()
        && query.state == expected_state;
    if !valid {
        return auth_failure(&state);
    }
    let tokens = match state
        .accounts
        .exchange_code(
            query.code.as_deref().unwrap_or_default(),
            verifier.as_deref().unwrap_or_default(),
        )
        .await
    {
        Ok(tokens) => tokens,
        Err(_) => return auth_failure(&state),
    };
    let user = match state.accounts.profile(&tokens.access_token).await {
        Ok(user) => user,
        Err(_) => return auth_failure(&state),
    };
    get_or_create_workspace(&state.pool, &user).await?;
    let invite_id =
        cookie(&headers, TEAM_INVITE_COOKIE).and_then(|value| Uuid::parse_str(&value).ok());
    let redirect = if let Some(invite_id) = invite_id {
        match accept_team_invitation(&state.pool, &user, invite_id).await {
            Ok(workspace_id) => format!("/?view=team&team={workspace_id}"),
            Err(_) => "/?view=team&invite=invalid".into(),
        }
    } else {
        "/".into()
    };
    let mut response = Redirect::to(&redirect).into_response();
    attach_token_cookies(&mut response, &state, &tokens)?;
    clear_flow_cookies(&mut response, &state)?;
    append_cookie(
        &mut response,
        clear_cookie(TEAM_INVITE_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

async fn join_team_handler(
    State(state): State<Arc<AppState>>,
    Path(invitation_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let mut response = Redirect::to("/auth/start").into_response();
    append_cookie(
        &mut response,
        http_only_cookie(
            TEAM_INVITE_COOKIE,
            &invitation_id.to_string(),
            7 * 24 * 60 * 60,
            state.secure_cookies,
        ),
    )?;
    Ok(response)
}

fn auth_failure(state: &AppState) -> Result<Response, ApiError> {
    let mut response = Redirect::to("/?auth=failed").into_response();
    clear_flow_cookies(&mut response, state)?;
    append_cookie(
        &mut response,
        clear_cookie(ACCESS_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        clear_cookie(REFRESH_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

fn append_cookie(response: &mut Response, value: String) -> Result<(), ApiError> {
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).map_err(ApiError::internal)?,
    );
    Ok(())
}

fn attach_token_cookies(
    response: &mut Response,
    state: &AppState,
    tokens: &TokenPair,
) -> Result<(), ApiError> {
    append_cookie(
        response,
        http_only_cookie(
            ACCESS_COOKIE,
            &tokens.access_token,
            900,
            state.secure_cookies,
        ),
    )?;
    append_cookie(
        response,
        http_only_cookie(
            REFRESH_COOKIE,
            &tokens.refresh_token,
            2_592_000,
            state.secure_cookies,
        ),
    )
}

fn clear_flow_cookies(response: &mut Response, state: &AppState) -> Result<(), ApiError> {
    append_cookie(response, clear_cookie(PKCE_COOKIE, state.secure_cookies))?;
    append_cookie(response, clear_cookie(STATE_COOKIE, state.secure_cookies))
}

async fn dashboard_auth(
    state: &AppState,
    headers: &HeaderMap,
    requested_workspace_id: Option<Uuid>,
) -> Result<(DashboardContext, Option<TokenPair>), ApiError> {
    let resolved = state.accounts.resolve(headers).await?;
    let (workspace, role, workspace_memberships) =
        resolve_workspace_access(&state.pool, &resolved.user, requested_workspace_id).await?;
    let display_name = resolved
        .user
        .display_name
        .clone()
        .unwrap_or_else(|| resolved.user.handle.clone());
    let user = CurrentUser {
        id: resolved.user.id,
        handle: resolved.user.handle,
        email: resolved.user.email,
        display_name,
    };
    Ok((
        DashboardContext {
            user,
            workspace,
            role,
            workspace_memberships,
        },
        resolved.rotated_tokens,
    ))
}

fn requested_workspace_id(headers: &HeaderMap) -> Result<Option<Uuid>, ApiError> {
    headers
        .get("x-workspace-id")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::bad_request("Invalid team identifier"))
                .and_then(|value| {
                    Uuid::parse_str(value)
                        .map_err(|_| ApiError::bad_request("Invalid team identifier"))
                })
        })
        .transpose()
}

fn require_workspace_editor(context: &DashboardContext) -> Result<(), ApiError> {
    if context.role == "owner" || context.role == "admin" {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "Your team role does not allow configuration changes",
        ))
    }
}

fn dashboard_response(
    state: &AppState,
    body: impl IntoResponse,
    tokens: Option<TokenPair>,
) -> Result<Response, ApiError> {
    let mut response = body.into_response();
    if let Some(tokens) = tokens {
        attach_token_cookies(&mut response, state, &tokens)?;
    }
    Ok(response)
}

async fn logout_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let refresh = cookie(&headers, REFRESH_COOKIE);
    state.accounts.logout(refresh.as_deref()).await;
    let mut response = Json(json!({ "authenticated": false })).into_response();
    append_cookie(
        &mut response,
        clear_cookie(ACCESS_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        clear_cookie(REFRESH_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardQuery {
    workspace_id: Option<Uuid>,
    product_id: Option<Uuid>,
    // Kept during rollout so old dashboard links continue to resolve.
    environment_id: Option<Uuid>,
}

async fn dashboard_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) = dashboard_auth(&state, &headers, query.workspace_id).await?;
    let data = dashboard(&state.pool, context, query.product_id, query.environment_id).await?;
    dashboard_response(&state, Json(data), tokens)
}

async fn create_product_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateProductInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let (product, environment) = create_product(&state.pool, context.workspace.id, input).await?;
    let (api_key, secret) = create_api_key(
        &state.pool,
        context.workspace.id,
        environment.id,
        Some("Default product key".into()),
        None,
    )
    .await?;
    dashboard_response(
        &state,
        (
            StatusCode::CREATED,
            Json(json!({
                "product": product,
                "environment": environment,
                "apiKey": api_key,
                "secret": secret,
                "shownOnce": true
            })),
        ),
        tokens,
    )
}

async fn create_api_key_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateApiKeyInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let (api_key, secret) = create_api_key(
        &state.pool,
        context.workspace.id,
        input.environment_id,
        input.label,
        input.expires_in_seconds,
    )
    .await?;
    dashboard_response(
        &state,
        (
            StatusCode::CREATED,
            Json(json!({ "apiKey": api_key, "secret": secret, "shownOnce": true })),
        ),
        tokens,
    )
}

async fn revoke_api_key_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    revoke_api_key(&state.pool, context.workspace.id, key_id).await?;
    dashboard_response(&state, Json(json!({ "revoked": true })), tokens)
}

async fn update_policy_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PolicyInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let environment = update_policy(&state.pool, context.workspace.id, input).await?;
    dashboard_response(&state, Json(json!({ "environment": environment })), tokens)
}

async fn create_team_invitation_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateTeamInvitationInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let invitation = create_team_invitation(&state.pool, &context, input).await?;
    let join_path = format!("/join/{}", invitation.id);
    dashboard_response(
        &state,
        (
            StatusCode::CREATED,
            Json(json!({ "invitation": invitation, "joinPath": join_path })),
        ),
        tokens,
    )
}

async fn update_team_member_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
    Json(input): Json<UpdateTeamMemberInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let member = update_team_member_role(&state.pool, &context, &os_user_id, input).await?;
    dashboard_response(&state, Json(json!({ "member": member })), tokens)
}

async fn remove_team_member_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    remove_team_member(&state.pool, &context, &os_user_id).await?;
    dashboard_response(&state, Json(json!({ "removed": true })), tokens)
}

async fn revoke_team_invitation_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(invitation_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    revoke_team_invitation(&state.pool, &context, invitation_id).await?;
    dashboard_response(&state, Json(json!({ "revoked": true })), tokens)
}

fn safe_input<T: DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    reject_sensitive_fields(&value).map_err(ApiError::bad_request)?;
    serde_json::from_value(value)
        .map_err(|error| ApiError::bad_request(format!("Invalid request: {error}")))
}

fn v1_maintenance_response() -> Response {
    let mut response = (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "The prototype write API is in maintenance mode.",
            "replacement": "/.well-known/agent-feedback-v1.json"
        })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("3600"));
    response
}

async fn telemetry_batch_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let accepted = ingest_telemetry_batch(
        &state.pool,
        &auth,
        safe_input::<TelemetryBatchInput>(value)?,
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": accepted, "dropped": 0 })),
    )
        .into_response())
}

async fn product_outcome_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("afr2_"))
        .ok_or_else(ApiError::unauthorized)?;
    let (interaction, review) = submit_product_outcome(
        &state.pool,
        &capability,
        safe_input::<ProductOutcomeInput>(value)?,
    )
    .await?;
    let mut response = Json(json!({
        "accepted": true,
        "interactionId": interaction.id,
        "review": review
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn start_session_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    if !state.v1_writes_enabled {
        return Ok(v1_maintenance_response());
    }
    let workspace = agent_workspace(&state.pool, &headers).await?;
    let (session, receipt) = start_interaction(&state.pool, &workspace, safe_input(value)?).await?;
    let agent_feedback = receipt
        .map(|receipt| feedback_handoff(&state, &workspace, &session, receipt))
        .unwrap_or(Value::Null);
    let mut response = (
        StatusCode::CREATED,
        Json(json!({
            "session": session,
            "interaction": session,
            "_agentFeedback": agent_feedback,
            "collectionPolicy": { "feedbackMode": workspace.feedback_mode, "metadataOnly": true },
            "next": "Attach _agentFeedback to the product response returned to the customer's agent. Never expose the af_live_ company key."
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

fn feedback_handoff(
    state: &AppState,
    workspace: &Workspace,
    session: &AgentSession,
    receipt: IssuedFeedbackReceipt,
) -> Value {
    let instruction = if workspace.feedback_mode == "auto" {
        "After using this product result, submit exactly one outcome review before finishing."
    } else {
        "If you can evaluate this product result, submit one concise outcome review."
    };
    json!({
        "schema": format!("{}/.well-known/agent-feedback.json", state.public_base_url),
        "interactionId": session.id,
        "mode": workspace.feedback_mode,
        "instruction": instruction,
        "submit": {
            "url": format!("{}/api/v1/feedback", state.public_base_url),
            "method": "POST",
            "authorization": format!("Bearer {}", receipt.token),
            "contentType": "application/json"
        },
        "requiredFields": ["worked", "summary"],
        "optionalFields": ["confidence", "wouldUseAgain", "friction", "agentName", "agentVersion"],
        "expiresAt": receipt.expires_at
    })
}

async fn record_event_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    if !state.v1_writes_enabled {
        return Ok(v1_maintenance_response());
    }
    let workspace = agent_workspace(&state.pool, &headers).await?;
    let event = record_event(&state.pool, &workspace, session_id, safe_input(value)?).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "accepted": true, "event": event })),
    )
        .into_response())
}

async fn complete_session_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    if !state.v1_writes_enabled {
        return Ok(v1_maintenance_response());
    }
    let workspace = agent_workspace(&state.pool, &headers).await?;
    let (session, feedback) =
        complete_session(&state.pool, &workspace, session_id, safe_input(value)?).await?;
    Ok(Json(
        json!({ "completed": true, "session": session, "feedbackStored": feedback.is_some(), "feedback": feedback }),
    )
    .into_response())
}

async fn customer_agent_feedback_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    if !state.v1_writes_enabled {
        return Ok(v1_maintenance_response());
    }
    let receipt_token = bearer_token(&headers)
        .filter(|token| token.starts_with("afr_"))
        .ok_or_else(ApiError::unauthorized)?;
    let (session, feedback) = submit_customer_agent_feedback(
        &state.pool,
        &receipt_token,
        safe_input::<CustomerAgentFeedbackInput>(value)?,
    )
    .await?;
    let mut response = Json(json!({
        "accepted": true,
        "interactionId": session.id,
        "feedback": feedback
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn mcp_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "name": "Agent Feedback",
        "transport": "MCP Streamable HTTP / JSON-RPC",
        "endpoint": format!("{}/mcp", state.public_base_url),
        "authentication": "Authorization: Bearer af_live_...",
        "privacy": "Metadata-only. Prompts, transcripts, secrets, personal data, and customer payloads are rejected."
    }))
}

fn mcp_tool_result(payload: Value, is_error: bool) -> Value {
    let mut value = json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_default() }],
        "structuredContent": payload,
    });
    if is_error {
        value["isError"] = json!(true);
    }
    value
}

fn mcp_ok(id: Value, result: Value) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}
fn mcp_error(id: Value, code: i32, message: impl Into<String>) -> Json<Value> {
    Json(
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }),
    )
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    match body.get("method").and_then(Value::as_str) {
        Some("initialize") => mcp_ok(
            id,
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "agent-feedback", "version": "1.0.0" },
                "instructions": "Start a session before the task. Record metadata-only events. Always call agent_complete_session before finishing and include concise outcome feedback. Never send prompts, transcripts, secrets, personal data, customer data, or raw tool payloads."
            }),
        ).into_response(),
        Some("tools/list") => mcp_ok(id, json!({ "tools": mcp_tools() })).into_response(),
        Some("notifications/initialized") => StatusCode::ACCEPTED.into_response(),
        Some("tools/call") => {
            if !state.v1_writes_enabled {
                return v1_maintenance_response();
            }
            let workspace = match agent_workspace(&state.pool, &headers).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    return mcp_ok(id, mcp_tool_result(json!({ "error": error.message }), true)).into_response();
                }
            };
            let name = body
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Err(message) = reject_sensitive_fields(&arguments) {
                return mcp_ok(id, mcp_tool_result(json!({ "error": message }), true)).into_response();
            }
            let result = match name {
                "agent_start_session" => match serde_json::from_value::<StartSessionInput>(arguments) {
                    Ok(input) => start_session(&state.pool, &workspace, input).await.map(|session| json!({ "session": session, "feedbackMode": workspace.feedback_mode })),
                    Err(error) => Err(ApiError::bad_request(format!("Invalid arguments: {error}"))),
                },
                "agent_record_event" => {
                    let session_id = arguments.get("sessionId").and_then(Value::as_str).and_then(|value| Uuid::parse_str(value).ok());
                    let input = serde_json::from_value::<RecordEventInput>(arguments.clone());
                    match (session_id, input) {
                        (Some(session_id), Ok(input)) => record_event(&state.pool, &workspace, session_id, input).await.map(|event| json!({ "accepted": true, "event": event })),
                        _ => Err(ApiError::bad_request("sessionId and valid event fields are required")),
                    }
                },
                "agent_complete_session" => {
                    let session_id = arguments.get("sessionId").and_then(Value::as_str).and_then(|value| Uuid::parse_str(value).ok());
                    let input = serde_json::from_value::<CompleteSessionInput>(arguments.clone());
                    match (session_id, input) {
                        (Some(session_id), Ok(input)) => complete_session(&state.pool, &workspace, session_id, input).await
                            .map(|(session, feedback)| json!({ "completed": true, "session": session, "feedbackStored": feedback.is_some(), "feedback": feedback })),
                        _ => Err(ApiError::bad_request("sessionId and valid completion feedback are required")),
                    }
                },
                _ => Err(ApiError::not_found("Unknown MCP tool")),
            };
            match result {
                Ok(payload) => mcp_ok(id, mcp_tool_result(payload, false)).into_response(),
                Err(error) => mcp_ok(id, mcp_tool_result(json!({ "error": error.message }), true)).into_response(),
            }
        }
        _ => mcp_error(id, -32601, "Unknown method").into_response(),
    }
}

#[cfg(test)]
mod page_tests {
    use super::reveal_auth_error;

    #[test]
    fn failed_authentication_message_is_revealed() {
        let html = r#"<p id="auth-error" class="auth-error" hidden>Try again</p>"#;
        let revealed = reveal_auth_error(html.into());
        assert!(revealed.contains(r#"id="auth-error" class="auth-error">Try again"#));
        assert!(!revealed.contains("auth-error\" hidden"));
    }
}

fn mcp_tools() -> Value {
    json!([
        {
            "name": "agent_start_session",
            "description": "Start a metadata-only trace before doing work for a user. Returns sessionId.",
            "inputSchema": { "type": "object", "properties": {
                "task": { "type": "string", "description": "Short task category or goal; never include the full prompt" },
                "customerRef": { "type": "string", "description": "Optional opaque ID from the company's existing authentication; never send an email or name" },
                "agentName": { "type": "string", "description": "Optional observed agent client name; omit when unknown" },
                "agentVersion": { "type": "string", "description": "Optional observed agent client version" },
                "externalId": { "type": "string", "description": "Optional idempotency key" }
            }, "required": ["task"] }
        },
        {
            "name": "agent_record_event",
            "description": "Record one metadata-only tool or workflow event. Never send raw input/output, prompts, transcripts, secrets, personal data, or customer content.",
            "inputSchema": { "type": "object", "properties": {
                "sessionId": { "type": "string" },
                "type": { "type": "string" },
                "name": { "type": "string" },
                "status": { "type": "string", "enum": ["started", "succeeded", "failed", "info"] },
                "durationMs": { "type": "integer", "minimum": 0 },
                "summary": { "type": "string", "description": "Short outcome metadata only" },
                "errorCode": { "type": "string" }
            }, "required": ["sessionId", "name"] }
        },
        {
            "name": "agent_complete_session",
            "description": "Always call this once when the work ends. Completes the session and atomically stores autonomous outcome feedback so it cannot be forgotten.",
            "inputSchema": { "type": "object", "properties": {
                "sessionId": { "type": "string" },
                "worked": { "type": "boolean" },
                "summary": { "type": "string", "minLength": 8, "description": "Concise outcome review without private data" },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "wouldUseAgain": { "type": "boolean" },
                "friction": { "type": "string" }
            }, "required": ["sessionId", "worked", "summary"] }
        }
    ])
}
