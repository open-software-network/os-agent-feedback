mod api_types;
mod code_match;
mod customer_features;
mod dev_auth;
mod error;
mod github;
mod grouping;
mod issue_template;
mod migration_bridge;
mod models;
mod os_accounts;
mod security;
mod store;

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use anyhow::Context as _;
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, RawQuery, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{Next, from_fn},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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
    code_match::{
        CodeHintCandidate, CodeMatchFinding, CodeMatchInput, CodeMatchVerificationTracker,
        CodeSearchCandidate, CodeSearchMatches, derive_queries, rank_matches,
        settle_file_not_found_candidates,
    },
    customer_features::{
        DashboardFeatureDetail, DashboardFeatureFilters, DashboardFeaturesPage,
        dashboard_feature_by_key, dashboard_features_page,
    },
    error::{ApiError, ApiErrorEnvelope},
    github::{
        GithubAppClient, GithubAppConfig, GithubCodeSearchCandidate, GithubCodeSearchFailureKind,
        GithubFileContentError, GithubFileContentFailureKind, GithubIssue,
        GithubIssueCreationOutcome, GithubIssueListError, GithubIssueListFailureKind,
        GithubPinnedCommitError, GithubRateLimit, validate_repo_full_name,
    },
    grouping::FingerprintGrouper,
    issue_template::{
        group_backlink, group_marker_comment, render_evidence_comment, render_issue_body,
        render_issue_title,
    },
    models::{
        CapabilityInspectionResponse, ClassificationDiscovery, ConsentDecisionInput,
        ConsentStateInput, ConsentStateResponse, CreateApiKeyInput, CreateProductInput,
        CreateTeamInvitationInput, CurrentUser, CustomerContextInput, CustomerContextResponse,
        DashboardContext, DashboardCustomerDetail, DashboardCustomerFilters,
        DashboardCustomersPage, DashboardData, DashboardFeedbackFilters, DashboardFeedbackPage,
        DashboardResponseFilters, DashboardResponsesPage, DashboardSessionDetail,
        DashboardSessionFilters, DashboardSessionsPage, DashboardSignalFilters,
        DashboardSignalsPage, DeleteProductInput, EnrichmentAnswerInput, EnrichmentAnswerResponse,
        EnrichmentConsentDecisionInput, EnrichmentConsentDecisionResponse, EnrichmentRequestInput,
        EnrichmentRequestResponse, FeedbackConsentDiscovery, FeedbackDiscoveryResponse,
        FeedbackFindingShapeDiscovery, FeedbackListInteractionsInput, FeedbackListReportsInput,
        FeedbackModesDiscovery, FeedbackRequiredFieldsDiscovery, FeedbackSubmissionDiscovery,
        FeedbackWorkaroundShapeDiscovery, GithubIssueLink, HealthResponse, IntegrationsDiscovery,
        McpDiscovery, MergeReportGroupsInput, MergeReportGroupsResponse,
        PersonalizationDecisionInput, PersonalizationDecisionResponse, PersonalizationOutcomeInput,
        PersonalizationOutcomeResponse, PolicyInput, ProductAuth, ProductFeedbackAcceptedResponse,
        ProductFeedbackReportInput, ProductGithubRepo, ProductGithubRepoInput,
        ProductGroupsResponse, ReliabilityDiscovery, TelemetryBatchInput, TelemetryBatchResult,
        TelemetryDiscovery, UpdateFeedbackWorkflowInput, UpdateNameInput, UpdateTeamMemberInput,
    },
    os_accounts::{
        ACCESS_COOKIE, OsAccountsClient, PKCE_COOKIE, REFRESH_COOKIE, STATE_COOKIE, TokenPair,
    },
    security::{
        bearer_token, clear_cookie, cookie, http_only_cookie, random_token, reject_sensitive_fields,
    },
    store::{
        CodeMatchCompletion, CodeMatchJob, CodeMatchVerificationRetry,
        CodeMatchVerificationRetryTarget, GithubInstallationUpsert, GroupIssueFilingClaim,
        GroupIssueFilingRequest, GroupIssueSyncContext, accept_team_invitation, agent_product_auth,
        backfill_customer_intelligence, backfill_report_groups, bump_last_commented_report_count,
        claim_code_match_batch, claim_group_issue_filing, claim_group_issue_reconciliation,
        claim_group_issue_state_refresh, clear_code_match_verification_retry_marker,
        clear_product_github_repo, complete_code_match_job, complete_group_issue_filing,
        complete_group_issue_reconciliation, create_api_key, create_enrichment_request,
        create_product_with_default_key, create_team_invitation, dashboard_customer_by_id,
        dashboard_customers_page, dashboard_feedback_page, dashboard_interaction_by_id,
        dashboard_report_by_id, dashboard_responses_page, dashboard_session_by_id,
        dashboard_sessions_page, dashboard_signals_page, dashboard_with_limits,
        dead_letter_code_match_job, decide_enrichment_consent, delete_product,
        feedback_consent_state, feedback_list_interactions, feedback_list_reports,
        get_group_github_issue, get_or_create_workspace, get_product_github_repo,
        github_installation_workspace, group_issue_context, group_issue_sync_context,
        ingest_telemetry_batch, inspect_feedback_capability, list_github_installations,
        list_product_groups, mark_group_issue_filing_for_reconciliation, merge_report_groups,
        purge_expired_product_data, read_product_auth, record_code_match_call,
        record_feedback_consent_decision, record_personalization_decision,
        record_personalization_outcome, regroup_report_groups, release_code_match_claim,
        release_code_match_for_verification_retry, release_code_match_job,
        release_group_issue_filing_claim, release_group_issue_reconciliation_claim,
        remove_team_member, rename_product, rename_workspace, reset_code_match_verification_retry,
        resolve_workspace_access, retrieve_customer_context, revert_last_commented_report_count,
        revoke_api_key, revoke_github_installation, revoke_team_invitation, rotate_api_key,
        set_product_github_repo, submit_enrichment_answer, submit_product_feedback,
        terminally_dead_letter_code_match_verification, transfer_team_ownership,
        update_feedback_workflow, update_group_issue_state, update_policy, update_team_member_role,
        upsert_github_installation,
    },
};

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    identity_hmac_secret: Vec<u8>,
    public_base_url: String,
    web_app_url: String,
    secure_cookies: bool,
    dev_auth: Option<dev_auth::DevAuthConfig>,
    accounts: OsAccountsClient,
    github: Option<GithubAppClient>,
    mcp_allowed_origins: Vec<String>,
}

const TEAM_INVITE_COOKIE: &str = "af_team_invite";
const AUTH_RETURN_TO_COOKIE: &str = "af_auth_return_to";
const GITHUB_STATE_COOKIE: &str = "af_gh_state";
const GITHUB_WORKSPACE_COOKIE: &str = "af_gh_ws";
const MAX_GROUP_ISSUE_SYNCS_PER_REQUEST: usize = 5;
const GROUP_ISSUE_STATE_REFRESH_INTERVAL_MINUTES: i64 = 15;
const GROUP_ISSUE_RECONCILIATION_RETRY_MINUTES: i64 = 1;
const GROUP_ISSUE_RECONCILIATION_CLOCK_SKEW_MINUTES: i64 = 5;
const CODE_MATCH_BATCH_SIZE: i64 = 20;
const CODE_MATCH_SEARCH_CALLS_PER_INSTALLATION_BATCH: usize = 10;
const CODE_MATCH_CONTENT_FETCHES_PER_INSTALLATION_BATCH: usize = 10;
const CODE_MATCH_MAX_ATTEMPTS: i32 = 8;
const CODE_MATCH_MAX_VERIFICATION_RETRIES: i32 = 8;
const CODE_MATCH_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);
// A 20-job batch can span 20 installations. At the GitHub client's 15s
// timeout, token + HEAD + five searches + ten bounded content fetches, plus
// search pacing, fits under two hours even when every request runs to timeout.
const CODE_MATCH_STALE_CLAIM_AGE: Duration = Duration::hours(2);
const CODE_MATCH_DEFAULT_PACE: std::time::Duration = std::time::Duration::from_secs(6);

/// How long a `pending` filing claim is respected before a crashed filer is
/// moved into reconciliation. Comfortably above the GitHub client's 15s
/// request timeout, so a live filer is never displaced.
const GROUP_ISSUE_FILING_CLAIM_STALE_MINUTES: i64 = 5;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Epode Customer Intelligence API",
        description = "Permissioned customer intelligence from agent-mediated product use."
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

fn build_app_router(dev_auth_enabled: bool) -> OpenApiRouter<Arc<AppState>> {
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
    let mut non_api_routes = Router::new()
        .route("/", get(root_page))
        .nest_service("/static", ServeDir::new("public"));
    if dev_auth_enabled {
        non_api_routes = non_api_routes.merge(dev_auth::router());
    }
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
        .routes(routes!(
            product_github_repo_handler,
            set_product_github_repo_handler,
            clear_product_github_repo_handler
        ))
        .routes(routes!(product_groups_handler))
        .routes(routes!(merge_report_groups_handler))
        .routes(routes!(file_group_github_issue_handler))
        .routes(routes!(join_team_handler))
        .routes(routes!(logout_handler))
        .routes(routes!(dashboard_handler))
        .routes(routes!(dashboard_feedback_list_handler))
        .routes(routes!(dashboard_customers_list_handler))
        .routes(routes!(dashboard_customer_handler))
        .routes(routes!(dashboard_responses_list_handler))
        .routes(routes!(dashboard_features_list_handler))
        .routes(routes!(dashboard_feature_handler))
        .routes(routes!(dashboard_signals_list_handler))
        .routes(routes!(dashboard_sessions_list_handler))
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
        .routes(routes!(capability_inspection_handler))
        .routes(routes!(consent_decision_handler))
        .routes(routes!(product_feedback_handler))
        .routes(routes!(enrichment_request_handler))
        .routes(routes!(enrichment_consent_decision_handler))
        .routes(routes!(enrichment_answer_handler))
        .routes(routes!(customer_context_handler))
        .routes(routes!(personalization_decision_handler))
        .routes(routes!(personalization_outcome_handler))
        .routes(routes!(mcp_info, mcp_handler))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(from_fn(security_headers))
}

pub(crate) fn openapi_spec_json() -> anyhow::Result<String> {
    let (_router, openapi) = build_app_router(false).split_for_parts();
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
    let identity_hmac_secret = match env::var("EPODE_IDENTITY_HMAC_SECRET") {
        Ok(value) => value.into_bytes(),
        Err(env::VarError::NotPresent) if !production => {
            b"epode-development-identity-hmac-secret-change-me".to_vec()
        }
        Err(env::VarError::NotPresent) => {
            anyhow::bail!("EPODE_IDENTITY_HMAC_SECRET is required in production")
        }
        Err(env::VarError::NotUnicode(_)) => {
            anyhow::bail!("EPODE_IDENTITY_HMAC_SECRET must be valid Unicode")
        }
    };
    anyhow::ensure!(
        identity_hmac_secret.len() >= 32,
        "EPODE_IDENTITY_HMAC_SECRET must be at least 32 bytes"
    );
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
    migration_bridge::prepare_database(&pool, production).await?;
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
    if command.as_deref() == Some("--backfill-customer-intelligence") {
        loop {
            let summary = backfill_customer_intelligence(&pool, &identity_hmac_secret, 500)
                .await
                .map_err(|error| anyhow::anyhow!(error.message))?;
            tracing::info!(
                interactions_scanned = summary.interactions_scanned,
                interactions_linked = summary.interactions_linked,
                reports_scanned = summary.reports_scanned,
                reports_projected = summary.reports_projected,
                consent_subjects_scanned = summary.consent_subjects_scanned,
                consent_grants_projected = summary.consent_grants_projected,
                exhausted = summary.exhausted,
                "customer intelligence backfill batch completed"
            );
            if summary.exhausted {
                break;
            }
            tokio::task::yield_now().await;
        }
        return Ok(());
    }

    // Group any reports that predate grouping, so a normal deploy converges
    // without an operator remembering to run the CLI. This runs to completion
    // rather than under a total cap, because a deployment with more history
    // than any cap would otherwise never finish grouping on its own.
    //
    // It is deliberately detached: boot and readiness never await it, so a
    // large historical table cannot delay the listener or trip a healthcheck.
    // Work stays bounded per step by the batch size and by a short yield
    // between batches, so it cannot monopolise the connection pool. Reports
    // already grouped are excluded by the `group_id IS NULL` filter, which is
    // what makes running this on every boot cheap and idempotent.
    let backfill_pool = pool.clone();
    tokio::spawn(async move {
        // Transient database errors must not strand ungrouped reports until
        // the next boot: retry with capped exponential backoff. The work is
        // idempotent (`group_id IS NULL`), so re-running after a partial
        // failure is always safe.
        let max_backoff = std::time::Duration::from_mins(5);
        let mut backoff = std::time::Duration::from_secs(1);
        loop {
            match backfill_report_groups(&backfill_pool, &FingerprintGrouper, None).await {
                Ok(summary) => {
                    if summary.scanned > 0 {
                        tracing::info!(
                            scanned = summary.scanned,
                            grouped = summary.grouped,
                            skipped = summary.skipped,
                            skipped_findings = summary.skipped_findings,
                            "startup report group backfill completed"
                        );
                    }
                    break;
                }
                // Never escalate to the process: the API is useful without
                // grouping. Retry from wherever this run stopped.
                Err(error) => {
                    tracing::warn!(
                        error = %error.message,
                        retry_in_secs = backoff.as_secs(),
                        "startup report group backfill failed; retrying"
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(max_backoff);
                }
            }
        }
    });

    // Customer intelligence is a projection over retained interaction,
    // feedback, and consent evidence. Converge historical rows after the
    // listener is free to start: every batch is bounded, idempotent, protected
    // by a database advisory lock, and retried without affecting readiness.
    let customer_backfill_pool = pool.clone();
    let customer_backfill_secret = identity_hmac_secret.clone();
    tokio::spawn(async move {
        let max_backoff = std::time::Duration::from_mins(5);
        let mut backoff = std::time::Duration::from_secs(1);
        loop {
            match backfill_customer_intelligence(
                &customer_backfill_pool,
                &customer_backfill_secret,
                500,
            )
            .await
            {
                Ok(summary) => {
                    if summary.interactions_scanned > 0
                        || summary.reports_scanned > 0
                        || summary.consent_subjects_scanned > 0
                    {
                        tracing::info!(
                            interactions_scanned = summary.interactions_scanned,
                            interactions_linked = summary.interactions_linked,
                            reports_scanned = summary.reports_scanned,
                            reports_projected = summary.reports_projected,
                            consent_subjects_scanned = summary.consent_subjects_scanned,
                            consent_grants_projected = summary.consent_grants_projected,
                            exhausted = summary.exhausted,
                            "startup customer intelligence backfill batch completed"
                        );
                    }
                    if summary.exhausted {
                        break;
                    }
                    backoff = std::time::Duration::from_secs(1);
                    tokio::task::yield_now().await;
                }
                Err(error) => {
                    tracing::warn!(
                        error = %error.message,
                        retry_in_secs = backoff.as_secs(),
                        "startup customer intelligence backfill failed; retrying"
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(max_backoff);
                }
            }
        }
    });

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);
    let public_base_url =
        env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://localhost:{port}"));
    let configured_web_app_url = env::var("WEB_APP_URL").ok();
    let dev_auth = dev_auth::DevAuthConfig::from_env(
        port,
        &public_base_url,
        configured_web_app_url.as_deref(),
    )?;
    let web_app_url = resolve_web_app_url(&public_base_url, configured_web_app_url.as_deref());
    if production {
        let accounts_url = env::var("OS_ACCOUNTS_URL")?;
        let accounts_api_url = env::var("OS_ACCOUNTS_API_URL")?;
        for (name, value) in [
            ("PUBLIC_BASE_URL", public_base_url.as_str()),
            ("WEB_APP_URL", web_app_url.as_str()),
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
        identity_hmac_secret,
        secure_cookies: public_base_url.starts_with("https://"),
        public_base_url,
        web_app_url,
        pool,
        dev_auth: dev_auth.clone(),
        accounts,
        github,
        mcp_allowed_origins,
    });
    spawn_retention_worker(state.pool.clone());
    spawn_code_match_worker(state.pool.clone(), state.github.clone());

    let (app, _openapi) = build_app_router(dev_auth.is_some()).split_for_parts();
    let app = app.with_state(state);

    let bind_ip = dev_auth.as_ref().map_or_else(
        || IpAddr::from([0, 0, 0, 0]),
        dev_auth::DevAuthConfig::bind_ip,
    );
    let address = SocketAddr::from((bind_ip, port));
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

fn spawn_code_match_worker(pool: PgPool, github: Option<GithubAppClient>) {
    let Some(github) = github else {
        // An unconfigured deployment has nothing useful to poll. In
        // particular, do not wake up every few seconds just to emit the same
        // configuration error while reports remain safely queued.
        return;
    };
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CODE_MATCH_POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let jobs = match claim_code_match_batch(
                &pool,
                CODE_MATCH_BATCH_SIZE,
                Utc::now() - CODE_MATCH_STALE_CLAIM_AGE,
            )
            .await
            {
                Ok(jobs) if jobs.is_empty() => continue,
                Ok(jobs) => jobs,
                Err(error) => {
                    tracing::warn!(error = %error.message, "code-match queue claim failed");
                    continue;
                }
            };
            let Some(claim_token) = jobs.first().map(|job| job.claim_token) else {
                continue;
            };
            // Running one drain in its own task contains a matcher panic. The
            // outer loop survives and releases every still-owned row so the
            // next pass can retry instead of waiting for stale-claim expiry.
            let drain_pool = pool.clone();
            let drain_github = github.clone();
            let drain = tokio::spawn(async move {
                drain_code_match_batch(&drain_pool, &drain_github, jobs).await
            })
            .await;
            let failure = match drain {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.to_string()),
                Err(error) => Some(format!("code-match drain task failed: {error}")),
            };
            if let Some(error) = failure {
                tracing::warn!(%error, "code-match batch failed; releasing claims");
                if let Err(release_error) = release_code_match_claim(
                    &pool,
                    claim_token,
                    Utc::now() + Duration::seconds(30),
                    &error,
                )
                .await
                {
                    tracing::warn!(
                        error = %release_error.message,
                        "code-match batch claims could not be released"
                    );
                }
            }
        }
    });
}

