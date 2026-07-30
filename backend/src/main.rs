mod error;
mod models;
mod os_accounts;
mod security;
mod store;

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{Next, from_fn},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{delete, get, patch, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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
    mcp_allowed_origins: Vec<String>,
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

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);
    let public_base_url =
        env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://localhost:{port}"));
    if production {
        let accounts_url = env::var("OS_ACCOUNTS_URL")?;
        let accounts_api_url = env::var("OS_ACCOUNTS_API_URL")?;
        for (name, value) in [
            ("PUBLIC_BASE_URL", public_base_url.as_str()),
            ("OS_ACCOUNTS_URL", accounts_url.as_str()),
            ("OS_ACCOUNTS_API_URL", accounts_api_url.as_str()),
        ] {
            let parsed = reqwest::Url::parse(value)
                .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}"))?;
            anyhow::ensure!(
                parsed.scheme() == "https",
                "{name} must use HTTPS in production"
            );
        }
    }
    let accounts = OsAccountsClient::from_env(&public_base_url)?;
    let database_url =
        env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let mcp_allowed_origins = env::var("MCP_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .chain(std::iter::once(
            public_base_url.trim_end_matches('/').to_owned(),
        ))
        .collect();
    let state = Arc::new(AppState {
        secure_cookies: public_base_url.starts_with("https://"),
        public_base_url,
        pool,
        accounts,
        mcp_allowed_origins,
    });
    spawn_retention_worker(state.pool.clone());

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
            header::HeaderName::from_static("mcp-protocol-version"),
            header::HeaderName::from_static("mcp-method"),
            header::HeaderName::from_static("mcp-name"),
        ]);

    let app = Router::new()
        .route("/", get(root_page))
        .route("/api/health", get(health))
        .route(
            "/.well-known/agent-feedback-v1.json",
            get(feedback_discovery_v2),
        )
        .route("/auth/start", get(auth_start))
        .route("/auth/callback", get(auth_callback))
        .route("/join/{invitation_id}", get(join_team_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/dashboard", get(dashboard_handler))
        .route(
            "/api/dashboard/reports/{report_id}",
            get(dashboard_report_handler).patch(update_feedback_workflow_handler),
        )
        .route(
            "/api/dashboard/interactions/{interaction_id}",
            get(dashboard_interaction_handler),
        )
        .route(
            "/api/dashboard/sessions/{session_id}",
            get(dashboard_session_handler),
        )
        .route("/api/products", post(create_product_handler))
        .route(
            "/api/products/{product_id}",
            patch(rename_product_handler).delete(delete_product_handler),
        )
        .route("/api/team", patch(rename_team_handler))
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
        .route(
            "/api/team/ownership/{os_user_id}",
            post(transfer_team_ownership_handler),
        )
        .route("/api/settings/api-keys", post(create_api_key_handler))
        .route(
            "/api/settings/api-keys/{key_id}",
            delete(revoke_api_key_handler),
        )
        .route(
            "/api/settings/api-keys/{key_id}/rotate",
            post(rotate_api_key_handler),
        )
        .route("/api/settings/policy", post(update_policy_handler))
        .route("/api/v2/telemetry/batches", post(telemetry_batch_handler))
        .route("/api/v2/reports", post(product_feedback_handler))
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

fn spawn_retention_worker(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3_600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            loop {
                match purge_expired_product_data(&pool, 2_000).await {
                    Ok(0) => break,
                    Ok(removed) => tracing::info!(removed, "purged expired product telemetry"),
                    Err(error) => {
                        tracing::warn!(?error, "product telemetry retention pass failed");
                        break;
                    }
                }
            }
        }
    });
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
    let mut html = read_page(page, "Epode").await;
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

