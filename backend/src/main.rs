mod api_types;
mod error;
mod github;
mod grouping;
mod models;
mod os_accounts;
mod security;
mod store;

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{Next, from_fn},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use utoipa::{
    Modify, OpenApi,
    openapi::security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme},
};
use utoipa_axum::{
    router::{OpenApiRouter, UtoipaMethodRouterExt},
    routes,
};
use uuid::Uuid;

use crate::{
    api_types::{
        ApiKeyCreatedResponse, ApiKeyRotatedResponse, AuthenticationStateResponse,
        ConsentDecisionResponse, DashboardInteractionResponse, DashboardReportResponse,
        EnvironmentResponse, GithubInstallationResponse, GithubInstallationsResponse,
        GithubRepositoriesResponse, GithubRepositoryResponse, McpInfoResponse, OpaqueJsonObject,
        ProductCreatedResponse, ProductDeletedResponse, ProductResponse, RemovedResponse,
        RevokedResponse, TeamInvitationCreatedResponse, TeamMemberResponse, TransferredResponse,
        UpdatedResponse, WorkspaceResponse,
    },
    error::{ApiError, ApiErrorEnvelope},
    github::{GithubAppClient, GithubAppConfig},
    grouping::FingerprintGrouper,
    models::{
        ClassificationDiscovery, ConsentDecisionInput, ConsentStateInput, ConsentStateResponse,
        CreateApiKeyInput, CreateProductInput, CreateTeamInvitationInput, CurrentUser,
        DashboardContext, DashboardData, DashboardSessionDetail, DeleteProductInput,
        FeedbackConsentDiscovery, FeedbackDiscoveryResponse, FeedbackFindingShapeDiscovery,
        FeedbackListInteractionsInput, FeedbackListReportsInput, FeedbackModesDiscovery,
        FeedbackRequiredFieldsDiscovery, FeedbackSubmissionDiscovery,
        FeedbackWorkaroundShapeDiscovery, HealthResponse, IntegrationsDiscovery, McpDiscovery,
        PolicyInput, ProductAuth, ProductFeedbackAcceptedResponse, ProductFeedbackReportInput,
        ReliabilityDiscovery, TelemetryBatchInput, TelemetryBatchResult, TelemetryDiscovery,
        UpdateFeedbackWorkflowInput, UpdateNameInput, UpdateTeamMemberInput,
    },
    os_accounts::{
        ACCESS_COOKIE, OsAccountsClient, PKCE_COOKIE, REFRESH_COOKIE, STATE_COOKIE, TokenPair,
    },
    security::{
        bearer_token, clear_cookie, cookie, http_only_cookie, random_token, reject_sensitive_fields,
    },
    store::{
        GithubInstallationUpsert, accept_team_invitation, agent_product_auth,
        backfill_report_groups, create_api_key, create_product_with_default_key,
        create_team_invitation, dashboard_interaction_by_id, dashboard_report_by_id,
        dashboard_session_by_id, dashboard_with_limits, delete_product, feedback_consent_state,
        feedback_list_interactions, feedback_list_reports, get_or_create_workspace,
        github_installation_workspace, ingest_telemetry_batch, list_github_installations,
        purge_expired_product_data, read_product_auth, record_feedback_consent_decision,
        regroup_report_groups, remove_team_member, rename_product, rename_workspace,
        resolve_workspace_access, revoke_api_key, revoke_github_installation,
        revoke_team_invitation, rotate_api_key, submit_product_feedback, transfer_team_ownership,
        update_feedback_workflow, update_policy, update_team_member_role,
        upsert_github_installation,
    },
};

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    public_base_url: String,
    secure_cookies: bool,
    accounts: OsAccountsClient,
    github: Option<GithubAppClient>,
    mcp_allowed_origins: Vec<String>,
}

const TEAM_INVITE_COOKIE: &str = "af_team_invite";

/// Batches the automatic startup backfill will run before deferring the rest to
/// the next boot or a manual `--backfill-report-groups`. At 500 reports per
/// batch this covers 10k reports, which keeps a cold deploy from stalling
/// behind a large historical table.
const STARTUP_BACKFILL_MAX_BATCHES: u32 = 20;
const GITHUB_STATE_COOKIE: &str = "af_gh_state";
const GITHUB_WORKSPACE_COOKIE: &str = "af_gh_ws";

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Epode Agent Feedback API",
        description = "Structured product feedback collection and workspace management API."
    ),
    modifiers(&SecuritySchemes)
)]
struct ApiDoc;

struct SecuritySchemes;

impl Modify for SecuritySchemes {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi
            .components
            .get_or_insert_with(utoipa::openapi::Components::new);
        components.add_security_scheme(
            "api_key",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "x-api-key",
                "Epode product API key.",
            ))),
        );
        components.add_security_scheme(
            "bearer_auth",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "session_cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                ACCESS_COOKIE,
                "Epode dashboard session cookie.",
            ))),
        );
    }
}

fn build_app_router() -> OpenApiRouter<Arc<AppState>> {
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
    let non_api_routes = Router::new()
        .route("/", get(root_page))
        .nest_service("/static", ServeDir::new("public"));
    let mut api_document = ApiDoc::openapi();
    // Cargo.toml has no license metadata, so omit utoipa's empty license object.
    api_document.info.license = None;

    OpenApiRouter::with_openapi(api_document)
        .merge(non_api_routes.into())
        .routes(routes!(health))
        .routes(routes!(feedback_discovery_v2))
        .routes(routes!(auth_start))
        .routes(routes!(auth_callback))
        .routes(routes!(github_install_handler))
        .routes(routes!(github_callback_handler))
        .routes(routes!(github_webhook_handler).layer(DefaultBodyLimit::max(2 * 1024 * 1024)))
        .routes(routes!(github_installations_handler))
        .routes(routes!(github_repositories_handler))
        .routes(routes!(join_team_handler))
        .routes(routes!(logout_handler))
        .routes(routes!(dashboard_handler))
        .routes(routes!(
            dashboard_report_handler,
            update_feedback_workflow_handler
        ))
        .routes(routes!(dashboard_interaction_handler))
        .routes(routes!(dashboard_session_handler))
        .routes(routes!(create_product_handler))
        .routes(routes!(rename_product_handler, delete_product_handler))
        .routes(routes!(rename_team_handler))
        .routes(routes!(create_team_invitation_handler))
        .routes(routes!(revoke_team_invitation_handler))
        .routes(routes!(
            update_team_member_handler,
            remove_team_member_handler
        ))
        .routes(routes!(transfer_team_ownership_handler))
        .routes(routes!(create_api_key_handler))
        .routes(routes!(revoke_api_key_handler))
        .routes(routes!(rotate_api_key_handler))
        .routes(routes!(update_policy_handler))
        .routes(routes!(telemetry_batch_handler))
        .routes(routes!(consent_state_handler))
        .routes(routes!(consent_decision_handler))
        .routes(routes!(product_feedback_handler))
        .routes(routes!(mcp_info, mcp_handler))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(from_fn(security_headers))
}

pub(crate) fn openapi_spec_json() -> anyhow::Result<String> {
    let (_router, openapi) = build_app_router().split_for_parts();
    Ok(serde_json::to_string_pretty(&openapi)?)
}