#[derive(Debug)]
struct InstallationSearchBudget {
    remaining: usize,
}

impl InstallationSearchBudget {
    const fn new() -> Self {
        Self {
            remaining: CODE_MATCH_SEARCH_CALLS_PER_INSTALLATION_BATCH,
        }
    }

    const fn take(&mut self) -> bool {
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        true
    }

    fn observe_headroom(&mut self, headroom: Option<i64>) {
        if let Some(headroom) = headroom.and_then(|value| usize::try_from(value).ok()) {
            self.remaining = self.remaining.min(headroom);
        }
    }
}

#[derive(Debug)]
struct InstallationContentBudget {
    remaining: usize,
}

#[derive(Debug)]
enum PinnedFileContent {
    Content(String),
    FileNotFound,
    Incomplete(GithubFileContentFailureKind),
}

const fn pinned_file_content_for_failure(kind: GithubFileContentFailureKind) -> PinnedFileContent {
    match kind {
        GithubFileContentFailureKind::NotFound => PinnedFileContent::FileNotFound,
        GithubFileContentFailureKind::Unauthorized
        | GithubFileContentFailureKind::Forbidden
        | GithubFileContentFailureKind::Server
        | GithubFileContentFailureKind::Timeout
        | GithubFileContentFailureKind::InvalidResponse
        | GithubFileContentFailureKind::Transport => PinnedFileContent::Incomplete(kind),
    }
}

fn normalized_code_match_repo(repo_full_name: &str) -> String {
    repo_full_name.trim().to_ascii_lowercase()
}

fn same_code_match_repo(left: &str, right: &str) -> bool {
    normalized_code_match_repo(left) == normalized_code_match_repo(right)
}

trait PinnedCommitVerifier: Sync {
    fn pinned_commit_is_fetchable(
        &self,
        repo_full_name: &str,
        computed_at_sha: &str,
    ) -> impl std::future::Future<Output = Result<(), GithubPinnedCommitError>> + Send;

    fn pinned_file_content(
        &self,
        repo_full_name: &str,
        file: &str,
        computed_at_sha: &str,
    ) -> impl std::future::Future<Output = Result<String, GithubFileContentError>> + Send;
}

struct GithubPinnedCommitVerifier<'a> {
    github: &'a GithubAppClient,
    token: &'a crate::github::GithubInstallationToken,
}

impl PinnedCommitVerifier for GithubPinnedCommitVerifier<'_> {
    async fn pinned_commit_is_fetchable(
        &self,
        repo_full_name: &str,
        computed_at_sha: &str,
    ) -> Result<(), GithubPinnedCommitError> {
        self.github
            .repository_commit_is_fetchable(self.token, repo_full_name, computed_at_sha)
            .await
    }

    async fn pinned_file_content(
        &self,
        repo_full_name: &str,
        file: &str,
        computed_at_sha: &str,
    ) -> Result<String, GithubFileContentError> {
        self.github
            .repository_file_content(self.token, repo_full_name, file, computed_at_sha)
            .await
    }
}

impl InstallationContentBudget {
    const fn new() -> Self {
        Self {
            remaining: CODE_MATCH_CONTENT_FETCHES_PER_INSTALLATION_BATCH,
        }
    }

    const fn take(&mut self) -> bool {
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        true
    }

    const fn remaining(&self) -> usize {
        self.remaining
    }
}

#[derive(Debug, Deserialize)]
struct StoredCodeMatchFinding {
    kind: String,
    topic: String,
}

#[derive(Debug)]
enum CodeMatchJobOutcome {
    Continue,
    BackoffInstallation { until: DateTime<Utc>, error: String },
}

enum CodeMatchVerificationPreflight {
    Proceed { retry_count: i32 },
    Stop(CodeMatchJobOutcome),
}

enum CodeMatchContentPreflight {
    Fresh {
        retry_count: i32,
    },
    RetrySha {
        computed_at_sha: String,
        retry_count: i32,
    },
    Resume {
        computed_at_sha: String,
        retry_count: i32,
        verification: PendingCodeMatchVerification,
    },
    Stop(CodeMatchJobOutcome),
}

struct CodeMatchSettlement<'a> {
    computed_at_sha: &'a str,
    matches: Vec<CodeSearchMatches>,
    verification: CodeMatchVerificationTracker,
    verification_retry_count: i32,
}

#[derive(Debug)]
struct IncompleteCodeMatchContent {
    reason: String,
    file: Option<String>,
    required_content: i32,
    pending_verification: Option<serde_json::Value>,
    error: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingGithubCodeSearchMatches {
    query: crate::code_match::CodeSearchQuery,
    candidates: Vec<GithubCodeSearchCandidate>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingCodeMatchVerification {
    pending: Vec<PendingGithubCodeSearchMatches>,
    resolved: Vec<CodeSearchMatches>,
    verification: CodeMatchVerificationTracker,
}

enum PendingCodeMatchResolution {
    Complete {
        matches: Vec<CodeSearchMatches>,
        verification: CodeMatchVerificationTracker,
    },
    Incomplete(IncompleteCodeMatchContent),
}

async fn drain_code_match_batch(
    pool: &PgPool,
    github: &GithubAppClient,
    jobs: Vec<CodeMatchJob>,
) -> anyhow::Result<()> {
    let mut jobs_by_installation = BTreeMap::<i64, Vec<CodeMatchJob>>::new();
    for job in jobs {
        let Some(installation_id) = job.installation_id.filter(|_| job.installation_active) else {
            let reason = "repository mapping or GitHub installation was removed";
            dead_letter_owned_code_match_job(pool, &job, reason).await?;
            continue;
        };
        jobs_by_installation
            .entry(installation_id)
            .or_default()
            .push(job);
    }

    for (installation_id, installation_jobs) in jobs_by_installation {
        let token = match github.installation_token(installation_id).await {
            Ok(token) => token,
            Err(error) => {
                let message = format!("GitHub installation token failed: {error}");
                for job in &installation_jobs {
                    if let Some((computed_at_sha, verification_retry_repo)) =
                        job.verification_retry()
                    {
                        let mapping_changed = job.repo_full_name.as_deref().is_some_and(|repo| {
                            !same_code_match_repo(repo, verification_retry_repo)
                        });
                        if mapping_changed {
                            let cleared = reset_code_match_verification_retry(
                                pool,
                                job.report_id,
                                job.claim_token,
                            )
                            .await
                            .map_err(|error| anyhow::anyhow!(error.message))?;
                            if cleared {
                                retry_or_dead_letter_code_match_job(pool, job, &message).await?;
                            }
                            continue;
                        }
                        // Once a pinned-commit proof has failed, keep this job
                        // retryable even if the next batch cannot mint a token.
                        // Dead-lettering here would strand a report with no
                        // hints row; the marker also prevents any future claim
                        // from reaching code search before proof recovers.
                        release_code_match_after_unproven_pinned_commit(
                            pool,
                            job,
                            computed_at_sha,
                            verification_retry_repo,
                            job.verification_retry_count,
                            false,
                            &message,
                        )
                        .await?;
                    } else if let Some(retry) = job.content_retry() {
                        let mapping_changed = job
                            .repo_full_name
                            .as_deref()
                            .is_some_and(|repo| !same_code_match_repo(repo, retry.repo_full_name));
                        if mapping_changed {
                            let cleared = reset_code_match_verification_retry(
                                pool,
                                job.report_id,
                                job.claim_token,
                            )
                            .await
                            .map_err(|error| anyhow::anyhow!(error.message))?;
                            if cleared {
                                retry_or_dead_letter_code_match_job(pool, job, &message).await?;
                            }
                            continue;
                        }
                        let incomplete = IncompleteCodeMatchContent {
                            reason: retry.reason.to_owned(),
                            file: retry.file.map(str::to_owned),
                            required_content: retry.required_content,
                            pending_verification: retry.candidates.cloned(),
                            error: message.clone(),
                        };
                        release_code_match_after_incomplete_content(
                            pool,
                            job,
                            retry.computed_at_sha,
                            retry.repo_full_name,
                            job.verification_retry_count,
                            &incomplete,
                        )
                        .await?;
                    } else {
                        retry_or_dead_letter_code_match_job(pool, job, &message).await?;
                    }
                }
                tracing::warn!(
                    installation_id,
                    jobs = installation_jobs.len(),
                    error = %error,
                    "code-match installation token failed; jobs retried or dead-lettered"
                );
                continue;
            }
        };

        let mut budget = InstallationSearchBudget::new();
        let mut content_budget = InstallationContentBudget::new();
        let mut next_search_at = tokio::time::Instant::now();
        let mut quota_retry_at = None;
        let mut head_sha_by_repo = BTreeMap::<(String, String), String>::new();
        let mut content_by_file = BTreeMap::<(String, String, String), PinnedFileContent>::new();
        for (index, job) in installation_jobs.iter().enumerate() {
            let outcome = process_code_match_job(
                pool,
                github,
                &token,
                job,
                &mut budget,
                &mut content_budget,
                &mut next_search_at,
                &mut quota_retry_at,
                &mut head_sha_by_repo,
                &mut content_by_file,
            )
            .await?;
            if let CodeMatchJobOutcome::BackoffInstallation { until, error } = outcome {
                for pending in &installation_jobs[index + 1..] {
                    release_code_match_job(
                        pool,
                        pending.report_id,
                        pending.claim_token,
                        until,
                        Some(&error),
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))?;
                }
                tracing::warn!(
                    installation_id,
                    retry_at = %until,
                    %error,
                    "code-match installation batch backed off"
                );
                break;
            }
        }
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "the arguments make the per-installation shared quota and caches explicit"
)]
async fn process_code_match_job(
    pool: &PgPool,
    github: &GithubAppClient,
    token: &crate::github::GithubInstallationToken,
    job: &CodeMatchJob,
    budget: &mut InstallationSearchBudget,
    content_budget: &mut InstallationContentBudget,
    next_search_at: &mut tokio::time::Instant,
    quota_retry_at: &mut Option<DateTime<Utc>>,
    head_sha_by_repo: &mut BTreeMap<(String, String), String>,
    content_by_file: &mut BTreeMap<(String, String, String), PinnedFileContent>,
) -> anyhow::Result<CodeMatchJobOutcome> {
    let repo_full_name = job
        .repo_full_name
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("claimed code-match job is missing its repository"))?;
    let default_branch = job
        .default_branch
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("claimed code-match job is missing its default branch"))?;
    let pinned_commit_verifier = GithubPinnedCommitVerifier { github, token };
    let verification_retry_count = match preflight_code_match_verification_retry(
        pool,
        &pinned_commit_verifier,
        job,
        repo_full_name,
    )
    .await?
    {
        CodeMatchVerificationPreflight::Proceed { retry_count } => retry_count,
        CodeMatchVerificationPreflight::Stop(outcome) => return Ok(outcome),
    };
    let content_preflight = preflight_code_match_content_retry(
        pool,
        &pinned_commit_verifier,
        job,
        repo_full_name,
        verification_retry_count,
        content_budget,
        content_by_file,
    )
    .await?;
    let (computed_at_sha, verification_retry_count, resumed_verification) = match content_preflight
    {
        CodeMatchContentPreflight::RetrySha {
            computed_at_sha,
            retry_count,
        } => (computed_at_sha, retry_count, None),
        CodeMatchContentPreflight::Resume {
            computed_at_sha,
            retry_count,
            verification,
        } => (computed_at_sha, retry_count, Some(verification)),
        CodeMatchContentPreflight::Stop(outcome) => return Ok(outcome),
        CodeMatchContentPreflight::Fresh { retry_count } => {
            let repo_key = (repo_full_name.to_owned(), default_branch.to_owned());
            let computed_at_sha = if let Some(sha) = head_sha_by_repo.get(&repo_key) {
                sha.clone()
            } else {
                match github
                    .repository_head_sha(token, repo_full_name, default_branch)
                    .await
                {
                    Ok(sha) => {
                        head_sha_by_repo.insert(repo_key, sha.clone());
                        sha
                    }
                    Err(error) => {
                        let message = format!("GitHub repository HEAD failed: {error}");
                        let until =
                            retry_or_dead_letter_code_match_job(pool, job, &message).await?;
                        let Some(until) = until else {
                            return Ok(CodeMatchJobOutcome::Continue);
                        };
                        return Ok(CodeMatchJobOutcome::BackoffInstallation {
                            until,
                            error: message,
                        });
                    }
                }
            };
            // A fresh search can return ten distinct files. Require a complete
            // per-attempt verification slice before spending the scarcer
            // search quota. If later queries discover more than ten files,
            // their durable pending payload continues without another search.
            if content_budget.remaining() < CODE_MATCH_CONTENT_FETCHES_PER_INSTALLATION_BATCH {
                let incomplete = IncompleteCodeMatchContent {
                    reason: "content_budget".to_owned(),
                    file: None,
                    required_content: i32::try_from(
                        CODE_MATCH_CONTENT_FETCHES_PER_INSTALLATION_BATCH,
                    )
                    .unwrap_or(i32::MAX),
                    pending_verification: None,
                    error: "installation lacks a complete content-verification slice before search"
                        .to_owned(),
                };
                return release_code_match_after_incomplete_content(
                    pool,
                    job,
                    &computed_at_sha,
                    repo_full_name,
                    retry_count,
                    &incomplete,
                )
                .await;
            }
            (computed_at_sha, retry_count, None)
        }
    };

    let pending_verification = if let Some(verification) = resumed_verification {
        // Search already completed before this content retry was persisted.
        // Resume the durable candidate set; never spend those search calls a
        // second time.
        verification
    } else {
        let stored_findings =
            serde_json::from_value::<Vec<StoredCodeMatchFinding>>(job.findings.clone())
                .unwrap_or_default();
        let match_findings = stored_findings
            .iter()
            .map(|finding| CodeMatchFinding {
                kind: &finding.kind,
                topic: &finding.topic,
            })
            .collect::<Vec<_>>();
        let queries = derive_queries(CodeMatchInput {
            repo_full_name,
            path_prefix: job.path_prefix.as_deref(),
            operation: &job.operation,
            surface: &job.surface,
            runtime_hint: job.runtime_hint.as_deref(),
            findings: &match_findings,
        });
        let query_count = queries.len();
        let mut calls_attempted = 0;
        let mut successful_queries = 0;
        let mut invalid_request_errors = Vec::new();
        let mut verification = CodeMatchVerificationTracker::default();
        let mut pending = Vec::new();
        let mut resolved = Vec::new();
        for query in queries {
            if !budget.take() {
                break;
            }
            tokio::time::sleep_until(*next_search_at).await;
            let started_at = std::time::Instant::now();
            match github.search_code(token, &query.expression).await {
                Ok(result) => {
                    calls_attempted += 1;
                    let hit = !result.candidates.is_empty();
                    record_code_match_call(
                        pool,
                        job.report_id,
                        result.rate_limit.remaining,
                        hit,
                        elapsed_millis(started_at),
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))?;
                    successful_queries += 1;
                    budget.observe_headroom(result.rate_limit.remaining);
                    let delay = code_search_pacing_delay(&result.rate_limit, Utc::now());
                    *next_search_at = tokio::time::Instant::now() + delay;
                    if result.rate_limit.remaining == Some(0) {
                        *quota_retry_at =
                            Some(code_search_retry_at(&result.rate_limit, Utc::now()));
                    }
                    let candidates = drop_fragmentless_code_search_candidates(
                        result.candidates,
                        &mut verification,
                    );
                    resolved.push(CodeSearchMatches {
                        query: query.clone(),
                        candidates: Vec::new(),
                    });
                    pending.push(PendingGithubCodeSearchMatches { query, candidates });
                }
                Err(error) => {
                    calls_attempted += 1;
                    let rate_limit = error.rate_limit().clone();
                    record_code_match_call(
                        pool,
                        job.report_id,
                        rate_limit.remaining,
                        false,
                        elapsed_millis(started_at),
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))?;
                    let kind = error.kind();
                    let message = error.to_string();
                    match kind {
                        GithubCodeSearchFailureKind::RateLimit => {
                            let until = code_search_retry_at(&rate_limit, Utc::now());
                            release_code_match_job(
                                pool,
                                job.report_id,
                                job.claim_token,
                                until,
                                Some(&message),
                            )
                            .await
                            .map_err(|error| anyhow::anyhow!(error.message))?;
                            return Ok(CodeMatchJobOutcome::BackoffInstallation {
                                until,
                                error: message,
                            });
                        }
                        GithubCodeSearchFailureKind::InvalidRequest => {
                            invalid_request_errors.push(message);
                        }
                        GithubCodeSearchFailureKind::Forbidden => {
                            let reason = format!("permanent GitHub code-search failure: {message}");
                            dead_letter_owned_code_match_job(pool, job, &reason).await?;
                            return Ok(CodeMatchJobOutcome::Continue);
                        }
                        GithubCodeSearchFailureKind::Unauthorized
                        | GithubCodeSearchFailureKind::NotFound
                        | GithubCodeSearchFailureKind::Server
                        | GithubCodeSearchFailureKind::Timeout
                        | GithubCodeSearchFailureKind::InvalidResponse
                        | GithubCodeSearchFailureKind::Transport => {
                            let until =
                                retry_or_dead_letter_code_match_job(pool, job, &message).await?;
                            let Some(until) = until else {
                                return Ok(CodeMatchJobOutcome::Continue);
                            };
                            return Ok(CodeMatchJobOutcome::BackoffInstallation {
                                until,
                                error: message,
                            });
                        }
                    }
                }
            }
        }

        if every_code_search_query_was_invalid(
            query_count,
            calls_attempted,
            invalid_request_errors.len(),
        ) {
            let reason = format!(
                "all {query_count} GitHub code-search queries were invalid: {}",
                invalid_request_errors.join("; ")
            );
            dead_letter_owned_code_match_job(pool, job, &reason).await?;
            return Ok(CodeMatchJobOutcome::Continue);
        }

        if query_count > 0 && successful_queries == 0 {
            let until = quota_retry_at.unwrap_or_else(|| Utc::now() + Duration::minutes(1));
            let error = invalid_request_errors.last().map(String::as_str);
            release_code_match_job(pool, job.report_id, job.claim_token, until, error)
                .await
                .map_err(|error| anyhow::anyhow!(error.message))?;
            return Ok(CodeMatchJobOutcome::Continue);
        }

        PendingCodeMatchVerification {
            pending,
            resolved,
            verification,
        }
    };

    let (matches, verification) = match resolve_pending_code_search_candidates(
        github,
        token,
        job.report_id,
        repo_full_name,
        &computed_at_sha,
        pending_verification,
        content_budget,
        content_by_file,
    )
    .await?
    {
        PendingCodeMatchResolution::Complete {
            matches,
            verification,
        } => (matches, verification),
        PendingCodeMatchResolution::Incomplete(incomplete) => {
            return release_code_match_after_incomplete_content(
                pool,
                job,
                &computed_at_sha,
                repo_full_name,
                verification_retry_count,
                &incomplete,
            )
            .await;
        }
    };

    settle_and_complete_code_match_job(
        pool,
        &pinned_commit_verifier,
        job,
        repo_full_name,
        CodeMatchSettlement {
            computed_at_sha: &computed_at_sha,
            matches,
            verification,
            verification_retry_count,
        },
    )
    .await
}