async fn feedback_discovery_v2(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "name": "Agent Feedback Protocol",
        "version": 1,
        "purpose": "Collect one structured product feedback report from a customer's independent agent.",
        "feedbackModes": {
            "never_ask": "The agent submits its own assessment autonomously without interrupting the user.",
            "ask_once": "The agent asks once per product and agent runtime, then remembers approval or refusal.",
            "ask_always": "The agent asks before every individual feedback report.",
            "off": "No feedback contract is emitted."
        },
        "telemetry": {
            "url": format!("{}/api/v2/telemetry/batches", state.public_base_url),
            "authentication": "Bearer af_live_... company product key",
            "delivery": "bounded, asynchronous, and non-blocking"
        },
        "feedbackSubmission": {
            "url": format!("{}/api/v2/reports", state.public_base_url),
            "authentication": "Bearer afr2_... short-lived interaction capability",
            "requiredFields": {
                "summary": "concise description of how the product contributed, 8 to 700 characters"
            },
            "optionalFields": ["impact", "confidence", "findings", "workaround"],
            "findingKinds": ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"],
            "findingSeverities": ["minor", "major", "blocking"],
            "consent": {
                "prompt": "May I send the product provider a short feedback report about how this product worked? Your prompt and task content will not be included.",
                "askOnceScope": "per product and agent runtime; no user or agent identity is stored by Epode",
                "askAlwaysScope": "per feedback report",
                "onRefusalOrNoResponse": "do not submit"
            }
        },
        "classification": {
            "http": "unclassified until a feedback report is submitted",
            "mcp": "confirmed immediately by protocol tool use"
        },
        "mcp": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "transport": "stateless Streamable HTTP",
            "discoveryMethod": "server/discover",
            "requiredHeaders": ["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name for named requests"],
            "transportSessions": false,
            "legacyCompatibility": ["2025-11-25"]
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
            "mcp": "protocol-backed explicit feedback tool"
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
    interaction_limit: Option<i64>,
    report_limit: Option<i64>,
    session_limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardDetailQuery {
    product_id: Uuid,
}

async fn dashboard_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) = dashboard_auth(&state, &headers, query.workspace_id).await?;
    let data = dashboard_with_limits(
        &state.pool,
        context,
        query.product_id,
        query.environment_id,
        query.interaction_limit.unwrap_or(250),
        query.report_limit.unwrap_or(250),
        query.session_limit.unwrap_or(100),
    )
    .await?;
    dashboard_response(&state, Json(data), tokens)
}

async fn dashboard_report_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<Uuid>,
    Query(query): Query<DashboardDetailQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let report = dashboard_report_by_id(
        &state.pool,
        context.workspace.id,
        query.product_id,
        report_id,
    )
    .await?;
    dashboard_response(&state, Json(json!({ "report": report })), tokens)
}

async fn update_feedback_workflow_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<Uuid>,
    Json(input): Json<UpdateFeedbackWorkflowInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    update_feedback_workflow(&state.pool, &context, report_id, input).await?;
    dashboard_response(&state, Json(json!({ "updated": true })), tokens)
}

async fn dashboard_interaction_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(interaction_id): Path<Uuid>,
    Query(query): Query<DashboardDetailQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let interaction = dashboard_interaction_by_id(
        &state.pool,
        context.workspace.id,
        query.product_id,
        interaction_id,
    )
    .await?;
    dashboard_response(&state, Json(json!({ "interaction": interaction })), tokens)
}

async fn dashboard_session_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<Uuid>,
    Query(query): Query<DashboardDetailQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let detail = dashboard_session_by_id(
        &state.pool,
        context.workspace.id,
        query.product_id,
        session_id,
    )
    .await?;
    dashboard_response(&state, Json(detail), tokens)
}

async fn create_product_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateProductInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let (product, environment, api_key, secret) =
        create_product_with_default_key(&state.pool, context.workspace.id, input).await?;
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

async fn rename_product_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
    Json(input): Json<UpdateNameInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let product = rename_product(&state.pool, context.workspace.id, product_id, input).await?;
    dashboard_response(&state, Json(json!({ "product": product })), tokens)
}

async fn rename_team_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<UpdateNameInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let workspace = rename_workspace(&state.pool, context.workspace.id, input).await?;
    dashboard_response(&state, Json(json!({ "workspace": workspace })), tokens)
}

async fn delete_product_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
    Json(input): Json<DeleteProductInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let product = delete_product(&state.pool, context.workspace.id, product_id, input).await?;
    dashboard_response(
        &state,
        Json(json!({ "deleted": true, "product": product })),
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
        input.kind,
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

async fn rotate_api_key_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let (api_key, secret, predecessor_expires_at) =
        rotate_api_key(&state.pool, context.workspace.id, key_id).await?;
    dashboard_response(
        &state,
        Json(json!({
            "apiKey": api_key,
            "secret": secret,
            "shownOnce": true,
            "predecessorExpiresAt": predecessor_expires_at
        })),
        tokens,
    )
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

async fn transfer_team_ownership_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    transfer_team_ownership(&state.pool, &context, &os_user_id).await?;
    dashboard_response(&state, Json(json!({ "transferred": true })), tokens)
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

async fn telemetry_batch_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let result = ingest_telemetry_batch(
        &state.pool,
        &auth,
        safe_input::<TelemetryBatchInput>(value)?,
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": result.accepted, "dropped": result.dropped })),
    )
        .into_response())
}