#[allow(
    clippy::print_stdout,
    reason = "the OpenAPI CLI mode intentionally emits the generated document to stdout"
)]
fn print_openapi() -> anyhow::Result<()> {
    println!("{}", openapi_spec_json()?);
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let command = env::args().nth(1);
    if command.as_deref() == Some("--print-openapi") {
        print_openapi()?;
        return Ok(());
    }

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
    let database_max_connections = match env::var("DATABASE_MAX_CONNECTIONS") {
        Ok(value) => value
            .parse::<u32>()
            .map_err(|_| anyhow::anyhow!("DATABASE_MAX_CONNECTIONS must be an integer"))?,
        Err(env::VarError::NotPresent) => 10,
        Err(env::VarError::NotUnicode(_)) => {
            anyhow::bail!("DATABASE_MAX_CONNECTIONS must be valid Unicode")
        }
    };
    anyhow::ensure!(
        (1..=100).contains(&database_max_connections),
        "DATABASE_MAX_CONNECTIONS must be between 1 and 100"
    );
    let pool = PgPoolOptions::new()
        .max_connections(database_max_connections)
        .connect(&database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    if command.as_deref() == Some("--backfill-report-groups") {
        let summary = backfill_report_groups(&pool, &FingerprintGrouper, None)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        tracing::info!(
            scanned = summary.scanned,
            grouped = summary.grouped,
            skipped = summary.skipped,
            skipped_findings = summary.skipped_findings,
            exhausted = summary.exhausted,
            "report group backfill completed"
        );
        return Ok(());
    }
    if command.as_deref() == Some("--regroup-report-groups") {
        let summary = regroup_report_groups(&pool, &FingerprintGrouper)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        tracing::info!(
            scanned = summary.scanned,
            moved = summary.moved,
            unchanged = summary.unchanged,
            skipped = summary.skipped,
            skipped_findings = summary.skipped_findings,
            "report group regroup completed"
        );
        return Ok(());
    }

    // Group any reports that predate grouping, so a normal deploy converges
    // without an operator remembering to run the CLI. Bounded: a large table
    // stops at the batch cap and resumes on the next boot (or via the
    // unbounded `--backfill-report-groups`), so boot cannot wedge behind it.
    // Already-grouped reports are excluded by the `group_id IS NULL` filter,
    // which is what makes running this every boot cheap and idempotent.
    match backfill_report_groups(
        &pool,
        &FingerprintGrouper,
        Some(STARTUP_BACKFILL_MAX_BATCHES),
    )
    .await
    {
        Ok(summary) => {
            if summary.scanned > 0 || !summary.exhausted {
                tracing::info!(
                    scanned = summary.scanned,
                    grouped = summary.grouped,
                    skipped = summary.skipped,
                    skipped_findings = summary.skipped_findings,
                    exhausted = summary.exhausted,
                    "startup report group backfill completed"
                );
            }
            if !summary.exhausted {
                tracing::warn!(
                    max_batches = STARTUP_BACKFILL_MAX_BATCHES,
                    "startup report group backfill hit its batch cap; \
                     rerun `--backfill-report-groups` to finish the remainder"
                );
            }
        }
        // Never block startup on grouping: the API is useful without it and the
        // next boot retries.
        Err(error) => tracing::error!(
            error = %error.message,
            "startup report group backfill failed; continuing without it"
        ),
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
    let github = GithubAppConfig::from_env()?.map(GithubAppClient::new);
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
        github,
        mcp_allowed_origins,
    });
    spawn_retention_worker(state.pool.clone());

    let (app, _openapi) = build_app_router().split_for_parts();
    let app = app.with_state(state);

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
        let mut interval = tokio::time::interval(std::time::Duration::from_hours(1));
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
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(?error, "failed to listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(?error, "failed to listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { () = ctrl_c => {}, () = terminate => {} }
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
        html = reveal_auth_error(&html);
    }
    Html(html)
}

fn reveal_auth_error(html: &str) -> String {
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

#[utoipa::path(
    get,
    path = "/api/health",
    tag = "system",
    responses(
        (status = 200, description = "API and database are healthy", body = HealthResponse),
        (status = 500, description = "Database health check failed", body = ApiErrorEnvelope)
    )
)]
async fn health(State(state): State<Arc<AppState>>) -> Result<Json<HealthResponse>, ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(HealthResponse {
        status: "ok".to_owned(),
        service: "agent-feedback".to_owned(),
        database: "ok".to_owned(),
    }))
}

#[utoipa::path(
    get,
    path = "/.well-known/agent-feedback-v1.json",
    tag = "ingest",
    responses(
        (
            status = 200,
            description = "Agent Feedback protocol discovery document",
            body = FeedbackDiscoveryResponse
        )
    )
)]
async fn feedback_discovery_v2(
    State(state): State<Arc<AppState>>,
) -> Json<FeedbackDiscoveryResponse> {
    Json(feedback_discovery(&state.public_base_url))
}

fn feedback_discovery(public_base_url: &str) -> FeedbackDiscoveryResponse {
    FeedbackDiscoveryResponse {
        name: "Agent Feedback Protocol".to_owned(),
        version: 1,
        purpose:
            "Collect one structured product feedback report from a customer's independent agent."
                .to_owned(),
        feedback_modes: FeedbackModesDiscovery {
            never_ask:
                "The agent submits its own assessment autonomously without interrupting the user."
                    .to_owned(),
            ask_once: "Epode remembers approval or refusal per product and opaque customer reference. Unknown customers receive a question-only decision action before any report schema."
                .to_owned(),
            ask_always: "The agent asks before every individual feedback report.".to_owned(),
            off: "No feedback contract is emitted.".to_owned(),
        },
        telemetry: TelemetryDiscovery {
            url: format!("{public_base_url}/api/v2/telemetry/batches"),
            authentication: "Bearer af_live_... company product key".to_owned(),
            delivery: "bounded, asynchronous, and non-blocking".to_owned(),
        },
        feedback_submission: FeedbackSubmissionDiscovery {
            url: format!("{public_base_url}/api/v2/reports"),
            authentication: "Bearer afr2_... short-lived interaction capability".to_owned(),
            consent_state_url: format!("{public_base_url}/api/v2/consent/state"),
            consent_decision_url: format!("{public_base_url}/api/v2/consent/decisions"),
            consent_owner: "Epode; agents never store Ask once decisions".to_owned(),
            required_fields: FeedbackRequiredFieldsDiscovery {
                summary:
                    "concise description of how the product contributed, 8 to 700 characters"
                        .to_owned(),
            },
            optional_fields: ["impact", "confidence", "findings", "workaround"]
                .map(str::to_owned)
                .to_vec(),
            finding_kinds: [
                "strength",
                "friction",
                "defect",
                "gap",
                "suggestion",
                "uncertainty",
                "other",
            ]
            .map(str::to_owned)
            .to_vec(),
            finding_severities: ["minor", "major", "blocking"]
                .map(str::to_owned)
                .to_vec(),
            confidence_range: [0, 1],
            finding_shape: FeedbackFindingShapeDiscovery {
                required: ["kind", "topic", "detail"].map(str::to_owned).to_vec(),
                optional: vec!["severity".to_owned()],
                topic_format: "lowercase_slug".to_owned(),
            },
            workaround_shape: FeedbackWorkaroundShapeDiscovery {
                required: vec!["used".to_owned()],
                optional: vec!["detail".to_owned()],
            },
            consent: FeedbackConsentDiscovery {
                prompt: "May I send the product provider a short feedback report about how this product worked? Your prompt and task content will not be included.".to_owned(),
                ask_once_scope:
                    "per product and opaque customerRef-derived subject; Epode stores only approved or declined"
                        .to_owned(),
                ask_always_scope: "per feedback report".to_owned(),
                on_refusal_or_no_response: "do not submit".to_owned(),
            },
        },
        classification: ClassificationDiscovery {
            http: "unclassified until a feedback report is submitted".to_owned(),
            mcp: "confirmed immediately by protocol tool use".to_owned(),
        },
        mcp: McpDiscovery {
            protocol_version: MCP_PROTOCOL_VERSION.to_owned(),
            transport: "stateless Streamable HTTP".to_owned(),
            discovery_method: "server/discover".to_owned(),
            required_headers: [
                "MCP-Protocol-Version",
                "Mcp-Method",
                "Mcp-Name for named requests",
            ]
            .map(str::to_owned)
            .to_vec(),
            transport_sessions: false,
            legacy_compatibility: vec!["2025-11-25".to_owned()],
        },
        integrations: IntegrationsDiscovery {
            node: format!(
                "{public_base_url}/static/agent-feedback-node-0.1.0.tgz"
            ),
            python: format!(
                "{public_base_url}/static/agent_feedback-0.1.0-py3-none-any.whl"
            ),
            go: format!("{public_base_url}/static/agent-feedback-go-0.1.0.tar.gz"),
            rust: format!(
                "{public_base_url}/static/agent-feedback-rust-0.1.0.tar.gz"
            ),
            protocol: format!(
                "{public_base_url}/static/agent-feedback-protocol-v1.zip"
            ),
        },
        reliability: ReliabilityDiscovery {
            http: "best effort for generic agents; deterministic with a feedback-aware runtime"
                .to_owned(),
            mcp: "protocol-backed explicit feedback tool".to_owned(),
        },
        identity: "Agent identity is neither required nor claimed. customerRef and runtime hints are optional opaque context.".to_owned(),
        privacy: "Never submit prompts, transcripts, secrets, credentials, personal data, customer content, or raw tool payloads.".to_owned(),
    }
}