async fn preflight_code_match_verification_retry(
    pool: &PgPool,
    verifier: &impl PinnedCommitVerifier,
    job: &CodeMatchJob,
    repo_full_name: &str,
) -> anyhow::Result<CodeMatchVerificationPreflight> {
    let Some((computed_at_sha, verification_retry_repo)) = job.verification_retry() else {
        return Ok(CodeMatchVerificationPreflight::Proceed {
            retry_count: job.verification_retry_count,
        });
    };
    if !same_code_match_repo(verification_retry_repo, repo_full_name) {
        // The SHA belongs to the repository recorded when verification first
        // failed. A supported product remap makes that proof irrelevant: clear
        // the whole episode before any GitHub call, then run fresh against the
        // current mapping without charging the verification-retry ceiling.
        let cleared = reset_code_match_verification_retry(pool, job.report_id, job.claim_token)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        if !cleared {
            tracing::warn!(
                report_id = %job.report_id,
                "code-match remap reset lost its claim fencing race"
            );
            return Ok(CodeMatchVerificationPreflight::Stop(
                CodeMatchJobOutcome::Continue,
            ));
        }
        return Ok(CodeMatchVerificationPreflight::Proceed { retry_count: 0 });
    }
    if let Err(error) = verifier
        .pinned_commit_is_fetchable(verification_retry_repo, computed_at_sha)
        .await
    {
        let message = format!("GitHub pinned commit remains unavailable: {error}");
        return release_code_match_after_unproven_pinned_commit(
            pool,
            job,
            computed_at_sha,
            verification_retry_repo,
            job.verification_retry_count,
            error.kind().counts_toward_verification_ceiling(),
            &message,
        )
        .await
        .map(CodeMatchVerificationPreflight::Stop);
    }
    let cleared = clear_code_match_verification_retry_marker(pool, job.report_id, job.claim_token)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    if !cleared {
        tracing::warn!(
            report_id = %job.report_id,
            "code-match verification retry preflight lost its claim fencing race"
        );
        return Ok(CodeMatchVerificationPreflight::Stop(
            CodeMatchJobOutcome::Continue,
        ));
    }
    Ok(CodeMatchVerificationPreflight::Proceed {
        retry_count: job.verification_retry_count,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "content retry preflight owns the shared installation budget and pinned-file cache"
)]
async fn preflight_code_match_content_retry(
    pool: &PgPool,
    verifier: &impl PinnedCommitVerifier,
    job: &CodeMatchJob,
    repo_full_name: &str,
    verification_retry_count: i32,
    budget: &mut InstallationContentBudget,
    content_by_file: &mut BTreeMap<(String, String, String), PinnedFileContent>,
) -> anyhow::Result<CodeMatchContentPreflight> {
    let Some(retry) = job.content_retry() else {
        return Ok(CodeMatchContentPreflight::Fresh {
            retry_count: verification_retry_count,
        });
    };
    if !same_code_match_repo(retry.repo_full_name, repo_full_name) {
        let cleared = reset_code_match_verification_retry(pool, job.report_id, job.claim_token)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        if !cleared {
            tracing::warn!(
                report_id = %job.report_id,
                "code-match content retry remap reset lost its claim fencing race"
            );
            return Ok(CodeMatchContentPreflight::Stop(
                CodeMatchJobOutcome::Continue,
            ));
        }
        return Ok(CodeMatchContentPreflight::Fresh { retry_count: 0 });
    }

    let required_content = usize::try_from(retry.required_content).unwrap_or(usize::MAX);
    let required_slice = required_content.min(CODE_MATCH_CONTENT_FETCHES_PER_INSTALLATION_BATCH);
    if budget.remaining() < required_slice {
        let incomplete = IncompleteCodeMatchContent {
            reason: retry.reason.to_owned(),
            file: retry.file.map(str::to_owned),
            required_content: retry.required_content,
            pending_verification: retry.candidates.cloned(),
            error: format!(
                "content verification needs a {required_slice}-fetch slice but only {} remain",
                budget.remaining()
            ),
        };
        return release_code_match_after_incomplete_content(
            pool,
            job,
            retry.computed_at_sha,
            retry.repo_full_name,
            job.verification_retry_count,
            &incomplete,
        )
        .await
        .map(CodeMatchContentPreflight::Stop);
    }

    if retry.reason == "content_fetch" {
        let file = retry
            .file
            .context("content-fetch retry is missing its file")?;
        anyhow::ensure!(budget.take(), "reserved content retry budget disappeared");
        let key = (
            normalized_code_match_repo(retry.repo_full_name),
            retry.computed_at_sha.to_owned(),
            file.to_owned(),
        );
        let content = match verifier
            .pinned_file_content(retry.repo_full_name, file, retry.computed_at_sha)
            .await
        {
            Ok(content) => PinnedFileContent::Content(content),
            Err(error) => pinned_file_content_for_failure(error.kind()),
        };
        if let PinnedFileContent::Incomplete(failure_kind) = &content {
            let incomplete = IncompleteCodeMatchContent {
                reason: "content_fetch".to_owned(),
                file: Some(file.to_owned()),
                required_content: retry.required_content,
                pending_verification: retry.candidates.cloned(),
                error: format!(
                    "GitHub pinned file remains unverifiable at the retry SHA: {failure_kind:?}"
                ),
            };
            return release_code_match_after_incomplete_content(
                pool,
                job,
                retry.computed_at_sha,
                retry.repo_full_name,
                job.verification_retry_count,
                &incomplete,
            )
            .await
            .map(CodeMatchContentPreflight::Stop);
        }
        content_by_file.insert(key, content);
    }

    // Keep the durable candidate payload on the claimed row until genuine
    // settlement. If the worker crashes after this preflight, stale-claim
    // recovery resumes contents work instead of regenerating search hits.
    if let Some(candidates) = retry.candidates {
        let verification = serde_json::from_value(candidates.clone())
            .context("code-match pending verification payload was invalid")?;
        Ok(CodeMatchContentPreflight::Resume {
            computed_at_sha: retry.computed_at_sha.to_owned(),
            retry_count: job.verification_retry_count,
            verification,
        })
    } else {
        Ok(CodeMatchContentPreflight::RetrySha {
            computed_at_sha: retry.computed_at_sha.to_owned(),
            retry_count: job.verification_retry_count,
        })
    }
}

async fn settle_and_complete_code_match_job(
    pool: &PgPool,
    verifier: &impl PinnedCommitVerifier,
    job: &CodeMatchJob,
    repo_full_name: &str,
    settlement: CodeMatchSettlement<'_>,
) -> anyhow::Result<CodeMatchJobOutcome> {
    let CodeMatchSettlement {
        computed_at_sha,
        matches,
        mut verification,
        verification_retry_count,
    } = settlement;
    let has_provisional_absence = matches.iter().any(|matches| {
        matches
            .candidates
            .iter()
            .any(CodeSearchCandidate::is_file_not_found)
    });
    let matches = if has_provisional_absence {
        // GitHub's contents endpoint uses 404 for a missing path, lost access,
        // and an unavailable ref. Prove this exact immutable commit with a
        // fresh request for every job before interpreting any 404 as absence.
        // A changed branch HEAD still counts as success: it is deliberately
        // neither fetched nor compared, because only this pinned SHA matters.
        if let Err(error) = verifier
            .pinned_commit_is_fetchable(repo_full_name, computed_at_sha)
            .await
        {
            let message = format!("GitHub pinned commit could not be verified: {error}");
            return release_code_match_after_unproven_pinned_commit(
                pool,
                job,
                computed_at_sha,
                repo_full_name,
                verification_retry_count,
                error.kind().counts_toward_verification_ceiling(),
                &message,
            )
            .await;
        }
        let (matches, dropped_as_absent) = settle_file_not_found_candidates(matches);
        verification.observe_absent(dropped_as_absent);
        matches
    } else {
        matches
    };
    let unverified_dropped = verification.unverified_dropped() > 0;
    let verification = verification.finish(&matches);
    let hints = rank_matches(matches);
    let stored_outcome = if hints.is_empty() {
        if unverified_dropped {
            "unverified_dropped"
        } else if verification.dropped_as_absent > 0 {
            "proven_absent"
        } else {
            "no_match"
        }
    } else {
        "matched"
    };
    let hints_json = code_hints_json(hints);
    // Invariant: every stored hint was verified to exist at computed_at_sha.
    // Fragmentless candidates are dropped; incomplete contents work requeues.
    // A ceiling-exhausted retry writes `terminal_unverifiable` atomically with
    // its dead letter and zero-count analytics row.
    let completed = complete_code_match_job(
        pool,
        job.report_id,
        job.claim_token,
        CodeMatchCompletion {
            attempt: job.attempts,
            computed_at_sha,
            hints: hints_json,
            verification,
            outcome: stored_outcome,
        },
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    if !completed {
        tracing::warn!(
            report_id = %job.report_id,
            "code-match completion lost its claim fencing race"
        );
    }
    Ok(CodeMatchJobOutcome::Continue)
}

async fn release_code_match_after_unproven_pinned_commit(
    pool: &PgPool,
    job: &CodeMatchJob,
    computed_at_sha: &str,
    repo_full_name: &str,
    verification_retry_count: i32,
    counts_toward_ceiling: bool,
    error: &str,
) -> anyhow::Result<CodeMatchJobOutcome> {
    let next_verification_retry =
        verification_retry_count.saturating_add(i32::from(counts_toward_ceiling));
    let until = generic_code_match_retry_at(next_verification_retry);
    if counts_toward_ceiling && next_verification_retry >= CODE_MATCH_MAX_VERIFICATION_RETRIES {
        let reason = format!(
            "pinned-commit verification retry ceiling {CODE_MATCH_MAX_VERIFICATION_RETRIES} reached: {error}"
        );
        // A preflight failure has no successfully computed revision. Persist
        // the marker SHA only as the intended verification target; the
        // explicit `terminal_unverifiable` outcome is what prevents readers
        // from interpreting this row as a successful computation at that SHA.
        let terminal = terminally_dead_letter_code_match_verification(
            pool,
            job.report_id,
            job.claim_token,
            job.attempts,
            computed_at_sha,
            &reason,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
        if !terminal {
            tracing::warn!(
                report_id = %job.report_id,
                "code-match terminal verification transition lost its claim fencing race"
            );
            return Ok(CodeMatchJobOutcome::Continue);
        }
        tracing::warn!(
            report_id = %job.report_id,
            verification_retries = next_verification_retry,
            %reason,
            "code-match verification retry ceiling reached"
        );
        return Ok(CodeMatchJobOutcome::BackoffInstallation {
            until,
            error: reason,
        });
    }
    let released = release_code_match_for_verification_retry(
        pool,
        job.report_id,
        job.claim_token,
        CodeMatchVerificationRetry {
            target: CodeMatchVerificationRetryTarget::PinnedCommit {
                computed_at_sha,
                repo_full_name: &normalized_code_match_repo(repo_full_name),
            },
            counts_toward_ceiling,
            available_at: until,
            error,
        },
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    if !released {
        tracing::warn!(
            report_id = %job.report_id,
            "code-match pinned-commit retry lost its claim fencing race"
        );
        return Ok(CodeMatchJobOutcome::Continue);
    }
    Ok(CodeMatchJobOutcome::BackoffInstallation {
        until,
        error: error.to_owned(),
    })
}

async fn release_code_match_after_incomplete_content(
    pool: &PgPool,
    job: &CodeMatchJob,
    computed_at_sha: &str,
    repo_full_name: &str,
    verification_retry_count: i32,
    incomplete: &IncompleteCodeMatchContent,
) -> anyhow::Result<CodeMatchJobOutcome> {
    let next_verification_retry = verification_retry_count.saturating_add(1);
    let until = generic_code_match_retry_at(next_verification_retry);
    if next_verification_retry >= CODE_MATCH_MAX_VERIFICATION_RETRIES {
        let reason = format!(
            "content verification retry ceiling {CODE_MATCH_MAX_VERIFICATION_RETRIES} reached: {}",
            incomplete.error
        );
        let terminal = terminally_dead_letter_code_match_verification(
            pool,
            job.report_id,
            job.claim_token,
            job.attempts,
            computed_at_sha,
            &reason,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
        if !terminal {
            tracing::warn!(
                report_id = %job.report_id,
                "code-match terminal content transition lost its claim fencing race"
            );
            return Ok(CodeMatchJobOutcome::Continue);
        }
        return Ok(CodeMatchJobOutcome::BackoffInstallation {
            until,
            error: reason,
        });
    }

    let normalized_repo = normalized_code_match_repo(repo_full_name);
    let released = release_code_match_for_verification_retry(
        pool,
        job.report_id,
        job.claim_token,
        CodeMatchVerificationRetry {
            target: CodeMatchVerificationRetryTarget::Content {
                reason: &incomplete.reason,
                computed_at_sha,
                repo_full_name: &normalized_repo,
                file: incomplete.file.as_deref(),
                required_content: incomplete.required_content,
                candidates: incomplete.pending_verification.as_ref(),
            },
            counts_toward_ceiling: true,
            available_at: until,
            error: &incomplete.error,
        },
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    if !released {
        tracing::warn!(
            report_id = %job.report_id,
            "code-match content retry lost its claim fencing race"
        );
        return Ok(CodeMatchJobOutcome::Continue);
    }
    Ok(CodeMatchJobOutcome::BackoffInstallation {
        until,
        error: incomplete.error.clone(),
    })
}

fn drop_fragmentless_code_search_candidates(
    candidates: Vec<GithubCodeSearchCandidate>,
    verification: &mut CodeMatchVerificationTracker,
) -> Vec<GithubCodeSearchCandidate> {
    candidates
        .into_iter()
        .filter(|candidate| {
            if candidate.needs_content() {
                return true;
            }
            // Path existence would cost a contents call. The cheap future
            // option is GET /repos/{o}/{r}/git/trees/{sha}?recursive=1 once
            // per repo/SHA/batch, with `truncated: true` handled explicitly.
            verification.observe_unverified_drop(1);
            false
        })
        .collect()
}

fn pending_code_match_content_files(pending: &PendingCodeMatchVerification) -> usize {
    pending
        .pending
        .iter()
        .flat_map(|matches| matches.candidates.iter())
        .map(GithubCodeSearchCandidate::file)
        .collect::<BTreeSet<_>>()
        .len()
}

fn incomplete_pending_code_match_content(
    pending: &PendingCodeMatchVerification,
    reason: &str,
    file: Option<String>,
    error: String,
) -> anyhow::Result<IncompleteCodeMatchContent> {
    let required_content =
        i32::try_from(pending_code_match_content_files(pending)).unwrap_or(i32::MAX);
    Ok(IncompleteCodeMatchContent {
        reason: reason.to_owned(),
        file,
        required_content: required_content.max(1),
        pending_verification: Some(
            serde_json::to_value(pending)
                .context("code-match pending verification could not be serialized")?,
        ),
        error,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "the arguments keep pinned-SHA resolution and its installation budget explicit"
)]
async fn resolve_pending_code_search_candidates(
    github: &GithubAppClient,
    token: &crate::github::GithubInstallationToken,
    report_id: Uuid,
    repo_full_name: &str,
    computed_at_sha: &str,
    mut pending: PendingCodeMatchVerification,
    budget: &mut InstallationContentBudget,
    content_by_file: &mut BTreeMap<(String, String, String), PinnedFileContent>,
) -> anyhow::Result<PendingCodeMatchResolution> {
    while let Some(file) = pending
        .pending
        .iter()
        .flat_map(|matches| &matches.candidates)
        .next()
        .map(|candidate| candidate.file().to_owned())
    {
        let key = (
            normalized_code_match_repo(repo_full_name),
            computed_at_sha.to_owned(),
            file.clone(),
        );
        if !content_by_file.contains_key(&key) {
            if !budget.take() {
                return incomplete_pending_code_match_content(
                    &pending,
                    "content_budget",
                    None,
                    "installation content-verification slice was exhausted; pending candidates were preserved"
                        .to_owned(),
                )
                .map(PendingCodeMatchResolution::Incomplete);
            }
            // Contents calls use GitHub's core quota, not the code-search
            // quota represented by match_analytics. The candidate payload is
            // durable, so a release from here never regenerates search hits.
            let content = match github
                .repository_file_content(token, repo_full_name, &file, computed_at_sha)
                .await
            {
                Ok(content) => PinnedFileContent::Content(content),
                Err(error) => {
                    let failure_kind = error.kind();
                    if failure_kind == GithubFileContentFailureKind::NotFound {
                        tracing::debug!(
                            %report_id,
                            repo = repo_full_name,
                            %file,
                            "code-match pinned file returned a provisional 404"
                        );
                    } else {
                        tracing::warn!(
                            %report_id,
                            repo = repo_full_name,
                            %file,
                            ?failure_kind,
                            %error,
                            "code-match candidate could not be verified at the pinned SHA"
                        );
                    }
                    pinned_file_content_for_failure(failure_kind)
                }
            };
            content_by_file.insert(key.clone(), content);
        }

        let Some(content) = content_by_file.get(&key) else {
            return incomplete_pending_code_match_content(
                &pending,
                "content_fetch",
                Some(file),
                "pinned file classification was not cached".to_owned(),
            )
            .map(PendingCodeMatchResolution::Incomplete);
        };
        if let PinnedFileContent::Incomplete(failure_kind) = content {
            return incomplete_pending_code_match_content(
                &pending,
                "content_fetch",
                Some(file),
                format!("GitHub pinned file could not be verified: {failure_kind:?}"),
            )
            .map(PendingCodeMatchResolution::Incomplete);
        }

        for (pending_matches, resolved_matches) in
            pending.pending.iter_mut().zip(&mut pending.resolved)
        {
            let mut remaining = Vec::new();
            for candidate in std::mem::take(&mut pending_matches.candidates) {
                if candidate.file() != file {
                    remaining.push(candidate);
                    continue;
                }
                pending.verification.observe_candidates(1);
                match content {
                    PinnedFileContent::Content(content) => {
                        if let Some(candidate) = candidate.verify_against_pinned_content(content) {
                            resolved_matches.candidates.push(candidate);
                        } else {
                            pending.verification.observe_absent(1);
                            tracing::debug!(
                                %report_id,
                                repo = repo_full_name,
                                %file,
                                "dropping code-match fragment absent at the pinned SHA"
                            );
                        }
                    }
                    PinnedFileContent::FileNotFound => {
                        resolved_matches
                            .candidates
                            .push(candidate.into_file_not_found());
                    }
                    PinnedFileContent::Incomplete(_) => unreachable!(
                        "incomplete contents return before consuming pending candidates"
                    ),
                }
            }
            pending_matches.candidates = remaining;
        }
    }

    Ok(PendingCodeMatchResolution::Complete {
        matches: pending.resolved,
        verification: pending.verification,
    })
}

async fn retry_or_dead_letter_code_match_job(
    pool: &PgPool,
    job: &CodeMatchJob,
    error: &str,
) -> anyhow::Result<Option<DateTime<Utc>>> {
    if code_match_retry_exhausted(job.attempts) {
        let reason = format!("code-match attempt limit {CODE_MATCH_MAX_ATTEMPTS} reached: {error}");
        dead_letter_owned_code_match_job(pool, job, &reason).await?;
        return Ok(None);
    }
    let until = generic_code_match_retry_at(job.attempts);
    release_code_match_job(pool, job.report_id, job.claim_token, until, Some(error))
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    Ok(Some(until))
}

async fn dead_letter_owned_code_match_job(
    pool: &PgPool,
    job: &CodeMatchJob,
    reason: &str,
) -> anyhow::Result<()> {
    let dead_lettered = dead_letter_code_match_job(pool, job.report_id, job.claim_token, reason)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    if dead_lettered {
        tracing::warn!(
            report_id = %job.report_id,
            product_id = %job.product_id,
            %reason,
            "code-match job dead-lettered"
        );
    } else {
        tracing::warn!(
            report_id = %job.report_id,
            "code-match dead-letter transition lost its claim fencing race"
        );
    }
    Ok(())
}

fn code_hints_json(hints: Vec<CodeHintCandidate>) -> serde_json::Value {
    serde_json::Value::Array(
        hints
            .into_iter()
            .filter(|hint| hint.verified)
            .map(|hint| {
                json!({
                    "file": hint.file,
                    "line_start": hint.line_start,
                    "line_end": hint.line_end,
                    "match_reason": hint.match_reason,
                    // This key is now an invariant, not a variable. Keep it so
                    // chunk 3's publishable-hint filter remains compatible.
                    "verified": true,
                })
            })
            .collect(),
    )
}

fn elapsed_millis(started_at: std::time::Instant) -> i64 {
    i64::try_from(started_at.elapsed().as_millis()).unwrap_or(i64::MAX)
}

const fn every_code_search_query_was_invalid(
    query_count: usize,
    calls_attempted: usize,
    invalid_requests: usize,
) -> bool {
    query_count > 0 && calls_attempted == query_count && invalid_requests == query_count
}

const fn code_match_retry_exhausted(attempts: i32) -> bool {
    attempts >= CODE_MATCH_MAX_ATTEMPTS
}

fn generic_code_match_retry_at(attempts: i32) -> DateTime<Utc> {
    let exponent = u32::try_from(attempts.clamp(0, 6)).unwrap_or(6);
    Utc::now() + Duration::seconds(5 * 2_i64.pow(exponent))
}

fn code_search_pacing_delay(
    rate_limit: &GithubRateLimit,
    now: DateTime<Utc>,
) -> std::time::Duration {
    if let Some(retry_after) = rate_limit.retry_after {
        return retry_after;
    }
    if let (Some(remaining), Some(reset_at)) = (rate_limit.remaining, rate_limit.reset_at)
        && let (Ok(remaining), Ok(until_reset)) =
            (u32::try_from(remaining.max(1)), (reset_at - now).to_std())
    {
        return (until_reset / remaining).max(std::time::Duration::from_secs(1));
    }
    CODE_MATCH_DEFAULT_PACE
}

fn code_search_retry_at(rate_limit: &GithubRateLimit, now: DateTime<Utc>) -> DateTime<Utc> {
    if let Some(retry_after) = rate_limit.retry_after
        && let Ok(retry_after) = Duration::from_std(retry_after)
    {
        return now + retry_after;
    }
    rate_limit
        .reset_at
        .filter(|reset_at| *reset_at > now)
        .map_or(now + Duration::minutes(1), |reset_at| {
            reset_at + Duration::seconds(1)
        })
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
    headers
        .entry("referrer-policy")
        .or_insert(HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.entry("content-security-policy").or_insert_with(|| {
        HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    });
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
            capability_inspection_url: format!(
                "{public_base_url}/api/v2/capabilities/introspect"
            ),
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
                prompt: "May I send this product's provider one short, privacy-safe outcome report about this use? Your prompts and task content will not be included.".to_owned(),
                ask_once_prompt: "May I send this product's provider one short, privacy-safe outcome report after this use and future uses without asking again? Epode will remember your choice for this product. Your prompts and task content are never included; nothing is installed.".to_owned(),
                ask_always_prompt: "May I send this product's provider one short, privacy-safe outcome report about this use? Your prompts and task content will not be included.".to_owned(),
                ask_once_scope:
                    "continuing scope only when the SDK receives a stable opaque customerRef; otherwise the per-use prompt applies"
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
                "{public_base_url}/static/agent-feedback-node-0.4.0.tgz"
            ),
            python: format!(
                "{public_base_url}/static/agent_feedback-0.4.0-py3-none-any.whl"
            ),
            go: format!("{public_base_url}/static/agent-feedback-go-0.4.0.tar.gz"),
            rust: format!(
                "{public_base_url}/static/agent-feedback-rust-0.4.0.tar.gz"
            ),
            protocol: format!(
                "{public_base_url}/static/agent-feedback-protocol-v1-0.4.0.zip"
            ),
        },
        integrity_manifest: format!(
            "{public_base_url}/static/agent-feedback-integrations-0.4.0.json"
        ),
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
    params(AuthStartQuery),
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
async fn auth_start(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthStartQuery>,
) -> Result<Response, ApiError> {
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
    if let Some(return_to) = validated_return_to(query.return_to.as_deref()) {
        append_cookie(
            &mut response,
            &http_only_cookie(
                AUTH_RETURN_TO_COOKIE,
                &URL_SAFE_NO_PAD.encode(return_to),
                600,
                state.secure_cookies,
            ),
        )?;
    } else {
        append_cookie(
            &mut response,
            &clear_cookie(AUTH_RETURN_TO_COOKIE, state.secure_cookies),
        )?;
    }
    Ok(response)
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct AuthStartQuery {
    /// Same-origin relative dashboard path restored after authentication.
    return_to: Option<String>,
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
    let return_to = auth_return_to(&headers);
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
        None => return_to.unwrap_or_else(|| "/".into()),
    };
    let mut response = Redirect::to(&redirect).into_response();
    attach_token_cookies(&mut response, &state, &tokens)?;
    clear_flow_cookies(&mut response, &state)?;
    append_cookie(&mut response, &dev_auth::clear_dev_cookie())?;
    append_cookie(
        &mut response,
        &clear_cookie(TEAM_INVITE_COOKIE, state.secure_cookies),
    )?;
    Ok(response)
}

/// The one spelling of the install endpoint's team query parameter.
///
/// The `OpenAPI` annotation and the parser must agree on it;
/// `github_install_query_parameter_is_documented` pins that.
const WORKSPACE_ID_QUERY_PARAM: &str = "workspaceId";

/// Header wins when both are supplied; the query parameter is the no-header
/// fallback. Neither is trusted on its own — the winner is handed to
/// `dashboard_auth`, which rejects a team the caller is not a member of.
///
/// Takes the RAW query string rather than a deserialized value: an extractor
/// would reject a malformed or repeated `workspaceId` before this function
/// could decide it was irrelevant, which is how header precedence kept getting
/// defeated. With a valid header the query is parsed but never consulted.
///
/// Without a header the parameter decides the team, so it must be unambiguous:
/// exactly one well-formed value is used, no value keeps the caller's default
/// team, and anything else fails loudly. A repeated parameter is rejected
/// rather than resolved by first-or-last-wins, because the two orders disagree
/// about which team gets the installation.
fn install_workspace_id(
    header_workspace_id: Option<Uuid>,
    raw_query: Option<&str>,
) -> Result<Option<Uuid>, ApiError> {
    if let Some(workspace_id) = header_workspace_id {
        return Ok(Some(workspace_id));
    }
    let values = raw_query.map_or_else(Vec::new, |query| {
        form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == WORKSPACE_ID_QUERY_PARAM)
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>()
    });
    match values.as_slice() {
        [] => Ok(None),
        [value] => Uuid::parse_str(value)
            .map(Some)
            .map_err(|_| ApiError::bad_request("Invalid workspaceId query parameter")),
        _ => Err(ApiError::bad_request(
            "Repeated workspaceId query parameter",
        )),
    }
}

#[utoipa::path(
    get,
    path = "/api/github/install",
    tag = "github",
    params(
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; wins over workspaceId when both are present"),
        ("workspaceId" = Option<Uuid>, Query, description = "Team to configure when the x-workspace-id header cannot be sent, as on a plain link. Ignored when the header is present; must appear at most once."),
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
        (status = 400, description = "Invalid team header, or an unusable workspaceId with no team header", body = ApiErrorEnvelope),
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
    RawQuery(raw_query): RawQuery,
) -> Result<Response, ApiError> {
    // The install entry point is a plain top-level link, so it cannot set the
    // x-workspace-id header the rest of the dashboard API uses. Accept the team
    // as a query parameter too, and resolve it through the SAME dashboard_auth
    // path: `resolve_workspace_access` is what proves membership, so a crafted
    // link cannot install into a team the caller does not belong to.
    let requested_workspace =
        install_workspace_id(requested_workspace_id(&headers)?, raw_query.as_deref())?;
    let (context, tokens) = dashboard_auth(&state, &headers, requested_workspace).await?;
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

#[utoipa::path(
    get,
    path = "/api/products/{product_id}/github-repo",
    tag = "github",
    params(
        ("product_id" = Uuid, Path, description = "Product whose GitHub repository mapping is requested"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Current product repository mapping, or null when unconfigured", body = Option<ProductGithubRepo>),
        (
            status = 400,
            description = "Invalid product path or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found for this team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Repository mapping could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn product_github_repo_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let mapping = get_product_github_repo(&state.pool, context.workspace.id, product_id).await?;
    dashboard_response(&state, Json(mapping), tokens)
}

#[utoipa::path(
    put,
    path = "/api/products/{product_id}/github-repo",
    tag = "github",
    params(
        ("product_id" = Uuid, Path, description = "Product whose GitHub repository mapping is configured"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = ProductGithubRepoInput,
    responses(
        (status = 200, description = "Product repository mapping saved", body = ProductGithubRepo),
        (
            status = 400,
            description = "Invalid product path, team header, repository mapping, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product or active GitHub installation not found for this team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the repository mapping schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Repository mapping could not be saved", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn set_product_github_repo_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
    Json(input): Json<ProductGithubRepoInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    validate_repo_full_name(&input.repo_full_name)
        .map_err(|_| ApiError::bad_request("Repository name must use the owner/name form"))?;
    let mapping =
        set_product_github_repo(&state.pool, context.workspace.id, product_id, &input).await?;
    dashboard_response(&state, Json(mapping), tokens)
}

#[utoipa::path(
    delete,
    path = "/api/products/{product_id}/github-repo",
    tag = "github",
    params(
        ("product_id" = Uuid, Path, description = "Product whose GitHub repository mapping is removed"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Product repository mapping removed when present", body = RemovedResponse),
        (
            status = 400,
            description = "Invalid product path or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found for this team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Repository mapping could not be removed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn clear_product_github_repo_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let removed = clear_product_github_repo(&state.pool, context.workspace.id, product_id).await?;
    dashboard_response(&state, Json(RemovedResponse { removed }), tokens)
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct ProductGroupsQuery {
    /// Maximum groups returned, from 1 to 100.
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    /// Number of groups to skip.
    #[param(default = 0, minimum = 0)]
    offset: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/products/{product_id}/groups",
    tag = "github",
    params(
        ("product_id" = Uuid, Path, description = "Product whose report groups are listed"),
        ProductGroupsQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Paginated report groups with linked GitHub issues", body = ProductGroupsResponse),
        (
            status = 400,
            description = "Invalid product path, pagination, or team header",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found for this team", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "Report groups could not be listed", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn product_groups_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<Uuid>,
    Query(query): Query<ProductGroupsQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || offset < 0 {
        return Err(ApiError::bad_request(
            "Group pagination must use a limit from 1 to 100 and a non-negative offset",
        ));
    }
    let page =
        list_product_groups(&state.pool, context.workspace.id, product_id, limit, offset).await?;
    let mut spawned_syncs = 0_usize;
    let mut dropped_syncs = 0_usize;
    let sync_checked_at = Utc::now();
    for listed in &page.groups {
        if group_issue_sync_needed(
            listed.group.github_issue.is_some(),
            listed.needs_reconciliation,
            listed.group.report_count,
            listed.last_commented_report_count,
            listed.state_refreshed_at,
            sync_checked_at,
        ) {
            if spawned_syncs >= MAX_GROUP_ISSUE_SYNCS_PER_REQUEST {
                dropped_syncs += 1;
                continue;
            }
            spawn_group_issue_sync(
                Arc::clone(&state),
                context.workspace.id,
                listed.group.group_key.clone(),
            );
            spawned_syncs += 1;
        }
    }
    if dropped_syncs > 0 {
        tracing::warn!(
            workspace_id = %context.workspace.id,
            %product_id,
            dropped_syncs,
            cap = MAX_GROUP_ISSUE_SYNCS_PER_REQUEST,
            "GitHub issue sync fan-out capped; deferred groups will retry on a later listing"
        );
    }
    let groups = page.groups.into_iter().map(|listed| listed.group).collect();
    dashboard_response(
        &state,
        Json(ProductGroupsResponse {
            groups,
            limit,
            offset,
            has_more: page.has_more,
        }),
        tokens,
    )
}

fn valid_report_group_key(group_key: &str) -> bool {
    group_key.len() == 32
        && group_key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[utoipa::path(
    post,
    path = "/api/groups/{group_key}/merge",
    tag = "github",
    params(
        ("group_key" = String, Path, description = "Source report group that will be merged away"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    request_body = MergeReportGroupsInput,
    responses(
        (status = 200, description = "Reports moved and durable merge lineage recorded", body = MergeReportGroupsResponse),
        (
            status = 400,
            description = "Invalid group key, self-merge, team header, or malformed JSON body",
            content(
                (ApiErrorEnvelope = "application/json"),
                (String = "text/plain")
            )
        ),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot edit the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Source or target group not found for this team", body = ApiErrorEnvelope),
        (status = 409, description = "Groups belong to different products, merge lineage would chain, or both groups have filed GitHub issues", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 413, description = "Request body exceeds the configured limit", body = String, content_type = "text/plain"),
        (status = 415, description = "Request body is not JSON", body = String, content_type = "text/plain"),
        (status = 422, description = "JSON body does not match the merge schema", body = String, content_type = "text/plain"),
        (status = 500, description = "Report groups could not be merged", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn merge_report_groups_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(source_group_key): Path<String>,
    Json(input): Json<MergeReportGroupsInput>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    if !valid_report_group_key(&source_group_key) || !valid_report_group_key(&input.into_group_key)
    {
        return Err(ApiError::bad_request(
            "Report group keys must be 32 lowercase hexadecimal characters",
        ));
    }
    let summary = merge_report_groups(
        &state.pool,
        context.workspace.id,
        &source_group_key,
        &input.into_group_key,
        &context.user.id,
    )
    .await?;
    dashboard_response(&state, Json(summary), tokens)
}

#[utoipa::path(
    post,
    path = "/api/groups/{group_key}/github-issue",
    tag = "github",
    params(
        ("group_key" = String, Path, description = "Stable report group key"),
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to configure; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Existing GitHub issue link for the group", body = GithubIssueLink),
        (status = 201, description = "GitHub issue created and linked to the group", body = GithubIssueLink),
        (status = 400, description = "Invalid team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot configure the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Feedback group not found for this team", body = ApiErrorEnvelope),
        (status = 409, description = "The group was merged away, its mapping is unusable, or a filing is being reconciled", body = ApiErrorEnvelope),
        (status = 410, description = "A pending team invitation changed while team membership was refreshed", body = ApiErrorEnvelope),
        (status = 500, description = "GitHub issue linkage could not be persisted", body = ApiErrorEnvelope),
        (status = 502, description = "GitHub issue creation failed or has an ambiguous outcome being reconciled", body = ApiErrorEnvelope),
        (status = 503, description = "GitHub App integration is not configured", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn file_group_github_issue_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_key): Path<String>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    require_workspace_editor(&context)?;
    let workspace_id = context.workspace.id;
    let backlink = group_backlink(&state.web_app_url, &group_key);
    let initial_context =
        group_issue_context(&state.pool, workspace_id, &group_key, backlink.clone())
            .await?
            .ok_or_else(|| ApiError::not_found("Feedback group not found for this team"))?;
    if let Some(target_group_key) = initial_context.merged_into_group_key.as_deref() {
        return Err(ApiError::conflict(format!(
            "This feedback group was merged into {target_group_key}; file the issue on that group instead"
        )));
    }
    if let Some(existing) = get_group_github_issue(&state.pool, workspace_id, &group_key).await? {
        spawn_group_issue_sync(Arc::clone(&state), workspace_id, group_key);
        return dashboard_response(&state, Json(existing.link()), tokens);
    }
    let (installation_id, repo_full_name) = validate_group_repo_mapping(&initial_context)?;
    let github = require_github(&state)?;

    // Claim the group BEFORE calling GitHub. The primary key on `group_key`
    // makes concurrent filers mutually exclusive without any database
    // connection being held across the network call.
    let stale_cutoff = Utc::now() - Duration::minutes(GROUP_ISSUE_FILING_CLAIM_STALE_MINUTES);
    match claim_group_issue_filing(
        &state.pool,
        GroupIssueFilingRequest {
            workspace_id,
            group_key: &group_key,
            installation_id,
            repo_full_name,
            created_by: &context.user.id,
            claim_report_count: initial_context.template.report_count,
        },
        stale_cutoff,
    )
    .await?
    {
        GroupIssueFilingClaim::AlreadyFiled(existing) => {
            spawn_group_issue_sync(Arc::clone(&state), workspace_id, group_key);
            return dashboard_response(&state, Json(existing.link()), tokens);
        }
        GroupIssueFilingClaim::InProgress => {
            return Err(ApiError::conflict(
                "A GitHub issue is already being filed for this feedback group",
            ));
        }
        GroupIssueFilingClaim::NeedsReconciliation => {
            spawn_group_issue_sync(Arc::clone(&state), workspace_id, group_key);
            return Err(ApiError::conflict(
                "GitHub issue reconciliation is in progress for this feedback group",
            ));
        }
        GroupIssueFilingClaim::Claimed => {}
    }

    let title = render_issue_title(&initial_context.template);
    let body = render_issue_body(&initial_context.template);
    let issue = match github
        .create_issue(installation_id, repo_full_name, &title, &body)
        .await
    {
        Ok(issue) => issue,
        Err(error) => {
            let outcome = error.outcome();
            tracing::warn!(
                %error,
                ?outcome,
                %workspace_id,
                %group_key,
                repo_full_name,
                "GitHub issue creation failed"
            );
            if outcome == GithubIssueCreationOutcome::DefiniteFailure {
                if let Err(release_error) =
                    release_group_issue_filing_claim(&state.pool, workspace_id, &group_key).await
                {
                    tracing::warn!(
                        status = %release_error.status,
                        %workspace_id,
                        %group_key,
                        "failed to release definite GitHub issue filing failure"
                    );
                }
                return Err(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "GitHub did not accept the issue creation request",
                ));
            }

            match mark_group_issue_filing_for_reconciliation(&state.pool, workspace_id, &group_key)
                .await
            {
                Ok(true) => {}
                Ok(false) => tracing::warn!(
                    %workspace_id,
                    %group_key,
                    "ambiguous GitHub issue filing claim was no longer pending"
                ),
                Err(mark_error) => tracing::warn!(
                    status = %mark_error.status,
                    %workspace_id,
                    %group_key,
                    "failed to mark ambiguous GitHub issue filing for reconciliation"
                ),
            }
            spawn_group_issue_sync(Arc::clone(&state), workspace_id, group_key);
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "GitHub issue filing is being reconciled; retry shortly",
            ));
        }
    };
    let link = GithubIssueLink {
        repo_full_name: repo_full_name.to_owned(),
        issue_number: issue.number,
        url: issue.html_url,
        state: issue.state,
    };
    let stored = complete_group_issue_filing(
        &state.pool,
        workspace_id,
        &group_key,
        &link,
        initial_context.template.report_count,
    )
    .await?;
    dashboard_response(&state, (StatusCode::CREATED, Json(stored.link())), tokens)
}

fn validate_group_repo_mapping(
    context: &crate::store::GroupIssueContext,
) -> Result<(i64, &str), ApiError> {
    let Some(installation_id) = context.installation_id else {
        return Err(ApiError::conflict(
            "The product has no GitHub repository mapping",
        ));
    };
    let Some(repo_full_name) = context.repo_full_name.as_deref() else {
        return Err(ApiError::conflict(
            "The product has no GitHub repository mapping",
        ));
    };
    if !context.installation_active {
        return Err(ApiError::conflict(
            "The product GitHub repository mapping has no active installation for this team",
        ));
    }
    Ok((installation_id, repo_full_name))
}

fn spawn_group_issue_sync(state: Arc<AppState>, workspace_id: Uuid, group_key: String) {
    if state.github.is_none() {
        return;
    }
    tokio::spawn(async move {
        if let Err(error) = sync_group_github_issue(&state, workspace_id, &group_key).await {
            tracing::warn!(
                status = %error.status,
                %workspace_id,
                %group_key,
                "best-effort GitHub issue synchronization failed"
            );
        }
    });
}

/// A sync is worth spawning for a due reconciliation, new evidence to comment
/// on, or a cached issue state stale enough to re-read.
///
/// The state refresh is deliberately NOT conditioned on new reports arriving: a
/// group that has gone quiet is exactly the one whose issue is most likely to
/// have been closed or reopened on GitHub, and gating on new evidence would pin
/// its badge to whatever it was when the last report landed. Call volume stays
/// bounded by the `state_refreshed_at` throttle and the per-request fan-out cap
/// rather than by the presence of new reports.
fn group_issue_sync_needed(
    has_github_issue: bool,
    needs_reconciliation: bool,
    current_report_count: i64,
    last_commented_report_count: Option<i64>,
    state_refreshed_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if needs_reconciliation {
        return group_issue_reconciliation_retry_due(state_refreshed_at, now);
    }
    if !has_github_issue {
        return false;
    }
    let new_evidence = last_commented_report_count
        .is_some_and(|last_commented| current_report_count > last_commented);
    new_evidence || group_issue_state_refresh_due(state_refreshed_at, now)
}

fn group_issue_reconciliation_retry_due(
    state_refreshed_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    state_refreshed_at.is_none_or(|last_attempt| {
        last_attempt <= now - Duration::minutes(GROUP_ISSUE_RECONCILIATION_RETRY_MINUTES)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GroupIssueReconciliationDecision {
    Adopt,
    KeepWaiting,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GroupIssueReconciliationInconclusive {
    RateLimit,
    Timeout,
    NotFound,
    PaginationCap,
    IncompletePagination,
    Server,
    InstallationAccess,
    InvalidResponse,
    Transport,
}

#[derive(Debug, Clone, Copy)]
enum GroupIssueReconciliationEvidence<'a> {
    Complete(&'a [GithubIssue]),
    Inconclusive(GroupIssueReconciliationInconclusive),
}

#[derive(Debug)]
struct GroupIssueReconciliationResolution<'a> {
    decision: GroupIssueReconciliationDecision,
    issue: Option<&'a GithubIssue>,
    matching_issue_count: usize,
}

fn group_issue_reconciliation_resolution<'a>(
    evidence: GroupIssueReconciliationEvidence<'a>,
    group_key: &str,
) -> GroupIssueReconciliationResolution<'a> {
    let issues = match evidence {
        GroupIssueReconciliationEvidence::Complete(issues) => issues,
        GroupIssueReconciliationEvidence::Inconclusive(reason) => {
            let decision = match reason {
                GroupIssueReconciliationInconclusive::RateLimit
                | GroupIssueReconciliationInconclusive::Timeout
                | GroupIssueReconciliationInconclusive::NotFound
                | GroupIssueReconciliationInconclusive::PaginationCap
                | GroupIssueReconciliationInconclusive::IncompletePagination
                | GroupIssueReconciliationInconclusive::Server
                | GroupIssueReconciliationInconclusive::InstallationAccess
                | GroupIssueReconciliationInconclusive::InvalidResponse
                | GroupIssueReconciliationInconclusive::Transport => {
                    GroupIssueReconciliationDecision::KeepWaiting
                }
            };
            return GroupIssueReconciliationResolution {
                decision,
                issue: None,
                matching_issue_count: 0,
            };
        }
    };
    let marker = group_marker_comment(group_key);
    let mut oldest = None;
    let mut matching_issue_count = 0;
    for issue in issues.iter().filter(|issue| {
        issue.pull_request.is_none()
            && issue
                .body
                .as_deref()
                .is_some_and(|body| body.contains(&marker))
    }) {
        matching_issue_count += 1;
        if oldest.is_none_or(|current: &GithubIssue| {
            (issue.created_at, issue.number) < (current.created_at, current.number)
        }) {
            oldest = Some(issue);
        }
    }
    GroupIssueReconciliationResolution {
        decision: if oldest.is_some() {
            GroupIssueReconciliationDecision::Adopt
        } else {
            // A complete REST listing is positive evidence that the canonical
            // marker is absent. No fuzzy candidate or time delay can replace
            // that exact-marker check.
            GroupIssueReconciliationDecision::Release
        },
        issue: oldest,
        matching_issue_count,
    }
}

fn reconciliation_inconclusive_reason(
    error: &GithubIssueListError,
) -> GroupIssueReconciliationInconclusive {
    if error.kind() == GithubIssueListFailureKind::PaginationCap {
        return GroupIssueReconciliationInconclusive::PaginationCap;
    }
    if error.page() > 1 {
        return GroupIssueReconciliationInconclusive::IncompletePagination;
    }
    match error.kind() {
        GithubIssueListFailureKind::RateLimit => GroupIssueReconciliationInconclusive::RateLimit,
        GithubIssueListFailureKind::Timeout => GroupIssueReconciliationInconclusive::Timeout,
        GithubIssueListFailureKind::NotFound => GroupIssueReconciliationInconclusive::NotFound,
        GithubIssueListFailureKind::PaginationCap => {
            GroupIssueReconciliationInconclusive::PaginationCap
        }
        GithubIssueListFailureKind::Installation | GithubIssueListFailureKind::Access => {
            GroupIssueReconciliationInconclusive::InstallationAccess
        }
        GithubIssueListFailureKind::Server => GroupIssueReconciliationInconclusive::Server,
        GithubIssueListFailureKind::InvalidResponse => {
            GroupIssueReconciliationInconclusive::InvalidResponse
        }
        GithubIssueListFailureKind::Transport => GroupIssueReconciliationInconclusive::Transport,
    }
}

fn group_issue_state_refresh_due(
    state_refreshed_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    state_refreshed_at.is_none_or(|last_refreshed| {
        last_refreshed <= now - Duration::minutes(GROUP_ISSUE_STATE_REFRESH_INTERVAL_MINUTES)
    })
}

async fn sync_group_github_issue(
    state: &AppState,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<(), ApiError> {
    let Some(github) = state.github.as_ref() else {
        return Ok(());
    };
    if reconcile_group_github_issue(state, github, workspace_id, group_key).await? {
        return Ok(());
    }
    let mut tx = state.pool.begin().await?;
    let Some(context) = group_issue_sync_context(&mut tx, workspace_id, group_key).await? else {
        tx.commit().await?;
        return Ok(());
    };
    // Claim the comment only when there is genuinely new evidence. Whether or
    // not there is, the state refresh below still gets its chance — a quiet
    // group is the one most likely to have been closed or reopened on GitHub.
    let claimed = if context.current_report_count > context.observed_report_count {
        bump_last_commented_report_count(
            &mut tx,
            workspace_id,
            group_key,
            context.observed_report_count,
            context.current_report_count,
        )
        .await?
    } else {
        false
    };
    tx.commit().await?;

    if claimed {
        post_group_evidence_comment(state, github, workspace_id, group_key, &context).await;
    }

    let refresh_checked_at = Utc::now();
    let refresh_cutoff =
        refresh_checked_at - Duration::minutes(GROUP_ISSUE_STATE_REFRESH_INTERVAL_MINUTES);
    if group_issue_state_refresh_due(context.state_refreshed_at, refresh_checked_at)
        && claim_group_issue_state_refresh(&state.pool, workspace_id, group_key, refresh_cutoff)
            .await?
    {
        refresh_group_issue_state(state, github, workspace_id, group_key, &context).await;
    }
    Ok(())
}

async fn reconcile_group_github_issue(
    state: &AppState,
    github: &GithubAppClient,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<bool, ApiError> {
    // External-consistency invariant: only a fully exhausted REST issue listing
    // may release a quarantined claim. Rate limits, timeouts, 404s (including a
    // stale renamed/transferred repo), revoked installation access, invalid
    // responses, and any partial/capped pagination all remain inconclusive.
    //
    // ACCEPTED LIMITATIONS: GitHub cannot list a human-deleted issue or one
    // transferred out of the repository, so a complete listing may look absent
    // after either action. The five-minute lower-bound skew covers ordinary
    // clock disagreement, but not larger clock faults. Repository identity is
    // pinned as owner/name because the current schema does not retain GitHub's
    // immutable repository id; redirects are followed, while a 404 is retained
    // for retry rather than treated as absence.
    let checked_at = Utc::now();
    let refresh_cutoff = checked_at - Duration::minutes(GROUP_ISSUE_RECONCILIATION_RETRY_MINUTES);
    let Some(context) =
        claim_group_issue_reconciliation(&state.pool, workspace_id, group_key, refresh_cutoff)
            .await?
    else {
        return Ok(false);
    };

    let since = context.needs_reconciliation_since
        - Duration::minutes(GROUP_ISSUE_RECONCILIATION_CLOCK_SKEW_MINUTES);
    let read = github
        .reconciliation_issues(context.installation_id, &context.repo_full_name, since)
        .await;
    let evidence = match &read {
        Ok(issues) => GroupIssueReconciliationEvidence::Complete(issues),
        Err(error) => GroupIssueReconciliationEvidence::Inconclusive(
            reconciliation_inconclusive_reason(error),
        ),
    };
    let resolution = group_issue_reconciliation_resolution(evidence, group_key);
    if let Err(error) = &read {
        tracing::warn!(
            %error,
            ?resolution.decision,
            reason = ?reconciliation_inconclusive_reason(error),
            page = error.page(),
            %workspace_id,
            %group_key,
            repo_full_name = %context.repo_full_name,
            "GitHub issue reconciliation listing was inconclusive; claim remains quarantined"
        );
    }
    if resolution.matching_issue_count > 1 {
        tracing::warn!(
            %workspace_id,
            %group_key,
            repo_full_name = %context.repo_full_name,
            matches = resolution.matching_issue_count,
            "multiple GitHub issues carry the exact group marker; adopting the oldest"
        );
    }

    match resolution.decision {
        GroupIssueReconciliationDecision::Adopt => {
            let Some(issue) = resolution.issue else {
                tracing::warn!(
                    %workspace_id,
                    %group_key,
                    "GitHub issue reconciliation adopt decision had no issue"
                );
                return Ok(true);
            };
            let link = GithubIssueLink {
                repo_full_name: context.repo_full_name,
                issue_number: issue.number,
                url: issue.html_url.clone(),
                state: issue.state.clone(),
            };
            if !complete_group_issue_reconciliation(
                &state.pool,
                workspace_id,
                group_key,
                context.reconciliation_claimed_at,
                &link,
                context.claim_report_count,
            )
            .await?
            {
                tracing::warn!(
                    %workspace_id,
                    %group_key,
                    "GitHub issue reconciliation adoption lost its conditional claim"
                );
            }
        }
        GroupIssueReconciliationDecision::KeepWaiting => {}
        GroupIssueReconciliationDecision::Release => {
            // This branch is reachable only from a complete, exhausted REST
            // listing with no exact canonical marker. Every inconclusive read
            // resolves to KeepWaiting above and therefore retains the claim.
            if !release_group_issue_reconciliation_claim(
                &state.pool,
                workspace_id,
                group_key,
                context.reconciliation_claimed_at,
            )
            .await?
            {
                tracing::warn!(
                    %workspace_id,
                    %group_key,
                    "GitHub issue reconciliation release lost its conditional claim"
                );
            }
        }
    }
    Ok(true)
}

/// Posts the evidence comment for an already-claimed counter bump.
///
/// Never returns an error: a GitHub failure reverts the claim so a later sync
/// retries, and must not abort the caller's state refresh.
async fn post_group_evidence_comment(
    state: &AppState,
    github: &GithubAppClient,
    workspace_id: Uuid,
    group_key: &str,
    context: &GroupIssueSyncContext,
) {
    let body = render_evidence_comment(
        context.current_report_count - context.observed_report_count,
        context.earliest_new_occurred_at,
        context.latest_new_occurred_at,
    );
    if let Err(error) = github
        .create_issue_comment(
            context.installation_id,
            &context.repo_full_name,
            context.issue_number,
            &body,
        )
        .await
    {
        match revert_last_commented_report_count(
            &state.pool,
            workspace_id,
            group_key,
            context.observed_report_count,
            context.current_report_count,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => tracing::warn!(
                %workspace_id,
                %group_key,
                observed_report_count = context.observed_report_count,
                claimed_report_count = context.current_report_count,
                "GitHub evidence comment counter revert lost its conditional race"
            ),
            Err(revert_error) => tracing::warn!(
                status = %revert_error.status,
                %workspace_id,
                %group_key,
                observed_report_count = context.observed_report_count,
                claimed_report_count = context.current_report_count,
                "GitHub evidence comment counter revert failed"
            ),
        }
        tracing::warn!(
            %error,
            %workspace_id,
            %group_key,
            repo_full_name = %context.repo_full_name,
            issue_number = context.issue_number,
            "GitHub evidence comment failed; report counter will be retried when safely reverted"
        );
    }
}

/// Re-reads the issue state for an already-claimed refresh slot.
///
/// Never returns an error: a stale badge is not worth failing a background sync.
async fn refresh_group_issue_state(
    state: &AppState,
    github: &GithubAppClient,
    workspace_id: Uuid,
    group_key: &str,
    context: &GroupIssueSyncContext,
) {
    match github
        .issue(
            context.installation_id,
            &context.repo_full_name,
            context.issue_number,
        )
        .await
    {
        Ok(issue) => {
            if let Err(error) =
                update_group_issue_state(&state.pool, workspace_id, group_key, &issue.state).await
            {
                tracing::warn!(
                    status = %error.status,
                    %workspace_id,
                    %group_key,
                    "GitHub issue state update failed"
                );
            }
        }
        Err(error) => tracing::warn!(
            %error,
            %workspace_id,
            %group_key,
            repo_full_name = %context.repo_full_name,
            issue_number = context.issue_number,
            "GitHub issue state refresh failed"
        ),
    }
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

fn resolve_web_app_url(public_base_url: &str, configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(public_base_url)
        .trim_end_matches('/')
        .to_owned()
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
    dashboard_response(state, github_callback_redirect(state, result), tokens)
        .unwrap_or_else(|_| github_callback_redirect(state, "error"))
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

fn validated_return_to(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > 4_096
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_owned())
}

fn auth_return_to(headers: &HeaderMap) -> Option<String> {
    let encoded = cookie(headers, AUTH_RETURN_TO_COOKIE)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    validated_return_to(Some(&decoded))
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
    append_cookie(response, &clear_cookie(STATE_COOKIE, state.secure_cookies))?;
    append_cookie(
        response,
        &clear_cookie(AUTH_RETURN_TO_COOKIE, state.secure_cookies),
    )
}

async fn dashboard_auth(
    state: &AppState,
    headers: &HeaderMap,
    requested_workspace_id: Option<Uuid>,
) -> Result<(DashboardContext, Option<TokenPair>), ApiError> {
    let (os_user, rotated_tokens) = if let Some(user) = state
        .dev_auth
        .as_ref()
        .and_then(|config| config.resolve_identity(headers, Utc::now()))
    {
        (user, None)
    } else {
        let resolved = state.accounts.resolve(headers).await?;
        (resolved.user, resolved.rotated_tokens)
    };
    let (workspace, role, workspace_memberships) =
        resolve_workspace_access(&state.pool, &os_user, requested_workspace_id).await?;
    let display_name = os_user
        .display_name
        .clone()
        .unwrap_or_else(|| os_user.handle.clone());
    let user = CurrentUser {
        id: os_user.id,
        handle: os_user.handle,
        email: os_user.email,
        display_name,
    };
    Ok((
        DashboardContext {
            user,
            workspace,
            role,
            workspace_memberships,
        },
        rotated_tokens,
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
    append_cookie(&mut response, &dev_auth::clear_dev_cookie())?;
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

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardFeedbackListQuery {
    product_id: Uuid,
    group_key: Option<String>,
    q: Option<String>,
    status: Option<String>,
    impact: Option<String>,
    surface: Option<String>,
    topic: Option<String>,
    finding_kind: Option<String>,
    severity: Option<String>,
    tag: Option<String>,
    assignee: Option<String>,
    workaround: Option<String>,
    operation: Option<String>,
    customer_ref: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardSessionsListQuery {
    product_id: Uuid,
    q: Option<String>,
    kind: Option<String>,
    impact: Option<String>,
    operation: Option<String>,
    customer_ref: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardCustomersListQuery {
    product_id: Uuid,
    q: Option<String>,
    identity_level: Option<String>,
    outcome_health: Option<String>,
    signal_type: Option<String>,
    consent_state: Option<String>,
    segment: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardSignalsListQuery {
    product_id: Uuid,
    q: Option<String>,
    customer_id: Option<Uuid>,
    feature_key: Option<String>,
    session_id: Option<Uuid>,
    #[serde(rename = "type")]
    signal_type: Option<String>,
    provenance: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardResponsesListQuery {
    product_id: Uuid,
    q: Option<String>,
    status: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
struct DashboardFeaturesListQuery {
    product_id: Uuid,
    q: Option<String>,
    signal_type: Option<String>,
    impact: Option<String>,
    status: Option<String>,
    segment: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    #[param(default = 50, minimum = 1, maximum = 100)]
    limit: Option<i64>,
    cursor: Option<String>,
}

fn comma_values(value: Option<String>, field: &str) -> Result<Option<Vec<String>>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.len() > 1_000 {
        return Err(ApiError::bad_request(format!("{field} filter is too long")));
    }
    let values = value
        .split(',')
        .map(str::trim)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if values.is_empty() || values.len() > 20 || values.iter().any(String::is_empty) {
        return Err(ApiError::bad_request(format!("Invalid {field} filter")));
    }
    Ok(Some(values))
}

#[utoipa::path(
    get,
    path = "/api/dashboard/customers",
    tag = "dashboard",
    params(
        DashboardCustomersListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Server-filtered customer intelligence page", body = DashboardCustomersPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 410, description = "Cursor is outside the retained window", body = ApiErrorEnvelope),
        (status = 500, description = "Customer intelligence could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_customers_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardCustomersListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let page = dashboard_customers_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardCustomerFilters {
            query: query.q,
            identity_levels: comma_values(query.identity_level, "identityLevel")?,
            outcome_health: comma_values(query.outcome_health, "outcomeHealth")?,
            signal_types: comma_values(query.signal_type, "signalType")?,
            consent_states: comma_values(query.consent_state, "consentState")?,
            segments: comma_values(query.segment, "segment")?,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/customers/{customer_id}",
    tag = "dashboard",
    params(
        ("customer_id" = Uuid, Path, description = "Customer identifier"),
        DashboardDetailQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Customer identity, evidence, sessions, and scoped consent", body = DashboardCustomerDetail),
        (status = 400, description = "Invalid path, query, or team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Customer not found for the product", body = ApiErrorEnvelope),
        (status = 500, description = "Customer detail could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_customer_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(customer_id): Path<Uuid>,
    Query(query): Query<DashboardDetailQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let detail = dashboard_customer_by_id(
        &state.pool,
        context.workspace.id,
        query.product_id,
        customer_id,
    )
    .await?;
    dashboard_response(&state, Json(detail), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/features",
    tag = "dashboard",
    params(
        DashboardFeaturesListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Evidence-backed customer needs and opportunities", body = DashboardFeaturesPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 500, description = "Features could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_features_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardFeaturesListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let page = dashboard_features_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardFeatureFilters {
            query: query.q,
            signal_types: comma_values(query.signal_type, "signalType")?,
            impacts: comma_values(query.impact, "impact")?,
            statuses: comma_values(query.status, "status")?,
            segments: comma_values(query.segment, "segment")?,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/features/{feature_key}",
    tag = "dashboard",
    params(
        ("feature_key" = String, Path, description = "Normalized customer need or feature key"),
        DashboardDetailQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Feature with exact customer, signal, and session evidence", body = DashboardFeatureDetail),
        (status = 400, description = "Invalid feature key, query, or team header", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Feature not found for the product", body = ApiErrorEnvelope),
        (status = 500, description = "Feature detail could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_feature_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(feature_key): Path<String>,
    Query(query): Query<DashboardDetailQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let detail = dashboard_feature_by_key(
        &state.pool,
        context.workspace.id,
        query.product_id,
        &feature_key,
    )
    .await?;
    dashboard_response(&state, Json(detail), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/responses",
    tag = "dashboard",
    params(
        DashboardResponsesListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Questions Epode asked and the answers customer agents returned", body = DashboardResponsesPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 410, description = "Cursor is outside the retained window", body = ApiErrorEnvelope),
        (status = 500, description = "Responses could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_responses_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardResponsesListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let page = dashboard_responses_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardResponseFilters {
            query: query.q,
            statuses: comma_values(query.status, "status")?,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/signals",
    tag = "dashboard",
    params(
        DashboardSignalsListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Evidence-backed typed customer signals", body = DashboardSignalsPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 410, description = "Cursor is outside the retained window", body = ApiErrorEnvelope),
        (status = 500, description = "Signals could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_signals_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardSignalsListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let page = dashboard_signals_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardSignalFilters {
            query: query.q,
            customer_id: query.customer_id,
            feature_key: query.feature_key,
            session_id: query.session_id,
            signal_types: comma_values(query.signal_type, "signalType")?,
            provenances: comma_values(query.provenance, "provenance")?,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/feedback",
    tag = "dashboard",
    params(
        DashboardFeedbackListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Server-filtered feedback page", body = DashboardFeedbackPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 410, description = "Cursor is outside the retained window", body = ApiErrorEnvelope),
        (status = 500, description = "Feedback page could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_feedback_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardFeedbackListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    if query
        .group_key
        .as_deref()
        .is_some_and(|group_key| !valid_report_group_key(group_key))
    {
        return Err(ApiError::bad_request("Invalid feedback group key"));
    }
    let assignees = comma_values(query.assignee, "assignee")?;
    let include_unassigned = assignees
        .as_deref()
        .is_some_and(|values| values.iter().any(|value| value == "unassigned"));
    let assignees = assignees.map(|values| {
        values
            .into_iter()
            .filter(|value| value != "unassigned")
            .collect::<Vec<_>>()
    });
    let page = dashboard_feedback_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardFeedbackFilters {
            query: query.q,
            group_key: query.group_key,
            statuses: comma_values(query.status, "status")?,
            impacts: comma_values(query.impact, "impact")?,
            surfaces: comma_values(query.surface, "surface")?,
            topics: comma_values(query.topic, "topic")?,
            finding_kinds: comma_values(query.finding_kind, "findingKind")?,
            severities: comma_values(query.severity, "severity")?,
            tags: comma_values(query.tag, "tag")?,
            assignees,
            include_unassigned,
            workarounds: comma_values(query.workaround, "workaround")?,
            operation: query.operation,
            customer_ref: query.customer_ref,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
}

#[utoipa::path(
    get,
    path = "/api/dashboard/sessions",
    tag = "dashboard",
    params(
        DashboardSessionsListQuery,
        ("x-workspace-id" = Option<Uuid>, Header, description = "Team to access; defaults to the caller's personal team")
    ),
    responses(
        (status = 200, description = "Server-filtered sessions page with complete rollups", body = DashboardSessionsPage),
        (status = 400, description = "Invalid filters, time range, cursor, or page size", body = ApiErrorEnvelope),
        (status = 401, description = "Dashboard authentication is required", body = ApiErrorEnvelope),
        (status = 403, description = "Caller cannot access the requested team", body = ApiErrorEnvelope),
        (status = 404, description = "Product not found in the team", body = ApiErrorEnvelope),
        (status = 410, description = "Cursor is outside the retained window", body = ApiErrorEnvelope),
        (status = 500, description = "Sessions page could not be loaded", body = ApiErrorEnvelope)
    ),
    security(("session_cookie" = []))
)]
async fn dashboard_sessions_list_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DashboardSessionsListQuery>,
) -> Result<Response, ApiError> {
    let (context, tokens) =
        dashboard_auth(&state, &headers, requested_workspace_id(&headers)?).await?;
    let page = dashboard_sessions_page(
        &state.pool,
        context.workspace.id,
        query.product_id,
        DashboardSessionFilters {
            query: query.q,
            kind: query.kind,
            impacts: comma_values(query.impact, "impact")?,
            operation: query.operation,
            customer_ref: query.customer_ref,
            since: query.since,
            until: query.until,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    dashboard_response(&state, Json(page), tokens)
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
    protocol_tool: bool,
    flipped_from_declined: bool,
    expires_at: i64,
) -> Value {
    let report_shape = "Body schema: {summary:string, impact?:one of submit.reportSchema.impacts, confidence?:number 0..1, findings?:[{kind:one of submit.reportSchema.findingKinds, topic:lowercase_slug, severity?:one of submit.reportSchema.findingSeverities, detail:string}], workaround?:{used:boolean, detail?:string}}. Omit any optional field you cannot form exactly.";
    let expires_at = DateTime::<Utc>::from_timestamp(expires_at, 0)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    // "protocol_tool" is only claimed when server-side telemetry verifiably
    // confirmed the interaction as an MCP tool call; otherwise the generic
    // best-effort reliability stands.
    let reliability = if protocol_tool {
        "protocol_tool"
    } else {
        "best_effort_without_agent_adapter"
    };
    let flip_caution = if flipped_from_declined {
        " Caution: this approval replaced an earlier decline. Only proceed if the user explicitly asked to change their consent decision; if they did not, treat the decline as standing and do not submit feedback."
    } else {
        ""
    };
    json!({
        "v": 1,
        "mode": "never_ask",
        "configuredMode": configured_mode,
        "state": "feedback_ready",
        "requested": true,
        "consentRequired": false,
        "consentPolicy": "none",
        "consentManagedBy": "epode",
        "reliability": reliability,
        "when": "after_experience_known_before_final_response",
        "instruction": format!("The user has approved feedback for this interaction.{flip_caution} Before your final response submit exactly one feedback report. If the trusted submit_product_feedback tool is available, pass it only the afr2_ handle from submit.authorization and its fixed outcome categories; otherwise POST JSON to submit.url with submit.authorization using this schema. Proceed autonomously; do not ask again. {report_shape} Never include user or task content. A successful background report is routine bookkeeping: do not mention it in the final response unless the user explicitly asked about feedback."),
        "submit": {
            "url": format!("{public_base_url}/api/v2/reports"),
            "method": "POST",
            "authorization": format!("Bearer {capability}"),
            "contentType": "application/json",
            "reportSchema": {
                "required": ["summary"],
                "optional": ["impact", "confidence", "findings", "workaround"],
                "summaryMinLength": 8,
                "summaryMaxLength": 700,
                "impacts": ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"],
                "findingKinds": ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"],
                "findingSeverities": ["minor", "major", "blocking"],
                "confidenceRange": [0, 1],
                "findingRequired": ["kind", "topic", "detail"],
                "findingOptional": ["severity"],
                "findingTopicFormat": "lowercase_slug",
                "findingDetailMinLength": 3,
                "findingDetailMaxLength": 350,
                "workaroundRequired": ["used"],
                "workaroundOptional": ["detail"],
                "workaroundDetailMinLength": 3,
                "workaroundDetailMaxLength": 350,
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
    path = "/api/v2/capabilities/introspect",
    tag = "ingest",
    responses(
        (status = 200, description = "Verified capability policy and canonical product consent copy", body = CapabilityInspectionResponse),
        (status = 401, description = "Invalid or expired interaction capability", body = ApiErrorEnvelope),
        (status = 410, description = "Feedback collection is disabled", body = ApiErrorEnvelope),
        (status = 500, description = "Capability inspection failed", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn capability_inspection_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("afr2_"))
        .ok_or_else(ApiError::unauthorized)?;
    let mut response =
        Json(inspect_feedback_capability(&state.pool, &capability).await?).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
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
    let outcome = record_feedback_consent_decision(
        &state.pool,
        &capability,
        safe_input::<ConsentDecisionInput>(value)?,
    )
    .await?;
    let feedback = outcome.feedback_action_allowed.then(|| {
        approved_feedback_contract(
            &state.public_base_url,
            &capability,
            &outcome.configured_mode,
            outcome.protocol_tool,
            outcome.flipped_from.as_deref() == Some("declined"),
            outcome.expires_at,
        )
    });
    let mut response = Json(ConsentDecisionResponse {
        state: outcome.decision,
        decided_at: outcome.decided_at,
        changed: outcome.changed,
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
        &state.identity_hmac_secret,
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
    post,
    path = "/api/v2/enrichment/requests",
    tag = "enrichment",
    request_body = EnrichmentRequestInput,
    responses(
        (status = 200, description = "Question and permission action selected for the interaction", body = EnrichmentRequestResponse),
        (status = 400, description = "Invalid purpose, operation, or identity context", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid product API key", body = ApiErrorEnvelope),
        (status = 409, description = "Interaction or identity context conflicts", body = ApiErrorEnvelope),
        (status = 500, description = "Enrichment request could not be created", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn enrichment_request_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let result = create_enrichment_request(
        &state.pool,
        &auth,
        &state.identity_hmac_secret,
        &state.public_base_url,
        safe_input::<EnrichmentRequestInput>(value)?,
    )
    .await?;
    let mut response = Json(result).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/enrichment/consent/decisions",
    tag = "enrichment",
    request_body = EnrichmentConsentDecisionInput,
    responses(
        (status = 200, description = "Enrichment permission decision recorded idempotently", body = EnrichmentConsentDecisionResponse),
        (status = 400, description = "Invalid decision", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid or expired enrichment capability", body = ApiErrorEnvelope),
        (status = 500, description = "Decision could not be stored", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn enrichment_consent_decision_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("aqr1_"))
        .ok_or_else(ApiError::unauthorized)?;
    let result = decide_enrichment_consent(
        &state.pool,
        &state.public_base_url,
        &capability,
        safe_input::<EnrichmentConsentDecisionInput>(value)?,
    )
    .await?;
    let mut response = Json(result).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/enrichment/answers",
    tag = "enrichment",
    request_body = EnrichmentAnswerInput,
    responses(
        (status = 200, description = "Permissioned customer context accepted idempotently", body = EnrichmentAnswerResponse),
        (status = 400, description = "Invalid, sensitive, or unbounded customer context", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid or expired enrichment capability", body = ApiErrorEnvelope),
        (status = 403, description = "Customer context sharing is not approved", body = ApiErrorEnvelope),
        (status = 409, description = "Request already has a different answer", body = ApiErrorEnvelope),
        (status = 500, description = "Answer could not be stored", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn enrichment_answer_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let capability = bearer_token(&headers)
        .filter(|token| token.starts_with("aqr1_"))
        .ok_or_else(ApiError::unauthorized)?;
    let result = submit_enrichment_answer(
        &state.pool,
        &capability,
        safe_input::<EnrichmentAnswerInput>(value)?,
    )
    .await?;
    let mut response = Json(result).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/customer-context",
    tag = "personalization",
    request_body = CustomerContextInput,
    responses(
        (status = 200, description = "Active permissioned context for a known, anonymous, or ephemeral customer", body = CustomerContextResponse),
        (status = 400, description = "Invalid identity or purpose", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid product API key", body = ApiErrorEnvelope),
        (status = 404, description = "Customer or interaction context not found", body = ApiErrorEnvelope),
        (status = 409, description = "Identity references conflict", body = ApiErrorEnvelope),
        (status = 500, description = "Customer context could not be retrieved", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn customer_context_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let result = retrieve_customer_context(
        &state.pool,
        &auth,
        &state.identity_hmac_secret,
        safe_input::<CustomerContextInput>(value)?,
    )
    .await?;
    let mut response = Json(result).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/personalization/decisions",
    tag = "personalization",
    request_body = PersonalizationDecisionInput,
    responses(
        (status = 200, description = "Personalization decision linked to exact retrieved signal evidence", body = PersonalizationDecisionResponse),
        (status = 400, description = "Invalid decision or evidence", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid product API key", body = ApiErrorEnvelope),
        (status = 404, description = "Context retrieval not found", body = ApiErrorEnvelope),
        (status = 409, description = "Idempotency key has a different payload", body = ApiErrorEnvelope),
        (status = 500, description = "Decision could not be stored", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn personalization_decision_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let mut response = Json(
        record_personalization_decision(
            &state.pool,
            &auth,
            safe_input::<PersonalizationDecisionInput>(value)?,
        )
        .await?,
    )
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/v2/personalization/outcomes",
    tag = "personalization",
    request_body = PersonalizationOutcomeInput,
    responses(
        (status = 200, description = "Business outcome linked to an exact personalization decision", body = PersonalizationOutcomeResponse),
        (status = 400, description = "Invalid outcome", body = ApiErrorEnvelope),
        (status = 401, description = "Invalid product API key", body = ApiErrorEnvelope),
        (status = 404, description = "Personalization decision not found", body = ApiErrorEnvelope),
        (status = 409, description = "Idempotency key has a different payload", body = ApiErrorEnvelope),
        (status = 500, description = "Outcome could not be stored", body = ApiErrorEnvelope)
    ),
    security(("bearer_auth" = []))
)]
async fn personalization_outcome_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let auth = agent_product_auth(&state.pool, &headers).await?;
    let mut response = Json(
        record_personalization_outcome(
            &state.pool,
            &auth,
            safe_input::<PersonalizationOutcomeInput>(value)?,
        )
        .await?,
    )
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
        ApiError, CodeHintCandidate, CodeMatchVerificationTracker, GithubCodeSearchCandidate,
        GithubFileContentFailureKind, GithubIssue, GithubRateLimit,
        GroupIssueReconciliationDecision, GroupIssueReconciliationEvidence,
        GroupIssueReconciliationInconclusive, InstallationContentBudget, InstallationSearchBudget,
        PinnedFileContent, WORKSPACE_ID_QUERY_PARAM, build_app_router, code_hints_json,
        code_match_retry_exhausted, code_search_pacing_delay, code_search_retry_at, comma_values,
        drop_fragmentless_code_search_candidates, every_code_search_query_was_invalid,
        feedback_discovery, github_callback_redirect_target, group_issue_reconciliation_resolution,
        group_issue_state_refresh_due, group_issue_sync_needed, group_marker_comment,
        install_workspace_id, mcp_auth_error, mcp_tool_allowed, mcp_tools,
        pinned_file_content_for_failure, resolve_web_app_url, reveal_auth_error,
        same_code_match_repo, valid_report_group_key, validated_return_to,
    };
    use chrono::{Duration, TimeZone as _, Utc};
    use serde_json::{Value, json};

    const NON_API_ROUTES: &[&str] = &["GET /"];
    const COVERAGE_GUARD_GUIDANCE: &str = "route registration form not understood by the coverage guard — teach `served_operations` about it or register API handlers with `.routes(routes!(handler))`";

    #[test]
    fn code_match_budget_is_shared_across_an_installation_batch() {
        let mut budget = InstallationSearchBudget::new();

        for _ in 0..10 {
            assert!(budget.take());
        }
        assert!(
            !budget.take(),
            "an eleventh report query must wait for another batch"
        );

        let mut header_bounded = InstallationSearchBudget::new();
        header_bounded.observe_headroom(Some(2));
        assert!(header_bounded.take());
        assert!(header_bounded.take());
        assert!(!header_bounded.take());

        let mut content_budget = InstallationContentBudget::new();
        for _ in 0..10 {
            assert!(content_budget.take());
        }
        assert!(
            !content_budget.take(),
            "an eleventh content fetch must requeue the report"
        );
    }

    #[test]
    fn fragmentless_code_search_candidates_are_dropped_before_storage() {
        let mut verification = CodeMatchVerificationTracker::default();
        let candidates = drop_fragmentless_code_search_candidates(
            vec![GithubCodeSearchCandidate::fragmentless_for_test(
                "src/path-only.rs",
            )],
            &mut verification,
        );

        assert!(candidates.is_empty());
        assert_eq!(verification.unverified_dropped(), 1);
    }

    #[test]
    fn code_match_invalid_queries_continue_until_every_query_was_tried() {
        assert!(!every_code_search_query_was_invalid(3, 1, 1));
        assert!(!every_code_search_query_was_invalid(3, 3, 2));
        assert!(every_code_search_query_was_invalid(3, 3, 3));
        assert!(!every_code_search_query_was_invalid(0, 0, 0));

        assert!(!code_match_retry_exhausted(7));
        assert!(code_match_retry_exhausted(8));
    }

    #[test]
    fn only_a_typed_file_404_can_become_provisional_absence() {
        assert!(matches!(
            pinned_file_content_for_failure(GithubFileContentFailureKind::NotFound),
            PinnedFileContent::FileNotFound
        ));
        for failure in [
            GithubFileContentFailureKind::Unauthorized,
            GithubFileContentFailureKind::Forbidden,
            GithubFileContentFailureKind::Server,
            GithubFileContentFailureKind::Timeout,
            GithubFileContentFailureKind::InvalidResponse,
            GithubFileContentFailureKind::Transport,
        ] {
            assert!(matches!(
                pinned_file_content_for_failure(failure),
                PinnedFileContent::Incomplete(kind) if kind == failure
            ));
        }
    }

    #[test]
    fn code_match_remap_detection_normalizes_both_repo_names() {
        assert!(same_code_match_repo(
            "Open-Software/Code-Match-Test",
            "open-software/code-match-test"
        ));
        assert!(!same_code_match_repo(
            "open-software/code-match-test",
            "open-software/another-repo"
        ));
    }

    #[test]
    fn code_match_pacing_uses_search_headroom_and_retry_headers() {
        let now = Utc.timestamp_opt(1_800_000_000, 0).unwrap();
        let reset_at = now + Duration::seconds(60);
        let paced = GithubRateLimit {
            remaining: Some(9),
            reset_at: Some(reset_at),
            retry_after: None,
        };
        assert_eq!(
            code_search_pacing_delay(&paced, now),
            std::time::Duration::from_mins(1) / 9
        );

        let retry_after = GithubRateLimit {
            retry_after: Some(std::time::Duration::from_secs(17)),
            ..paced
        };
        assert_eq!(
            code_search_pacing_delay(&retry_after, now),
            std::time::Duration::from_secs(17)
        );
        assert_eq!(
            code_search_retry_at(&retry_after, now),
            now + Duration::seconds(17)
        );
        assert_eq!(
            code_search_retry_at(&paced, now),
            reset_at + Duration::seconds(1)
        );
    }

    #[test]
    fn stored_code_hints_use_the_canonical_database_shape() {
        assert_eq!(
            code_hints_json(vec![
                CodeHintCandidate {
                    file: "backend/src/store.rs".to_owned(),
                    line_start: Some(42),
                    line_end: Some(45),
                    match_reason: "operation token `search`".to_owned(),
                    verified: true,
                },
                CodeHintCandidate {
                    file: "backend/src/unresolved.rs".to_owned(),
                    line_start: None,
                    line_end: None,
                    match_reason: "surface token `search`".to_owned(),
                    verified: false,
                }
            ]),
            json!([{
                "file": "backend/src/store.rs",
                "line_start": 42,
                "line_end": 45,
                "match_reason": "operation token `search`",
                "verified": true,
            }])
        );
        assert_eq!(code_hints_json(Vec::new()), json!([]));
    }

    #[test]
    fn dashboard_comma_filters_are_bounded_and_unambiguous() {
        assert_eq!(
            comma_values(Some("new, investigating".into()), "status")
                .expect("valid comma list should parse"),
            Some(vec!["new".into(), "investigating".into()])
        );
        for invalid in ["new,", ",new", "", &"x".repeat(1_001)] {
            assert!(comma_values(Some(invalid.to_owned()), "status").is_err());
        }
        assert!(
            comma_values(
                Some(
                    (0..21)
                        .map(|index| format!("v{index}"))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                "status"
            )
            .is_err()
        );
    }

    #[test]
    fn failed_authentication_message_is_revealed() {
        let html = r#"<p id="auth-error" class="auth-error" hidden>Try again</p>"#;
        let revealed = reveal_auth_error(html);
        assert!(revealed.contains(r#"id="auth-error" class="auth-error">Try again"#));
        assert!(!revealed.contains("auth-error\" hidden"));
    }

    #[test]
    fn install_workspace_id_prefers_the_header_and_falls_back_to_the_query() {
        let header = uuid::Uuid::from_u128(1);
        let query = uuid::Uuid::from_u128(2);
        let one = format!("workspaceId={query}");
        let q = Some(one.as_str());

        // Header wins when both are present.
        assert_eq!(
            install_workspace_id(Some(header), q).ok().flatten(),
            Some(header)
        );
        // Query parameter is the fallback for the plain install link, which
        // cannot set headers.
        assert_eq!(install_workspace_id(None, q).ok().flatten(), Some(query));
        // Header alone keeps working for the header-driven dashboard calls.
        assert_eq!(
            install_workspace_id(Some(header), None).ok().flatten(),
            Some(header)
        );
        // Neither: dashboard_auth falls back to the caller's personal team.
        assert_eq!(install_workspace_id(None, None).ok().flatten(), None);
        // An empty or unrelated query is the same as no parameter at all.
        assert_eq!(install_workspace_id(None, Some("")).ok().flatten(), None);
        assert_eq!(
            install_workspace_id(None, Some("other=1&x=2"))
                .ok()
                .flatten(),
            None
        );
        // Percent-encoded neighbours and a later position still resolve.
        let mixed = format!("other=a%20b&workspaceId={query}");
        assert_eq!(
            install_workspace_id(None, Some(mixed.as_str()))
                .ok()
                .flatten(),
            Some(query)
        );
    }

    #[test]
    fn install_workspace_id_ignores_a_malformed_query_only_when_a_header_decides() {
        let header = uuid::Uuid::from_u128(1);
        let good = uuid::Uuid::from_u128(2);
        let other = uuid::Uuid::from_u128(3);
        let bad_queries = [
            "workspaceId=".to_owned(),
            "workspaceId=not-a-uuid".to_owned(),
            "workspaceId=../../etc/passwd".to_owned(),
            "workspaceId=%00".to_owned(),
            // Repeated keys: the reason an extractor cannot own this decision.
            format!("workspaceId={good}&workspaceId={other}"),
            format!("workspaceId={good}&workspaceId={good}"),
            format!("workspaceId={good}&workspaceId=not-a-uuid"),
        ];

        // A valid header must not be defeated by anything in a parameter the
        // docs say is ignored — malformed OR repeated. A serde extractor would
        // reject these before the handler ever ran.
        for query in &bad_queries {
            assert_eq!(
                install_workspace_id(Some(header), Some(query.as_str()))
                    .ok()
                    .flatten(),
                Some(header),
                "header must win over query {query:?}"
            );
        }

        // With no header the parameter is load-bearing, so it must be
        // unambiguous. Falling back to the caller's default team would
        // resurrect the original bug, and picking first-or-last from a repeated
        // key would silently choose a team.
        for query in &bad_queries {
            let error = install_workspace_id(None, Some(query.as_str()))
                .expect_err("a load-bearing ambiguous workspaceId must fail");
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{query:?}");
            assert!(
                error.message.contains("workspaceId"),
                "{} for {query:?}",
                error.message
            );
        }
    }

    #[test]
    fn github_conflict_redirect_targets_connectors_view() {
        assert_eq!(
            github_callback_redirect_target("https://epode.test/", "conflict"),
            "https://epode.test/?view=connectors&github=conflict"
        );
    }

    #[test]
    fn web_app_url_uses_explicit_value_or_public_base_fallback() {
        assert_eq!(
            resolve_web_app_url("https://api.epode.test/", Some("https://app.epode.test/")),
            "https://app.epode.test"
        );
        assert_eq!(
            resolve_web_app_url("http://localhost:8080/", None),
            "http://localhost:8080"
        );
    }

    #[test]
    fn auth_return_target_accepts_only_bounded_same_origin_relative_paths() {
        for valid in [
            "/?view=feedback&report=report-1",
            "/?view=sessions&session=session-1",
            "/team?tab=members#selected",
        ] {
            assert_eq!(validated_return_to(Some(valid)), Some(valid.to_owned()));
        }
        for invalid in [
            "https://evil.example/",
            "//evil.example/",
            "/\\evil.example/",
            "team?tab=members",
            "/dashboard\nset-cookie: injected",
            "",
        ] {
            assert_eq!(validated_return_to(Some(invalid)), None, "{invalid}");
        }
        assert_eq!(validated_return_to(None), None);
        assert_eq!(
            validated_return_to(Some(&format!("/{}", "x".repeat(4_096)))),
            None
        );
    }

    #[test]
    fn group_issue_sync_requires_new_evidence_and_throttles_state_refresh() {
        let now = Utc::now();
        let fresh = Some(now - Duration::minutes(1));
        let reconciliation_fresh = Some(now - Duration::seconds(30));
        let stale = Some(now - Duration::minutes(30));

        // No issue: never sync, however stale.
        assert!(!group_issue_sync_needed(false, false, 2, None, stale, now));
        // Recently refreshed and no new evidence: steady state costs nothing.
        assert!(!group_issue_sync_needed(
            true,
            false,
            2,
            Some(2),
            fresh,
            now
        ));
        assert!(!group_issue_sync_needed(
            true,
            false,
            1,
            Some(2),
            fresh,
            now
        ));
        // New evidence always syncs, even just-refreshed.
        assert!(group_issue_sync_needed(true, false, 3, Some(2), fresh, now));
        // A quiet group whose state has gone stale must still refresh, or a
        // closed/reopened issue would keep a stale badge forever.
        assert!(group_issue_sync_needed(true, false, 2, Some(2), stale, now));
        assert!(group_issue_sync_needed(true, false, 2, Some(2), None, now));
        // A quarantined claim self-heals even though it has no filed link yet.
        assert!(group_issue_sync_needed(false, true, 2, Some(0), None, now));
        assert!(!group_issue_sync_needed(
            false,
            true,
            2,
            Some(0),
            reconciliation_fresh,
            now
        ));

        assert!(group_issue_state_refresh_due(None, now));
        assert!(group_issue_state_refresh_due(
            Some(now - Duration::minutes(16)),
            now
        ));
        assert!(!group_issue_state_refresh_due(
            Some(now - Duration::minutes(14)),
            now
        ));
    }

    #[test]
    fn reconciliation_release_rule_requires_complete_consistent_evidence() {
        let absent = group_issue_reconciliation_resolution(
            GroupIssueReconciliationEvidence::Complete(&[]),
            "group-a",
        );
        assert_eq!(absent.decision, GroupIssueReconciliationDecision::Release);

        for reason in [
            GroupIssueReconciliationInconclusive::RateLimit,
            GroupIssueReconciliationInconclusive::Timeout,
            GroupIssueReconciliationInconclusive::NotFound,
            GroupIssueReconciliationInconclusive::PaginationCap,
            GroupIssueReconciliationInconclusive::IncompletePagination,
            GroupIssueReconciliationInconclusive::Server,
            GroupIssueReconciliationInconclusive::InstallationAccess,
            GroupIssueReconciliationInconclusive::InvalidResponse,
            GroupIssueReconciliationInconclusive::Transport,
        ] {
            let resolution = group_issue_reconciliation_resolution(
                GroupIssueReconciliationEvidence::Inconclusive(reason),
                "group-a",
            );
            assert_eq!(
                resolution.decision,
                GroupIssueReconciliationDecision::KeepWaiting,
                "{reason:?} must retain the claim"
            );
        }
    }

    #[test]
    fn report_group_keys_are_lowercase_fingerprints() {
        assert!(valid_report_group_key("6910e1b05a001949e02f04db6d67d013"));
        for invalid in [
            "",
            "6910e1b05a001949e02f04db6d67d01",
            "6910E1B05A001949E02F04DB6D67D013",
            "6910e1b05a001949e02f04db6d67d01g",
            "../6910e1b05a001949e02f04db6d67d013",
        ] {
            assert!(!valid_report_group_key(invalid), "{invalid}");
        }
    }

    #[test]
    fn reconciliation_adopts_only_exact_markers_and_chooses_the_oldest_issue() {
        let created_at = |hour| {
            Utc.with_ymd_and_hms(2026, 7, 31, hour, 0, 0)
                .single()
                .expect("fixed reconciliation timestamp should exist")
        };
        let issue = |number, body: String, hour, pull_request| GithubIssue {
            number,
            html_url: format!("https://github.test/issues/{number}"),
            state: "open".to_owned(),
            body: Some(body),
            created_at: created_at(hour),
            pull_request,
        };
        let exact = group_marker_comment("group-a");
        let issues = vec![
            issue(
                30,
                format!("copied {}", group_marker_comment("group-b")),
                1,
                None,
            ),
            issue(20, format!("body {exact}"), 3, None),
            issue(10, format!("body {exact}"), 2, None),
            issue(
                5,
                format!("pull request {exact}"),
                0,
                Some(serde_json::json!({})),
            ),
        ];
        let resolution = group_issue_reconciliation_resolution(
            GroupIssueReconciliationEvidence::Complete(&issues),
            "group-a",
        );
        assert_eq!(resolution.decision, GroupIssueReconciliationDecision::Adopt);
        assert_eq!(resolution.matching_issue_count, 2);
        assert_eq!(resolution.issue.map(|issue| issue.number), Some(10));

        let mismatch_only = &issues[..1];
        let mismatch = group_issue_reconciliation_resolution(
            GroupIssueReconciliationEvidence::Complete(mismatch_only),
            "group-a",
        );
        assert_ne!(mismatch.decision, GroupIssueReconciliationDecision::Adopt);
        assert!(mismatch.issue.is_none());
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
                "capabilityInspectionUrl": "https://epode.test/api/v2/capabilities/introspect",
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
                    "prompt": "May I send this product's provider one short, privacy-safe outcome report about this use? Your prompts and task content will not be included.",
                    "askOncePrompt": "May I send this product's provider one short, privacy-safe outcome report after this use and future uses without asking again? Epode will remember your choice for this product. Your prompts and task content are never included; nothing is installed.",
                    "askAlwaysPrompt": "May I send this product's provider one short, privacy-safe outcome report about this use? Your prompts and task content will not be included.",
                    "askOnceScope": "continuing scope only when the SDK receives a stable opaque customerRef; otherwise the per-use prompt applies",
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
                "node": "https://epode.test/static/agent-feedback-node-0.4.0.tgz",
                "python": "https://epode.test/static/agent_feedback-0.4.0-py3-none-any.whl",
                "go": "https://epode.test/static/agent-feedback-go-0.4.0.tar.gz",
                "rust": "https://epode.test/static/agent-feedback-rust-0.4.0.tar.gz",
                "protocol": "https://epode.test/static/agent-feedback-protocol-v1-0.4.0.zip"
            },
            "integrityManifest": "https://epode.test/static/agent-feedback-integrations-0.4.0.json",
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
            .split_once("fn build_app_router(dev_auth_enabled: bool)")
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
            ".merge(dev_auth::router())",
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

    /// The parser matches a hardcoded key; the `OpenAPI` annotation documents a
    /// name. If those two ever disagree the endpoint silently ignores the
    /// parameter callers are told to send, so pin them to one string here.
    #[test]
    fn github_install_query_parameter_is_documented() {
        let (_router, openapi) = build_app_router(false).split_for_parts();
        let spec = serde_json::to_value(&openapi).expect("the OpenAPI document should serialize");
        let parameters = spec["paths"]["/api/github/install"]["get"]["parameters"]
            .as_array()
            .expect("the install operation should document its parameters");
        let documented = parameters
            .iter()
            .filter(|parameter| parameter["in"] == "query")
            .map(|parameter| parameter["name"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            documented,
            vec![WORKSPACE_ID_QUERY_PARAM],
            "the documented query parameter must be the one the handler parses"
        );
    }

    #[test]
    fn openapi_document_covers_every_api_route_and_method() {
        let (_router, openapi) = build_app_router(false).split_for_parts();
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