async fn product_feedback_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("afr2_"))
        .ok_or_else(ApiError::unauthorized)?;
    let (interaction, report) = submit_product_feedback(
        &state.pool,
        &capability,
        safe_input::<ProductFeedbackReportInput>(value)?,
    )
    .await?;
    let mut response = Json(json!({
        "accepted": true,
        "interactionId": interaction.id,
        "report": report
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
        "transport": "MCP 2026-07-28 stateless Streamable HTTP / JSON-RPC",
        "endpoint": format!("{}/mcp", state.public_base_url),
        "authentication": "Authorization: Bearer af_read_...",
        "privacy": "Metadata-only. Prompts, transcripts, secrets, personal data, and customer payloads are rejected."
    }))
}

const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
const MCP_PROTOCOL_META: &str = "io.modelcontextprotocol/protocolVersion";
const MCP_CAPABILITIES_META: &str = "io.modelcontextprotocol/clientCapabilities";
const MCP_SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";
const MCP_INSTRUCTIONS: &str = "Inspect product interactions and structured feedback reports. This server is read-only. Never request prompts, transcripts, secrets, personal data, customer data, or raw tool payloads.";

fn mcp_server_info() -> Value {
    json!({ "name": "agent-feedback", "version": "2.0.0" })
}

fn mcp_complete_result(mut value: Value, modern: bool) -> Value {
    if modern {
        value["resultType"] = json!("complete");
        value["_meta"] = json!({ (MCP_SERVER_INFO_META): mcp_server_info() });
    }
    value
}

fn mcp_tool_result(payload: Value, is_error: bool, modern: bool) -> Value {
    let mut value = json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_default() }],
        "structuredContent": payload,
    });
    if is_error {
        value["isError"] = json!(true);
    }
    mcp_complete_result(value, modern)
}

fn mcp_ok(id: Value, result: Value) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}
fn mcp_error(id: Value, code: i32, message: impl Into<String>) -> Json<Value> {
    Json(
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }),
    )
}

fn mcp_error_response(
    id: Value,
    status: StatusCode,
    code: i32,
    message: impl Into<String>,
    data: Option<Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(data) = data {
        error["data"] = data;
    }
    (
        status,
        Json(json!({ "jsonrpc": "2.0", "id": id, "error": error })),
    )
        .into_response()
}

async fn mcp_product_auth(pool: &PgPool, headers: &HeaderMap) -> Result<ProductAuth, ApiError> {
    read_product_auth(pool, headers).await
}