#[utoipa::path(
    get,
    path = "/auth/start",
    tag = "auth",
    responses(
        (
            status = 303,
            description = "Redirect to OS Accounts to begin authentication",
            headers(
                ("Location" = String, description = "OS Accounts authorization URL"),
                ("Set-Cookie" = String, description = "Short-lived PKCE verifier and OAuth state cookies")
            )
        ),
        (status = 500, description = "Authentication flow setup failed", body = ApiErrorEnvelope)
    )
)]
async fn auth_start(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let (verifier, oauth_state, login_url) =
        state.accounts.new_flow().map_err(ApiError::internal)?;
    let mut response = Redirect::to(login_url.as_str()).into_response();
    append_cookie(
        &mut response,
        &http_only_cookie(PKCE_COOKIE, &verifier, 600, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &http_only_cookie(STATE_COOKIE, &oauth_state, 600, state.secure_cookies),
    )?;
    Ok(response)
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct AuthCallbackQuery {
    /// Authorization code returned by OS Accounts.
    code: Option<String>,
    /// OAuth state returned by OS Accounts.
    state: Option<String>,
}

#[utoipa::path(
    get,
    path = "/auth/callback",
    tag = "auth",
    params(AuthCallbackQuery),
    responses(
        (
            status = 303,
            description = "Authentication completed or failed; redirect to the dashboard or login page",
            headers(
                ("Location" = String, description = "Dashboard or authentication-failure URL"),
                ("Set-Cookie" = String, description = "Dashboard session cookies and cleared OAuth flow cookies")
            )
        ),
        (status = 500, description = "Authentication callback processing failed", body = ApiErrorEnvelope)
    )
)]
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
    let Ok(tokens) = state
        .accounts
        .exchange_code(
            query.code.as_deref().unwrap_or_default(),
            verifier.as_deref().unwrap_or_default(),
        )
        .await
    else {
        return auth_failure(&state);
    };
    let Ok(user) = state.accounts.profile(&tokens.access_token).await else {
        return auth_failure(&state);
    };
    get_or_create_workspace(&state.pool, &user).await?;
    let invite_id =
        cookie(&headers, TEAM_INVITE_COOKIE).and_then(|value| Uuid::parse_str(&value).ok());
    let redirect = match invite_id {
        Some(invite_id) => accept_team_invitation(&state.pool, &user, invite_id)
            .await
            .map_or_else(
                |_| "/?view=team&invite=invalid".into(),
                |workspace_id| format!("/?view=team&team={workspace_id}"),
            ),
        None => "/".into(),
    };
    let mut response = Redirect::to(&redirect).into_response();
    attach_token_cookies(&mut response, &state, &tokens)?;
    clear_flow_cookies(&mut response, &state)?;
    append_cookie(
        &mut response,
        &clear_cookie(TEAM_INVITE_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/api/github/install",
    tag = "github",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (
            status = 303,
            description = "Redirect to GitHub to install the Epode GitHub App",
            body = String,
            content_type = "text/plain",
            headers(
                ("Location" = String, description = "GitHub App installation URL"),
                ("Set-Cookie" = String, description = "Short-lived GitHub installation state and team cookies")
            )
        ),
        (status = 400, description = "Invalid team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "GitHub installation flow could not be started", body = ApiErrorEnvelope),
        (status = 503, description = "GitHub App integration is not configured", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn github_install_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let github = require_github(&state)?;
    let github_state = random_token("");
    let mut response = dashboard_response(
        &state,
        Redirect::to(&github.install_url(&github_state)),
        tokens,
    )?;
    append_cookie(
        &mut response,
        &http_only_cookie(
            GITHUB_STATE_COOKIE,
            &github_state,
            600,
            state.secure_cookies,
        ),
    )?;
    append_cookie(
        &mut response,
        &http_only_cookie(
            GITHUB_WORKSPACE_COOKIE,
            &context.workspace.id.to_string(),
            600,
            state.secure_cookies,
        ),
    )?;
    Ok(response)
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct GithubCallbackQuery {
    /// GitHub installation identifier created or updated by the setup flow.
    installation_id: Option<i64>,
    /// GitHub's setup action, such as `install` or `update`.
    setup_action: Option<String>,
    /// Opaque state nonce supplied when the setup flow began.
    state: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/github/callback",
    tag = "github",
    params(GithubCallbackQuery),
    responses(
        (
            status = 303,
            description = "Redirect to the connectors dashboard with github=connected, github=conflict, or github=error",
            body = String,
            content_type = "text/plain",
            headers(
                ("Location" = String, description = "Connectors dashboard result URL"),
                ("Set-Cookie" = String, description = "Cleared GitHub installation flow cookies")
            )
        ),
        (status = 400, description = "Malformed GitHub callback query", body = String, content_type = "text/plain"),
        (status = 503, description = "GitHub App integration is not configured", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn github_callback_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<GithubCallbackQuery>,
) -> Response {
    let Some(github) = state.github.as_ref() else {
        let mut response = ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub App integration is not configured",
        )
        .into_response();
        clear_github_flow_cookies(&mut response, &state);
        return response;
    };
    let GithubCallbackQuery {
        installation_id,
        setup_action,
        state: returned_state,
    } = query;
    let _setup_action = setup_action.as_deref();
    let expected_state = cookie(&headers, GITHUB_STATE_COOKIE);
    let Some(cookie_workspace_id) =
        cookie(&headers, GITHUB_WORKSPACE_COOKIE).and_then(|value| Uuid::parse_str(&value).ok())
    else {
        return github_callback_redirect(&state, "error");
    };
    let Ok((context, tokens)) = dashboard_auth(&state, &headers, Some(cookie_workspace_id)).await
    else {
        return github_callback_redirect(&state, "error");
    };
    if require_workspace_editor(&context).is_err() {
        return github_callback_redirect_with_tokens(&state, "error", tokens);
    }

    let valid_state = expected_state
        .as_deref()
        .is_some_and(|expected| returned_state.as_deref() == Some(expected));
    let Some(installation_id) = installation_id else {
        return github_callback_redirect_with_tokens(&state, "error", tokens);
    };
    if !valid_state {
        return github_callback_redirect_with_tokens(&state, "error", tokens);
    }

    let Ok(account) = github.installation(installation_id).await else {
        tracing::warn!(
            installation_id,
            "GitHub installation lookup failed during callback"
        );
        return github_callback_redirect_with_tokens(&state, "error", tokens);
    };
    let result = upsert_github_installation(
        &state.pool,
        context.workspace.id,
        installation_id,
        &account.login,
        &account.account_type,
    )
    .await;
    let outcome = match result {
        Ok(GithubInstallationUpsert::Bound) => "connected",
        Ok(GithubInstallationUpsert::ConflictingWorkspace) => "conflict",
        Err(_) => {
            tracing::warn!(
                installation_id,
                workspace_id = %context.workspace.id,
                "GitHub installation binding failed during callback"
            );
            "error"
        }
    };
    github_callback_redirect_with_tokens(&state, outcome, tokens)
}

#[derive(Debug, Deserialize)]
struct GithubWebhookPayload {
    action: Option<String>,
    installation: Option<GithubWebhookInstallation>,
}

#[derive(Debug, Deserialize)]
struct GithubWebhookInstallation {
    id: i64,
    account: Option<GithubWebhookAccount>,
}

#[derive(Debug, Deserialize)]
struct GithubWebhookAccount {
    login: String,
    #[serde(rename = "type")]
    account_type: String,
}

#[utoipa::path(
    post,
    path = "/api/github/webhook",
    tag = "github",
    params(
        ("X-Hub-Signature-256" = String, Header, description = "HMAC-SHA256 signature of the raw request body"),
        ("X-GitHub-Event" = String, Header, description = "GitHub webhook event name")
    ),
    request_body(content = String, content_type = "application/json", description = "Raw GitHub webhook event payload"),
    responses(
        (status = 200, description = "Signed webhook accepted", body = String, content_type = "text/plain"),
        (status = 400, description = "Signed webhook payload could not be parsed", body = ApiErrorEnvelope),
        (status = 401, description = "Webhook signature is missing or invalid", body = ApiErrorEnvelope),
        (status = 413, description = "Webhook body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 500, description = "Webhook could not be persisted; GitHub should redeliver", body = ApiErrorEnvelope),
        (status = 503, description = "GitHub App integration is not configured", body = ApiErrorEnvelope)
    ),
    description = "Receives signed GitHub App events. Persistence failures answer \
        500 so GitHub redelivers; an unparseable payload answers 400; unhandled \
        or non-actionable events answer 200."
)]
async fn github_webhook_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, &'static str), ApiError> {
    let github = require_github(&state)?;
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !github.verify_webhook_signature(&body, signature) {
        tracing::warn!("rejected GitHub webhook with invalid signature");
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid GitHub webhook signature",
        ));
    }

    if headers
        .get("x-github-event")
        .and_then(|value| value.to_str().ok())
        == Some("installation")
    {
        // The signature already passed, so a body that will not deserialize is
        // upstream schema drift or a garbled delivery rather than an attack.
        // Answer 400 so it shows up in GitHub's delivery log instead of being
        // silently accepted; a retry of the same bytes fails identically, so
        // this stays 4xx rather than joining the retryable 5xx path.
        let Ok(payload) = serde_json::from_slice::<GithubWebhookPayload>(&body) else {
            tracing::warn!("rejected malformed signed GitHub installation webhook");
            return Err(ApiError::bad_request(
                "Malformed GitHub installation webhook payload",
            ));
        };
        handle_github_installation_webhook(&state, payload).await?;
    }
    Ok((StatusCode::OK, "ok"))
}

/// Applies an `installation` event.
///
/// Persistence failures propagate so the webhook answers 5xx and GitHub
/// redelivers. Everything else — an unknown installation, a missing account, a
/// conflicting workspace, an action we do not act on — is a terminal no-op that
/// returns `Ok`, because redelivering those would fail identically forever.
async fn handle_github_installation_webhook(
    state: &AppState,
    payload: GithubWebhookPayload,
) -> Result<(), ApiError> {
    let Some(installation) = payload.installation else {
        return Ok(());
    };
    match payload.action.as_deref() {
        Some("deleted" | "suspend") => {
            revoke_github_installation(&state.pool, installation.id)
                .await
                .inspect_err(|_| {
                    tracing::warn!(
                        installation_id = installation.id,
                        "failed to revoke GitHub installation from webhook"
                    );
                })?;
        }
        Some("created" | "unsuspend") => {
            let workspace_id = github_installation_workspace(&state.pool, installation.id)
                .await
                .inspect_err(|_| {
                    tracing::warn!(
                        installation_id = installation.id,
                        "failed to look up GitHub installation workspace from webhook"
                    );
                })?;
            let (Some(workspace_id), Some(account)) = (workspace_id, installation.account) else {
                return Ok(());
            };
            match upsert_github_installation(
                &state.pool,
                workspace_id,
                installation.id,
                &account.login,
                &account.account_type,
            )
            .await
            {
                Ok(GithubInstallationUpsert::Bound) => {}
                Ok(GithubInstallationUpsert::ConflictingWorkspace) => tracing::warn!(
                    installation_id = installation.id,
                    "ignored conflicting GitHub installation restore from webhook"
                ),
                Err(error) => {
                    tracing::warn!(
                        installation_id = installation.id,
                        "failed to restore GitHub installation from webhook"
                    );
                    return Err(error);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/github/installations",
    tag = "github",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "GitHub App configuration and active installations", body = GithubInstallationsResponse),
        (status = 400, description = "Invalid team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "GitHub installations could not be listed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn github_installations_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let configured = state.github.is_some();
    let installations = if configured {
        list_github_installations(&state.pool, context.workspace.id)
            .await?
            .into_iter()
            .map(|installation| GithubInstallationResponse {
                id: installation.id,
                installation_id: installation.installation_id,
                account_login: installation.account_login,
                account_type: installation.account_type,
                created_at: installation.created_at,
            })
            .collect()
    } else {
        Vec::new()
    };
    dashboard_response(
        &state,
        Json(GithubInstallationsResponse {
            configured,
            installations,
        }),
        tokens,
    )
}

#[utoipa::path(
    get,
    path = "/api/github/installations/{installation_id}/repositories",
    tag = "github",
    params(
        ("installation_id" = i64, Path, description = "GitHub installation identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Repositories visible to the GitHub installation", body = GithubRepositoriesResponse),
        (
            status = 400,
            description = "Invalid path or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Active GitHub installation not found for this team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "GitHub repositories could not be listed", body = ApiErrorEnvelope),
        (status = 503, description = "GitHub App integration is not configured", body = ApiErrorEnvelope)
    ),
    description = "Lists repositories reachable by the installation. The listing \
        is capped at 1000 repositories; when the cap is reached `truncated` is \
        true and the response is a partial view.",
    security(("session_cookie" = []))
)]
async fn github_repositories_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(installation_id): Path<i64>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let github = require_github(&state)?;
    let active_installations = list_github_installations(&state.pool, context.workspace.id).await?;
    if !active_installations
        .iter()
        .any(|installation| installation.installation_id == installation_id)
    {
        return Err(ApiError::not_found(
            "GitHub installation not found for this team",
        ));
    }
    let page = github
        .installation_repositories(installation_id)
        .await
        .map_err(ApiError::internal)?;
    let truncated = page.truncated;
    let repositories = page
        .repositories
        .into_iter()
        .map(|repository| GithubRepositoryResponse {
            full_name: repository.full_name,
            default_branch: repository.default_branch,
            private: repository.private,
        })
        .collect();
    dashboard_response(
        &state,
        Json(GithubRepositoriesResponse {
            installation_id,
            repositories,
            truncated,
        }),
        tokens,
    )
}

fn require_github(state: &AppState) -> Result<&GithubAppClient, ApiError> {
    state.github.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub App integration is not configured",
        )
    })
}