fn mcp_auth_error(id: Value, error: ApiError) -> Response {
    mcp_error_response(id, error.status, -32001, error.message, None)
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

fn validate_modern_mcp_request(headers: &HeaderMap, body: &Value) -> Option<Response> {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = body.get("params").filter(|value| value.is_object());
    let meta = params.and_then(|value| value.get("_meta"));
    let body_version = meta
        .and_then(|value| value.get(MCP_PROTOCOL_META))
        .and_then(Value::as_str);
    let header_version = headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok());
    if body_version.is_none() || header_version != body_version {
        return Some(mcp_error_response(
            id,
            StatusCode::BAD_REQUEST,
            -32020,
            "Required MCP protocol version metadata is missing or mismatched",
            None,
        ));
    }
    if body_version != Some(MCP_PROTOCOL_VERSION) {
        return Some(mcp_error_response(
            id,
            StatusCode::BAD_REQUEST,
            -32022,
            "Unsupported protocol version",
            Some(json!({
                "supported": [MCP_PROTOCOL_VERSION, "2025-11-25"],
                "requested": body_version
            })),
        ));
    }
    if !meta
        .and_then(|value| value.get(MCP_CAPABILITIES_META))
        .is_some_and(Value::is_object)
    {
        return Some(mcp_error_response(
            id,
            StatusCode::BAD_REQUEST,
            -32602,
            "Client capabilities are required in request _meta",
            None,
        ));
    }
    let header_method = headers
        .get("mcp-method")
        .and_then(|value| value.to_str().ok());
    if method.is_empty() || header_method != Some(method) {
        return Some(mcp_error_response(
            id,
            StatusCode::BAD_REQUEST,
            -32020,
            "Required Mcp-Method header is missing or mismatched",
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
            return Some(mcp_error_response(
                id,
                StatusCode::BAD_REQUEST,
                -32020,
                "Required Mcp-Name header is missing, malformed, or mismatched",
                None,
            ));
        }
    }
    None
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        && !state
            .mcp_allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    {
        return mcp_error_response(
            id,
            StatusCode::FORBIDDEN,
            -32000,
            "Origin is not allowed",
            None,
        );
    }
    let header_version = headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok());
    let body_version = body
        .get("params")
        .and_then(|value| value.get("_meta"))
        .and_then(|value| value.get(MCP_PROTOCOL_META))
        .and_then(Value::as_str);
    let requested_version = body_version.or(header_version);
    if requested_version
        .is_some_and(|version| version != MCP_PROTOCOL_VERSION && version != "2025-11-25")
    {
        return mcp_error_response(
            id,
            StatusCode::BAD_REQUEST,
            -32022,
            "Unsupported protocol version",
            Some(json!({
                "supported": [MCP_PROTOCOL_VERSION, "2025-11-25"],
                "requested": requested_version
            })),
        );
    }
    let modern = requested_version == Some(MCP_PROTOCOL_VERSION);
    if modern && let Some(response) = validate_modern_mcp_request(&headers, &body) {
        return response;
    }
    match body.get("method").and_then(Value::as_str) {
        Some("initialize") if !modern => mcp_ok(
            id,
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": mcp_server_info(),
                "instructions": MCP_INSTRUCTIONS
            }),
        )
        .into_response(),
        Some("server/discover") if modern => mcp_ok(
            id,
            json!({
                "resultType": "complete",
                "supportedVersions": [MCP_PROTOCOL_VERSION],
                "capabilities": { "tools": { "listChanged": false } },
                "_meta": { (MCP_SERVER_INFO_META): mcp_server_info() },
                "instructions": MCP_INSTRUCTIONS,
                "ttlMs": 3_600_000,
                "cacheScope": "private"
            }),
        )
        .into_response(),
        Some("tools/list") => {
            let _auth = match mcp_product_auth(&state.pool, &headers).await {
                Ok(auth) => auth,
                Err(error) => return mcp_auth_error(id, error),
            };
            let mut result = json!({ "tools": mcp_tools() });
            if modern {
                result["resultType"] = json!("complete");
                result["_meta"] = json!({ (MCP_SERVER_INFO_META): mcp_server_info() });
                result["ttlMs"] = json!(300_000);
                result["cacheScope"] = json!("private");
            }
            mcp_ok(id, result).into_response()
        }
        Some("notifications/initialized") if !modern => StatusCode::ACCEPTED.into_response(),
        Some("tools/call") => {
            let auth = match mcp_product_auth(&state.pool, &headers).await {
                Ok(auth) => auth,
                Err(error) => return mcp_auth_error(id, error),
            };
            let name = body
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !mcp_tool_allowed(name) {
                return mcp_ok(
                    id,
                    mcp_tool_result(json!({ "error": "Unknown MCP tool" }), true, modern),
                )
                .into_response();
            }
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Err(message) = reject_sensitive_fields(&arguments) {
                return mcp_ok(
                    id,
                    mcp_tool_result(json!({ "error": message }), true, modern),
                )
                .into_response();
            }
            let result = match name {
                "feedback_list_reports" => {
                    match serde_json::from_value::<FeedbackListReportsInput>(arguments) {
                        Ok(input) => feedback_list_reports(&state.pool, &auth, input)
                            .await
                            .map(|response| json!(response)),
                        Err(error) => {
                            Err(ApiError::bad_request(format!("Invalid arguments: {error}")))
                        }
                    }
                }
                "feedback_list_interactions" => {
                    match serde_json::from_value::<FeedbackListInteractionsInput>(arguments) {
                        Ok(input) => feedback_list_interactions(&state.pool, &auth, input)
                            .await
                            .map(|response| json!(response)),
                        Err(error) => {
                            Err(ApiError::bad_request(format!("Invalid arguments: {error}")))
                        }
                    }
                }
                _ => Err(ApiError::not_found("Unknown MCP tool")),
            };
            match result {
                Ok(payload) => mcp_ok(id, mcp_tool_result(payload, false, modern)).into_response(),
                Err(error) => mcp_ok(
                    id,
                    mcp_tool_result(json!({ "error": error.message }), true, modern),
                )
                .into_response(),
            }
        }
        _ if modern => {
            mcp_error_response(id, StatusCode::NOT_FOUND, -32601, "Unknown method", None)
        }
        _ => mcp_error(id, -32601, "Unknown method").into_response(),
    }
}