fn github_callback_redirect_target(public_base_url: &str, result: &str) -> String {
    format!(
        "{}/?view=connectors&github={result}",
        public_base_url.trim_end_matches('/')
    )
}

fn github_callback_redirect(state: &AppState, result: &str) -> Response {
    let location = github_callback_redirect_target(&state.public_base_url, result);
    let mut response = Redirect::to(&location).into_response();
    clear_github_flow_cookies(&mut response, state);
    response
}

fn github_callback_redirect_with_tokens(
    state: &AppState,
    result: &str,
    tokens: Option<TokenPair>,
) -> Response {
    dashboard_response(state, github_callback_redirect(state, result), tokens).map_or_else(
        |_| github_callback_redirect(state, "error"),
        std::convert::identity,
    )
}

fn clear_github_flow_cookies(response: &mut Response, state: &AppState) {
    for value in [
        clear_cookie(GITHUB_STATE_COOKIE, state.secure_cookies),
        clear_cookie(GITHUB_WORKSPACE_COOKIE, state.secure_cookies),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
}

#[utoipa::path(
    get,
    path = "/join/{invitation_id}",
    tag = "auth",
    params(
        ("invitation_id" = Uuid, Path, description = "Team invitation identifier")
    ),
    responses(
        (
            status = 303,
            description = "Remember the invitation and redirect to authentication",
            headers(
                ("Location" = String, description = "Authentication start URL"),
                ("Set-Cookie" = String, description = "Short-lived team invitation cookie")
            )
        ),
        (status = 400, description = "Invitation identifier is not a UUID", body = String, content_type = "text/plain"),
        (status = 500, description = "Invitation redirect setup failed", body = ApiErrorEnvelope)
    )
)]
async fn join_team_handler(
    State(state): State<Arc<AppState>>,
    Path(invitation_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let mut response = Redirect::to("/auth/start").into_response();
    append_cookie(
        &mut response,
        &http_only_cookie(
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
        &clear_cookie(ACCESS_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &clear_cookie(REFRESH_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

fn append_cookie(response: &mut Response, value: &str) -> Result<(), ApiError> {
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(value).map_err(ApiError::internal)?,
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
        &http_only_cookie(
            ACCESS_COOKIE,
            &tokens.access_token,
            900,
            state.secure_cookies,
        ),
    )?;
    append_cookie(
        response,
        &http_only_cookie(
            REFRESH_COOKIE,
            &tokens.refresh_token,
            2_592_000,
            state.secure_cookies,
        ),
    )
}

fn clear_flow_cookies(response: &mut Response, state: &AppState) -> Result<(), ApiError> {
    append_cookie(response, &clear_cookie(PKCE_COOKIE, state.secure_cookies))?;
    append_cookie(response, &clear_cookie(STATE_COOKIE, state.secure_cookies))
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

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "auth",
    responses(
        (
            status = 200,
            description = "Dashboard session cleared",
            body = AuthenticationStateResponse,
            headers(
                ("Set-Cookie" = String, description = "Cleared dashboard session cookies")
            )
        ),
        (status = 500, description = "Session cookie cleanup failed", body = ApiErrorEnvelope)
    )
)]
async fn logout_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let refresh = cookie(&headers, REFRESH_COOKIE);
    state.accounts.logout(refresh.as_deref()).await;
    let mut response = Json(AuthenticationStateResponse {
        authenticated: false,
    })
    .into_response();
    append_cookie(
        &mut response,
        &clear_cookie(ACCESS_COOKIE, state.secure_cookies),
    )?;
    append_cookie(
        &mut response,
        &clear_cookie(REFRESH_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardQuery {
    /// Team to open. Defaults to the caller's personal team.
    workspace_id: Option<Uuid>,
    /// Product to select. Defaults to the first product.
    product_id: Option<Uuid>,
    // Kept during rollout so old dashboard links continue to resolve.
    /// Legacy environment selection used by existing dashboard links.
    environment_id: Option<Uuid>,
    /// Maximum interactions returned.
    #[param(default = 250)]
    interaction_limit: Option<i64>,
    /// Maximum feedback reports returned.
    #[param(default = 250)]
    report_limit: Option<i64>,
    /// Maximum sessions returned.
    #[param(default = 100)]
    session_limit: Option<i64>,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardDetailQuery {
    /// Product that owns the requested dashboard record.
    product_id: Uuid,
}

#[utoipa::path(
    get,
    path = "/api/dashboard",
    tag = "dashboard",
    params(DashboardQuery),
    responses(
        (status = 200, description = "Dashboard state", body = DashboardData),
        (status = 400, description = "Malformed dashboard query parameters", body = String, content_type = "text/plain"),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Dashboard state could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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

#[utoipa::path(
    get,
    path = "/api/dashboard/reports/{report_id}",
    tag = "dashboard",
    params(
        ("report_id" = Uuid, Path, description = "Feedback report identifier"),
        DashboardDetailQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Feedback report with interaction and workflow context", body = DashboardReportResponse),
        (
            status = 400,
            description = "Invalid path, query, or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Feedback report not found for the product", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Feedback report could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
    dashboard_response(&state, Json(DashboardReportResponse { report }), tokens)
}

#[utoipa::path(
    patch,
    path = "/api/dashboard/reports/{report_id}",
    tag = "dashboard",
    params(
        ("report_id" = Uuid, Path, description = "Feedback report identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    request_body = UpdateFeedbackWorkflowInput,
    responses(
        (status = 200, description = "Feedback workflow updated", body = UpdatedResponse),
        (
            status = 400,
            description = "Invalid path, team header, workflow update, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot edit the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Feedback report not found for the product", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the workflow update schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Feedback workflow could not be updated", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
    dashboard_response(&state, Json(UpdatedResponse { updated: true }), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/interactions/{interaction_id}",
    tag = "dashboard",
    params(
        ("interaction_id" = Uuid, Path, description = "Interaction identifier"),
        DashboardDetailQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Product interaction", body = DashboardInteractionResponse),
        (
            status = 400,
            description = "Invalid path, query, or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Interaction not found for the product", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Interaction could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
    dashboard_response(
        &state,
        Json(DashboardInteractionResponse { interaction }),
        tokens,
    )
}

#[utoipa::path(
    get,
    path = "/api/dashboard/sessions/{session_id}",
    tag = "dashboard",
    params(
        ("session_id" = Uuid, Path, description = "Session identifier"),
        DashboardDetailQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Session with its interactions and feedback reports", body = DashboardSessionDetail),
        (
            status = 400,
            description = "Invalid path, query, or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Session not found for the product", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Session could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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

#[utoipa::path(
    post,
    path = "/api/products",
    tag = "products",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = CreateProductInput,
    responses(
        (status = 201, description = "Product, default environment, and one-time API key secret created", body = ProductCreatedResponse),
        (
            status = 400,
            description = "Invalid team header, product data, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Team not found", body = ApiErrorEnvelope),
        (status = 409, description = "Product name conflicts or the team product limit was reached", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the product schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Product could not be created", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
            Json(ProductCreatedResponse {
                product,
                environment,
                api_key,
                secret,
                shown_once: true,
            }),
        ),
        tokens,
    )
}

#[utoipa::path(
    patch,
    path = "/api/products/{product_id}",
    tag = "products",
    params(
        ("product_id" = Uuid, Path, description = "Product identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = UpdateNameInput,
    responses(
        (status = 200, description = "Renamed product", body = ProductResponse),
        (
            status = 400,
            description = "Invalid path, team header, product name, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found", body = ApiErrorEnvelope),
        (status = 409, description = "A product with this name already exists", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the product update schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Product could not be renamed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
    dashboard_response(&state, Json(ProductResponse { product }), tokens)
}

#[utoipa::path(
    patch,
    path = "/api/team",
    tag = "team",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = UpdateNameInput,
    responses(
        (status = 200, description = "Renamed team", body = WorkspaceResponse),
        (
            status = 400,
            description = "Invalid team header, team name, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Team not found", body = ApiErrorEnvelope),
        (status = 409, description = "A team with this name already exists", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the team update schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Team could not be renamed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn rename_team_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<UpdateNameInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let workspace = rename_workspace(&state.pool, context.workspace.id, input).await?;
    dashboard_response(&state, Json(WorkspaceResponse { workspace }), tokens)
}

#[utoipa::path(
    delete,
    path = "/api/products/{product_id}",
    tag = "products",
    params(
        ("product_id" = Uuid, Path, description = "Product identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = DeleteProductInput,
    responses(
        (status = 200, description = "Deleted product", body = ProductDeletedResponse),
        (
            status = 400,
            description = "Invalid path, team header, confirmation, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the product deletion schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Product could not be deleted", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
        Json(ProductDeletedResponse {
            deleted: true,
            product,
        }),
        tokens,
    )
}

#[utoipa::path(
    post,
    path = "/api/settings/api-keys",
    tag = "settings",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = CreateApiKeyInput,
    responses(
        (status = 201, description = "API key and one-time secret created", body = ApiKeyCreatedResponse),
        (
            status = 400,
            description = "Invalid team header, API key configuration, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product environment not found", body = ApiErrorEnvelope),
        (status = 409, description = "Environment already has the maximum number of active keys", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the API key schema", body = String, content_type = "text/plain"),
        (status = 500, description = "API key could not be created", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
            Json(ApiKeyCreatedResponse {
                api_key,
                secret,
                shown_once: true,
            }),
        ),
        tokens,
    )
}

#[utoipa::path(
    delete,
    path = "/api/settings/api-keys/{key_id}",
    tag = "settings",
    params(
        ("key_id" = Uuid, Path, description = "API key identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "API key revoked", body = RevokedResponse),
        (
            status = 400,
            description = "Invalid key identifier or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Active API key not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "API key could not be revoked", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn revoke_api_key_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    revoke_api_key(&state.pool, context.workspace.id, key_id).await?;
    dashboard_response(&state, Json(RevokedResponse { revoked: true }), tokens)
}

#[utoipa::path(
    post,
    path = "/api/settings/api-keys/{key_id}/rotate",
    tag = "settings",
    params(
        ("key_id" = Uuid, Path, description = "API key identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Successor API key and one-time secret created", body = ApiKeyRotatedResponse),
        (
            status = 400,
            description = "Invalid key identifier or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Active API key not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "API key could not be rotated", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
        Json(ApiKeyRotatedResponse {
            api_key,
            secret,
            shown_once: true,
            predecessor_expires_at,
        }),
        tokens,
    )
}

#[utoipa::path(
    post,
    path = "/api/settings/policy",
    tag = "settings",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = PolicyInput,
    responses(
        (status = 200, description = "Updated product environment policy", body = EnvironmentResponse),
        (
            status = 400,
            description = "Invalid team header, policy values, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product environment not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the policy schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Policy could not be updated", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn update_policy_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PolicyInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let environment = update_policy(&state.pool, context.workspace.id, input).await?;
    dashboard_response(&state, Json(EnvironmentResponse { environment }), tokens)
}

#[utoipa::path(
    post,
    path = "/api/team/invitations",
    tag = "team",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = CreateTeamInvitationInput,
    responses(
        (status = 201, description = "Team invitation created", body = TeamInvitationCreatedResponse),
        (
            status = 400,
            description = "Invalid team header, invitation values, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot invite this role to the requested team", body = ApiErrorEnvelope),
        (status = 409, description = "Invitee is already a member or has an active invitation", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the invitation schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Invitation could not be created", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
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
            Json(TeamInvitationCreatedResponse {
                invitation,
                join_path,
            }),
        ),
        tokens,
    )
}

#[utoipa::path(
    patch,
    path = "/api/team/members/{os_user_id}",
    tag = "team",
    params(
        ("os_user_id" = String, Path, description = "OS Accounts user identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = UpdateTeamMemberInput,
    responses(
        (status = 200, description = "Updated team member", body = TeamMemberResponse),
        (
            status = 400,
            description = "Invalid team header, member role, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot change this member's role", body = ApiErrorEnvelope),
        (status = 404, description = "Team member not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the member update schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Team member could not be updated", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn update_team_member_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
    Json(input): Json<UpdateTeamMemberInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let member = update_team_member_role(&state.pool, &context, &os_user_id, input).await?;
    dashboard_response(&state, Json(TeamMemberResponse { member }), tokens)
}

#[utoipa::path(
    delete,
    path = "/api/team/members/{os_user_id}",
    tag = "team",
    params(
        ("os_user_id" = String, Path, description = "OS Accounts user identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Team member removed", body = RemovedResponse),
        (status = 400, description = "Invalid team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot remove this team member", body = ApiErrorEnvelope),
        (status = 404, description = "Team member not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Team member could not be removed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn remove_team_member_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    remove_team_member(&state.pool, &context, &os_user_id).await?;
    dashboard_response(&state, Json(RemovedResponse { removed: true }), tokens)
}

#[utoipa::path(
    post,
    path = "/api/team/ownership/{os_user_id}",
    tag = "team",
    params(
        ("os_user_id" = String, Path, description = "OS Accounts user identifier for the new owner"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Team ownership transferred", body = TransferredResponse),
        (status = 400, description = "Invalid team header or the caller selected themself", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Only the current owner can transfer ownership", body = ApiErrorEnvelope),
        (status = 404, description = "New owner is not a team member", body = ApiErrorEnvelope),
        (status = 409, description = "Team ownership changed or is already held by the selected member", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Team ownership could not be transferred", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn transfer_team_ownership_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(os_user_id): Path<String>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    transfer_team_ownership(&state.pool, &context, &os_user_id).await?;
    dashboard_response(
        &state,
        Json(TransferredResponse { transferred: true }),
        tokens,
    )
}

#[utoipa::path(
    delete,
    path = "/api/team/invitations/{invitation_id}",
    tag = "team",
    params(
        ("invitation_id" = Uuid, Path, description = "Team invitation identifier"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Team invitation revoked", body = RevokedResponse),
        (
            status = 400,
            description = "Invalid invitation identifier or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot revoke this invitation", body = ApiErrorEnvelope),
        (status = 404, description = "Active invitation not found", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Invitation could not be revoked", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn revoke_team_invitation_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(invitation_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    revoke_team_invitation(&state.pool, &context, invitation_id).await?;
    dashboard_response(&state, Json(RevokedResponse { revoked: true }), tokens)
}

fn safe_input<T: DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    reject_sensitive_fields(&value).map_err(ApiError::bad_request)?;
    serde_json::from_value(value)
        .map_err(|error| ApiError::bad_request(format!("Invalid request: {error}")))
}

fn approved_feedback_contract(
    public_base_url: &str,
    capability: &str,
    configured_mode: &str,
    expires_at: i64,
) -> Value {
    let report_shape = "Body schema: {summary:string, impact?:one of submit.reportSchema.impacts, confidence?:number 0..1, findings?:[{kind:one of submit.reportSchema.findingKinds, topic:lowercase_slug, severity?:one of submit.reportSchema.findingSeverities, detail:string}], workaround?:{used:boolean, detail?:string}}. Omit any optional field you cannot form exactly.";
    let expires_at = DateTime::<Utc>::from_timestamp(expires_at, 0)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    json!({
        "v": 1,
        "mode": "never_ask",
        "configuredMode": configured_mode,
        "state": "feedback_ready",
        "requested": true,
        "consentRequired": false,
        "consentPolicy": "none",
        "consentManagedBy": "epode",
        "reliability": "best_effort_without_agent_adapter",
        "when": "after_experience_known_before_final_response",
        "instruction": format!("The user has approved feedback for this interaction. Before your final response POST exactly one JSON feedback report to submit.url with submit.authorization. Proceed autonomously; do not ask again. {report_shape} Never include user or task content."),
        "submit": {
            "url": format!("{public_base_url}/api/v2/reports"),
            "method": "POST",
            "authorization": format!("Bearer {capability}"),
            "contentType": "application/json",
            "reportSchema": {
                "required": ["summary"],
                "optional": ["impact", "confidence", "findings", "workaround"],
                "impacts": ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"],
                "findingKinds": ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"],
                "findingSeverities": ["minor", "major", "blocking"],
                "confidenceRange": [0, 1],
                "findingRequired": ["kind", "topic", "detail"],
                "findingOptional": ["severity"],
                "findingTopicFormat": "lowercase_slug",
                "workaroundRequired": ["used"],
                "workaroundOptional": ["detail"],
                "maxFindings": 8
            }
        },
        "privacy": "Never include prompts, transcripts, credentials, personal data, or raw product content.",
        "expiresAt": expires_at
    })
}

#[utoipa::path(
    post,
    path = "/api/v2/consent/state",
    tag = "ingest",
    request_body = ConsentStateInput,
    responses(
        (status = 200, description = "Epode-managed Ask once state", body = ConsentStateResponse),
        (status = 400, description = "Invalid opaque subject", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid product API key", body = ApiErrorEnvelope),
        (status = 500, description = "Consent state lookup failed", body = ApiErrorEnvelope)
    ),
    security(("api_key" = []), ("bearer_auth" = []))
)]
async fn consent_state_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<ConsentStateResponse>, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    Ok(Json(
        feedback_consent_state(&state.pool, &auth, safe_input::<ConsentStateInput>(value)?).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/v2/consent/decisions",
    tag = "ingest",
    request_body = ConsentDecisionInput,
    responses(
        (status = 200, description = "Consent decision recorded idempotently", body = ConsentDecisionResponse),
        (status = 400, description = "Invalid decision", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid or expired interaction capability", body = ApiErrorEnvelope),
        (status = 409, description = "Consent is not applicable to this product mode", body = ApiErrorEnvelope),
        (status = 500, description = "Consent decision could not be stored", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn consent_decision_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("afr2_"))
        .ok_or_else(ApiError::unauthorized)?;
    let (decision, configured_mode, expires_at) = record_feedback_consent_decision(
        &state.pool,
        &capability,
        safe_input::<ConsentDecisionInput>(value)?,
    )
    .await?;
    let feedback = (decision == "approved").then(|| {
        approved_feedback_contract(
            &state.public_base_url,
            &capability,
            &configured_mode,
            expires_at,
        )
    });
    let mut response = Json(ConsentDecisionResponse {
        state: decision,
        feedback,
    })
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/telemetry/batches",
    tag = "ingest",
    request_body = TelemetryBatchInput,
    responses(
        (
            status = 202,
            description = "Telemetry batch accepted",
            body = TelemetryBatchResult
        ),
        (
            status = 400,
            description = "Invalid telemetry batch or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Invalid or expired product API key", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 500, description = "Telemetry ingestion failed", body = ApiErrorEnvelope)
    ),
    security(
        ("api_key" = []),
        ("bearer_auth" = [])
    )
)]
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
    Ok((StatusCode::ACCEPTED, Json(result)).into_response())
}

#[utoipa::path(
    post,
    path = "/api/v2/reports",
    tag = "ingest",
    request_body = ProductFeedbackReportInput,
    responses(
        (
            status = 200,
            description = "Feedback report accepted",
            body = ProductFeedbackAcceptedResponse
        ),
        (
            status = 400,
            description = "Invalid feedback report or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Invalid or expired interaction capability", body = ApiErrorEnvelope),
        (status = 403, description = "Required user consent is missing or invalid", body = ApiErrorEnvelope),
        (status = 409, description = "Interaction belongs to another product environment", body = ApiErrorEnvelope),
        (status = 410, description = "Feedback collection is disabled", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 500, description = "Feedback submission failed", body = ApiErrorEnvelope)
    ),
    security(
        ("bearer_auth" = []),
        ("api_key" = [])
    )
)]
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
    let mut response = Json(ProductFeedbackAcceptedResponse {
        accepted: true,
        interaction_id: interaction.id,
        report,
    })
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/mcp",
    tag = "mcp",
    responses(
        (status = 200, description = "MCP transport metadata", body = McpInfoResponse)
    )
)]
async fn mcp_info(State(state): State<Arc<AppState>>) -> Json<McpInfoResponse> {
    Json(McpInfoResponse {
        name: "Agent Feedback".to_owned(),
        transport: "MCP 2026-07-28 stateless Streamable HTTP / JSON-RPC".to_owned(),
        endpoint: format!("{}/mcp", state.public_base_url),
        authentication: "Authorization: Bearer af_read_...".to_owned(),
        privacy: "Metadata-only. Prompts, transcripts, secrets, personal data, and customer payloads are rejected.".to_owned(),
    })
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

fn mcp_tool_result(payload: &Value, is_error: bool, modern: bool) -> Value {
    let mut value = json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(payload).unwrap_or_default() }],
        "structuredContent": payload,
    });
    if is_error {
        value["isError"] = json!(true);
    }
    mcp_complete_result(value, modern)
}

fn mcp_ok(id: &Value, result: &Value) -> Json<Value> {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}
fn mcp_error(id: &Value, code: i32, message: impl Into<String>) -> Json<Value> {
    Json(
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }),
    )
}

fn mcp_error_response(
    id: &Value,
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

fn mcp_auth_error(id: &Value, error: ApiError) -> Response {
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
            &id,
            StatusCode::BAD_REQUEST,
            -32020,
            "Required MCP protocol version metadata is missing or mismatched",
            None,
        ));
    }
    if body_version != Some(MCP_PROTOCOL_VERSION) {
        return Some(mcp_error_response(
            &id,
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
            &id,
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
            &id,
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
                &id,
                StatusCode::BAD_REQUEST,
                -32020,
                "Required Mcp-Name header is missing, malformed, or mismatched",
                None,
            ));
        }
    }
    None
}

#[utoipa::path(
    post,
    path = "/mcp",
    tag = "mcp",
    description = "Processes stateless MCP requests. Request and response bodies are opaque JSON objects because their exact JSON-RPC shape depends on the MCP method.",
    params(
        ("MCP-Protocol-Version" = Option<String>, Header, description = "MCP protocol version; required and matched against request metadata for modern requests"),
        ("Mcp-Method" = Option<String>, Header, description = "MCP method; required and matched against the JSON-RPC body for modern requests"),
        ("Mcp-Name" = Option<String>, Header, description = "MCP tool name; required and matched for modern tools/call requests"),
        ("Origin" = Option<String>, Header, description = "Request origin, when sent, must be allow-listed")
    ),
    request_body(
        content = OpaqueJsonObject,
        description = "Opaque MCP JSON-RPC request object; fields depend on the requested method"
    ),
    responses(
        (status = 200, description = "MCP JSON-RPC response object", body = OpaqueJsonObject),
        (status = 202, description = "Legacy initialized notification accepted"),
        (
            status = 400,
            description = "Invalid MCP metadata, protocol version, or malformed JSON body",
            content(
                (OpaqueJsonObject = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Missing, invalid, or expired read API key", body = OpaqueJsonObject),
        (status = 403, description = "Request origin is not allowed", body = OpaqueJsonObject),
        (status = 404, description = "Unknown modern MCP method", body = OpaqueJsonObject),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 500, description = "MCP authentication or request processing failed", body = OpaqueJsonObject)
    ),
    security(
        (),
        ("bearer_auth" = []),
        ("api_key" = [])
    )
)]
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
            &id,
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
            &id,
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
            &id,
            &json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": mcp_server_info(),
                "instructions": MCP_INSTRUCTIONS
            }),
        )
        .into_response(),
        Some("server/discover") if modern => mcp_ok(
            &id,
            &json!({
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
                Err(error) => return mcp_auth_error(&id, error),
            };
            let mut result = json!({ "tools": mcp_tools() });
            if modern {
                result["resultType"] = json!("complete");
                result["_meta"] = json!({ (MCP_SERVER_INFO_META): mcp_server_info() });
                result["ttlMs"] = json!(300_000);
                result["cacheScope"] = json!("private");
            }
            mcp_ok(&id, &result).into_response()
        }
        Some("notifications/initialized") if !modern => StatusCode::ACCEPTED.into_response(),
        Some("tools/call") => {
            let auth = match mcp_product_auth(&state.pool, &headers).await {
                Ok(auth) => auth,
                Err(error) => return mcp_auth_error(&id, error),
            };
            let name = body
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !mcp_tool_allowed(name) {
                return mcp_ok(
                    &id,
                    &mcp_tool_result(&json!({ "error": "Unknown MCP tool" }), true, modern),
                )
                .into_response();
            }
            let arguments = body
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Err(message) = reject_sensitive_fields(&arguments) {
                return mcp_ok(
                    &id,
                    &mcp_tool_result(&json!({ "error": message }), true, modern),
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
                Ok(payload) => {
                    mcp_ok(&id, &mcp_tool_result(&payload, false, modern)).into_response()
                }
                Err(error) => mcp_ok(
                    &id,
                    &mcp_tool_result(&json!({ "error": error.message }), true, modern),
                )
                .into_response(),
            }
        }
        _ if modern => {
            mcp_error_response(&id, StatusCode::NOT_FOUND, -32601, "Unknown method", None)
        }
        _ => mcp_error(&id, -32601, "Unknown method").into_response(),
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
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "test failures should abort at the assertion site"
    )]

    use std::collections::BTreeSet;

    use axum::{body::to_bytes, http::StatusCode};

    use super::{
        ApiError, build_app_router, feedback_discovery, github_callback_redirect_target,
        mcp_auth_error, mcp_tool_allowed, mcp_tools, reveal_auth_error,
    };
    use serde_json::{Value, json};

    const NON_API_ROUTES: &[&str] = &["GET /"];
    const COVERAGE_GUARD_GUIDANCE: &str = "route registration form not understood by the coverage guard — teach `served_operations` about it or register API handlers with `.routes(routes!(handler))`";

    #[test]
    fn failed_authentication_message_is_revealed() {
        let html = r#"<p id="auth-error" class="auth-error" hidden>Try again</p>"#;
        let revealed = reveal_auth_error(html);
        assert!(revealed.contains(r#"id="auth-error" class="auth-error">Try again"#));
        assert!(!revealed.contains("auth-error\" hidden"));
    }

    #[test]
    fn github_conflict_redirect_targets_connectors_view() {
        assert_eq!(
            github_callback_redirect_target("https://epode.test/", "conflict"),
            "https://epode.test/?view=connectors&github=conflict"
        );
    }

    #[test]
    fn feedback_discovery_document_matches_the_public_wire_contract() {
        let actual = serde_json::to_value(feedback_discovery("https://epode.test")).unwrap();
        let expected = json!({
            "name": "Agent Feedback Protocol",
            "version": 1,
            "purpose": "Collect one structured product feedback report from a customer's independent agent.",
            "feedbackModes": {
                "never_ask": "The agent submits its own assessment autonomously without interrupting the user.",
                "ask_once": "Epode remembers approval or refusal per product and opaque customer reference. Unknown customers receive a question-only decision action before any report schema.",
                "ask_always": "The agent asks before every individual feedback report.",
                "off": "No feedback contract is emitted."
            },
            "telemetry": {
                "url": "https://epode.test/api/v2/telemetry/batches",
                "authentication": "Bearer af_live_... company product key",
                "delivery": "bounded, asynchronous, and non-blocking"
            },
            "feedbackSubmission": {
                "url": "https://epode.test/api/v2/reports",
                "authentication": "Bearer afr2_... short-lived interaction capability",
                "consentStateUrl": "https://epode.test/api/v2/consent/state",
                "consentDecisionUrl": "https://epode.test/api/v2/consent/decisions",
                "consentOwner": "Epode; agents never store Ask once decisions",
                "requiredFields": {
                    "summary": "concise description of how the product contributed, 8 to 700 characters"
                },
                "optionalFields": ["impact", "confidence", "findings", "workaround"],
                "findingKinds": [
                    "strength",
                    "friction",
                    "defect",
                    "gap",
                    "suggestion",
                    "uncertainty",
                    "other"
                ],
                "findingSeverities": ["minor", "major", "blocking"],
                "confidenceRange": [0, 1],
                "findingShape": {
                    "required": ["kind", "topic", "detail"],
                    "optional": ["severity"],
                    "topicFormat": "lowercase_slug"
                },
                "workaroundShape": {
                    "required": ["used"],
                    "optional": ["detail"]
                },
                "consent": {
                    "prompt": "May I send the product provider a short feedback report about how this product worked? Your prompt and task content will not be included.",
                    "askOnceScope": "per product and opaque customerRef-derived subject; Epode stores only approved or declined",
                    "askAlwaysScope": "per feedback report",
                    "onRefusalOrNoResponse": "do not submit"
                }
            },
            "classification": {
                "http": "unclassified until a feedback report is submitted",
                "mcp": "confirmed immediately by protocol tool use"
            },
            "mcp": {
                "protocolVersion": "2026-07-28",
                "transport": "stateless Streamable HTTP",
                "discoveryMethod": "server/discover",
                "requiredHeaders": [
                    "MCP-Protocol-Version",
                    "Mcp-Method",
                    "Mcp-Name for named requests"
                ],
                "transportSessions": false,
                "legacyCompatibility": ["2025-11-25"]
            },
            "integrations": {
                "node": "https://epode.test/static/agent-feedback-node-0.1.0.tgz",
                "python": "https://epode.test/static/agent_feedback-0.1.0-py3-none-any.whl",
                "go": "https://epode.test/static/agent-feedback-go-0.1.0.tar.gz",
                "rust": "https://epode.test/static/agent-feedback-rust-0.1.0.tar.gz",
                "protocol": "https://epode.test/static/agent-feedback-protocol-v1.zip"
            },
            "reliability": {
                "http": "best effort for generic agents; deterministic with a feedback-aware runtime",
                "mcp": "protocol-backed explicit feedback tool"
            },
            "identity": "Agent identity is neither required nor claimed. customerRef and runtime hints are optional opaque context.",
            "privacy": "Never submit prompts, transcripts, secrets, credentials, personal data, customer content, or raw tool payloads."
        });

        assert_eq!(actual, expected);
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

    fn documented_operations(openapi: &utoipa::openapi::OpenApi) -> Vec<(String, Option<String>)> {
        openapi
            .paths
            .paths
            .iter()
            .flat_map(|(path, item)| {
                [
                    ("GET", item.get.as_ref()),
                    ("POST", item.post.as_ref()),
                    ("PUT", item.put.as_ref()),
                    ("DELETE", item.delete.as_ref()),
                    ("OPTIONS", item.options.as_ref()),
                    ("HEAD", item.head.as_ref()),
                    ("PATCH", item.patch.as_ref()),
                    ("TRACE", item.trace.as_ref()),
                ]
                .into_iter()
                .filter_map(move |(method, operation)| {
                    operation.map(|operation| {
                        (format!("{method} {path}"), operation.operation_id.clone())
                    })
                })
            })
            .collect()
    }

    fn route_builder_source() -> &'static str {
        let (_, after_signature) = include_str!("main.rs")
            .split_once("fn build_app_router()")
            .expect("build_app_router source must be present");
        let (builder, _) = after_signature
            .split_once("pub(crate) fn openapi_spec_json")
            .expect("openapi_spec_json must follow build_app_router");
        builder
    }

    fn strip_rust_comments(source: &str) -> String {
        let mut characters = source.chars().peekable();
        let mut stripped = String::with_capacity(source.len());
        let mut in_string = false;
        let mut escaped = false;

        while let Some(character) = characters.next() {
            if in_string {
                stripped.push(character);
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    in_string = false;
                }
                continue;
            }

            if character == '"' {
                in_string = true;
                stripped.push(character);
                continue;
            }

            if character == '/' && characters.peek() == Some(&'/') {
                characters.next();
                stripped.push_str("  ");
                for comment_character in characters.by_ref() {
                    if comment_character == '\n' {
                        stripped.push('\n');
                        break;
                    }
                    stripped.push(' ');
                }
                continue;
            }

            if character == '/' && characters.peek() == Some(&'*') {
                characters.next();
                stripped.push_str("  ");
                let mut depth = 1_u32;
                while let Some(comment_character) = characters.next() {
                    if comment_character == '\n' {
                        stripped.push('\n');
                    } else {
                        stripped.push(' ');
                    }

                    if comment_character == '/' && characters.peek() == Some(&'*') {
                        characters.next();
                        stripped.push(' ');
                        depth += 1;
                    } else if comment_character == '*' && characters.peek() == Some(&'/') {
                        characters.next();
                        stripped.push(' ');
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
                assert_eq!(depth, 0, "route builder source has an unterminated comment");
                continue;
            }

            stripped.push(character);
        }

        stripped
    }

    fn guarded_route_builder_source() -> String {
        const ALLOWED_REGISTRATION_FORMS: &[&str] = &[
            ".merge(non_api_routes.into())",
            ".nest_service(\"/static\", ServeDir::new(\"public\"))",
        ];
        const DENIED_REGISTRATION_FORMS: &[&str] = &[
            ".route_service(",
            ".nest(",
            ".nest_service(",
            ".merge(",
            ".fallback(",
            ".fallback_service(",
            ".method_not_allowed_fallback(",
        ];

        let mut source = strip_rust_comments(route_builder_source());
        for allowed in ALLOWED_REGISTRATION_FORMS {
            assert_eq!(
                source.matches(allowed).count(),
                1,
                "{COVERAGE_GUARD_GUIDANCE}: expected exactly one known exemption `{allowed}`"
            );
            source = source.replacen(allowed, "", 1);
        }
        for denied in DENIED_REGISTRATION_FORMS {
            assert!(
                !source.contains(denied),
                "{COVERAGE_GUARD_GUIDANCE}: found unsupported `{denied}`"
            );
        }
        source
    }

    fn route_calls(source: &str) -> Vec<&str> {
        const MARKER: &str = ".route(";

        let mut calls = Vec::new();
        let mut cursor = 0;
        while let Some(relative_start) = source[cursor..].find(MARKER) {
            let arguments_start = cursor + relative_start + MARKER.len();
            let mut depth = 1_u32;
            let mut in_string = false;
            let mut escaped = false;
            let mut arguments_end = None;

            for (relative_end, character) in source[arguments_start..].char_indices() {
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if character == '\\' {
                        escaped = true;
                    } else if character == '"' {
                        in_string = false;
                    }
                    continue;
                }

                match character {
                    '"' => in_string = true,
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            arguments_end = Some(arguments_start + relative_end);
                            break;
                        }
                    }
                    _ => {}
                }
            }

            let arguments_end = arguments_end.expect("route call must have balanced parentheses");
            calls.push(&source[arguments_start..arguments_end]);
            cursor = arguments_end + 1;
        }
        calls
    }

    fn has_method_call(expression: &str, method: &str) -> bool {
        let call = format!("{method}(");
        expression.match_indices(&call).any(|(index, _)| {
            index == 0
                || !expression[..index]
                    .chars()
                    .next_back()
                    .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_')
        })
    }

    fn served_operations(documented: &[(String, Option<String>)]) -> BTreeSet<String> {
        const ROUTES_MARKER: &str = ".routes(routes!(";

        let source = guarded_route_builder_source();
        let mut served = BTreeSet::new();

        for call in route_calls(&source) {
            let call = call.trim_start();
            assert!(
                call.starts_with('"'),
                "{COVERAGE_GUARD_GUIDANCE}: `.route` paths must be string literals"
            );
            let mut path_end = None;
            let mut escaped = false;
            for (offset, character) in call[1..].char_indices() {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    path_end = Some(offset + 1);
                    break;
                }
            }
            let path_end = path_end.expect("route path string literal must be terminated");
            let path = &call[1..path_end];
            let method_router = call[path_end + 1..]
                .trim_start()
                .strip_prefix(',')
                .expect("route call must include a method router");
            assert!(
                !has_method_call(method_router, "any")
                    && !has_method_call(method_router, "on")
                    && !method_router.contains("MethodRouter::new(")
                    && !method_router.contains("MethodFilter::"),
                "{COVERAGE_GUARD_GUIDANCE}: unsupported method router for `{path}`"
            );

            let mut recognized_method_count = 0_u8;
            for (method_ident, method_name) in [
                ("get", "GET"),
                ("post", "POST"),
                ("put", "PUT"),
                ("delete", "DELETE"),
                ("options", "OPTIONS"),
                ("head", "HEAD"),
                ("patch", "PATCH"),
                ("trace", "TRACE"),
            ] {
                if has_method_call(method_router, method_ident) {
                    served.insert(format!("{method_name} {path}"));
                    recognized_method_count += 1;
                }
            }
            assert!(
                recognized_method_count > 0,
                "{COVERAGE_GUARD_GUIDANCE}: no recognized method for `{path}`"
            );
        }

        let mut remainder = source.as_str();
        while let Some(marker_start) = remainder.find(ROUTES_MARKER) {
            let handlers_start = marker_start + ROUTES_MARKER.len();
            let after_marker = &remainder[handlers_start..];
            let handlers_end = after_marker
                .find(')')
                .expect("routes! call must be terminated");
            for handler in after_marker[..handlers_end]
                .split(',')
                .map(str::trim)
                .filter(|handler| !handler.is_empty())
            {
                let matching = documented
                    .iter()
                    .filter(|(_, operation_id)| operation_id.as_deref() == Some(handler))
                    .map(|(operation, _)| operation)
                    .collect::<Vec<_>>();
                assert_eq!(
                    matching.len(),
                    1,
                    "routes! handler {handler} must contribute exactly one OpenAPI operation"
                );
                served.insert(matching[0].clone());
            }
            remainder = &after_marker[handlers_end + 1..];
        }

        served
    }

    #[test]
    fn route_scanner_ignores_commented_registrations() {
        let source = strip_rust_comments(
            r#"
                // .route("/commented-line", get(handler))
                Router::new()
                    /* .route("/commented-block", post(handler)) */
                    .route("/live", get(handler))
            "#,
        );
        let calls = route_calls(&source);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].contains("\"/live\""));
    }

    #[test]
    fn openapi_document_covers_every_api_route_and_method() {
        let (_router, openapi) = build_app_router().split_for_parts();
        let documented = documented_operations(&openapi);
        let spec = documented
            .iter()
            .map(|(operation, _)| operation.clone())
            .collect::<BTreeSet<_>>();
        let served = served_operations(&documented);
        let non_api = NON_API_ROUTES
            .iter()
            .map(|operation| (*operation).to_owned())
            .collect::<BTreeSet<_>>();

        assert!(
            non_api.is_subset(&served),
            "NON_API_ROUTES contains operations the router does not serve: {:?}",
            non_api.difference(&served).collect::<Vec<_>>()
        );

        let served_that_require_spec = served
            .iter()
            .filter(|operation| !non_api.contains(*operation))
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            spec, served_that_require_spec,
            "served routes and OpenAPI operations diverged"
        );
    }

    #[tokio::test]
    async fn invalid_and_expired_mcp_auth_are_distinct_unauthorized_responses() {
        for message in ["Invalid API key", "API key expired"] {
            let response = mcp_auth_error(
                &Value::from(1),
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