fn mcp_tool_allowed(name: &str) -> bool {
    matches!(name, "feedback_list_reports" | "feedback_list_interactions")
}

fn mcp_tools() -> Value {
    mcp_read_tools()
}

fn mcp_read_tools() -> Value {
    json!([
        {
            "name": "feedback_list_reports",
            "description": "List rich feedback reports submitted by customer agents, newest first. Reports contain a narrative plus optional impact, findings, workaround, and confidence. Pass summary:true to get aggregate report and finding counts for the whole product — call that first to orient.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "boolean",
                        "default": false,
                        "description": "Return aggregate counts and rates for the product instead of records. All other filters except since are ignored."
                    },
                    "since": {
                        "type": "string",
                        "format": "date-time",
                        "description": "ISO 8601. Track this per client to poll for what is new."
                    },
                    "impact": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"]
                        },
                        "description": "Filter by the agent's optional high-level impact assessment."
                    },
                    "findingKind": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"] }
                    },
                    "severity": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["minor", "major", "blocking"] }
                    },
                    "topic": { "type": "string", "description": "Exact normalized finding topic." },
                    "operation": {
                        "type": "string",
                        "description": "Exact operation name, e.g. a tool or route name."
                    },
                    "customerRef": {
                        "type": "string",
                        "description": "Opaque customer id as supplied by the product. Use to see whether one customer keeps failing."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "default": 25
                    },
                    "cursor": {
                        "type": "string",
                        "description": "Opaque cursor from a previous response's nextCursor."
                    }
                }
            }
        },
        {
            "name": "feedback_list_interactions",
            "description": "List product interactions, newest first, including those with no feedback report. Use reviewed:false to find operations customer agents use but never report on.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "string", "format": "date-time" },
                    "reviewed": {
                        "type": "boolean",
                        "description": "true = only interactions with a feedback report; false = only those without; omit for both."
                    },
                    "operation": { "type": "string" },
                    "customerRef": { "type": "string" },
                    "surface": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["http_json", "http_html", "http_headers", "mcp", "unknown"]
                        }
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "default": 25
                    },
                    "cursor": { "type": "string" }
                }
            }
        }
    ])
}

#[cfg(test)]
mod page_tests {
    use axum::{body::to_bytes, http::StatusCode};

    use super::{ApiError, mcp_auth_error, mcp_tool_allowed, mcp_tools, reveal_auth_error};
    use serde_json::Value;

    #[test]
    fn failed_authentication_message_is_revealed() {
        let html = r#"<p id="auth-error" class="auth-error" hidden>Try again</p>"#;
        let revealed = reveal_auth_error(html.into());
        assert!(revealed.contains(r#"id="auth-error" class="auth-error">Try again"#));
        assert!(!revealed.contains("auth-error\" hidden"));
    }

    fn tool_names() -> Vec<String> {
        mcp_tools()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn mcp_tool_surface_is_read_only() {
        assert_eq!(
            tool_names(),
            ["feedback_list_reports", "feedback_list_interactions"]
        );
        assert!(!mcp_tool_allowed("agent_start_session"));
        assert!(mcp_tool_allowed("feedback_list_reports"));
    }

    #[tokio::test]
    async fn invalid_and_expired_mcp_auth_are_distinct_unauthorized_responses() {
        for message in ["Invalid API key", "API key expired"] {
            let response = mcp_auth_error(
                Value::from(1),
                ApiError::new(StatusCode::UNAUTHORIZED, message),
            );
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                payload.pointer("/error/message"),
                Some(&Value::from(message))
            );
        }
    }
}
