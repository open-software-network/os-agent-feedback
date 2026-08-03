#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::collections::{BTreeMap, BTreeSet};

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::{Acquire, Executor, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    code_match::CodeMatchVerificationOutcome,
    error::ApiError,
    github::validate_repo_full_name,
    grouping::{GroupInput, ReportGrouper},
    issue_template::{
        IssueCount, IssueFindingRollup, IssueTemplateData, contains_sensitive_report_text,
    },
    models::{
        ApiKeyPublic, CapabilityInspectionResponse, ConsentDecisionInput, ConsentEventSummary,
        ConsentGrant, ConsentStateInput, ConsentStateResponse, CreateProductInput,
        CreateTeamInvitationInput, CustomerContextInput, CustomerContextItem,
        CustomerContextResponse, CustomerDetailCounts, CustomerFacets, CustomerIdentifier,
        CustomerRollup, CustomerSignal, CustomerSummary, DashboardContext, DashboardCustomerDetail,
        DashboardCustomerFilters, DashboardCustomersPage, DashboardData, DashboardFeedbackFacets,
        DashboardFeedbackFilters, DashboardFeedbackPage, DashboardListState,
        DashboardResponseAnswer, DashboardResponseFilters, DashboardResponseRollup,
        DashboardResponseSummary, DashboardResponsesPage, DashboardSessionDetail,
        DashboardSessionFilters, DashboardSessionRollup, DashboardSessionSummary,
        DashboardSessionsPage, DashboardSignalFilters, DashboardSignalsPage, DeleteProductInput,
        EnrichmentAnswerAction, EnrichmentAnswerBodySchema, EnrichmentAnswerInput,
        EnrichmentAnswerItemsSchema, EnrichmentAnswerResponse, EnrichmentCatalogEntry,
        EnrichmentConsentAction, EnrichmentConsentBodySchema, EnrichmentConsentDecisionInput,
        EnrichmentConsentDecisionResponse, EnrichmentRequestInput, EnrichmentRequestResponse,
        FeedbackFindingInput, FeedbackInteractionItem, FeedbackInteractionsPage,
        FeedbackListInteractionsInput, FeedbackListReportsInput, FeedbackOperationSummary,
        FeedbackReportItem, FeedbackReportsPage, FeedbackReportsResponse, FeedbackSummary,
        FeedbackSurfaceSummary, FeedbackWindow, GithubIssueLink, InsightCount, Insights,
        InteractionTelemetryInput, MergeReportGroupsResponse, PersonalizationDecision,
        PersonalizationDecisionInput, PersonalizationDecisionResponse, PersonalizationOutcome,
        PersonalizationOutcomeInput, PersonalizationOutcomeResponse, PolicyInput, Product,
        ProductActivationMilestones, ProductAuth, ProductEnvironment, ProductFeedbackReport,
        ProductFeedbackReportInput, ProductFeedbackReportWithInteraction, ProductGithubRepo,
        ProductGithubRepoInput, ProductInteraction, ProductReportGroup, ProductSession,
        TeamInvitation, TeamMember, TelemetryBatchInput, TelemetryBatchResult,
        UpdateFeedbackWorkflowInput, UpdateNameInput, UpdateTeamMemberInput, Workspace,
        WorkspaceMembership,
    },
    os_accounts::OsUser,
    security::{
        bearer_token, parse_capability, parse_enrichment_capability, random_token, sha256,
        sha256_bytes, sign_deterministic_enrichment_capability, valid_consent_subject,
        verify_capability, verify_enrichment_capability,
    },
};

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct GithubInstallationRow {
    pub(crate) id: Uuid,
    pub(crate) installation_id: i64,
    pub(crate) account_login: String,
    pub(crate) account_type: String,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct CodeMatchJob {
    pub(crate) report_id: Uuid,
    pub(crate) product_id: Uuid,
    pub(crate) claim_token: Uuid,
    pub(crate) attempts: i32,
    pub(crate) installation_id: Option<i64>,
    pub(crate) installation_active: bool,
    pub(crate) repo_full_name: Option<String>,
    pub(crate) default_branch: Option<String>,
    pub(crate) path_prefix: Option<String>,
    pub(crate) operation: String,
    pub(crate) surface: String,
    pub(crate) runtime_hint: Option<String>,
    pub(crate) findings: serde_json::Value,
    pub(crate) verification_retry_sha: Option<String>,
    pub(crate) verification_retry_repo: Option<String>,
    pub(crate) verification_retry_count: i32,
    pub(crate) verification_retry_reason: Option<String>,
    pub(crate) verification_retry_content_sha: Option<String>,
    pub(crate) verification_retry_content_repo: Option<String>,
    pub(crate) verification_retry_file: Option<String>,
    pub(crate) verification_retry_required_content: Option<i32>,
    pub(crate) verification_retry_candidates: Option<serde_json::Value>,
}

pub(crate) struct CodeMatchCompletion<'a> {
    pub(crate) attempt: i32,
    pub(crate) computed_at_sha: &'a str,
    pub(crate) hints: serde_json::Value,
    pub(crate) verification: CodeMatchVerificationOutcome,
    pub(crate) outcome: &'a str,
}

pub(crate) struct CodeMatchVerificationRetry<'a> {
    pub(crate) target: CodeMatchVerificationRetryTarget<'a>,
    pub(crate) counts_toward_ceiling: bool,
    pub(crate) available_at: DateTime<Utc>,
    pub(crate) error: &'a str,
}

pub(crate) enum CodeMatchVerificationRetryTarget<'a> {
    PinnedCommit {
        computed_at_sha: &'a str,
        repo_full_name: &'a str,
    },
    Content {
        reason: &'a str,
        computed_at_sha: &'a str,
        repo_full_name: &'a str,
        file: Option<&'a str>,
        required_content: i32,
        candidates: Option<&'a serde_json::Value>,
    },
}

pub(crate) struct CodeMatchContentRetry<'a> {
    pub(crate) reason: &'a str,
    pub(crate) computed_at_sha: &'a str,
    pub(crate) repo_full_name: &'a str,
    pub(crate) file: Option<&'a str>,
    pub(crate) required_content: i32,
    pub(crate) candidates: Option<&'a serde_json::Value>,
}

impl CodeMatchJob {
    pub(crate) fn verification_retry(&self) -> Option<(&str, &str)> {
        self.verification_retry_sha
            .as_deref()
            .zip(self.verification_retry_repo.as_deref())
    }

    pub(crate) fn content_retry(&self) -> Option<CodeMatchContentRetry<'_>> {
        Some(CodeMatchContentRetry {
            reason: self.verification_retry_reason.as_deref()?,
            computed_at_sha: self.verification_retry_content_sha.as_deref()?,
            repo_full_name: self.verification_retry_content_repo.as_deref()?,
            file: self.verification_retry_file.as_deref(),
            required_content: self.verification_retry_required_content?,
            candidates: self.verification_retry_candidates.as_ref(),
        })
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct GroupGithubIssueRow {
    pub(crate) repo_full_name: String,
    pub(crate) issue_number: i64,
    pub(crate) url: String,
    pub(crate) state: String,
}

impl GroupGithubIssueRow {
    pub(crate) fn link(&self) -> GithubIssueLink {
        GithubIssueLink {
            repo_full_name: self.repo_full_name.clone(),
            issue_number: self.issue_number,
            url: self.url.clone(),
            state: self.state.clone(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct GroupIssueContext {
    pub(crate) merged_into_group_key: Option<String>,
    pub(crate) installation_id: Option<i64>,
    pub(crate) repo_full_name: Option<String>,
    pub(crate) installation_active: bool,
    pub(crate) template: IssueTemplateData,
}

#[derive(Debug)]
pub(crate) struct ListedProductGroup {
    pub(crate) group: ProductReportGroup,
    pub(crate) last_commented_report_count: Option<i64>,
    pub(crate) state_refreshed_at: Option<DateTime<Utc>>,
    pub(crate) needs_reconciliation: bool,
}

#[derive(Debug)]
pub(crate) struct ProductGroupPage {
    pub(crate) groups: Vec<ListedProductGroup>,
    pub(crate) has_more: bool,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct GroupIssueSyncContext {
    pub(crate) installation_id: i64,
    pub(crate) repo_full_name: String,
    pub(crate) issue_number: i64,
    pub(crate) observed_report_count: i64,
    pub(crate) current_report_count: i64,
    pub(crate) earliest_new_occurred_at: Option<DateTime<Utc>>,
    pub(crate) latest_new_occurred_at: Option<DateTime<Utc>>,
    pub(crate) state_refreshed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct GroupIssueReconciliationContext {
    pub(crate) installation_id: i64,
    pub(crate) repo_full_name: String,
    pub(crate) needs_reconciliation_since: DateTime<Utc>,
    pub(crate) reconciliation_claimed_at: DateTime<Utc>,
    pub(crate) claim_report_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GithubInstallationUpsert {
    Bound,
    ConflictingWorkspace,
}

pub(crate) fn clean(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn slug(value: &str) -> String {
    let base = value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!(
        "{}-{}",
        if base.is_empty() {
            "workspace"
        } else {
            &base[..base.len().min(36)]
        },
        &Uuid::new_v4().simple().to_string()[..6]
    )
}

fn database_conflict(error: sqlx::Error, message: &str) -> ApiError {
    if error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .as_deref()
        == Some("23505")
    {
        ApiError::conflict(message)
    } else {
        ApiError::internal(error)
    }
}

fn validated_name(value: &str, entity: &str) -> Result<String, ApiError> {
    let name = clean(value, 80);
    if name.chars().count() < 2 {
        return Err(ApiError::bad_request(format!(
            "{entity} name must contain at least 2 characters"
        )));
    }
    Ok(name)
}

pub(crate) async fn upsert_github_installation(
    pool: &PgPool,
    workspace_id: Uuid,
    installation_id: i64,
    login: &str,
    account_type: &str,
) -> Result<GithubInstallationUpsert, ApiError> {
    let result = sqlx::query(
        r"INSERT INTO github_installations
        (id, workspace_id, installation_id, account_login, account_type)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (installation_id) DO UPDATE SET
          account_login = EXCLUDED.account_login,
          account_type = EXCLUDED.account_type,
          revoked_at = NULL
        WHERE github_installations.workspace_id = EXCLUDED.workspace_id",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(installation_id)
    .bind(login)
    .bind(account_type)
    .execute(pool)
    .await?;
    Ok(if result.rows_affected() == 0 {
        GithubInstallationUpsert::ConflictingWorkspace
    } else {
        GithubInstallationUpsert::Bound
    })
}

pub(crate) async fn revoke_github_installation(
    pool: &PgPool,
    installation_id: i64,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE github_installations SET revoked_at = NOW() WHERE installation_id = $1")
        .bind(installation_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn list_github_installations(
    pool: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<GithubInstallationRow>, ApiError> {
    Ok(sqlx::query_as::<_, GithubInstallationRow>(
        r"SELECT id, installation_id, account_login, account_type, created_at
        FROM github_installations
        WHERE workspace_id = $1 AND revoked_at IS NULL
        ORDER BY account_login, installation_id",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?)
}

pub(crate) async fn github_installation_workspace(
    pool: &PgPool,
    installation_id: i64,
) -> Result<Option<Uuid>, ApiError> {
    Ok(sqlx::query_scalar(
        "SELECT workspace_id FROM github_installations WHERE installation_id = $1",
    )
    .bind(installation_id)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn ensure_product_in_workspace(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
) -> Result<(), ApiError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND workspace_id = $2)",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(ApiError::not_found("Product not found for this team"))
    }
}

pub(crate) async fn set_product_github_repo(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    input: &ProductGithubRepoInput,
) -> Result<ProductGithubRepo, ApiError> {
    validate_repo_full_name(&input.repo_full_name)
        .map_err(|_| ApiError::bad_request("Repository name must use the owner/name form"))?;
    ensure_product_in_workspace(pool, workspace_id, product_id).await?;
    let installation_exists: bool = sqlx::query_scalar(
        r"SELECT EXISTS(
          SELECT 1 FROM github_installations
          WHERE installation_id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        )",
    )
    .bind(input.installation_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    if !installation_exists {
        return Err(ApiError::not_found(
            "Active GitHub installation not found for this team",
        ));
    }
    let default_branch = input.default_branch.trim();
    if default_branch.is_empty()
        || default_branch.len() > 255
        || default_branch.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request("Default branch is invalid"));
    }
    let path_prefix = input
        .path_prefix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if path_prefix.is_some_and(|value| value.len() > 500 || value.chars().any(char::is_control)) {
        return Err(ApiError::bad_request("Path prefix is invalid"));
    }

    sqlx::query_as::<_, ProductGithubRepo>(
        r"INSERT INTO product_github_repos
        (product_id, workspace_id, installation_id, repo_full_name, default_branch, path_prefix)
        SELECT p.id, p.workspace_id, $3, $4, $5, $6
        FROM products p
        JOIN github_installations installation
          ON installation.installation_id = $3
         AND installation.workspace_id = p.workspace_id
         AND installation.revoked_at IS NULL
        WHERE p.id = $2 AND p.workspace_id = $1
        ON CONFLICT (product_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          installation_id = EXCLUDED.installation_id,
          repo_full_name = EXCLUDED.repo_full_name,
          default_branch = EXCLUDED.default_branch,
          path_prefix = EXCLUDED.path_prefix,
          updated_at = NOW()
        RETURNING product_id, installation_id, repo_full_name, default_branch, path_prefix,
          created_at, updated_at",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(input.installation_id)
    .bind(&input.repo_full_name)
    .bind(default_branch)
    .bind(path_prefix)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        ApiError::not_found("Product or active GitHub installation not found for this team")
    })
}

pub(crate) async fn get_product_github_repo(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
) -> Result<Option<ProductGithubRepo>, ApiError> {
    ensure_product_in_workspace(pool, workspace_id, product_id).await?;
    Ok(sqlx::query_as::<_, ProductGithubRepo>(
        r"SELECT product_id, installation_id, repo_full_name, default_branch, path_prefix,
          created_at, updated_at
        FROM product_github_repos
        WHERE product_id = $1 AND workspace_id = $2",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn clear_product_github_repo(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
) -> Result<bool, ApiError> {
    ensure_product_in_workspace(pool, workspace_id, product_id).await?;
    let result =
        sqlx::query("DELETE FROM product_github_repos WHERE product_id = $1 AND workspace_id = $2")
            .bind(product_id)
            .bind(workspace_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() == 1)
}

async fn enqueue_code_match_if_mapped(
    tx: &mut Transaction<'_, Postgres>,
    report_id: Uuid,
    product_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        r"INSERT INTO code_match_queue (report_id, product_id)
        SELECT $1, mapping.product_id
        FROM product_github_repos mapping
        WHERE mapping.product_id = $2
        ON CONFLICT (report_id) DO NOTHING",
    )
    .bind(report_id)
    .bind(product_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn claim_code_match_batch(
    pool: &PgPool,
    limit: i64,
    stale_before: DateTime<Utc>,
) -> Result<Vec<CodeMatchJob>, ApiError> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let claim_token = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    // A worker can die after claiming but before releasing. Reset only claims
    // older than the client/request timeout envelope, then let the normal
    // indexed claim predicate pick them up again.
    sqlx::query(
        r"UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL
        WHERE dead_lettered_at IS NULL AND claimed_at < $1",
    )
    .bind(stale_before)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r"WITH claimable AS (
          SELECT report_id
          FROM code_match_queue
          WHERE claimed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= NOW()
          ORDER BY enqueued_at, available_at, report_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE code_match_queue queue SET
          claimed_at = NOW(), claim_token = $2, attempts = queue.attempts + 1
        FROM claimable
        WHERE queue.report_id = claimable.report_id",
    )
    .bind(limit)
    .bind(claim_token)
    .execute(&mut *tx)
    .await?;
    let jobs = sqlx::query_as::<_, CodeMatchJob>(
        r"SELECT queue.report_id, queue.product_id, queue.claim_token, queue.attempts,
          queue.verification_retry_sha, queue.verification_retry_repo,
          queue.verification_retry_count,
          queue.verification_retry_reason, queue.verification_retry_content_sha,
          queue.verification_retry_content_repo, queue.verification_retry_file,
          queue.verification_retry_required_content, queue.verification_retry_candidates,
          mapping.installation_id,
          (installation.installation_id IS NOT NULL) AS installation_active,
          mapping.repo_full_name, mapping.default_branch, mapping.path_prefix,
          interaction.operation, interaction.surface,
          interaction.runtime_hint, report.findings
        FROM code_match_queue queue
        JOIN feedback_reports report ON report.id = queue.report_id
        JOIN interactions_v2 interaction ON interaction.id = report.interaction_id
        LEFT JOIN product_github_repos mapping ON mapping.product_id = queue.product_id
        LEFT JOIN github_installations installation
          ON installation.installation_id = mapping.installation_id
         AND installation.workspace_id = report.workspace_id
         AND installation.revoked_at IS NULL
        WHERE queue.claim_token = $1
        ORDER BY mapping.installation_id, queue.enqueued_at, queue.report_id",
    )
    .bind(claim_token)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(jobs)
}

pub(crate) async fn record_code_match_call(
    pool: &PgPool,
    report_id: Uuid,
    rate_headroom: Option<i64>,
    hit: bool,
    latency_ms: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        r"INSERT INTO match_analytics
        (id, report_id, calls_used, rate_headroom, hit, latency_ms)
        VALUES ($1, $2, 1, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(report_id)
    .bind(rate_headroom)
    .bind(hit)
    .bind(latency_ms.max(0))
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn complete_code_match_job(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
    completion: CodeMatchCompletion<'_>,
) -> Result<bool, ApiError> {
    let completed = sqlx::query_scalar::<_, Uuid>(
        r"WITH completed AS (
          DELETE FROM code_match_queue
          WHERE report_id = $1 AND claim_token = $2
          RETURNING report_id
        ), hints_written AS (
          INSERT INTO report_code_hints (report_id, computed_at_sha, hints, outcome)
          SELECT report_id, $3, $4, $11 FROM completed
          ON CONFLICT (report_id) DO UPDATE SET
            computed_at_sha = EXCLUDED.computed_at_sha,
            hints = EXCLUDED.hints,
            outcome = EXCLUDED.outcome,
            created_at = NOW()
          RETURNING report_id
        ), verification_recorded AS (
          INSERT INTO code_match_verification_analytics
          (id, report_id, attempt, computed_at_sha, candidates_seen,
            dropped_as_absent, kept_verified, kept_unverified)
          SELECT $5, report_id, $6, $3, $7, $8, $9, $10 FROM hints_written
          RETURNING report_id
        )
        SELECT report_id FROM verification_recorded",
    )
    .bind(report_id)
    .bind(claim_token)
    .bind(completion.computed_at_sha)
    .bind(completion.hints)
    .bind(Uuid::new_v4())
    .bind(completion.attempt)
    .bind(completion.verification.candidates_seen)
    .bind(completion.verification.dropped_as_absent)
    .bind(completion.verification.kept_verified)
    .bind(completion.verification.kept_unverified)
    .bind(completion.outcome)
    .fetch_optional(pool)
    .await?;
    Ok(completed.is_some())
}

/// Releases unsettled verification without consuming its ordinary attempt
/// slot. Pinned-commit and content retries retain distinct state while sharing
/// the bounded verification counter. Content retries also retain their noisy
/// search candidates so later claims resume core-quota checks without spending
/// search quota again.
pub(crate) async fn release_code_match_for_verification_retry(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
    retry: CodeMatchVerificationRetry<'_>,
) -> Result<bool, ApiError> {
    let (
        pinned_sha,
        pinned_repo,
        reason,
        content_sha,
        content_repo,
        file,
        required_content,
        candidates,
    ) = match retry.target {
        CodeMatchVerificationRetryTarget::PinnedCommit {
            computed_at_sha,
            repo_full_name,
        } => (
            Some(computed_at_sha),
            Some(repo_full_name),
            None,
            None,
            None,
            None,
            None,
            None,
        ),
        CodeMatchVerificationRetryTarget::Content {
            reason,
            computed_at_sha,
            repo_full_name,
            file,
            required_content,
            candidates,
        } => (
            None,
            None,
            Some(reason),
            Some(computed_at_sha),
            Some(repo_full_name),
            file,
            Some(required_content),
            candidates,
        ),
    };
    let result = sqlx::query(
        r"UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL,
          verification_retry_sha = $3, verification_retry_repo = $4,
          verification_retry_reason = $5,
          verification_retry_content_sha = $6,
          verification_retry_content_repo = $7,
          verification_retry_file = $8,
          verification_retry_required_content = $9,
          verification_retry_candidates = $10,
          verification_retry_count = verification_retry_count
            + CASE WHEN $11 THEN 1 ELSE 0 END,
          available_at = $12, last_error = LEFT($13, 500),
          attempts = GREATEST(attempts - 1, 0)
        WHERE report_id = $1 AND claim_token = $2",
    )
    .bind(report_id)
    .bind(claim_token)
    .bind(pinned_sha)
    .bind(pinned_repo)
    .bind(reason)
    .bind(content_sha)
    .bind(content_repo)
    .bind(file)
    .bind(required_content)
    .bind(candidates)
    .bind(retry.counts_toward_ceiling)
    .bind(retry.available_at)
    .bind(retry.error)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn clear_code_match_verification_retry_marker(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE code_match_queue SET verification_retry_sha = NULL,
          verification_retry_repo = NULL, last_error = NULL
        WHERE report_id = $1 AND claim_token = $2",
    )
    .bind(report_id)
    .bind(claim_token)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn reset_code_match_verification_retry(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE code_match_queue SET verification_retry_sha = NULL,
          verification_retry_repo = NULL, verification_retry_count = 0,
          verification_retry_reason = NULL, verification_retry_content_sha = NULL,
          verification_retry_content_repo = NULL, verification_retry_file = NULL,
          verification_retry_required_content = NULL, verification_retry_candidates = NULL,
          last_error = NULL
        WHERE report_id = $1 AND claim_token = $2",
    )
    .bind(report_id)
    .bind(claim_token)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Atomically makes an exhausted verification episode terminal and visible:
/// the queue row is dead-lettered, an empty hints row is upserted, and a
/// zero-count analytics row is appended in the same statement. The explicit
/// `terminal_unverifiable` hints outcome distinguishes it from both a no-hit
/// settlement and proven absence without consulting the retained queue row.
pub(crate) async fn terminally_dead_letter_code_match_verification(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
    attempt: i32,
    computed_at_sha: &str,
    reason: &str,
) -> Result<bool, ApiError> {
    let terminal = sqlx::query_scalar::<_, Uuid>(
        r"WITH dead_lettered AS (
          UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL,
            dead_lettered_at = NOW(), last_error = LEFT($4, 500),
            verification_retry_sha = NULL, verification_retry_repo = NULL,
            verification_retry_count = 0, verification_retry_reason = NULL,
            verification_retry_content_sha = NULL,
            verification_retry_content_repo = NULL, verification_retry_file = NULL,
            verification_retry_required_content = NULL, verification_retry_candidates = NULL
          WHERE report_id = $1 AND claim_token = $2
          RETURNING report_id
        ), hints_written AS (
          INSERT INTO report_code_hints (report_id, computed_at_sha, hints, outcome)
          SELECT report_id, $3, '[]'::jsonb, 'terminal_unverifiable' FROM dead_lettered
          ON CONFLICT (report_id) DO UPDATE SET
            computed_at_sha = EXCLUDED.computed_at_sha,
            hints = EXCLUDED.hints,
            outcome = EXCLUDED.outcome,
            created_at = NOW()
          RETURNING report_id
        ), verification_recorded AS (
          INSERT INTO code_match_verification_analytics
          (id, report_id, attempt, computed_at_sha, candidates_seen,
            dropped_as_absent, kept_verified, kept_unverified)
          SELECT $5, report_id, $6, $3, 0, 0, 0, 0 FROM hints_written
          RETURNING report_id
        )
        SELECT report_id FROM verification_recorded",
    )
    .bind(report_id)
    .bind(claim_token)
    .bind(computed_at_sha)
    .bind(reason)
    .bind(Uuid::new_v4())
    .bind(attempt)
    .fetch_optional(pool)
    .await?;
    Ok(terminal.is_some())
}

pub(crate) async fn dead_letter_code_match_job(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
    reason: &str,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL,
          dead_lettered_at = NOW(), last_error = LEFT($3, 500)
        WHERE report_id = $1 AND claim_token = $2",
    )
    .bind(report_id)
    .bind(claim_token)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn release_code_match_job(
    pool: &PgPool,
    report_id: Uuid,
    claim_token: Uuid,
    available_at: DateTime<Utc>,
    error: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query(
        r"UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL,
          available_at = $3, last_error = LEFT($4, 500)
        WHERE report_id = $1 AND claim_token = $2",
    )
    .bind(report_id)
    .bind(claim_token)
    .bind(available_at)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn release_code_match_claim(
    pool: &PgPool,
    claim_token: Uuid,
    available_at: DateTime<Utc>,
    error: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r"UPDATE code_match_queue SET claimed_at = NULL, claim_token = NULL,
          available_at = $2, last_error = LEFT($3, 500)
        WHERE claim_token = $1",
    )
    .bind(claim_token)
    .bind(available_at)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct GroupIssueContextRow {
    group_key: String,
    explanation: String,
    merged_into_group_key: Option<String>,
    installation_id: Option<i64>,
    repo_full_name: Option<String>,
    installation_active: bool,
    report_count: i64,
    earliest_occurred_at: Option<DateTime<Utc>>,
    latest_occurred_at: Option<DateTime<Utc>>,
    primary_kind: Option<String>,
    primary_topic: Option<String>,
    primary_operation: Option<String>,
    impacts: serde_json::Value,
    findings: serde_json::Value,
    workarounds: serde_json::Value,
    operations: Vec<String>,
    surfaces: Vec<String>,
    status_codes: Vec<i32>,
}

pub(crate) async fn group_issue_context(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    backlink: String,
) -> Result<Option<GroupIssueContext>, ApiError> {
    group_issue_context_with_executor(pool, workspace_id, group_key, backlink).await
}

async fn group_issue_context_with_executor<'executor>(
    executor: impl Executor<'executor, Database = Postgres>,
    workspace_id: Uuid,
    group_key: &str,
    backlink: String,
) -> Result<Option<GroupIssueContext>, ApiError> {
    let row = sqlx::query_as::<_, GroupIssueContextRow>(
        r"WITH scoped_group AS (
          SELECT g.id, g.workspace_id, g.product_id, g.group_key, g.explanation,
            g.merged_into_group_key,
            mapping.installation_id, mapping.repo_full_name,
            (installation.installation_id IS NOT NULL) AS installation_active
          FROM report_groups g
          JOIN products p
            ON p.id = g.product_id AND p.workspace_id = g.workspace_id
          LEFT JOIN product_github_repos mapping
            ON mapping.product_id = g.product_id
           AND mapping.workspace_id = g.workspace_id
          LEFT JOIN github_installations installation
            ON installation.installation_id = mapping.installation_id
           AND installation.workspace_id = g.workspace_id
           AND installation.revoked_at IS NULL
          WHERE g.workspace_id = $1 AND g.group_key = $2
        ),
        scoped_reports AS (
          SELECT r.id AS report_id, r.impact, r.findings, r.workaround, r.created_at,
            i.operation, i.surface, i.status_code, i.occurred_at
          FROM scoped_group g
          JOIN feedback_reports r
            ON r.group_id = g.id AND r.workspace_id = g.workspace_id
          JOIN interactions_v2 i
            ON i.id = r.interaction_id AND i.workspace_id = g.workspace_id
          JOIN product_environments environment
            ON environment.id = i.environment_id
           AND environment.workspace_id = g.workspace_id
           AND environment.product_id = g.product_id
        ),
        expanded_findings AS (
          SELECT reports.report_id, reports.operation, reports.occurred_at,
            finding.ordinality,
            finding.value ->> 'kind' AS kind,
            finding.value ->> 'topic' AS topic,
            finding.value ->> 'severity' AS severity,
            finding.value ->> 'detail' AS detail
          FROM scoped_reports reports
          CROSS JOIN LATERAL
            jsonb_array_elements(reports.findings) WITH ORDINALITY AS finding(value, ordinality)
          WHERE COALESCE(finding.value ->> 'kind', '') <> ''
            AND COALESCE(finding.value ->> 'topic', '') <> ''
        ),
        finding_rollups AS (
          SELECT kind, topic, COUNT(*)::BIGINT AS count,
            COUNT(*) FILTER (WHERE COALESCE(detail, '') <> '')::BIGINT AS detail_count,
            COALESCE(
              (ARRAY_AGG(detail ORDER BY occurred_at, report_id, ordinality)
                FILTER (WHERE COALESCE(detail, '') <> ''))[1:10],
              ARRAY[]::TEXT[]
            ) AS details
          FROM expanded_findings
          GROUP BY kind, topic
        ),
        primary_finding AS (
          SELECT kind, topic, operation
          FROM expanded_findings
          ORDER BY
            CASE severity
              WHEN 'blocking' THEN 3 WHEN 'major' THEN 2 WHEN 'minor' THEN 1 ELSE 0
            END DESC,
            CASE kind
              WHEN 'defect' THEN 7 WHEN 'friction' THEN 6 WHEN 'gap' THEN 5
              WHEN 'uncertainty' THEN 4 WHEN 'suggestion' THEN 3 WHEN 'other' THEN 2
              WHEN 'strength' THEN 1 ELSE 0
            END DESC,
            occurred_at, report_id, ordinality
          LIMIT 1
        )
        SELECT g.group_key, g.explanation, g.merged_into_group_key,
          g.installation_id, g.repo_full_name,
          g.installation_active,
          (SELECT COUNT(*)::BIGINT FROM scoped_reports) AS report_count,
          (SELECT MIN(occurred_at) FROM scoped_reports) AS earliest_occurred_at,
          (SELECT MAX(occurred_at) FROM scoped_reports) AS latest_occurred_at,
          (SELECT kind FROM primary_finding) AS primary_kind,
          (SELECT topic FROM primary_finding) AS primary_topic,
          COALESCE(
            (SELECT operation FROM primary_finding),
            (SELECT MIN(operation) FROM scoped_reports),
            'unknown'
          ) AS primary_operation,
          COALESCE((
            SELECT JSONB_AGG(
              JSONB_BUILD_OBJECT('value', impact, 'count', count)
              ORDER BY impact
            )
            FROM (
              SELECT impact, COUNT(*)::BIGINT AS count
              FROM scoped_reports
              WHERE impact IS NOT NULL
              GROUP BY impact
            ) impact_counts
          ), '[]'::JSONB) AS impacts,
          COALESCE((
            SELECT JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'kind', kind,
                'topic', topic,
                'count', count,
                'detailCount', detail_count,
                'details', details
              )
              ORDER BY count DESC, kind, topic
            )
            FROM finding_rollups
          ), '[]'::JSONB) AS findings,
          COALESCE((
            SELECT JSONB_AGG(workaround ORDER BY workaround::TEXT)
            FROM (
              SELECT DISTINCT workaround
              FROM scoped_reports
              WHERE workaround IS NOT NULL
            ) distinct_workarounds
          ), '[]'::JSONB) AS workarounds,
          ARRAY(
            SELECT DISTINCT operation FROM scoped_reports ORDER BY operation
          ) AS operations,
          ARRAY(
            SELECT DISTINCT surface FROM scoped_reports ORDER BY surface
          ) AS surfaces,
          ARRAY(
            SELECT DISTINCT status_code
            FROM scoped_reports
            WHERE status_code IS NOT NULL
            ORDER BY status_code
          ) AS status_codes
        FROM scoped_group g",
    )
    .bind(workspace_id)
    .bind(group_key)
    .fetch_optional(executor)
    .await?;

    row.map(|row| {
        let impacts =
            serde_json::from_value::<Vec<IssueCount>>(row.impacts).map_err(ApiError::internal)?;
        let findings = serde_json::from_value::<Vec<IssueFindingRollup>>(row.findings)
            .map_err(ApiError::internal)?;
        let workarounds = serde_json::from_value::<Vec<serde_json::Value>>(row.workarounds)
            .map_err(ApiError::internal)?;
        Ok(GroupIssueContext {
            merged_into_group_key: row.merged_into_group_key,
            installation_id: row.installation_id,
            repo_full_name: row.repo_full_name,
            installation_active: row.installation_active,
            template: IssueTemplateData {
                group_key: row.group_key,
                explanation: row.explanation,
                primary_kind: row.primary_kind.unwrap_or_else(|| "none".to_owned()),
                primary_topic: row.primary_topic.unwrap_or_else(|| "none".to_owned()),
                primary_operation: row
                    .primary_operation
                    .unwrap_or_else(|| "unknown".to_owned()),
                impacts,
                findings,
                workarounds,
                operations: row.operations,
                surfaces: row.surfaces,
                status_codes: row.status_codes,
                earliest_occurred_at: row.earliest_occurred_at,
                latest_occurred_at: row.latest_occurred_at,
                report_count: row.report_count,
                backlink,
            },
        })
    })
    .transpose()
}

pub(crate) async fn get_group_github_issue(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<Option<GroupGithubIssueRow>, ApiError> {
    Ok(sqlx::query_as::<_, GroupGithubIssueRow>(
        r"SELECT issue.repo_full_name, issue.issue_number, issue.url, issue.state
        FROM group_github_issues issue
        JOIN report_groups report_group
          ON report_group.group_key = issue.group_key
         AND report_group.workspace_id = issue.workspace_id
        WHERE issue.workspace_id = $1 AND issue.group_key = $2
          AND issue.filing_state = 'filed'",
    )
    .bind(workspace_id)
    .bind(group_key)
    .fetch_optional(pool)
    .await?)
}

/// Outcome of trying to claim a group for issue filing.
#[derive(Debug)]
pub(crate) enum GroupIssueFilingClaim {
    /// The caller owns the claim and should now call GitHub.
    Claimed,
    /// An issue already exists; return it and call nothing.
    AlreadyFiled(Box<GroupGithubIssueRow>),
    /// Another filer holds a fresh claim.
    InProgress,
    /// GitHub may already have created the issue; reconcile before filing.
    NeedsReconciliation,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GroupIssueFilingRequest<'a> {
    pub(crate) workspace_id: Uuid,
    pub(crate) group_key: &'a str,
    pub(crate) installation_id: i64,
    pub(crate) repo_full_name: &'a str,
    pub(crate) created_by: &'a str,
    /// Exact report count represented by the body rendered before this claim.
    pub(crate) claim_report_count: i64,
}

/// Claims a group for filing before any GitHub call is made.
///
/// The primary key on `group_key` is what de-duplicates concurrent filers, so
/// no database connection has to be held across the network request. A filer
/// that dies mid-call leaves a `pending` row. Once it is older than
/// `stale_cutoff`, the outcome is ambiguous, so it is quarantined for
/// reconciliation instead of being handed to another blind filer.
/// `claim_report_count` becomes the evidence baseline on either direct filing
/// or later adoption; a live recount at adoption would silently swallow reports
/// that arrived after the rendered body.
pub(crate) async fn claim_group_issue_filing(
    pool: &PgPool,
    request: GroupIssueFilingRequest<'_>,
    stale_cutoff: DateTime<Utc>,
) -> Result<GroupIssueFilingClaim, ApiError> {
    let mut tx = pool.begin().await?;

    // Take the SAME advisory lock `merge_report_groups` takes, on the same key.
    // Row locks cannot close this race in either direction: a merge locks the
    // `group_github_issues` rows that exist, but a filing that has not claimed
    // yet has no row to lock, and a merge that has not committed its lineage
    // yet is invisible to the filing's check. The advisory lock is a mutual
    // exclusion point that exists before any row does.
    //
    // This does not reintroduce the connection-holding problem that removed the
    // old filing lock: the GitHub call now happens after this transaction
    // commits, so the lock is held only for these few statements.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(request.group_key)
        .execute(&mut *tx)
        .await?;

    // Re-check lineage under the lock. A merge that committed while this
    // request was in flight is now visible, and a merge still running cannot
    // interleave past this point.
    let merge_target = sqlx::query_scalar::<_, Option<String>>(
        r"SELECT report_group.merged_into_group_key
        FROM report_groups report_group
        JOIN products product
          ON product.id = report_group.product_id
         AND product.workspace_id = report_group.workspace_id
        WHERE report_group.workspace_id = $1 AND report_group.group_key = $2",
    )
    .bind(request.workspace_id)
    .bind(request.group_key)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    if let Some(target_group_key) = merge_target {
        return Err(ApiError::conflict(format!(
            "Feedback group was merged into {target_group_key}; file the target group instead"
        )));
    }
    let claimed = sqlx::query_scalar::<_, i32>(
        r"INSERT INTO group_github_issues
        (group_key, workspace_id, installation_id, repo_full_name, created_by,
         filing_state, claimed_at, last_commented_report_count)
        SELECT report_group.group_key, report_group.workspace_id, $3, $4, $5,
          'pending', NOW(), $6
        FROM report_groups report_group
        JOIN products product
          ON product.id = report_group.product_id
         AND product.workspace_id = report_group.workspace_id
        WHERE report_group.workspace_id = $1 AND report_group.group_key = $2
        ON CONFLICT (group_key) DO NOTHING
        RETURNING 1",
    )
    .bind(request.workspace_id)
    .bind(request.group_key)
    .bind(request.installation_id)
    .bind(request.repo_full_name)
    .bind(request.created_by)
    .bind(request.claim_report_count)
    .fetch_optional(&mut *tx)
    .await?;
    if claimed.is_some() {
        tx.commit().await?;
        return Ok(GroupIssueFilingClaim::Claimed);
    }

    let existing = sqlx::query_as::<_, GroupGithubIssueRow>(
        r"SELECT issue.repo_full_name, issue.issue_number, issue.url, issue.state
        FROM group_github_issues issue
        JOIN report_groups report_group
          ON report_group.group_key = issue.group_key
         AND report_group.workspace_id = issue.workspace_id
        WHERE issue.workspace_id = $1 AND issue.group_key = $2
          AND issue.filing_state = 'filed'",
    )
    .bind(request.workspace_id)
    .bind(request.group_key)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        tx.commit().await?;
        return Ok(GroupIssueFilingClaim::AlreadyFiled(Box::new(existing)));
    }

    let needs_reconciliation = sqlx::query_scalar::<_, bool>(
        r"SELECT EXISTS (
          SELECT 1 FROM group_github_issues
          WHERE workspace_id = $1 AND group_key = $2
            AND filing_state = 'needs_reconciliation'
        )",
    )
    .bind(request.workspace_id)
    .bind(request.group_key)
    .fetch_one(&mut *tx)
    .await?;
    if needs_reconciliation {
        tx.commit().await?;
        return Ok(GroupIssueFilingClaim::NeedsReconciliation);
    }

    // A stale pending owner may have died after GitHub accepted the request.
    // Quarantine it for a consistent marker listing rather than filing a
    // possible duplicate.
    let quarantined = sqlx::query_scalar::<_, i32>(
        r"UPDATE group_github_issues
        SET filing_state = 'needs_reconciliation', state_refreshed_at = NULL,
            updated_at = NOW()
        WHERE workspace_id = $1 AND group_key = $2
          AND filing_state = 'pending' AND claimed_at <= $3
        RETURNING 1",
    )
    .bind(request.workspace_id)
    .bind(request.group_key)
    .bind(stale_cutoff)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    if quarantined.is_some() {
        return Ok(GroupIssueFilingClaim::NeedsReconciliation);
    }
    Ok(GroupIssueFilingClaim::InProgress)
}

/// Records the issue GitHub returned against a claim this caller owns.
pub(crate) async fn complete_group_issue_filing(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    link: &GithubIssueLink,
    report_count: i64,
) -> Result<GroupGithubIssueRow, ApiError> {
    sqlx::query_as::<_, GroupGithubIssueRow>(
        r"UPDATE group_github_issues
        SET issue_number = $3, url = $4, state = $5, filing_state = 'filed',
            last_commented_report_count = $6, state_refreshed_at = NOW(), updated_at = NOW()
        WHERE workspace_id = $1 AND group_key = $2 AND filing_state = 'pending'
        RETURNING repo_full_name, issue_number, url, state",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(link.issue_number)
    .bind(&link.url)
    .bind(&link.state)
    .bind(report_count)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::internal("GitHub issue filing claim disappeared before it completed"))
}

/// Drops a claim whose GitHub call failed, so a retry can file cleanly.
pub(crate) async fn release_group_issue_filing_claim(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r"DELETE FROM group_github_issues
        WHERE workspace_id = $1 AND group_key = $2 AND filing_state = 'pending'",
    )
    .bind(workspace_id)
    .bind(group_key)
    .execute(pool)
    .await?;
    Ok(())
}

/// Retains an ambiguous filing outcome until GitHub search can settle it.
pub(crate) async fn mark_group_issue_filing_for_reconciliation(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues
        SET filing_state = 'needs_reconciliation', state_refreshed_at = NULL,
            updated_at = NOW()
        WHERE workspace_id = $1 AND group_key = $2 AND filing_state = 'pending'",
    )
    .bind(workspace_id)
    .bind(group_key)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Claims one throttled reconciliation attempt and returns its pinned repo.
pub(crate) async fn claim_group_issue_reconciliation(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    refresh_cutoff: DateTime<Utc>,
) -> Result<Option<GroupIssueReconciliationContext>, ApiError> {
    Ok(sqlx::query_as::<_, GroupIssueReconciliationContext>(
        r"WITH candidate AS (
          SELECT issue.group_key
          FROM group_github_issues issue
          JOIN report_groups report_group
            ON report_group.group_key = issue.group_key
           AND report_group.workspace_id = issue.workspace_id
          JOIN products product
            ON product.id = report_group.product_id
           AND product.workspace_id = report_group.workspace_id
          JOIN github_installations installation
            ON installation.installation_id = issue.installation_id
           AND installation.workspace_id = issue.workspace_id
           AND installation.revoked_at IS NULL
          WHERE issue.workspace_id = $1 AND issue.group_key = $2
            AND issue.filing_state = 'needs_reconciliation'
        ), claimed AS (
          UPDATE group_github_issues issue
          SET state_refreshed_at = NOW(), updated_at = NOW()
          FROM candidate
          WHERE issue.group_key = candidate.group_key
            AND issue.workspace_id = $1
            AND issue.filing_state = 'needs_reconciliation'
            AND (
              issue.state_refreshed_at IS NULL
              OR issue.state_refreshed_at <= $3
            )
          RETURNING issue.group_key, issue.installation_id, issue.repo_full_name,
            issue.claimed_at AS needs_reconciliation_since,
            issue.state_refreshed_at AS reconciliation_claimed_at,
            issue.last_commented_report_count AS claim_report_count
        )
        SELECT claimed.installation_id, claimed.repo_full_name,
          claimed.needs_reconciliation_since, claimed.reconciliation_claimed_at,
          claimed.claim_report_count
        FROM claimed
        JOIN candidate ON candidate.group_key = claimed.group_key",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(refresh_cutoff)
    .fetch_optional(pool)
    .await?)
}

/// Adopts the exactly marked issue if this task still owns the attempt.
pub(crate) async fn complete_group_issue_reconciliation(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    reconciliation_claimed_at: DateTime<Utc>,
    link: &GithubIssueLink,
    claim_report_count: i64,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues
        SET issue_number = $4, url = $5, state = $6, filing_state = 'filed',
            last_commented_report_count = $7, state_refreshed_at = NOW(), updated_at = NOW()
        WHERE workspace_id = $1 AND group_key = $2
          AND filing_state = 'needs_reconciliation'
          AND state_refreshed_at = $3",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(reconciliation_claimed_at)
    .bind(link.issue_number)
    .bind(&link.url)
    .bind(&link.state)
    .bind(claim_report_count)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Releases a definitively absent issue if this task still owns the attempt.
pub(crate) async fn release_group_issue_reconciliation_claim(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    reconciliation_claimed_at: DateTime<Utc>,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"DELETE FROM group_github_issues
        WHERE workspace_id = $1 AND group_key = $2
          AND filing_state = 'needs_reconciliation'
          AND state_refreshed_at = $3",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(reconciliation_claimed_at)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MergeReportGroupRow {
    id: Uuid,
    group_key: String,
    product_id: Uuid,
    merged_into_group_key: Option<String>,
}

pub(crate) async fn merge_report_groups(
    pool: &PgPool,
    workspace_id: Uuid,
    source_group_key: &str,
    target_group_key: &str,
    actor_os_user_id: &str,
) -> Result<MergeReportGroupsResponse, ApiError> {
    if source_group_key == target_group_key {
        return Err(ApiError::bad_request(
            "Source and target feedback groups must be different",
        ));
    }

    let mut tx = pool.begin().await?;
    let mut lock_keys = [source_group_key, target_group_key];
    lock_keys.sort_unstable();
    for group_key in lock_keys {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(group_key)
            .execute(&mut *tx)
            .await?;
    }

    let groups = sqlx::query_as::<_, MergeReportGroupRow>(
        r"SELECT id, group_key, product_id, merged_into_group_key
        FROM report_groups
        WHERE workspace_id = $1 AND (group_key = $2 OR group_key = $3)
        ORDER BY group_key
        FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(source_group_key)
    .bind(target_group_key)
    .fetch_all(&mut *tx)
    .await?;
    let source = groups
        .iter()
        .find(|group| group.group_key == source_group_key)
        .cloned()
        .ok_or_else(|| ApiError::not_found("Source feedback group not found for this team"))?;
    let target = groups
        .iter()
        .find(|group| group.group_key == target_group_key)
        .cloned()
        .ok_or_else(|| ApiError::not_found("Target feedback group not found for this team"))?;

    if source.product_id != target.product_id {
        return Err(ApiError::conflict(
            "Source and target feedback groups belong to different products",
        ));
    }
    // Merge lineage is deliberately exactly one hop. Both sides must be final,
    // unmerged groups, which prevents chains and makes cycles impossible.
    if let Some(final_target) = source.merged_into_group_key {
        return Err(ApiError::conflict(format!(
            "Source feedback group is already merged into {final_target}"
        )));
    }
    if let Some(final_target) = target.merged_into_group_key {
        return Err(ApiError::conflict(format!(
            "Target feedback group is already merged into {final_target}; merge into that final target directly"
        )));
    }
    let source_has_merged_groups = sqlx::query_scalar::<_, bool>(
        r"SELECT EXISTS (
          SELECT 1
          FROM report_groups
          WHERE workspace_id = $1 AND merged_into_group_key = $2
        )",
    )
    .bind(workspace_id)
    .bind(source_group_key)
    .fetch_one(&mut *tx)
    .await?;
    if source_has_merged_groups {
        return Err(ApiError::conflict(
            "Source feedback group is already the final target of another merge and cannot be merged away",
        ));
    }

    // `issue_number` is NULL while a filing is in flight, so select the filing
    // state too and decode the number as optional. Reading it as a bare `i64`
    // would fail at runtime the moment a merge raced a filing.
    let issue_rows = sqlx::query_as::<_, (String, Option<i64>, String)>(
        r"SELECT group_key, issue_number, filing_state
        FROM group_github_issues
        WHERE workspace_id = $1 AND (group_key = $2 OR group_key = $3)
        ORDER BY group_key
        FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(source_group_key)
    .bind(target_group_key)
    .fetch_all(&mut *tx)
    .await?;
    // An unsettled filing on either side blocks the merge. Merging mid-filing
    // would let the in-flight issue land against a group that no longer owns
    // these reports, and reconciliation would then adopt it for the wrong
    // group. Same spirit as the both-issues conflict below, but retriable:
    // the claim settles on its own within minutes.
    if let Some((group_key, _, filing_state)) = issue_rows
        .iter()
        .find(|(_, _, filing_state)| filing_state != "filed")
    {
        return Err(ApiError::conflict(format!(
            "A GitHub issue filing is still in progress for {group_key} ({filing_state}); retry the merge once it settles"
        )));
    }
    let source_issue_number = issue_rows.iter().find_map(|(group_key, issue_number, _)| {
        (group_key == source_group_key)
            .then_some(*issue_number)
            .flatten()
    });
    let target_issue_number = issue_rows.iter().find_map(|(group_key, issue_number, _)| {
        (group_key == target_group_key)
            .then_some(*issue_number)
            .flatten()
    });
    if let (Some(source_issue), Some(target_issue)) = (source_issue_number, target_issue_number) {
        return Err(ApiError::conflict(format!(
            "Source GitHub issue #{source_issue} and target GitHub issue #{target_issue} are both filed; close one on GitHub before merging"
        )));
    }

    let moved = sqlx::query(
        r"UPDATE feedback_reports
        SET group_id = $1
        WHERE workspace_id = $2 AND group_id = $3",
    )
    .bind(target.id)
    .bind(workspace_id)
    .bind(source.id)
    .execute(&mut *tx)
    .await?;

    if source_issue_number.is_some() {
        sqlx::query(
            r"UPDATE group_github_issues
            SET group_key = $1, last_commented_report_count = 0, updated_at = NOW()
            WHERE workspace_id = $2 AND group_key = $3",
        )
        .bind(target_group_key)
        .bind(workspace_id)
        .bind(source_group_key)
        .execute(&mut *tx)
        .await?;
    }

    let lineage_updated = sqlx::query(
        r"UPDATE report_groups
        SET merged_into_group_key = $1, merged_at = NOW(), merged_by = $2, updated_at = NOW()
        WHERE workspace_id = $3 AND id = $4 AND merged_into_group_key IS NULL",
    )
    .bind(target_group_key)
    .bind(actor_os_user_id)
    .bind(workspace_id)
    .bind(source.id)
    .execute(&mut *tx)
    .await?;
    if lineage_updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "Source feedback group was merged concurrently",
        ));
    }

    let reports_moved = i64::try_from(moved.rows_affected()).map_err(ApiError::internal)?;
    tx.commit().await?;
    Ok(MergeReportGroupsResponse {
        reports_moved,
        target_group_key: target_group_key.to_owned(),
    })
}

#[derive(Debug, sqlx::FromRow)]
struct ProductGroupListRow {
    group_key: String,
    explanation: String,
    report_count: i64,
    latest_occurred_at: Option<DateTime<Utc>>,
    issue_repo_full_name: Option<String>,
    issue_number: Option<i64>,
    issue_url: Option<String>,
    issue_state: Option<String>,
    last_commented_report_count: Option<i64>,
    state_refreshed_at: Option<DateTime<Utc>>,
    filing_state: Option<String>,
}

pub(crate) async fn list_product_groups(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<ProductGroupPage, ApiError> {
    ensure_product_in_workspace(pool, workspace_id, product_id).await?;
    let limit = limit.clamp(1, 100);
    let offset = offset.max(0);
    let rows = sqlx::query_as::<_, ProductGroupListRow>(
        r"SELECT report_group.group_key, report_group.explanation,
          COUNT(environment.id)::BIGINT AS report_count,
          MAX(interaction.occurred_at) FILTER (
            WHERE environment.id IS NOT NULL
          ) AS latest_occurred_at,
          issue.repo_full_name AS issue_repo_full_name,
          issue.issue_number,
          issue.url AS issue_url,
          issue.state AS issue_state,
          issue.last_commented_report_count,
          issue.state_refreshed_at,
          issue.filing_state
        FROM report_groups report_group
        JOIN products product
          ON product.id = report_group.product_id
         AND product.workspace_id = report_group.workspace_id
        LEFT JOIN feedback_reports report
          ON report.group_id = report_group.id
         AND report.workspace_id = report_group.workspace_id
        LEFT JOIN interactions_v2 interaction
          ON interaction.id = report.interaction_id
         AND interaction.workspace_id = report_group.workspace_id
        LEFT JOIN product_environments environment
          ON environment.id = interaction.environment_id
         AND environment.workspace_id = report_group.workspace_id
         AND environment.product_id = report_group.product_id
        LEFT JOIN group_github_issues issue
          ON issue.group_key = report_group.group_key
         AND issue.workspace_id = report_group.workspace_id
        WHERE report_group.workspace_id = $1
          AND report_group.product_id = $2
          AND report_group.merged_into_group_key IS NULL
        GROUP BY report_group.id, report_group.group_key, report_group.explanation,
          issue.repo_full_name, issue.issue_number, issue.url, issue.state,
          issue.last_commented_report_count, issue.state_refreshed_at,
          issue.filing_state
        ORDER BY MAX(interaction.occurred_at) DESC NULLS LAST,
          report_group.updated_at DESC, report_group.group_key
        LIMIT $3 OFFSET $4",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(limit + 1)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    let has_more = i64::try_from(rows.len()).is_ok_and(|count| count > limit);
    let groups = rows
        .into_iter()
        .take(usize::try_from(limit).map_err(ApiError::internal)?)
        .map(|row| {
            let github_issue = match (
                row.issue_repo_full_name,
                row.issue_number,
                row.issue_url,
                row.issue_state,
            ) {
                (Some(repo_full_name), Some(issue_number), Some(url), Some(state)) => {
                    Some(GithubIssueLink {
                        repo_full_name,
                        issue_number,
                        url,
                        state,
                    })
                }
                _ => None,
            };
            ListedProductGroup {
                group: ProductReportGroup {
                    group_key: row.group_key,
                    explanation: row.explanation,
                    report_count: row.report_count,
                    latest_occurred_at: row.latest_occurred_at,
                    github_issue,
                },
                last_commented_report_count: row.last_commented_report_count,
                state_refreshed_at: row.state_refreshed_at,
                needs_reconciliation: row.filing_state.as_deref() == Some("needs_reconciliation"),
            }
        })
        .collect();
    Ok(ProductGroupPage { groups, has_more })
}

pub(crate) async fn group_issue_sync_context(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    group_key: &str,
) -> Result<Option<GroupIssueSyncContext>, ApiError> {
    Ok(sqlx::query_as::<_, GroupIssueSyncContext>(
        r"WITH scoped_issue AS (
          -- The installation comes from the ISSUE, not the product's current
          -- repo mapping. Remapping a product to another repo must not route
          -- comments for an existing issue through an installation that does
          -- not own that issue's repository: the issue keeps being updated
          -- where it actually lives.
          SELECT issue.group_key, issue.repo_full_name, issue.issue_number,
            issue.last_commented_report_count, issue.state_refreshed_at,
            report_group.id AS group_id,
            report_group.product_id, issue.installation_id
          FROM group_github_issues issue
          JOIN report_groups report_group
            ON report_group.group_key = issue.group_key
           AND report_group.workspace_id = issue.workspace_id
          JOIN products product
            ON product.id = report_group.product_id
           AND product.workspace_id = report_group.workspace_id
          JOIN github_installations installation
            ON installation.installation_id = issue.installation_id
           AND installation.workspace_id = issue.workspace_id
           AND installation.revoked_at IS NULL
          WHERE issue.workspace_id = $1 AND issue.group_key = $2
            AND issue.filing_state = 'filed'
        ),
        ordered_reports AS (
          SELECT interaction.occurred_at,
            ROW_NUMBER() OVER (ORDER BY report.created_at, report.id) AS report_number
          FROM scoped_issue issue
          JOIN feedback_reports report
            ON report.group_id = issue.group_id AND report.workspace_id = $1
          JOIN interactions_v2 interaction
            ON interaction.id = report.interaction_id AND interaction.workspace_id = $1
          JOIN product_environments environment
            ON environment.id = interaction.environment_id
           AND environment.workspace_id = $1
           AND environment.product_id = issue.product_id
        )
        SELECT issue.installation_id, issue.repo_full_name, issue.issue_number,
          issue.last_commented_report_count AS observed_report_count,
          COUNT(report.report_number)::BIGINT AS current_report_count,
          MIN(report.occurred_at) FILTER (
            WHERE report.report_number > issue.last_commented_report_count
          ) AS earliest_new_occurred_at,
          MAX(report.occurred_at) FILTER (
            WHERE report.report_number > issue.last_commented_report_count
          ) AS latest_new_occurred_at,
          issue.state_refreshed_at
        FROM scoped_issue issue
        LEFT JOIN ordered_reports report ON TRUE
        GROUP BY issue.installation_id, issue.repo_full_name, issue.issue_number,
          issue.last_commented_report_count, issue.state_refreshed_at",
    )
    .bind(workspace_id)
    .bind(group_key)
    .fetch_optional(&mut **tx)
    .await?)
}

pub(crate) async fn bump_last_commented_report_count(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    group_key: &str,
    observed_report_count: i64,
    current_report_count: i64,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues issue
        SET last_commented_report_count = $4, updated_at = NOW()
        FROM report_groups report_group
        WHERE issue.group_key = report_group.group_key
          AND issue.workspace_id = report_group.workspace_id
          AND issue.workspace_id = $1
          AND issue.group_key = $2
          AND issue.filing_state = 'filed'
          AND issue.last_commented_report_count = $3
          AND $4 > $3",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(observed_report_count)
    .bind(current_report_count)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn revert_last_commented_report_count(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    observed_report_count: i64,
    claimed_report_count: i64,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues issue
        SET last_commented_report_count = $3, updated_at = NOW()
        FROM report_groups report_group
        WHERE issue.group_key = report_group.group_key
          AND issue.workspace_id = report_group.workspace_id
          AND issue.workspace_id = $1
          AND issue.group_key = $2
          AND issue.filing_state = 'filed'
          AND issue.last_commented_report_count = $4",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(observed_report_count)
    .bind(claimed_report_count)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn claim_group_issue_state_refresh(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    refresh_cutoff: DateTime<Utc>,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues issue
        SET state_refreshed_at = NOW(), updated_at = NOW()
        FROM report_groups report_group
        WHERE issue.group_key = report_group.group_key
          AND issue.workspace_id = report_group.workspace_id
          AND issue.workspace_id = $1
          AND issue.group_key = $2
          AND issue.filing_state = 'filed'
          AND (
            issue.state_refreshed_at IS NULL
            OR issue.state_refreshed_at <= $3
          )",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(refresh_cutoff)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn update_group_issue_state(
    pool: &PgPool,
    workspace_id: Uuid,
    group_key: &str,
    state: &str,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r"UPDATE group_github_issues issue
        SET state = $3, state_refreshed_at = NOW(), updated_at = NOW()
        FROM report_groups report_group
        WHERE issue.group_key = report_group.group_key
          AND issue.workspace_id = report_group.workspace_id
          AND issue.workspace_id = $1
          AND issue.group_key = $2
          AND issue.filing_state = 'filed'",
    )
    .bind(workspace_id)
    .bind(group_key)
    .bind(state)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn get_or_create_workspace(
    pool: &PgPool,
    os_user: &OsUser,
) -> Result<Workspace, ApiError> {
    let workspace = if let Some(workspace) =
        sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE os_user_id = $1")
            .bind(&os_user.id)
            .fetch_optional(pool)
            .await?
    {
        workspace
    } else {
        let display = os_user.display_name.as_deref().unwrap_or(&os_user.handle);
        let name = format!("{} workspace", clean(display, 70));
        sqlx::query_as::<_, Workspace>(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (os_user_id) DO UPDATE SET updated_at = workspaces.updated_at
            RETURNING *",
        )
        .bind(Uuid::new_v4())
        .bind(&os_user.id)
        .bind(name)
        .bind(slug(display))
        .fetch_one(pool)
        .await?
    };
    upsert_workspace_member(pool, workspace.id, os_user, "owner").await?;
    Ok(workspace)
}

async fn upsert_workspace_member(
    pool: &PgPool,
    workspace_id: Uuid,
    os_user: &OsUser,
    role: &str,
) -> Result<(), ApiError> {
    let display_name = os_user.display_name.as_deref().unwrap_or(&os_user.handle);
    sqlx::query(
        r"INSERT INTO workspace_members
        (workspace_id, os_user_id, handle, email, display_name, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, os_user_id) DO UPDATE SET
          handle = EXCLUDED.handle,
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          updated_at = NOW()",
    )
    .bind(workspace_id)
    .bind(&os_user.id)
    .bind(clean(&os_user.handle, 80))
    .bind(
        os_user
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase()),
    )
    .bind(clean(display_name, 100))
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

fn invitation_matches(invitation: &TeamInvitation, os_user: &OsUser) -> bool {
    match invitation.invitee_kind.as_str() {
        "email" => os_user
            .email
            .as_deref()
            .is_some_and(|email| email.trim().eq_ignore_ascii_case(&invitation.invitee_value)),
        "handle" => os_user
            .handle
            .trim_start_matches('@')
            .eq_ignore_ascii_case(&invitation.invitee_value),
        "link" => true,
        _ => false,
    }
}

async fn accept_invitation(
    pool: &PgPool,
    os_user: &OsUser,
    invitation: &TeamInvitation,
) -> Result<Uuid, ApiError> {
    if !invitation_matches(invitation, os_user) {
        return Err(ApiError::forbidden(
            "This invitation was created for a different email address",
        ));
    }
    let mut tx = pool.begin().await?;
    let display_name = os_user.display_name.as_deref().unwrap_or(&os_user.handle);
    sqlx::query(
        r"INSERT INTO workspace_members
        (workspace_id, os_user_id, handle, email, display_name, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, os_user_id) DO UPDATE SET
          handle = EXCLUDED.handle,
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          role = CASE WHEN workspace_members.role IN ('owner', 'admin') THEN workspace_members.role ELSE EXCLUDED.role END,
          updated_at = NOW()",
    )
    .bind(invitation.workspace_id)
    .bind(&os_user.id)
    .bind(clean(&os_user.handle, 80))
    .bind(
        os_user
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase()),
    )
    .bind(clean(display_name, 100))
    .bind(&invitation.role)
    .execute(&mut *tx)
    .await?;
    let accepted = sqlx::query(
        r"UPDATE workspace_invitations
        SET accepted_at = CASE WHEN invitee_kind = 'link' THEN NULL ELSE NOW() END,
          accepted_by_os_user_id = CASE WHEN invitee_kind = 'link' THEN NULL ELSE $1 END
        WHERE id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()",
    )
    .bind(&os_user.id)
    .bind(invitation.id)
    .execute(&mut *tx)
    .await?;
    if accepted.rows_affected() != 1 {
        return Err(ApiError::gone(
            "This team invitation is no longer available",
        ));
    }
    tx.commit().await?;
    Ok(invitation.workspace_id)
}

pub(crate) async fn accept_team_invitation(
    pool: &PgPool,
    os_user: &OsUser,
    invitation_id: Uuid,
) -> Result<Uuid, ApiError> {
    let invitation = sqlx::query_as::<_, TeamInvitation>(
        r"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()",
    )
    .bind(invitation_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::gone("This team invitation is no longer available"))?;
    accept_invitation(pool, os_user, &invitation).await
}

async fn accept_matching_invitations(pool: &PgPool, os_user: &OsUser) -> Result<(), ApiError> {
    let email = os_user
        .email
        .as_deref()
        .map(|value| value.trim().to_lowercase());
    let handle = os_user.handle.trim_start_matches('@').to_lowercase();
    let invitations = sqlx::query_as::<_, TeamInvitation>(
        r"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
          AND ((invitee_kind = 'handle' AND invitee_value = $1)
            OR (invitee_kind = 'email' AND invitee_value = $2))",
    )
    .bind(handle)
    .bind(email)
    .fetch_all(pool)
    .await?;
    for invitation in invitations {
        accept_invitation(pool, os_user, &invitation).await?;
    }
    Ok(())
}

pub(crate) async fn resolve_workspace_access(
    pool: &PgPool,
    os_user: &OsUser,
    requested_workspace_id: Option<Uuid>,
) -> Result<(Workspace, String, Vec<WorkspaceMembership>), ApiError> {
    let personal_workspace = get_or_create_workspace(pool, os_user).await?;
    accept_matching_invitations(pool, os_user).await?;
    sqlx::query(
        r"UPDATE workspace_members SET handle = $1, email = $2, display_name = $3,
        updated_at = NOW() WHERE os_user_id = $4",
    )
    .bind(clean(&os_user.handle, 80))
    .bind(
        os_user
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase()),
    )
    .bind(clean(
        os_user.display_name.as_deref().unwrap_or(&os_user.handle),
        100,
    ))
    .bind(&os_user.id)
    .execute(pool)
    .await?;
    let memberships = sqlx::query_as::<_, WorkspaceMembership>(
        r"SELECT w.id AS workspace_id, w.name AS workspace_name,
        w.slug AS workspace_slug, m.role
        FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.os_user_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        m.joined_at, w.name",
    )
    .bind(&os_user.id)
    .fetch_all(pool)
    .await?;
    let selected = if let Some(workspace_id) = requested_workspace_id {
        memberships
            .iter()
            .find(|membership| membership.workspace_id == workspace_id)
            .ok_or_else(|| ApiError::forbidden("You are not a member of this team"))?
    } else {
        memberships
            .iter()
            .find(|membership| membership.workspace_id == personal_workspace.id)
            .or_else(|| memberships.first())
            .ok_or_else(|| ApiError::forbidden("No team membership is available"))?
    };
    let workspace = sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE id = $1")
        .bind(selected.workspace_id)
        .fetch_one(pool)
        .await?;
    Ok((workspace, selected.role.clone(), memberships))
}

fn normalize_invitee_email(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_lowercase();
    let valid = (3..=160).contains(&value.len())
        && !value.chars().any(char::is_whitespace)
        && value.split('@').count() == 2
        && !value.starts_with('@')
        && !value.ends_with('@');
    if !valid {
        return Err(ApiError::bad_request("Enter a valid email address"));
    }
    Ok(value)
}

fn validate_team_role(role: &str) -> Result<&str, ApiError> {
    match role {
        "admin" | "member" => Ok(role),
        _ => Err(ApiError::bad_request("Role must be admin or member")),
    }
}

pub(crate) async fn create_team_invitation(
    pool: &PgPool,
    context: &DashboardContext,
    input: CreateTeamInvitationInput,
) -> Result<TeamInvitation, ApiError> {
    if context.role != "owner" && context.role != "admin" {
        return Err(ApiError::forbidden(
            "Only owners and admins can invite members",
        ));
    }
    let role = validate_team_role(input.role.trim())?;
    if context.role == "admin" && role != "member" {
        return Err(ApiError::forbidden("Admins can only invite members"));
    }
    if input.invitee.is_none() {
        if role != "member" {
            return Err(ApiError::bad_request(
                "Shareable invite links can only grant the member role",
            ));
        }
        sqlx::query(
            r"UPDATE workspace_invitations SET revoked_at = NOW()
            WHERE workspace_id = $1 AND invitee_kind = 'link'
              AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()",
        )
        .bind(context.workspace.id)
        .execute(pool)
        .await?;
        let invitation_id = Uuid::new_v4();
        if let Some(invitation) = sqlx::query_as::<_, TeamInvitation>(
            r"INSERT INTO workspace_invitations
            (id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value, role, expires_at)
            VALUES ($1, $2, $3, 'link', $4, 'member', NOW() + INTERVAL '24 hours')
            ON CONFLICT (workspace_id) WHERE invitee_kind = 'link'
              AND accepted_at IS NULL AND revoked_at IS NULL
            DO NOTHING
            RETURNING id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
            role, created_at, expires_at",
        )
        .bind(invitation_id)
        .bind(context.workspace.id)
        .bind(&context.user.id)
        .bind(invitation_id.to_string())
        .fetch_optional(pool)
        .await?
        {
            return Ok(invitation);
        }
        return sqlx::query_as::<_, TeamInvitation>(
            r"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
            role, created_at, expires_at FROM workspace_invitations
            WHERE workspace_id = $1 AND invitee_kind = 'link' AND role = 'member'
              AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
            ORDER BY created_at DESC LIMIT 1",
        )
        .bind(context.workspace.id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| ApiError::conflict("Could not create the team invite link"));
    }
    let invitation_id = Uuid::new_v4();
    let invitee_kind = "email";
    let invitee_value = normalize_invitee_email(&input.invitee.unwrap_or_default())?;
    let existing_member: bool = match invitee_kind {
        "email" => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND LOWER(email) = $2)",
        )
        .bind(context.workspace.id)
        .bind(&invitee_value)
        .fetch_one(pool)
        .await?,
        "handle" => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND LOWER(handle) = $2)",
        )
        .bind(context.workspace.id)
        .bind(&invitee_value)
        .fetch_one(pool)
        .await?,
        _ => false,
    };
    if existing_member {
        return Err(ApiError::conflict("This person is already a team member"));
    }
    sqlx::query(
        r"UPDATE workspace_invitations SET revoked_at = NOW()
        WHERE workspace_id = $1 AND invitee_kind = $2 AND invitee_value = $3
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()",
    )
    .bind(context.workspace.id)
    .bind(invitee_kind)
    .bind(&invitee_value)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, TeamInvitation>(
        r"INSERT INTO workspace_invitations
        (id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value, role, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')
        RETURNING id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at",
    )
    .bind(invitation_id)
    .bind(context.workspace.id)
    .bind(&context.user.id)
    .bind(invitee_kind)
    .bind(invitee_value)
    .bind(role)
    .fetch_one(pool)
    .await
    .map_err(|error| database_conflict(error, "An active invitation already exists"))
}

pub(crate) async fn update_team_member_role(
    pool: &PgPool,
    context: &DashboardContext,
    os_user_id: &str,
    input: UpdateTeamMemberInput,
) -> Result<TeamMember, ApiError> {
    if context.role != "owner" {
        return Err(ApiError::forbidden(
            "Only the owner can change member roles",
        ));
    }
    let role = validate_team_role(input.role.trim())?;
    let target = sqlx::query_as::<_, TeamMember>(
        "SELECT * FROM workspace_members WHERE workspace_id = $1 AND os_user_id = $2",
    )
    .bind(context.workspace.id)
    .bind(os_user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Team member not found"))?;
    if target.role == "owner" {
        return Err(ApiError::forbidden("The owner role cannot be changed"));
    }
    sqlx::query_as::<_, TeamMember>(
        r"UPDATE workspace_members SET role = $1, updated_at = NOW()
        WHERE workspace_id = $2 AND os_user_id = $3 RETURNING *",
    )
    .bind(role)
    .bind(context.workspace.id)
    .bind(os_user_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub(crate) async fn remove_team_member(
    pool: &PgPool,
    context: &DashboardContext,
    os_user_id: &str,
) -> Result<(), ApiError> {
    if context.role != "owner" && context.role != "admin" {
        return Err(ApiError::forbidden(
            "Only owners and admins can remove members",
        ));
    }
    let target = sqlx::query_as::<_, TeamMember>(
        "SELECT * FROM workspace_members WHERE workspace_id = $1 AND os_user_id = $2",
    )
    .bind(context.workspace.id)
    .bind(os_user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Team member not found"))?;
    if target.role == "owner" {
        return Err(ApiError::forbidden("The team owner cannot be removed"));
    }
    if context.role == "admin" && target.role != "member" {
        return Err(ApiError::forbidden("Admins can only remove members"));
    }
    if target.os_user_id == context.user.id {
        return Err(ApiError::forbidden("You cannot remove yourself"));
    }
    sqlx::query("DELETE FROM workspace_members WHERE workspace_id = $1 AND os_user_id = $2")
        .bind(context.workspace.id)
        .bind(os_user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn transfer_team_ownership(
    pool: &PgPool,
    context: &DashboardContext,
    new_owner_os_user_id: &str,
) -> Result<(), ApiError> {
    if context.role != "owner" {
        return Err(ApiError::forbidden(
            "Only the current owner can transfer ownership",
        ));
    }
    if new_owner_os_user_id == context.user.id {
        return Err(ApiError::bad_request("Choose another team member"));
    }
    let mut tx = pool.begin().await?;
    let target_role = sqlx::query_scalar::<_, String>(
        r"SELECT role FROM workspace_members
        WHERE workspace_id = $1 AND os_user_id = $2 FOR UPDATE",
    )
    .bind(context.workspace.id)
    .bind(new_owner_os_user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("Team member not found"))?;
    if target_role == "owner" {
        return Err(ApiError::conflict("This member already owns the team"));
    }
    let current_owner = sqlx::query_scalar::<_, String>(
        r"SELECT os_user_id FROM workspace_members
        WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE",
    )
    .bind(context.workspace.id)
    .fetch_one(&mut *tx)
    .await?;
    if current_owner != context.user.id {
        return Err(ApiError::conflict(
            "Team ownership changed; refresh and try again",
        ));
    }
    sqlx::query(
        r"UPDATE workspace_members SET role = CASE
          WHEN os_user_id = $2 THEN 'admin'
          WHEN os_user_id = $3 THEN 'owner'
          ELSE role END, updated_at = NOW()
        WHERE workspace_id = $1 AND os_user_id IN ($2, $3)",
    )
    .bind(context.workspace.id)
    .bind(&context.user.id)
    .bind(new_owner_os_user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn revoke_team_invitation(
    pool: &PgPool,
    context: &DashboardContext,
    invitation_id: Uuid,
) -> Result<(), ApiError> {
    if context.role != "owner" && context.role != "admin" {
        return Err(ApiError::forbidden(
            "Only owners and admins can revoke invitations",
        ));
    }
    let invitation = sqlx::query_as::<_, TeamInvitation>(
        r"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL",
    )
    .bind(invitation_id)
    .bind(context.workspace.id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Invitation not found"))?;
    if context.role == "admin" && invitation.role != "member" {
        return Err(ApiError::forbidden(
            "Admins can only revoke member invitations",
        ));
    }
    sqlx::query("UPDATE workspace_invitations SET revoked_at = NOW() WHERE id = $1")
        .bind(invitation_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn agent_product_auth(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<ProductAuth, ApiError> {
    let token = bearer_token(headers)
        .filter(|token| token.starts_with("af_live_"))
        .ok_or_else(invalid_api_key)?;
    let key_hash = sha256(&token);
    product_auth_for_key(pool, &key_hash, None).await
}

pub(crate) async fn read_product_auth(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<ProductAuth, ApiError> {
    let token = bearer_token(headers)
        .filter(|token| token.starts_with("af_read_"))
        .ok_or_else(invalid_api_key)?;
    let key_hash = sha256(&token);
    product_auth_for_key(pool, &key_hash, Some("read")).await
}

fn invalid_api_key() -> ApiError {
    ApiError::new(axum::http::StatusCode::UNAUTHORIZED, "Invalid API key")
}

fn expired_api_key() -> ApiError {
    ApiError::new(axum::http::StatusCode::UNAUTHORIZED, "API key expired")
}

async fn product_auth_for_key(
    pool: &PgPool,
    key_hash: &[u8],
    required_kind: Option<&str>,
) -> Result<ProductAuth, ApiError> {
    let key = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<DateTime<Utc>>)>(
        r"SELECT k.id, k.workspace_id, k.environment_id, k.expires_at FROM api_keys k
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL
          AND ($2::TEXT IS NULL OR k.kind = $2)",
    )
    .bind(key_hash)
    .bind(required_kind)
    .fetch_optional(pool)
    .await?
    .ok_or_else(invalid_api_key)?;
    if key.3.is_some_and(|expires_at| expires_at <= Utc::now()) {
        return Err(expired_api_key());
    }
    let workspace = sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE id = $1")
        .bind(key.1)
        .fetch_one(pool)
        .await?;
    let environment = sqlx::query_as::<_, ProductEnvironment>(
        "SELECT * FROM product_environments WHERE id = $1 AND workspace_id = $2",
    )
    .bind(key.2)
    .bind(key.1)
    .fetch_one(pool)
    .await?;
    sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1")
        .bind(key_hash)
        .execute(pool)
        .await?;
    Ok(ProductAuth {
        workspace,
        environment,
        api_key_id: key.0,
    })
}

async fn record_product_activation(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    product_id: Uuid,
    opportunity: bool,
    confirmed_interaction: bool,
    report: bool,
) -> Result<(), ApiError> {
    let confirmed_interaction = confirmed_interaction || report;
    let opportunity = opportunity || confirmed_interaction;
    sqlx::query(
        r"INSERT INTO product_activation_milestones
        (product_id, workspace_id, first_opportunity_at,
         first_confirmed_interaction_at, first_report_at)
        VALUES (
          $1,
          $2,
          CASE WHEN $3 THEN NOW() END,
          CASE WHEN $4 THEN NOW() END,
          CASE WHEN $5 THEN NOW() END
        )
        ON CONFLICT (product_id) DO UPDATE SET
          first_opportunity_at = COALESCE(
            product_activation_milestones.first_opportunity_at,
            EXCLUDED.first_opportunity_at
          ),
          first_confirmed_interaction_at = COALESCE(
            product_activation_milestones.first_confirmed_interaction_at,
            EXCLUDED.first_confirmed_interaction_at
          ),
          first_report_at = COALESCE(
            product_activation_milestones.first_report_at,
            EXCLUDED.first_report_at
          ),
          updated_at = NOW()
        WHERE
          (product_activation_milestones.first_opportunity_at IS NULL
            AND EXCLUDED.first_opportunity_at IS NOT NULL)
          OR (product_activation_milestones.first_confirmed_interaction_at IS NULL
            AND EXCLUDED.first_confirmed_interaction_at IS NOT NULL)
          OR (product_activation_milestones.first_report_at IS NULL
            AND EXCLUDED.first_report_at IS NOT NULL)",
    )
    .bind(product_id)
    .bind(workspace_id)
    .bind(opportunity)
    .bind(confirmed_interaction)
    .bind(report)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn create_product(
    pool: &PgPool,
    workspace_id: Uuid,
    input: CreateProductInput,
) -> Result<(Product, ProductEnvironment), ApiError> {
    let name = validated_name(&input.name, "Product")?;
    let mut tx = pool.begin().await?;
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE")
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("Team not found"))?;
    let product_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await?;
    if product_count >= 25 {
        return Err(ApiError::conflict("This workspace already has 25 products"));
    }
    let product = sqlx::query_as::<_, Product>(
        r"INSERT INTO products (id, workspace_id, name, slug)
        VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(&name)
    .bind(slug(&name))
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "A product with this name already exists"))?;
    let environment = sqlx::query_as::<_, ProductEnvironment>(
        r"INSERT INTO product_environments
        (id, workspace_id, product_id, name, slug)
        VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product.id)
    .bind("Default")
    .bind("default")
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "This product already exists"))?;
    record_product_activation(&mut tx, workspace_id, product.id, false, false, false).await?;
    tx.commit().await?;
    Ok((product, environment))
}

pub(crate) async fn create_product_with_default_key(
    pool: &PgPool,
    workspace_id: Uuid,
    input: CreateProductInput,
) -> Result<(Product, ProductEnvironment, ApiKeyPublic, String), ApiError> {
    let name = validated_name(&input.name, "Product")?;
    let mut tx = pool.begin().await?;
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE")
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("Team not found"))?;
    let product_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await?;
    if product_count >= 25 {
        return Err(ApiError::conflict("This workspace already has 25 products"));
    }
    let product = sqlx::query_as::<_, Product>(
        r"INSERT INTO products (id, workspace_id, name, slug)
        VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(&name)
    .bind(slug(&name))
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "A product with this name already exists"))?;
    let environment = sqlx::query_as::<_, ProductEnvironment>(
        r"INSERT INTO product_environments
        (id, workspace_id, product_id, name, slug)
        VALUES ($1, $2, $3, 'Default', 'default') RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product.id)
    .fetch_one(&mut *tx)
    .await?;
    let key_id = Uuid::new_v4();
    let secret = format!(
        "af_live_{}_{}_{}",
        key_id.simple(),
        environment.id.simple(),
        random_token("")
    );
    let api_key = sqlx::query_as::<_, ApiKeyPublic>(
        r"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, kind, key_hash)
        VALUES ($1, $2, $3, 'Default product key', $4, 'write', $5)
        RETURNING id, environment_id, label, prefix, kind, created_at, last_used_at, revoked_at,
          expires_at, 0::BIGINT AS interaction_count, 0::BIGINT AS report_count",
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(environment.id)
    .bind(secret.chars().take(16).collect::<String>())
    .bind(sha256(&secret))
    .fetch_one(&mut *tx)
    .await?;
    record_product_activation(&mut tx, workspace_id, product.id, false, false, false).await?;
    tx.commit().await?;
    Ok((product, environment, api_key, secret))
}

pub(crate) async fn rename_workspace(
    pool: &PgPool,
    workspace_id: Uuid,
    input: UpdateNameInput,
) -> Result<Workspace, ApiError> {
    let name = validated_name(&input.name, "Team")?;
    let updated = sqlx::query_as::<_, Workspace>(
        r"UPDATE workspaces SET name = $1, slug = $2, updated_at = NOW()
        WHERE id = $3 RETURNING *",
    )
    .bind(&name)
    .bind(slug(&name))
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_conflict(error, "A team with this name already exists"))?;
    updated.ok_or_else(|| ApiError::not_found("Team not found"))
}

pub(crate) async fn rename_product(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    input: UpdateNameInput,
) -> Result<Product, ApiError> {
    let name = validated_name(&input.name, "Product")?;
    let updated = sqlx::query_as::<_, Product>(
        r"UPDATE products SET name = $1, slug = $2, updated_at = NOW()
        WHERE id = $3 AND workspace_id = $4 RETURNING *",
    )
    .bind(&name)
    .bind(slug(&name))
    .bind(product_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_conflict(error, "A product with this name already exists"))?;
    updated.ok_or_else(|| ApiError::not_found("Product not found"))
}

pub(crate) async fn delete_product(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    input: DeleteProductInput,
) -> Result<Product, ApiError> {
    let mut tx = pool.begin().await?;
    let product = sqlx::query_as::<_, Product>(
        "SELECT * FROM products WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("Product not found"))?;
    if input.confirmation.trim() != product.name {
        return Err(ApiError::bad_request(
            "Type the exact product name to confirm deletion",
        ));
    }
    let removed_issue_links = sqlx::query_as::<_, (String, i64)>(
        r"SELECT issue.repo_full_name, issue.issue_number
        FROM group_github_issues issue
        JOIN report_groups report_group
          ON report_group.group_key = issue.group_key
         AND report_group.workspace_id = issue.workspace_id
        WHERE report_group.workspace_id = $1 AND report_group.product_id = $2
        ORDER BY issue.repo_full_name, issue.issue_number",
    )
    .bind(workspace_id)
    .bind(product_id)
    .fetch_all(&mut *tx)
    .await?;
    let deleted = sqlx::query_as::<_, Product>(
        "DELETE FROM products WHERE id = $1 AND workspace_id = $2 RETURNING *",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    for (repo_full_name, issue_number) in removed_issue_links {
        tracing::info!(
            %workspace_id,
            %product_id,
            %repo_full_name,
            issue_number,
            "product deletion removed Epode's GitHub issue link; customer issue remains"
        );
    }
    Ok(deleted)
}

pub(crate) async fn create_api_key(
    pool: &PgPool,
    workspace_id: Uuid,
    environment_id: Uuid,
    label: Option<String>,
    kind: Option<String>,
    expires_in_seconds: Option<i64>,
) -> Result<(ApiKeyPublic, String), ApiError> {
    let kind = kind.unwrap_or_else(|| "write".into());
    let key_prefix = match kind.as_str() {
        "write" => "af_live_",
        "read" => "af_read_",
        _ => return Err(ApiError::bad_request("kind must be write or read")),
    };
    let expires_at = match expires_in_seconds {
        Some(seconds) => {
            if !(60..=365 * 24 * 60 * 60).contains(&seconds) {
                return Err(ApiError::bad_request(
                    "expiresInSeconds must be between 60 seconds and 365 days",
                ));
            }
            Some(Utc::now() + chrono::Duration::seconds(seconds))
        }
        None => None,
    };
    let mut tx = pool.begin().await?;
    let environment_exists = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM product_environments WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(environment_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await?;
    if environment_exists.is_none() {
        return Err(ApiError::not_found("Product environment not found"));
    }
    let active_keys: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM api_keys WHERE environment_id = $1 AND kind = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(environment_id)
    .bind(&kind)
    .fetch_one(&mut *tx)
    .await?;
    if active_keys >= 10 {
        return Err(ApiError::conflict(
            "Revoke an existing API key before creating another",
        ));
    }
    let key_id = Uuid::new_v4();
    let secret = if kind == "write" {
        format!(
            "{key_prefix}{}_{}_{}",
            key_id.simple(),
            environment_id.simple(),
            random_token("")
        )
    } else {
        format!("{key_prefix}{}_{}", key_id.simple(), random_token(""))
    };
    let prefix = secret.chars().take(16).collect::<String>();
    let row = sqlx::query_as::<_, ApiKeyPublic>(
        r"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, kind, key_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, environment_id, label, prefix, kind, created_at, last_used_at, revoked_at,
          expires_at, 0::BIGINT AS interaction_count, 0::BIGINT AS report_count",
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(clean(label.as_deref().unwrap_or("Production"), 60))
    .bind(prefix)
    .bind(kind)
    .bind(sha256(&secret))
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((row, secret))
}

pub(crate) async fn revoke_api_key(
    pool: &PgPool,
    workspace_id: Uuid,
    key_id: Uuid,
) -> Result<(), ApiError> {
    let result = sqlx::query("UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL")
        .bind(key_id).bind(workspace_id).execute(pool).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("API key not found"));
    }
    Ok(())
}

pub(crate) async fn rotate_api_key(
    pool: &PgPool,
    workspace_id: Uuid,
    key_id: Uuid,
) -> Result<(ApiKeyPublic, String, DateTime<Utc>), ApiError> {
    let mut tx = pool.begin().await?;
    let old = sqlx::query_as::<_, (Uuid, Option<String>, String)>(
        r"SELECT environment_id, label, kind FROM api_keys
        WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        FOR UPDATE",
    )
    .bind(key_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("API key not found"))?;
    let key_prefix = if old.2 == "read" {
        "af_read_"
    } else {
        "af_live_"
    };
    let successor_id = Uuid::new_v4();
    let secret = if old.2 == "write" {
        format!(
            "{key_prefix}{}_{}_{}",
            successor_id.simple(),
            old.0.simple(),
            random_token("")
        )
    } else {
        format!("{key_prefix}{}_{}", successor_id.simple(), random_token(""))
    };
    let prefix = secret.chars().take(16).collect::<String>();
    let successor_expires_at = if old.2 == "read" {
        Some(Utc::now() + Duration::days(90))
    } else {
        None
    };
    let successor = sqlx::query_as::<_, ApiKeyPublic>(
        r"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, kind, key_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, environment_id, label, prefix, kind, created_at, last_used_at, revoked_at,
          expires_at, 0::BIGINT AS interaction_count, 0::BIGINT AS report_count",
    )
    .bind(successor_id)
    .bind(workspace_id)
    .bind(old.0)
    .bind(clean(old.1.as_deref().unwrap_or("Production"), 60))
    .bind(prefix)
    .bind(&old.2)
    .bind(sha256(&secret))
    .bind(successor_expires_at)
    .fetch_one(&mut *tx)
    .await?;
    let overlap_expires_at = Utc::now() + Duration::hours(1);
    sqlx::query(
        r"UPDATE api_keys SET expires_at = CASE
          WHEN expires_at IS NULL OR expires_at > $3 THEN $3 ELSE expires_at END
        WHERE id = $1 AND workspace_id = $2",
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(overlap_expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((successor, secret, overlap_expires_at))
}

#[derive(Debug, Deserialize, Serialize)]
struct FeedbackCursor {
    occurred_at: DateTime<Utc>,
    id: Uuid,
}

fn feedback_window(
    retention_days: i32,
    requested_since: Option<DateTime<Utc>>,
) -> (FeedbackWindow, DateTime<Utc>) {
    let retained_since = Utc::now() - Duration::days(retention_days.into());
    let since = requested_since
        .filter(|requested| *requested > retained_since)
        .unwrap_or(retained_since);
    (
        FeedbackWindow {
            since,
            retention_days,
        },
        retained_since,
    )
}

fn feedback_limit(limit: Option<i64>) -> Result<i64, ApiError> {
    let limit = limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request("limit must be between 1 and 100"));
    }
    Ok(limit)
}

fn validate_feedback_values(
    values: Option<&[String]>,
    allowed: &[&str],
    field: &str,
) -> Result<(), ApiError> {
    if values.is_some_and(|values| {
        values
            .iter()
            .any(|value| !allowed.contains(&value.as_str()))
    }) {
        return Err(ApiError::bad_request(format!("Invalid {field} filter")));
    }
    Ok(())
}

fn decode_feedback_cursor(
    value: Option<&str>,
    retained_since: DateTime<Utc>,
) -> Result<Option<FeedbackCursor>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::bad_request("Invalid cursor"))?;
    let cursor: FeedbackCursor =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("Invalid cursor"))?;
    if cursor.occurred_at < retained_since {
        return Err(ApiError::gone("Cursor is outside the retained window"));
    }
    Ok(Some(cursor))
}

fn encode_feedback_cursor(occurred_at: DateTime<Utc>, id: Uuid) -> Result<String, ApiError> {
    let bytes =
        serde_json::to_vec(&FeedbackCursor { occurred_at, id }).map_err(ApiError::internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn dashboard_list_limit(limit: Option<i64>) -> Result<i64, ApiError> {
    let limit = limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request("limit must be between 1 and 100"));
    }
    Ok(limit)
}

fn validate_dashboard_text(
    value: Option<&str>,
    field: &str,
    maximum: usize,
) -> Result<(), ApiError> {
    if value.is_some_and(|value| value.is_empty() || value.len() > maximum) {
        return Err(ApiError::bad_request(format!(
            "{field} must be between 1 and {maximum} characters"
        )));
    }
    Ok(())
}

fn dashboard_search_pattern(value: &str) -> String {
    format!(
        "%{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

async fn dashboard_environment_for_product(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
) -> Result<ProductEnvironment, ApiError> {
    sqlx::query_as::<_, ProductEnvironment>(
        r"SELECT e.* FROM product_environments e
        JOIN products p ON p.id = e.product_id
        WHERE p.id = $1 AND p.workspace_id = $2 AND e.workspace_id = $2
        ORDER BY e.created_at, e.id LIMIT 1",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Product not found"))
}

pub(crate) async fn dashboard_feedback_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardFeedbackFilters,
) -> Result<DashboardFeedbackPage, ApiError> {
    validate_feedback_values(
        filters.statuses.as_deref(),
        &["new", "investigating", "planned", "resolved", "wont_act"],
        "status",
    )?;
    validate_feedback_values(
        filters.impacts.as_deref(),
        &[
            "helped",
            "helped_with_friction",
            "neutral",
            "hindered",
            "blocked",
            "unknown",
        ],
        "impact",
    )?;
    validate_feedback_values(
        filters.surfaces.as_deref(),
        &["http_json", "http_html", "http_headers", "mcp", "unknown"],
        "surface",
    )?;
    validate_feedback_values(
        filters.finding_kinds.as_deref(),
        &[
            "strength",
            "friction",
            "defect",
            "gap",
            "suggestion",
            "uncertainty",
            "other",
        ],
        "findingKind",
    )?;
    validate_feedback_values(
        filters.severities.as_deref(),
        &["minor", "major", "blocking"],
        "severity",
    )?;
    validate_feedback_values(
        filters.workarounds.as_deref(),
        &["used", "suggested", "none"],
        "workaround",
    )?;
    validate_dashboard_text(filters.query.as_deref(), "query", 200)?;
    validate_dashboard_text(filters.operation.as_deref(), "operation", 160)?;
    validate_dashboard_text(filters.customer_ref.as_deref(), "customerRef", 160)?;
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }

    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let since = filters
        .since
        .filter(|since| *since > retained_since)
        .unwrap_or(retained_since);
    let limit = dashboard_list_limit(filters.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let cursor = decode_feedback_cursor(filters.cursor.as_deref(), retained_since)?;
    let cursor_created_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let search = filters.query.as_deref().map(dashboard_search_pattern);

    let total = sqlx::query_scalar::<_, i64>(
        r"SELECT COUNT(*) FROM feedback_reports r
        JOIN interactions_v2 i ON i.id = r.interaction_id
        LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2 AND r.created_at >= $3
          AND ($4::TIMESTAMPTZ IS NULL OR r.created_at <= $4)
          AND ($5::TEXT IS NULL OR r.summary ILIKE $5 ESCAPE '\'
            OR i.operation ILIKE $5 ESCAPE '\'
            OR COALESCE(i.customer_ref, '') ILIKE $5 ESCAPE '\'
            OR r.findings::TEXT ILIKE $5 ESCAPE '\')
          AND ($6::TEXT[] IS NULL OR COALESCE(w.status, 'new') = ANY($6))
          AND ($7::TEXT[] IS NULL OR COALESCE(r.impact, 'unknown') = ANY($7))
          AND ($8::TEXT[] IS NULL OR i.surface = ANY($8))
          AND ($9::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'topic' = ANY($9)))
          AND ($10::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'kind' = ANY($10)))
          AND ($11::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'severity' = ANY($11)))
          AND ($12::TEXT[] IS NULL OR COALESCE(w.tags, '{}'::TEXT[]) && $12)
          AND ($13::TEXT[] IS NULL OR w.assignee_os_user_id = ANY($13)
            OR ($14 AND w.assignee_os_user_id IS NULL))
          AND ($15::TEXT[] IS NULL OR CASE
            WHEN r.workaround IS NULL THEN 'none'
            WHEN r.workaround ->> 'used' = 'true' THEN 'used'
            ELSE 'suggested' END = ANY($15))
          AND ($16::TEXT IS NULL OR i.operation = $16)
          AND ($17::TEXT IS NULL OR i.customer_ref = $17)
          AND ($18::TEXT IS NULL OR EXISTS (
            SELECT 1 FROM report_groups report_group
            WHERE report_group.id = r.group_id
              AND report_group.workspace_id = r.workspace_id
              AND report_group.group_key = $18))",
    )
    .bind(environment.id)
    .bind(retained_since)
    .bind(since)
    .bind(filters.until)
    .bind(&search)
    .bind(&filters.statuses)
    .bind(&filters.impacts)
    .bind(&filters.surfaces)
    .bind(&filters.topics)
    .bind(&filters.finding_kinds)
    .bind(&filters.severities)
    .bind(&filters.tags)
    .bind(&filters.assignees)
    .bind(filters.include_unassigned)
    .bind(&filters.workarounds)
    .bind(&filters.operation)
    .bind(&filters.customer_ref)
    .bind(&filters.group_key)
    .fetch_one(pool)
    .await?;

    let facets = dashboard_feedback_facets(
        pool,
        environment.id,
        retained_since,
        since,
        filters.until,
        search.as_deref(),
        &filters,
    )
    .await?;

    let mut reports = sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        COALESCE((
          SELECT jsonb_agg(
            CASE WHEN stored_hint.value ? 'verified' THEN stored_hint.value
              ELSE stored_hint.value || jsonb_build_object('verified', FALSE) END
            ORDER BY stored_hint.ordinality)
          FROM jsonb_array_elements(code_hints.hints)
            WITH ORDINALITY AS stored_hint(value, ordinality)
        ), '[]'::JSONB) AS code_hints,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r
        JOIN interactions_v2 i ON i.id = r.interaction_id
        LEFT JOIN report_code_hints code_hints ON code_hints.report_id = r.id
        LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2 AND r.created_at >= $3
          AND ($4::TIMESTAMPTZ IS NULL OR r.created_at <= $4)
          AND ($5::TEXT IS NULL OR r.summary ILIKE $5 ESCAPE '\'
            OR i.operation ILIKE $5 ESCAPE '\'
            OR COALESCE(i.customer_ref, '') ILIKE $5 ESCAPE '\'
            OR r.findings::TEXT ILIKE $5 ESCAPE '\')
          AND ($6::TEXT[] IS NULL OR COALESCE(w.status, 'new') = ANY($6))
          AND ($7::TEXT[] IS NULL OR COALESCE(r.impact, 'unknown') = ANY($7))
          AND ($8::TEXT[] IS NULL OR i.surface = ANY($8))
          AND ($9::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'topic' = ANY($9)))
          AND ($10::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'kind' = ANY($10)))
          AND ($11::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'severity' = ANY($11)))
          AND ($12::TEXT[] IS NULL OR COALESCE(w.tags, '{}'::TEXT[]) && $12)
          AND ($13::TEXT[] IS NULL OR w.assignee_os_user_id = ANY($13)
            OR ($14 AND w.assignee_os_user_id IS NULL))
          AND ($15::TEXT[] IS NULL OR CASE
            WHEN r.workaround IS NULL THEN 'none'
            WHEN r.workaround ->> 'used' = 'true' THEN 'used'
            ELSE 'suggested' END = ANY($15))
          AND ($16::TEXT IS NULL OR i.operation = $16)
          AND ($17::TEXT IS NULL OR i.customer_ref = $17)
          AND ($18::TEXT IS NULL OR EXISTS (
            SELECT 1 FROM report_groups report_group
            WHERE report_group.id = r.group_id
              AND report_group.workspace_id = r.workspace_id
              AND report_group.group_key = $18))
          AND ($19::TIMESTAMPTZ IS NULL OR (r.created_at, r.id) < ($19, $20))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $21",
    )
    .bind(environment.id)
    .bind(retained_since)
    .bind(since)
    .bind(filters.until)
    .bind(search)
    .bind(filters.statuses)
    .bind(filters.impacts)
    .bind(filters.surfaces)
    .bind(filters.topics)
    .bind(filters.finding_kinds)
    .bind(filters.severities)
    .bind(filters.tags)
    .bind(filters.assignees)
    .bind(filters.include_unassigned)
    .bind(filters.workarounds)
    .bind(filters.operation)
    .bind(filters.customer_ref)
    .bind(filters.group_key)
    .bind(cursor_created_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if reports.len() > page_size {
        let last = &reports[page_size - 1];
        Some(encode_feedback_cursor(last.created_at, last.id)?)
    } else {
        None
    };
    reports.truncate(page_size);
    Ok(DashboardFeedbackPage {
        reports,
        total,
        facets,
        limit,
        next_cursor,
    })
}

/// Compute disjunctive facet counts: each facet applies every active filter
/// except its own selection, so counts stay useful without claiming that an
/// incompatible value belongs to the current result set.
async fn dashboard_feedback_facets(
    pool: &PgPool,
    environment_id: Uuid,
    retained_since: DateTime<Utc>,
    since: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
    search: Option<&str>,
    filters: &DashboardFeedbackFilters,
) -> Result<DashboardFeedbackFacets, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        r"WITH base AS MATERIALIZED (
          SELECT r.id, COALESCE(w.status, 'new') AS workflow_status,
            COALESCE(r.impact, 'unknown') AS impact, i.surface,
            CASE WHEN jsonb_typeof(r.findings) = 'array' THEN r.findings ELSE '[]'::JSONB END AS findings,
            COALESCE(w.tags, '{}'::TEXT[]) AS tags,
            COALESCE(w.assignee_os_user_id::TEXT, 'unassigned') AS assignee,
            CASE WHEN r.workaround IS NULL THEN 'none'
              WHEN r.workaround ->> 'used' = 'true' THEN 'used'
              ELSE 'suggested' END AS workaround,
            ($9::TEXT[] IS NULL OR COALESCE(w.status, 'new') = ANY($9)) AS matches_status,
            ($10::TEXT[] IS NULL OR COALESCE(r.impact, 'unknown') = ANY($10)) AS matches_impact,
            ($11::TEXT[] IS NULL OR i.surface = ANY($11)) AS matches_surface,
            ($12::TEXT[] IS NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(r.findings) finding
              WHERE finding ->> 'topic' = ANY($12))) AS matches_topic,
            ($13::TEXT[] IS NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(r.findings) finding
              WHERE finding ->> 'kind' = ANY($13))) AS matches_finding_kind,
            ($14::TEXT[] IS NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(r.findings) finding
              WHERE finding ->> 'severity' = ANY($14))) AS matches_severity,
            ($15::TEXT[] IS NULL OR COALESCE(w.tags, '{}'::TEXT[]) && $15) AS matches_tag,
            ($16::TEXT[] IS NULL OR w.assignee_os_user_id = ANY($16)
              OR ($17 AND w.assignee_os_user_id IS NULL)) AS matches_assignee,
            ($18::TEXT[] IS NULL OR CASE
              WHEN r.workaround IS NULL THEN 'none'
              WHEN r.workaround ->> 'used' = 'true' THEN 'used'
              ELSE 'suggested' END = ANY($18)) AS matches_workaround
          FROM feedback_reports r
          JOIN interactions_v2 i ON i.id = r.interaction_id
          LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
          WHERE i.environment_id = $1 AND i.occurred_at >= $2 AND r.created_at >= $3
            AND ($4::TIMESTAMPTZ IS NULL OR r.created_at <= $4)
            AND ($5::TEXT IS NULL OR r.summary ILIKE $5 ESCAPE '\'
              OR i.operation ILIKE $5 ESCAPE '\'
              OR COALESCE(i.customer_ref, '') ILIKE $5 ESCAPE '\'
              OR r.findings::TEXT ILIKE $5 ESCAPE '\')
            AND ($6::TEXT IS NULL OR i.operation = $6)
            AND ($7::TEXT IS NULL OR i.customer_ref = $7)
            AND ($8::TEXT IS NULL OR EXISTS (
              SELECT 1 FROM report_groups report_group
              WHERE report_group.id = r.group_id
                AND report_group.workspace_id = r.workspace_id
                AND report_group.group_key = $8))
        ), facet_values AS (
          SELECT id AS report_id, 'status'::TEXT AS facet, workflow_status AS value FROM base
            WHERE matches_impact AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_assignee AND matches_workaround
          UNION ALL SELECT id, 'impact', impact FROM base
            WHERE matches_status AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_assignee AND matches_workaround
          UNION ALL SELECT id, 'surface', surface FROM base
            WHERE matches_status AND matches_impact AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_assignee AND matches_workaround
          UNION ALL SELECT id, 'assignee', assignee FROM base
            WHERE matches_status AND matches_impact AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_workaround
          UNION ALL SELECT id, 'workaround', workaround FROM base
            WHERE matches_status AND matches_impact AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_assignee
          UNION ALL SELECT id, 'tag', tag FROM base CROSS JOIN LATERAL UNNEST(tags) tag
            WHERE matches_status AND matches_impact AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_severity AND matches_assignee
              AND matches_workaround
          UNION ALL SELECT id, 'topic', finding ->> 'topic'
            FROM base CROSS JOIN LATERAL jsonb_array_elements(findings) finding
            WHERE matches_status AND matches_impact AND matches_surface
              AND matches_finding_kind AND matches_severity AND matches_tag
              AND matches_assignee AND matches_workaround
          UNION ALL SELECT id, 'finding_kind', finding ->> 'kind'
            FROM base CROSS JOIN LATERAL jsonb_array_elements(findings) finding
            WHERE matches_status AND matches_impact AND matches_surface AND matches_topic
              AND matches_severity AND matches_tag AND matches_assignee
              AND matches_workaround
          UNION ALL SELECT id, 'severity', finding ->> 'severity'
            FROM base CROSS JOIN LATERAL jsonb_array_elements(findings) finding
            WHERE matches_status AND matches_impact AND matches_surface AND matches_topic
              AND matches_finding_kind AND matches_tag AND matches_assignee
              AND matches_workaround
        )
        SELECT facet, value, COUNT(DISTINCT report_id)::BIGINT
        FROM facet_values
        WHERE value IS NOT NULL AND value <> ''
        GROUP BY facet, value
        ORDER BY facet, COUNT(DISTINCT report_id) DESC, value",
    )
    .bind(environment_id)
    .bind(retained_since)
    .bind(since)
    .bind(until)
    .bind(search)
    .bind(&filters.operation)
    .bind(&filters.customer_ref)
    .bind(&filters.group_key)
    .bind(&filters.statuses)
    .bind(&filters.impacts)
    .bind(&filters.surfaces)
    .bind(&filters.topics)
    .bind(&filters.finding_kinds)
    .bind(&filters.severities)
    .bind(&filters.tags)
    .bind(&filters.assignees)
    .bind(filters.include_unassigned)
    .bind(&filters.workarounds)
    .fetch_all(pool)
    .await?;

    let mut facets = DashboardFeedbackFacets::default();
    for (facet, name, count) in rows {
        let item = InsightCount { name, count };
        match facet.as_str() {
            "status" => facets.status.push(item),
            "impact" => facets.impact.push(item),
            "surface" => facets.surface.push(item),
            "topic" => facets.topic.push(item),
            "finding_kind" => facets.finding_kind.push(item),
            "severity" => facets.severity.push(item),
            "tag" => facets.tag.push(item),
            "assignee" => facets.assignee.push(item),
            "workaround" => facets.workaround.push(item),
            _ => {}
        }
    }
    Ok(facets)
}

#[allow(
    clippy::cast_precision_loss,
    reason = "bounded aggregate counts are converted to a display-only average"
)]
pub(crate) async fn dashboard_sessions_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardSessionFilters,
) -> Result<DashboardSessionsPage, ApiError> {
    validate_feedback_values(
        filters.impacts.as_deref(),
        &[
            "helped",
            "helped_with_friction",
            "neutral",
            "hindered",
            "blocked",
            "unknown",
        ],
        "impact",
    )?;
    if filters
        .kind
        .as_deref()
        .is_some_and(|kind| !["all", "multi", "response", "no_response"].contains(&kind))
    {
        return Err(ApiError::bad_request("Invalid session kind filter"));
    }
    validate_dashboard_text(filters.query.as_deref(), "query", 200)?;
    validate_dashboard_text(filters.operation.as_deref(), "operation", 160)?;
    validate_dashboard_text(filters.customer_ref.as_deref(), "customerRef", 160)?;
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }

    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let since = filters
        .since
        .filter(|since| *since > retained_since)
        .unwrap_or(retained_since);
    let limit = dashboard_list_limit(filters.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let cursor = decode_feedback_cursor(filters.cursor.as_deref(), retained_since)?;
    let cursor_last_seen_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let search = filters.query.as_deref().map(dashboard_search_pattern);

    let (session_count, interaction_count, multi_step_sessions) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r"SELECT COUNT(*), COALESCE(SUM(activity.interaction_count), 0)::BIGINT,
            COUNT(*) FILTER (WHERE activity.interaction_count > 1)
            FROM sessions_v2 s
            CROSS JOIN LATERAL (
              SELECT COUNT(*)::BIGINT AS interaction_count,
                COUNT(r.id)::BIGINT AS report_count
              FROM interactions_v2 i
              LEFT JOIN feedback_reports r ON r.interaction_id = i.id
              WHERE i.session_id = s.id AND i.occurred_at >= $9
            ) activity
            WHERE s.environment_id = $1 AND s.last_seen_at >= $2
              AND ($3::TIMESTAMPTZ IS NULL OR s.last_seen_at <= $3)
              AND ($4::TEXT IS NULL OR s.ref_hint ILIKE $4 ESCAPE '\'
                OR s.source ILIKE $4 ESCAPE '\'
                OR EXISTS (SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
                  AND i.occurred_at >= $9
                  AND (i.operation ILIKE $4 ESCAPE '\'
                    OR COALESCE(i.customer_ref, '') ILIKE $4 ESCAPE '\')))
              AND ($5::TEXT IS NULL OR $5 = 'all'
                OR ($5 = 'multi' AND activity.interaction_count > 1)
                OR ($5 = 'response' AND EXISTS (
                  SELECT 1 FROM interactions_v2 i
                  JOIN enrichment_requests request ON request.interaction_id = i.id
                    AND request.workspace_id = i.workspace_id
                  WHERE i.session_id = s.id AND request.created_at >= $9))
                OR ($5 = 'no_response' AND NOT EXISTS (
                  SELECT 1 FROM interactions_v2 i
                  JOIN enrichment_requests request ON request.interaction_id = i.id
                    AND request.workspace_id = i.workspace_id
                  WHERE i.session_id = s.id AND request.created_at >= $9)))
              AND ($6::TEXT[] IS NULL OR EXISTS (
                SELECT 1 FROM interactions_v2 i JOIN feedback_reports r ON r.interaction_id = i.id
                WHERE i.session_id = s.id AND i.occurred_at >= $9
                  AND COALESCE(r.impact, 'unknown') = ANY($6)))
              AND ($7::TEXT IS NULL OR EXISTS (
                SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
                  AND i.occurred_at >= $9 AND i.operation = $7))
              AND ($8::TEXT IS NULL OR EXISTS (
                SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
                  AND i.occurred_at >= $9 AND i.customer_ref = $8))",
        )
        .bind(environment.id)
        .bind(since)
        .bind(filters.until)
        .bind(&search)
        .bind(&filters.kind)
        .bind(&filters.impacts)
        .bind(&filters.operation)
        .bind(&filters.customer_ref)
        .bind(retained_since)
        .fetch_one(pool)
        .await?;

    let mut sessions = sqlx::query_as::<_, DashboardSessionSummary>(
        r"SELECT s.id, s.workspace_id, s.environment_id, s.source, s.ref_hint,
          s.started_at, s.last_seen_at, s.created_at,
          activity.interaction_count, activity.report_count,
          activity.first_operation, activity.last_operation, activity.customer_ref,
          activity.strongest_impact
        FROM sessions_v2 s
        CROSS JOIN LATERAL (
          SELECT COUNT(i.id)::BIGINT AS interaction_count,
            COUNT(r.id)::BIGINT AS report_count,
            (ARRAY_AGG(i.operation ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id)
              FILTER (WHERE i.id IS NOT NULL))[1] AS first_operation,
            (ARRAY_AGG(i.operation ORDER BY i.occurred_at DESC,
              i.client_sequence DESC NULLS LAST, i.id DESC)
              FILTER (WHERE i.id IS NOT NULL))[1] AS last_operation,
            (ARRAY_AGG(i.customer_ref ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id)
              FILTER (WHERE i.customer_ref IS NOT NULL))[1] AS customer_ref,
            (ARRAY_AGG(r.impact ORDER BY CASE r.impact
              WHEN 'blocked' THEN 5 WHEN 'hindered' THEN 4
              WHEN 'helped_with_friction' THEN 3 WHEN 'neutral' THEN 2
              WHEN 'unknown' THEN 1 WHEN 'helped' THEN 0 ELSE -1 END DESC,
              r.created_at DESC) FILTER (WHERE r.impact IS NOT NULL))[1] AS strongest_impact
          FROM interactions_v2 i
          LEFT JOIN feedback_reports r ON r.interaction_id = i.id
          WHERE i.session_id = s.id AND i.occurred_at >= $9
        ) activity
        WHERE s.environment_id = $1 AND s.last_seen_at >= $2
          AND ($3::TIMESTAMPTZ IS NULL OR s.last_seen_at <= $3)
          AND ($4::TEXT IS NULL OR s.ref_hint ILIKE $4 ESCAPE '\'
            OR s.source ILIKE $4 ESCAPE '\'
            OR EXISTS (SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
              AND i.occurred_at >= $9
              AND (i.operation ILIKE $4 ESCAPE '\'
                OR COALESCE(i.customer_ref, '') ILIKE $4 ESCAPE '\')))
          AND ($5::TEXT IS NULL OR $5 = 'all'
            OR ($5 = 'multi' AND activity.interaction_count > 1)
            OR ($5 = 'response' AND EXISTS (
              SELECT 1 FROM interactions_v2 i
              JOIN enrichment_requests request ON request.interaction_id = i.id
                AND request.workspace_id = i.workspace_id
              WHERE i.session_id = s.id AND request.created_at >= $9))
            OR ($5 = 'no_response' AND NOT EXISTS (
              SELECT 1 FROM interactions_v2 i
              JOIN enrichment_requests request ON request.interaction_id = i.id
                AND request.workspace_id = i.workspace_id
              WHERE i.session_id = s.id AND request.created_at >= $9)))
          AND ($6::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM interactions_v2 i JOIN feedback_reports r ON r.interaction_id = i.id
            WHERE i.session_id = s.id AND i.occurred_at >= $9
              AND COALESCE(r.impact, 'unknown') = ANY($6)))
          AND ($7::TEXT IS NULL OR EXISTS (
            SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
              AND i.occurred_at >= $9 AND i.operation = $7))
          AND ($8::TEXT IS NULL OR EXISTS (
            SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id
              AND i.occurred_at >= $9 AND i.customer_ref = $8))
          AND ($10::TIMESTAMPTZ IS NULL OR (s.last_seen_at, s.id) < ($10, $11))
        ORDER BY s.last_seen_at DESC, s.id DESC LIMIT $12",
    )
    .bind(environment.id)
    .bind(since)
    .bind(filters.until)
    .bind(search)
    .bind(filters.kind)
    .bind(filters.impacts)
    .bind(filters.operation)
    .bind(filters.customer_ref)
    .bind(retained_since)
    .bind(cursor_last_seen_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if sessions.len() > page_size {
        let last = &sessions[page_size - 1];
        Some(encode_feedback_cursor(last.last_seen_at, last.id)?)
    } else {
        None
    };
    sessions.truncate(page_size);
    let average_interactions = if session_count == 0 {
        0.0
    } else {
        interaction_count as f64 / session_count as f64
    };
    Ok(DashboardSessionsPage {
        sessions,
        rollup: DashboardSessionRollup {
            sessions: session_count,
            interactions: interaction_count,
            multi_step_sessions,
            average_interactions,
        },
        limit,
        next_cursor,
    })
}

fn validate_customer_filters(filters: &DashboardCustomerFilters) -> Result<(), ApiError> {
    validate_feedback_values(
        filters.identity_levels.as_deref(),
        &["verified", "pseudonymous", "ephemeral"],
        "identityLevel",
    )?;
    validate_feedback_values(
        filters.outcome_health.as_deref(),
        &["healthy", "at_risk", "unknown"],
        "outcomeHealth",
    )?;
    validate_feedback_values(
        filters.signal_types.as_deref(),
        &[
            "outcome",
            "intent",
            "friction",
            "preference",
            "constraint",
            "feature_need",
            "alternative_considered",
            "workaround",
            "satisfaction",
            "likelihood_to_reuse",
        ],
        "signalType",
    )?;
    validate_feedback_values(
        filters.consent_states.as_deref(),
        &[
            "approved", "declined", "revoked", "expired", "mixed", "unknown",
        ],
        "consentState",
    )?;
    validate_dashboard_text(filters.query.as_deref(), "query", 200)?;
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }
    if filters
        .segments
        .as_ref()
        .is_some_and(|segments| segments.is_empty() || segments.len() > 20)
    {
        return Err(ApiError::bad_request("Invalid segment filter"));
    }
    Ok(())
}

async fn customer_facets(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    retained_since: DateTime<Utc>,
) -> Result<CustomerFacets, ApiError> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        r"WITH product_customers AS (
          SELECT customer.id, customer.identity_level, customer.segments
          FROM customers customer
          WHERE customer.workspace_id = $1
            AND customer.merged_into_customer_id IS NULL
            AND EXISTS (
              SELECT 1 FROM customer_identifiers identifier
              WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
                AND identifier.customer_id = customer.id
            )
        ), outcomes AS (
          SELECT customer.id,
            COALESCE((
              SELECT CASE
                WHEN signal.attributes ->> 'impact' IN ('blocked', 'hindered') THEN 'at_risk'
                WHEN signal.attributes ->> 'impact' IN ('helped', 'helped_with_friction') THEN 'healthy'
                ELSE 'unknown' END
              FROM customer_signals signal
              WHERE signal.workspace_id = $1 AND signal.product_id = $2
                AND signal.customer_id = customer.id
                AND signal.signal_type = 'outcome' AND signal.collected_at >= $3
                AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
              ORDER BY signal.collected_at DESC, signal.id DESC LIMIT 1
            ), 'unknown') AS outcome_health
          FROM product_customers customer
        ), consents AS (
          SELECT customer.id,
            COALESCE((
              SELECT CASE
                WHEN grant_row.state <> 'revoked' AND grant_row.expires_at <= NOW()
                  THEN 'expired' ELSE grant_row.state
              END
              FROM consent_grants grant_row
              WHERE grant_row.workspace_id = $1 AND grant_row.product_id = $2
                AND grant_row.customer_id = customer.id
                AND grant_row.scope = 'personalize'
                AND grant_row.enrichment_purpose = 'product_personalization'
                AND grant_row.subject = (
                  SELECT candidate.subject FROM consent_grants candidate
                  WHERE candidate.workspace_id = $1 AND candidate.product_id = $2
                    AND candidate.customer_id = customer.id
                    AND candidate.enrichment_purpose = 'product_personalization'
                  ORDER BY candidate.decided_at DESC, candidate.revision DESC,
                    CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
                    candidate.subject, candidate.id LIMIT 1
                )
              ORDER BY grant_row.id LIMIT 1
            ), 'unknown') AS consent_state
          FROM product_customers customer
        ), facet_values AS (
          SELECT 'identity_level'::TEXT AS facet, identity_level AS value, id AS evidence_id
          FROM product_customers
          UNION ALL SELECT 'outcome_health', outcome_health, id FROM outcomes
          UNION ALL SELECT 'consent_state', consent_state, id FROM consents
          UNION ALL SELECT 'segment', segment, customer.id
            FROM product_customers customer CROSS JOIN LATERAL UNNEST(customer.segments) segment
          UNION ALL SELECT 'signal_type',
            COALESCE(signal.attributes->>'enrichmentType', signal.signal_type), signal.id
            FROM customer_signals signal
            WHERE signal.workspace_id = $1 AND signal.product_id = $2
              AND signal.collected_at >= $3
              AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
        )
        SELECT facet, value, COUNT(DISTINCT evidence_id)::BIGINT
        FROM facet_values WHERE value IS NOT NULL AND value <> ''
        GROUP BY facet, value ORDER BY facet, COUNT(DISTINCT evidence_id) DESC, value",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(retained_since)
    .fetch_all(pool)
    .await?;
    let mut facets = CustomerFacets::default();
    for (facet, name, count) in rows {
        let item = InsightCount { name, count };
        match facet.as_str() {
            "identity_level" => facets.identity_level.push(item),
            "outcome_health" => facets.outcome_health.push(item),
            "signal_type" => facets.signal_type.push(item),
            "consent_state" => facets.consent_state.push(item),
            "segment" => facets.segment.push(item),
            _ => {}
        }
    }
    Ok(facets)
}

pub(crate) async fn dashboard_customers_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardCustomerFilters,
) -> Result<DashboardCustomersPage, ApiError> {
    validate_customer_filters(&filters)?;
    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let since = filters
        .since
        .filter(|since| *since > retained_since)
        .unwrap_or(retained_since);
    let limit = dashboard_list_limit(filters.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let cursor = decode_feedback_cursor(filters.cursor.as_deref(), retained_since)?;
    let cursor_last_activity_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let search = filters.query.as_deref().map(dashboard_search_pattern);

    let mut customers = sqlx::query_as::<_, CustomerSummary>(
        r"WITH summaries AS (
          SELECT customer.id, customer.kind, customer.parent_customer_id,
            (SELECT COUNT(*) FROM customers member
              WHERE member.workspace_id = customer.workspace_id
                AND member.parent_customer_id = customer.id
                AND member.merged_into_customer_id IS NULL)::BIGINT AS member_count,
            COALESCE(customer.display_name, user_identifier.display_hint,
              account_identifier.display_hint, any_identifier.display_hint,
              CASE WHEN customer.identity_level = 'pseudonymous'
                THEN 'Anonymous customer' ELSE 'Customer' END) AS display_name,
            customer.identity_level, customer.identity_confidence,
            account_identifier.display_hint AS account_ref_hint,
            user_identifier.display_hint AS user_ref_hint,
            customer.segments,
            COALESCE(activity.last_activity_at, customer.last_seen_at) AS last_activity_at,
            COALESCE(outcome.outcome_health, 'unknown') AS outcome_health,
            COALESCE(activity.signal_count, 0)::BIGINT AS signal_count,
            COALESCE(activity.session_count, 0)::BIGINT AS session_count,
            COALESCE(activity.active_need_count, 0)::BIGINT AS active_need_count,
            COALESCE(consent.consent_state, 'unknown') AS consent_state
          FROM customers customer
          JOIN LATERAL (
            SELECT identifier.display_hint
            FROM customer_identifiers identifier
            WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
              AND identifier.customer_id = customer.id
            ORDER BY identifier.created_at, identifier.id LIMIT 1
          ) any_identifier ON TRUE
          LEFT JOIN LATERAL (
            SELECT identifier.display_hint
            FROM customer_identifiers identifier
            WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
              AND identifier.customer_id = customer.id AND identifier.kind = 'account_ref'
            ORDER BY identifier.created_at, identifier.id LIMIT 1
          ) account_identifier ON TRUE
          LEFT JOIN LATERAL (
            SELECT identifier.display_hint
            FROM customer_identifiers identifier
            WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
              AND identifier.customer_id = customer.id AND identifier.kind = 'user_ref'
            ORDER BY identifier.created_at, identifier.id LIMIT 1
          ) user_identifier ON TRUE
          LEFT JOIN LATERAL (
            SELECT MAX(interaction.occurred_at) AS last_activity_at,
              COUNT(signal.id)::BIGINT AS signal_count,
              COUNT(DISTINCT interaction.session_id)::BIGINT AS session_count,
              COUNT(signal.id) FILTER (WHERE signal.signal_type IN ('feature_need', 'friction')
                AND (signal.expires_at IS NULL OR signal.expires_at > NOW()))::BIGINT
                AS active_need_count
            FROM interactions_v2 interaction
            LEFT JOIN customer_signals signal
              ON signal.interaction_id = interaction.id
              AND signal.workspace_id = interaction.workspace_id
              AND signal.product_id = $2
              AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
            WHERE interaction.workspace_id = $1
              AND interaction.environment_id IN (
                SELECT id FROM product_environments
                WHERE workspace_id = $1 AND product_id = $2
              )
              AND interaction.customer_id = customer.id
              AND interaction.occurred_at >= $3
              AND ($4::TIMESTAMPTZ IS NULL OR interaction.occurred_at <= $4)
          ) activity ON TRUE
          LEFT JOIN LATERAL (
            SELECT CASE
              WHEN signal.attributes ->> 'impact' IN ('blocked', 'hindered') THEN 'at_risk'
              WHEN signal.attributes ->> 'impact' IN ('helped', 'helped_with_friction') THEN 'healthy'
              ELSE 'unknown' END AS outcome_health
            FROM customer_signals signal
            WHERE signal.workspace_id = $1 AND signal.product_id = $2
              AND signal.customer_id = customer.id AND signal.signal_type = 'outcome'
              AND signal.collected_at >= $3
              AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
            ORDER BY signal.collected_at DESC, signal.id DESC LIMIT 1
          ) outcome ON TRUE
          LEFT JOIN LATERAL (
            SELECT CASE
              WHEN grant_row.state <> 'revoked' AND grant_row.expires_at <= NOW()
                THEN 'expired' ELSE grant_row.state
            END AS consent_state
            FROM consent_grants grant_row
            WHERE grant_row.workspace_id = $1 AND grant_row.product_id = $2
              AND grant_row.customer_id = customer.id
              AND grant_row.scope = 'personalize'
              AND grant_row.enrichment_purpose = 'product_personalization'
              AND grant_row.subject = (
                SELECT candidate.subject FROM consent_grants candidate
                WHERE candidate.workspace_id = $1 AND candidate.product_id = $2
                  AND candidate.customer_id = customer.id
                  AND candidate.enrichment_purpose = 'product_personalization'
                ORDER BY candidate.decided_at DESC, candidate.revision DESC,
                  CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
                  candidate.subject, candidate.id LIMIT 1
              )
            ORDER BY grant_row.id LIMIT 1
          ) consent ON TRUE
          WHERE customer.workspace_id = $1 AND customer.merged_into_customer_id IS NULL
        )
        SELECT * FROM summaries
        WHERE last_activity_at IS NOT NULL
          AND ($4::TIMESTAMPTZ IS NULL OR last_activity_at <= $4)
          AND ($5::TEXT IS NULL OR display_name ILIKE $5 ESCAPE '\'
            OR COALESCE(account_ref_hint, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(user_ref_hint, '') ILIKE $5 ESCAPE '\')
          AND ($6::TEXT[] IS NULL OR identity_level = ANY($6))
          AND ($7::TEXT[] IS NULL OR outcome_health = ANY($7))
          AND ($8::TEXT[] IS NULL OR consent_state = ANY($8))
          AND ($9::TEXT[] IS NULL OR segments && $9)
          AND ($10::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM customer_signals signal
            WHERE signal.workspace_id = $1 AND signal.product_id = $2
              AND signal.customer_id = summaries.id
              AND COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) = ANY($10)
              AND signal.collected_at >= $3
              AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          ))
          AND ($11::TIMESTAMPTZ IS NULL OR (last_activity_at, id) < ($11, $12))
        ORDER BY last_activity_at DESC, id DESC LIMIT $13",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(since)
    .bind(filters.until)
    .bind(search)
    .bind(filters.identity_levels)
    .bind(filters.outcome_health)
    .bind(filters.consent_states)
    .bind(filters.segments)
    .bind(filters.signal_types)
    .bind(cursor_last_activity_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if customers.len() > page_size {
        let last = &customers[page_size - 1];
        Some(encode_feedback_cursor(last.last_activity_at, last.id)?)
    } else {
        None
    };
    customers.truncate(page_size);

    let (customer_count, verified, pseudonymous, ephemeral, active, at_risk) =
        sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
            r"SELECT COUNT(DISTINCT customer.id),
              COUNT(DISTINCT customer.id) FILTER (WHERE customer.identity_level = 'verified'),
              COUNT(DISTINCT customer.id) FILTER (WHERE customer.identity_level = 'pseudonymous'),
              COUNT(DISTINCT customer.id) FILTER (WHERE customer.identity_level = 'ephemeral'),
              COUNT(DISTINCT customer.id) FILTER (
                WHERE customer.last_seen_at >= NOW() - INTERVAL '30 days'),
              COUNT(DISTINCT customer.id) FILTER (WHERE EXISTS (
                SELECT 1 FROM customer_signals signal
                WHERE signal.workspace_id = $1 AND signal.product_id = $2
                  AND signal.customer_id = customer.id AND signal.signal_type = 'outcome'
                  AND signal.attributes ->> 'impact' IN ('blocked', 'hindered')
                  AND signal.collected_at >= $3
                  AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
              ))
            FROM customers customer
            WHERE customer.workspace_id = $1 AND customer.merged_into_customer_id IS NULL
              AND EXISTS (SELECT 1 FROM customer_identifiers identifier
                WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
                  AND identifier.customer_id = customer.id)",
        )
        .bind(workspace_id)
        .bind(product_id)
        .bind(retained_since)
        .fetch_one(pool)
        .await?;
    let unclassified = sqlx::query_scalar::<_, i64>(
        r"SELECT COUNT(*) FROM interactions_v2
        WHERE workspace_id = $1 AND environment_id IN (
          SELECT id FROM product_environments WHERE workspace_id = $1 AND product_id = $2
        ) AND customer_id IS NULL AND occurred_at >= $3",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(retained_since)
    .fetch_one(pool)
    .await?;
    Ok(DashboardCustomersPage {
        customers,
        rollup: CustomerRollup {
            customers: customer_count,
            verified,
            pseudonymous,
            ephemeral,
            unclassified,
            active,
            at_risk,
        },
        facets: customer_facets(pool, workspace_id, product_id, retained_since).await?,
        limit,
        next_cursor,
    })
}

fn validate_signal_filters(filters: &DashboardSignalFilters) -> Result<(), ApiError> {
    validate_feedback_values(
        filters.signal_types.as_deref(),
        &[
            "outcome",
            "intent",
            "friction",
            "preference",
            "constraint",
            "feature_need",
            "alternative_considered",
            "workaround",
            "satisfaction",
            "likelihood_to_reuse",
        ],
        "type",
    )?;
    validate_feedback_values(
        filters.provenances.as_deref(),
        &[
            "agent_reports_user_statement",
            "agent_reports_current_task",
            "agent_inference",
            "product_activity",
            "company_assertion",
        ],
        "provenance",
    )?;
    validate_dashboard_text(filters.query.as_deref(), "query", 200)?;
    validate_dashboard_text(filters.feature_key.as_deref(), "featureKey", 64)?;
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }
    Ok(())
}

pub(crate) async fn dashboard_responses_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardResponseFilters,
) -> Result<DashboardResponsesPage, ApiError> {
    validate_feedback_values(
        filters.statuses.as_deref(),
        &[
            "answered",
            "awaiting_answer",
            "declined",
            "no_relevant_context",
        ],
        "status",
    )?;
    validate_dashboard_text(filters.query.as_deref(), "query", 200)?;
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }

    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let since = filters
        .since
        .filter(|since| *since > retained_since)
        .unwrap_or(retained_since);
    let limit = dashboard_list_limit(filters.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let cursor = decode_feedback_cursor(filters.cursor.as_deref(), retained_since)?;
    let cursor_asked_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let search = filters.query.as_deref().map(dashboard_search_pattern);

    let (questions, answered, awaiting_answer, declined) =
        sqlx::query_as::<_, (i64, i64, i64, i64)>(
            r"SELECT COUNT(*),
              COUNT(*) FILTER (WHERE answer.status = 'answered'),
              COUNT(*) FILTER (WHERE answer.id IS NULL
                AND request.state NOT IN ('declined', 'no_relevant_context')),
              COUNT(*) FILTER (WHERE COALESCE(answer.status, request.state) = 'declined')
            FROM enrichment_requests request
            LEFT JOIN enrichment_answers answer ON answer.request_id = request.id
              AND answer.workspace_id = request.workspace_id
            WHERE request.workspace_id = $1 AND request.product_id = $2
              AND request.created_at >= $3",
        )
        .bind(workspace_id)
        .bind(product_id)
        .bind(retained_since)
        .fetch_one(pool)
        .await?;

    let mut responses = sqlx::query_as::<_, DashboardResponseSummary>(
        r"SELECT request.id, request.question,
          CASE
            WHEN answer.status = 'answered' THEN 'answered'
            WHEN COALESCE(answer.status, request.state) = 'declined' THEN 'declined'
            WHEN COALESCE(answer.status, request.state) = 'no_relevant_context'
              THEN 'no_relevant_context'
            ELSE 'awaiting_answer'
          END AS status,
          request.purpose, request.surface, request.customer_id,
          COALESCE(customer.display_name, interaction.customer_ref) AS customer_name,
          interaction.session_id, session.ref_hint AS session_ref,
          request.created_at AS asked_at,
          COALESCE(answer.created_at, request.answered_at) AS answered_at
        FROM enrichment_requests request
        LEFT JOIN enrichment_answers answer ON answer.request_id = request.id
          AND answer.workspace_id = request.workspace_id
        LEFT JOIN interactions_v2 interaction ON interaction.id = request.interaction_id
          AND interaction.workspace_id = request.workspace_id
        LEFT JOIN sessions_v2 session ON session.id = interaction.session_id
          AND session.workspace_id = request.workspace_id
        LEFT JOIN customers customer ON customer.id = request.customer_id
          AND customer.workspace_id = request.workspace_id
        WHERE request.workspace_id = $1 AND request.product_id = $2
          AND request.created_at >= $3
          AND ($4::TIMESTAMPTZ IS NULL OR request.created_at <= $4)
          AND ($5::TEXT IS NULL OR request.question ILIKE $5 ESCAPE '\'
            OR request.purpose ILIKE $5 ESCAPE '\'
            OR COALESCE(customer.display_name, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(interaction.customer_ref, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(session.ref_hint, '') ILIKE $5 ESCAPE '\'
            OR EXISTS (
              SELECT 1 FROM enrichment_signal_items item
              WHERE item.enrichment_answer_id = answer.id
                AND (item.signal_key ILIKE $5 ESCAPE '\'
                  OR item.signal_value ILIKE $5 ESCAPE '\')
            ))
          AND ($6::TEXT[] IS NULL OR CASE
            WHEN answer.status = 'answered' THEN 'answered'
            WHEN COALESCE(answer.status, request.state) = 'declined' THEN 'declined'
            WHEN COALESCE(answer.status, request.state) = 'no_relevant_context'
              THEN 'no_relevant_context'
            ELSE 'awaiting_answer'
          END = ANY($6))
          AND ($7::TIMESTAMPTZ IS NULL OR (request.created_at, request.id) < ($7, $8))
        ORDER BY request.created_at DESC, request.id DESC LIMIT $9",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(since)
    .bind(filters.until)
    .bind(search)
    .bind(filters.statuses)
    .bind(cursor_asked_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;

    let next_cursor = if responses.len() > page_size {
        let last = &responses[page_size - 1];
        Some(encode_feedback_cursor(last.asked_at, last.id)?)
    } else {
        None
    };
    responses.truncate(page_size);

    let request_ids = responses
        .iter()
        .map(|response| response.id)
        .collect::<Vec<_>>();
    if !request_ids.is_empty() {
        let answer_items = sqlx::query_as::<_, (Uuid, String, String, String, String, bool)>(
            r"SELECT answer.request_id, item.signal_key,
              COALESCE(signal.attributes->>'enrichmentType', signal.signal_type),
              item.signal_value, signal.summary, item.remembered
            FROM enrichment_answers answer
            JOIN enrichment_signal_items item ON item.enrichment_answer_id = answer.id
              AND item.workspace_id = answer.workspace_id
            JOIN customer_signals signal ON signal.id = item.signal_id
              AND signal.workspace_id = answer.workspace_id
            WHERE answer.workspace_id = $1 AND answer.request_id = ANY($2)
            ORDER BY answer.request_id, item.item_index",
        )
        .bind(workspace_id)
        .bind(&request_ids)
        .fetch_all(pool)
        .await?;
        for (request_id, key, answer_type, value, summary, remembered) in answer_items {
            if let Some(response) = responses
                .iter_mut()
                .find(|response| response.id == request_id)
            {
                response.answers.push(DashboardResponseAnswer {
                    key,
                    answer_type,
                    value,
                    summary,
                    remembered,
                });
            }
        }
    }

    Ok(DashboardResponsesPage {
        responses,
        rollup: DashboardResponseRollup {
            questions,
            answered,
            awaiting_answer,
            declined,
        },
        limit,
        next_cursor,
    })
}

pub(crate) async fn dashboard_signals_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardSignalFilters,
) -> Result<DashboardSignalsPage, ApiError> {
    validate_signal_filters(&filters)?;
    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let since = filters
        .since
        .filter(|since| *since > retained_since)
        .unwrap_or(retained_since);
    let limit = dashboard_list_limit(filters.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let cursor = decode_feedback_cursor(filters.cursor.as_deref(), retained_since)?;
    let cursor_collected_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let search = filters.query.as_deref().map(dashboard_search_pattern);
    let total = sqlx::query_scalar::<_, i64>(
        r"SELECT COUNT(*) FROM customer_signals signal
        LEFT JOIN enrichment_signal_items enrichment ON enrichment.signal_id = signal.id
          AND enrichment.workspace_id = signal.workspace_id
        WHERE signal.workspace_id = $1 AND signal.product_id = $2
          AND signal.collected_at >= $3
          AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          AND ($4::TIMESTAMPTZ IS NULL OR signal.collected_at <= $4)
          AND ($5::TEXT IS NULL OR signal.summary ILIKE $5 ESCAPE '\'
            OR COALESCE(signal.detail, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(enrichment.signal_key, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(enrichment.signal_value, '') ILIKE $5 ESCAPE '\')
          AND ($6::UUID IS NULL OR signal.customer_id = $6)
          AND ($7::TEXT IS NULL OR signal.feature_key = $7)
          AND ($8::UUID IS NULL OR signal.session_id = $8)
          AND ($9::TEXT[] IS NULL OR
            COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) = ANY($9))
          AND ($10::TEXT[] IS NULL OR signal.provenance = ANY($10))",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(since)
    .bind(filters.until)
    .bind(&search)
    .bind(filters.customer_id)
    .bind(&filters.feature_key)
    .bind(filters.session_id)
    .bind(&filters.signal_types)
    .bind(&filters.provenances)
    .fetch_one(pool)
    .await?;
    let mut signals = sqlx::query_as::<_, CustomerSignal>(
        r"SELECT signal.id, signal.customer_id, signal.session_id,
          signal.interaction_id, signal.feedback_report_id, signal.feature_key,
          enrichment.signal_key, TO_JSONB(enrichment.signal_value) AS value,
          COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) AS signal_type,
          signal.summary, signal.detail, signal.provenance,
          signal.confidence, signal.collected_at, signal.expires_at,
          signal.consent_scope,
          CASE WHEN request.id IS NULL THEN grant_row.state
            WHEN effective_personalize.state <> 'revoked'
              AND effective_personalize.expires_at <= NOW() THEN 'expired'
            ELSE effective_personalize.state END AS consent_state,
          CASE WHEN signal.provenance = 'agent_inference'
              OR effective_share.id IS NULL OR effective_share.state <> 'approved'
              OR (effective_share.expires_at IS NOT NULL
                AND effective_share.expires_at <= NOW())
              OR effective_personalize.id IS NULL
              OR effective_personalize.state <> 'approved'
              OR (effective_personalize.expires_at IS NOT NULL
                AND effective_personalize.expires_at <= NOW())
              OR grant_row.state <> 'approved'
              OR (grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= NOW())
              OR (COALESCE(enrichment.remembered, FALSE)
                AND remember_grant.id IS NULL)
            THEN '{}'::TEXT[]
            ELSE ARRAY[request.purpose] END AS allowed_uses
        FROM customer_signals signal
        LEFT JOIN enrichment_signal_items enrichment ON enrichment.signal_id = signal.id
          AND enrichment.workspace_id = signal.workspace_id
        LEFT JOIN consent_grants grant_row
          ON grant_row.id = signal.consent_grant_id
          AND grant_row.workspace_id = signal.workspace_id
        LEFT JOIN enrichment_answers answer ON answer.id = enrichment.enrichment_answer_id
          AND answer.workspace_id = signal.workspace_id
        LEFT JOIN enrichment_requests request ON request.id = answer.request_id
          AND request.workspace_id = answer.workspace_id
        LEFT JOIN LATERAL (
          SELECT candidate.subject
          FROM consent_grants candidate
          WHERE candidate.environment_id = request.environment_id
            AND candidate.workspace_id = request.workspace_id
            AND candidate.enrichment_purpose = request.purpose
            AND (candidate.subject = request.consent_subject
              OR (enrichment.customer_id IS NOT NULL
                AND candidate.customer_id = enrichment.customer_id))
          ORDER BY candidate.decided_at DESC, candidate.revision DESC,
            CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
            candidate.subject, candidate.id LIMIT 1
        ) effective_consent ON request.id IS NOT NULL
        LEFT JOIN consent_grants effective_share
          ON effective_share.environment_id = request.environment_id
          AND effective_share.subject = effective_consent.subject
          AND effective_share.scope = 'share_preferences'
          AND effective_share.enrichment_purpose = request.purpose
        LEFT JOIN consent_grants effective_personalize
          ON effective_personalize.environment_id = request.environment_id
          AND effective_personalize.subject = effective_consent.subject
          AND effective_personalize.scope = 'personalize'
          AND effective_personalize.enrichment_purpose = request.purpose
        LEFT JOIN consent_grants remember_grant
          ON remember_grant.environment_id = request.environment_id
          AND remember_grant.subject = effective_consent.subject
          AND remember_grant.scope = 'remember_preferences'
          AND remember_grant.enrichment_purpose = request.purpose
          AND remember_grant.state = 'approved'
          AND (remember_grant.expires_at IS NULL OR remember_grant.expires_at > NOW())
        WHERE signal.workspace_id = $1 AND signal.product_id = $2
          AND signal.collected_at >= $3
          AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          AND ($4::TIMESTAMPTZ IS NULL OR signal.collected_at <= $4)
          AND ($5::TEXT IS NULL OR signal.summary ILIKE $5 ESCAPE '\'
            OR COALESCE(signal.detail, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(enrichment.signal_key, '') ILIKE $5 ESCAPE '\'
            OR COALESCE(enrichment.signal_value, '') ILIKE $5 ESCAPE '\')
          AND ($6::UUID IS NULL OR signal.customer_id = $6)
          AND ($7::TEXT IS NULL OR signal.feature_key = $7)
          AND ($8::UUID IS NULL OR signal.session_id = $8)
          AND ($9::TEXT[] IS NULL OR
            COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) = ANY($9))
          AND ($10::TEXT[] IS NULL OR signal.provenance = ANY($10))
          AND ($11::TIMESTAMPTZ IS NULL OR
            (signal.collected_at, signal.id) < ($11, $12))
        ORDER BY signal.collected_at DESC, signal.id DESC LIMIT $13",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(since)
    .bind(filters.until)
    .bind(search)
    .bind(filters.customer_id)
    .bind(filters.feature_key)
    .bind(filters.session_id)
    .bind(filters.signal_types)
    .bind(filters.provenances)
    .bind(cursor_collected_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if signals.len() > page_size {
        let last = &signals[page_size - 1];
        Some(encode_feedback_cursor(last.collected_at, last.id)?)
    } else {
        None
    };
    signals.truncate(page_size);
    Ok(DashboardSignalsPage {
        signals,
        total,
        limit,
        next_cursor,
    })
}

async fn dashboard_customer_summary_by_id(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    customer_id: Uuid,
    retained_since: DateTime<Utc>,
) -> Result<CustomerSummary, ApiError> {
    sqlx::query_as::<_, CustomerSummary>(
        r"SELECT customer.id, customer.kind, customer.parent_customer_id,
          (SELECT COUNT(*) FROM customers member
            WHERE member.workspace_id = customer.workspace_id
              AND member.parent_customer_id = customer.id
              AND member.merged_into_customer_id IS NULL)::BIGINT AS member_count,
          COALESCE(customer.display_name, user_identifier.display_hint,
            account_identifier.display_hint, any_identifier.display_hint,
            CASE WHEN customer.identity_level = 'pseudonymous'
              THEN 'Anonymous customer' ELSE 'Customer' END) AS display_name,
          customer.identity_level, customer.identity_confidence,
          account_identifier.display_hint AS account_ref_hint,
          user_identifier.display_hint AS user_ref_hint, customer.segments,
          COALESCE(activity.last_activity_at, customer.last_seen_at) AS last_activity_at,
          COALESCE(outcome.outcome_health, 'unknown') AS outcome_health,
          COALESCE(activity.signal_count, 0)::BIGINT AS signal_count,
          COALESCE(activity.session_count, 0)::BIGINT AS session_count,
          COALESCE(activity.active_need_count, 0)::BIGINT AS active_need_count,
          COALESCE(consent.consent_state, 'unknown') AS consent_state
        FROM customers customer
        JOIN LATERAL (SELECT identifier.display_hint FROM customer_identifiers identifier
          WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
            AND identifier.customer_id = customer.id
          ORDER BY identifier.created_at, identifier.id LIMIT 1) any_identifier ON TRUE
        LEFT JOIN LATERAL (SELECT identifier.display_hint FROM customer_identifiers identifier
          WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
            AND identifier.customer_id = customer.id AND identifier.kind = 'account_ref'
          ORDER BY identifier.created_at, identifier.id LIMIT 1) account_identifier ON TRUE
        LEFT JOIN LATERAL (SELECT identifier.display_hint FROM customer_identifiers identifier
          WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
            AND identifier.customer_id = customer.id AND identifier.kind = 'user_ref'
          ORDER BY identifier.created_at, identifier.id LIMIT 1) user_identifier ON TRUE
        LEFT JOIN LATERAL (SELECT MAX(interaction.occurred_at) AS last_activity_at,
          COUNT(signal.id)::BIGINT AS signal_count,
          COUNT(DISTINCT interaction.session_id)::BIGINT AS session_count,
          COUNT(signal.id) FILTER (WHERE signal.signal_type IN ('feature_need', 'friction')
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW()))::BIGINT active_need_count
          FROM interactions_v2 interaction LEFT JOIN customer_signals signal
            ON signal.interaction_id = interaction.id AND signal.workspace_id = interaction.workspace_id
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          WHERE interaction.workspace_id = $1 AND interaction.customer_id = customer.id
            AND interaction.environment_id IN (SELECT id FROM product_environments
              WHERE workspace_id = $1 AND product_id = $2)
            AND interaction.occurred_at >= $4) activity ON TRUE
        LEFT JOIN LATERAL (SELECT CASE
          WHEN signal.attributes ->> 'impact' IN ('blocked', 'hindered') THEN 'at_risk'
          WHEN signal.attributes ->> 'impact' IN ('helped', 'helped_with_friction') THEN 'healthy'
          ELSE 'unknown' END outcome_health FROM customer_signals signal
          WHERE signal.workspace_id = $1 AND signal.product_id = $2
            AND signal.customer_id = customer.id AND signal.signal_type = 'outcome'
            AND signal.collected_at >= $4
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          ORDER BY signal.collected_at DESC, signal.id DESC LIMIT 1) outcome ON TRUE
        LEFT JOIN LATERAL (SELECT CASE
          WHEN grant_row.state <> 'revoked' AND grant_row.expires_at <= NOW()
            THEN 'expired' ELSE grant_row.state
        END consent_state FROM consent_grants grant_row
          WHERE grant_row.workspace_id = $1 AND grant_row.product_id = $2
            AND grant_row.customer_id = customer.id
            AND grant_row.scope = 'personalize'
            AND grant_row.enrichment_purpose = 'product_personalization'
            AND grant_row.subject = (
              SELECT candidate.subject FROM consent_grants candidate
              WHERE candidate.workspace_id = $1 AND candidate.product_id = $2
                AND candidate.customer_id = customer.id
                AND candidate.enrichment_purpose = 'product_personalization'
              ORDER BY candidate.decided_at DESC, candidate.revision DESC,
                CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
                candidate.subject, candidate.id LIMIT 1
            )
          ORDER BY grant_row.id LIMIT 1) consent ON TRUE
        WHERE customer.id = $3 AND customer.workspace_id = $1
          AND customer.merged_into_customer_id IS NULL",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .bind(retained_since)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Customer not found for product"))
}

pub(crate) async fn dashboard_customer_by_id(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    customer_id: Uuid,
) -> Result<DashboardCustomerDetail, ApiError> {
    let environment = dashboard_environment_for_product(pool, workspace_id, product_id).await?;
    let retained_since = Utc::now() - Duration::days(environment.retention_days.into());
    let customer = dashboard_customer_summary_by_id(
        pool,
        workspace_id,
        product_id,
        customer_id,
        retained_since,
    )
    .await?;
    let identifiers = sqlx::query_as::<_, CustomerIdentifier>(
        r"SELECT id, kind, display_hint, identity_level, provenance, verified_at
        FROM customer_identifiers WHERE workspace_id = $1 AND product_id = $2
          AND customer_id = $3 ORDER BY created_at, id",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .fetch_all(pool)
    .await?;
    let signal_page = dashboard_signals_page(
        pool,
        workspace_id,
        product_id,
        DashboardSignalFilters {
            customer_id: Some(customer_id),
            limit: Some(100),
            ..DashboardSignalFilters::default()
        },
    )
    .await?;
    let sessions = sqlx::query_as::<_, DashboardSessionSummary>(
        r"SELECT session.id, session.workspace_id, session.environment_id,
          session.source, session.ref_hint, session.started_at, session.last_seen_at,
          session.created_at, activity.interaction_count, activity.report_count,
          activity.first_operation, activity.last_operation, activity.customer_ref,
          activity.strongest_impact
        FROM sessions_v2 session
        CROSS JOIN LATERAL (SELECT COUNT(interaction.id)::BIGINT interaction_count,
          COUNT(report.id)::BIGINT report_count,
          (ARRAY_AGG(interaction.operation ORDER BY interaction.occurred_at,
            interaction.client_sequence NULLS LAST, interaction.id))[1] first_operation,
          (ARRAY_AGG(interaction.operation ORDER BY interaction.occurred_at DESC,
            interaction.client_sequence DESC NULLS LAST, interaction.id DESC))[1] last_operation,
          (ARRAY_AGG(interaction.customer_ref ORDER BY interaction.occurred_at)
            FILTER (WHERE interaction.customer_ref IS NOT NULL))[1] customer_ref,
          (ARRAY_AGG(report.impact ORDER BY CASE report.impact
            WHEN 'blocked' THEN 5 WHEN 'hindered' THEN 4
            WHEN 'helped_with_friction' THEN 3 WHEN 'neutral' THEN 2
            WHEN 'unknown' THEN 1 WHEN 'helped' THEN 0 ELSE -1 END DESC)
            FILTER (WHERE report.impact IS NOT NULL))[1] strongest_impact
          FROM interactions_v2 interaction
          LEFT JOIN feedback_reports report ON report.interaction_id = interaction.id
          WHERE interaction.session_id = session.id AND interaction.customer_id = $3
            AND interaction.occurred_at >= $4) activity
        WHERE session.workspace_id = $1 AND session.environment_id IN (
          SELECT id FROM product_environments WHERE workspace_id = $1 AND product_id = $2)
          AND activity.interaction_count > 0
        ORDER BY session.last_seen_at DESC, session.id DESC LIMIT 100",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .bind(retained_since)
    .fetch_all(pool)
    .await?;
    let consent = sqlx::query_as::<_, ConsentGrant>(
        r"SELECT id, scope, enrichment_purpose,
          CASE WHEN state <> 'revoked' AND expires_at <= NOW() THEN 'expired' ELSE state END AS state,
          basis, decided_at, expires_at, revoked_at, revision
        FROM consent_grants WHERE workspace_id = $1 AND product_id = $2
          AND customer_id = $3
        ORDER BY updated_at DESC, id DESC",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .fetch_all(pool)
    .await?;
    let consent_history = sqlx::query_as::<_, ConsentEventSummary>(
        r"SELECT event.id, event.scope, event.enrichment_purpose,
          event.prior_state, event.state, event.basis,
          event.revision, event.source, event.decided_at, event.created_at
        FROM (
          SELECT id, workspace_id, product_id, consent_grant_id, scope,
            enrichment_purpose, prior_state, state, basis, revision, source,
            decided_at, created_at
          FROM consent_events
          UNION ALL
          SELECT id, workspace_id, product_id, consent_grant_id, scope,
            enrichment_purpose, prior_state, state, basis, revision, source,
            decided_at, created_at
          FROM enrichment_consent_events
        ) event
        JOIN consent_grants grant_row ON grant_row.id = event.consent_grant_id
          AND grant_row.workspace_id = event.workspace_id
        WHERE event.workspace_id = $1 AND event.product_id = $2
          AND grant_row.customer_id = $3
        ORDER BY event.created_at DESC, event.id DESC LIMIT 100",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .fetch_all(pool)
    .await?;
    let (signal_count, session_count, feature_count) = sqlx::query_as::<_, (i64, i64, i64)>(
        r"SELECT
              (SELECT COUNT(*) FROM customer_signals signal
                WHERE signal.workspace_id = $1 AND signal.product_id = $2
                  AND signal.customer_id = $3 AND signal.collected_at >= $4
                  AND (signal.expires_at IS NULL OR signal.expires_at > NOW())),
              (SELECT COUNT(DISTINCT interaction.session_id) FROM interactions_v2 interaction
                WHERE interaction.workspace_id = $1 AND interaction.customer_id = $3
                  AND interaction.environment_id IN (SELECT id FROM product_environments
                    WHERE workspace_id = $1 AND product_id = $2)
                  AND interaction.occurred_at >= $4),
              (SELECT COUNT(DISTINCT signal.feature_key) FROM customer_signals signal
                WHERE signal.workspace_id = $1 AND signal.product_id = $2
                  AND signal.customer_id = $3 AND signal.collected_at >= $4
                  AND signal.feature_key IS NOT NULL
                  AND (signal.expires_at IS NULL OR signal.expires_at > NOW()))",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .bind(retained_since)
    .fetch_one(pool)
    .await?;
    Ok(DashboardCustomerDetail {
        counts: CustomerDetailCounts {
            signals: signal_count,
            sessions: session_count,
            features: feature_count,
        },
        customer,
        identifiers,
        signals: signal_page.signals,
        sessions,
        consent,
        consent_history,
    })
}

#[allow(
    clippy::cast_precision_loss,
    reason = "database row counts are intentionally converted to f64 for display-only rates"
)]
fn rounded_rate(numerator: i64, denominator: i64) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        (numerator as f64 / denominator as f64 * 100.0).round() / 100.0
    }
}

async fn feedback_summary(
    pool: &PgPool,
    auth: &ProductAuth,
    since: Option<DateTime<Utc>>,
) -> Result<FeedbackSummary, ApiError> {
    let (window, _) = feedback_window(auth.environment.retention_days, since);
    let product: String =
        sqlx::query_scalar("SELECT name FROM products WHERE id = $1 AND workspace_id = $2")
            .bind(auth.environment.product_id)
            .bind(auth.workspace.id)
            .fetch_one(pool)
            .await?;
    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
        r"SELECT COUNT(i.id), COUNT(r.id),
        COUNT(i.id) FILTER (WHERE i.classification = 'confirmed' OR ec.id IS NOT NULL),
        COUNT(r.id) FILTER (WHERE r.workaround ->> 'used' = 'true'),
        COUNT(r.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.findings) finding
          WHERE finding ->> 'severity' = 'blocking'
        ))
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_one(pool)
    .await?;
    let operation_counts = sqlx::query_as::<_, (String, i64, i64)>(
        r"SELECT i.operation, COUNT(i.id), COUNT(r.id)
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY i.operation
        ORDER BY COUNT(i.id) DESC, i.operation
        LIMIT 20",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?;
    let top_operations = operation_counts
        .into_iter()
        .map(
            |(operation, interactions, reports)| FeedbackOperationSummary {
                operation,
                interactions,
                reports,
            },
        )
        .collect();
    let surfaces = sqlx::query_as::<_, (String, i64)>(
        r"SELECT surface, COUNT(*) FROM interactions_v2
        WHERE environment_id = $1 AND occurred_at >= $2
        GROUP BY surface ORDER BY COUNT(*) DESC, surface",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(surface, interactions)| FeedbackSurfaceSummary {
        surface,
        interactions,
    })
    .collect();
    let impacts = sqlx::query_as::<_, (String, i64)>(
        r"SELECT COALESCE(r.impact, 'unspecified'), COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY COALESCE(r.impact, 'unspecified')",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let finding_kinds = sqlx::query_as::<_, (String, i64)>(
        r"SELECT finding ->> 'kind', COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
        LATERAL jsonb_array_elements(r.findings) finding
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY finding ->> 'kind'",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let severities = sqlx::query_as::<_, (String, i64)>(
        r"SELECT finding ->> 'severity', COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
        LATERAL jsonb_array_elements(r.findings) finding
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
          AND finding ? 'severity'
        GROUP BY finding ->> 'severity'",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    Ok(FeedbackSummary {
        product,
        window,
        interactions: counts.0,
        reviewed: counts.1,
        review_rate: rounded_rate(counts.1, counts.2),
        confirmation_rate: rounded_rate(counts.2, counts.0),
        impacts,
        finding_kinds,
        severities,
        workaround_rate: rounded_rate(counts.3, counts.1),
        top_operations,
        surfaces,
    })
}

pub(crate) async fn feedback_list_reports(
    pool: &PgPool,
    auth: &ProductAuth,
    input: FeedbackListReportsInput,
) -> Result<FeedbackReportsResponse, ApiError> {
    if input.summary.unwrap_or(false) {
        return Ok(FeedbackReportsResponse::Summary(
            feedback_summary(pool, auth, input.since).await?,
        ));
    }
    validate_feedback_values(
        input.impact.as_deref(),
        &[
            "helped",
            "helped_with_friction",
            "neutral",
            "hindered",
            "blocked",
            "unknown",
        ],
        "impact",
    )?;
    validate_feedback_values(
        input.finding_kind.as_deref(),
        &[
            "strength",
            "friction",
            "defect",
            "gap",
            "suggestion",
            "uncertainty",
            "other",
        ],
        "findingKind",
    )?;
    validate_feedback_values(
        input.severity.as_deref(),
        &["minor", "major", "blocking"],
        "severity",
    )?;
    let limit = feedback_limit(input.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let (window, retained_since) = feedback_window(auth.environment.retention_days, input.since);
    let cursor = decode_feedback_cursor(input.cursor.as_deref(), retained_since)?;
    let cursor_occurred_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let mut reports = sqlx::query_as::<_, FeedbackReportItem>(
        r"SELECT r.id, r.summary, r.impact, r.confidence, r.findings, r.workaround,
        i.operation, i.customer_ref, i.surface, i.duration_ms, i.status_code,
        i.occurred_at, r.created_at, i.id AS interaction_id
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
          AND ($3::TEXT[] IS NULL OR r.impact = ANY($3))
          AND ($4::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'kind' = ANY($4)
          ))
          AND ($5::TEXT[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'severity' = ANY($5)
          ))
          AND ($6::TEXT IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE LOWER(finding ->> 'topic') = LOWER($6)
          ))
          AND ($7::TEXT IS NULL OR i.operation = $7)
          AND ($8::TEXT IS NULL OR i.customer_ref = $8)
          AND ($9::TIMESTAMPTZ IS NULL OR (i.occurred_at, i.id) < ($9, $10))
        ORDER BY i.occurred_at DESC, i.id DESC
        LIMIT $11",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .bind(input.impact)
    .bind(input.finding_kind)
    .bind(input.severity)
    .bind(input.topic)
    .bind(input.operation)
    .bind(input.customer_ref)
    .bind(cursor_occurred_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if reports.len() > page_size {
        let last = &reports[page_size - 1];
        Some(encode_feedback_cursor(
            last.occurred_at,
            last.interaction_id,
        )?)
    } else {
        None
    };
    reports.truncate(page_size);
    Ok(FeedbackReportsResponse::Page(FeedbackReportsPage {
        reports,
        next_cursor,
        window,
    }))
}

pub(crate) async fn feedback_list_interactions(
    pool: &PgPool,
    auth: &ProductAuth,
    input: FeedbackListInteractionsInput,
) -> Result<FeedbackInteractionsPage, ApiError> {
    validate_feedback_values(
        input.surface.as_deref(),
        &["http_json", "http_html", "http_headers", "mcp", "unknown"],
        "surface",
    )?;
    let limit = feedback_limit(input.limit)?;
    let page_size = usize::try_from(limit).map_err(ApiError::internal)?;
    let (window, retained_since) = feedback_window(auth.environment.retention_days, input.since);
    let cursor = decode_feedback_cursor(input.cursor.as_deref(), retained_since)?;
    let cursor_occurred_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let mut interactions = sqlx::query_as::<_, FeedbackInteractionItem>(
        r"SELECT i.id, i.operation, i.customer_ref, i.surface,
        CASE WHEN ec.id IS NOT NULL THEN 'confirmed' ELSE i.classification END AS classification,
        i.duration_ms, i.status_code, i.occurred_at
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
          AND ($3::BOOLEAN IS NULL OR (r.id IS NOT NULL) = $3)
          AND ($4::TEXT IS NULL OR i.operation = $4)
          AND ($5::TEXT IS NULL OR i.customer_ref = $5)
          AND ($6::TEXT[] IS NULL OR i.surface = ANY($6))
          AND ($7::TIMESTAMPTZ IS NULL OR (i.occurred_at, i.id) < ($7, $8))
        ORDER BY i.occurred_at DESC, i.id DESC
        LIMIT $9",
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .bind(input.reviewed)
    .bind(input.operation)
    .bind(input.customer_ref)
    .bind(input.surface)
    .bind(cursor_occurred_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let next_cursor = if interactions.len() > page_size {
        let last = &interactions[page_size - 1];
        Some(encode_feedback_cursor(last.occurred_at, last.id)?)
    } else {
        None
    };
    interactions.truncate(page_size);
    Ok(FeedbackInteractionsPage {
        interactions,
        next_cursor,
        window,
    })
}

pub(crate) async fn update_policy(
    pool: &PgPool,
    workspace_id: Uuid,
    input: PolicyInput,
) -> Result<ProductEnvironment, ApiError> {
    if !["never_ask", "ask_once", "ask_always", "off"].contains(&input.feedback_mode.as_str())
        || !(1..=365).contains(&input.retention_days)
    {
        return Err(ApiError::bad_request(
            "Invalid feedback mode or retention period",
        ));
    }
    let updated = sqlx::query_as::<_, ProductEnvironment>(
        r"UPDATE product_environments SET feedback_mode = $1,
        collect_event_summaries = $2, retention_days = $3, updated_at = NOW()
        WHERE id = $4 AND workspace_id = $5 RETURNING *",
    )
    .bind(input.feedback_mode)
    .bind(input.collect_event_summaries)
    .bind(input.retention_days)
    .bind(input.environment_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?;
    updated.ok_or_else(|| ApiError::not_found("Product environment not found"))
}

pub(crate) async fn purge_expired_product_data(
    pool: &PgPool,
    batch_size: i64,
) -> Result<u64, ApiError> {
    let limit = batch_size.clamp(1, 10_000);
    let removed_interactions = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT i.id FROM interactions_v2 i
          JOIN product_environments e ON e.id = i.environment_id
          WHERE i.occurred_at < NOW() - make_interval(days => e.retention_days)
          ORDER BY i.occurred_at
          LIMIT $1
        ), removed AS (
          DELETE FROM interactions_v2 i USING doomed d WHERE i.id = d.id RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    let removed_sessions = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT s.id FROM sessions_v2 s
          WHERE NOT EXISTS (SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id)
          ORDER BY s.last_seen_at
          LIMIT $1
        ), removed AS (
          DELETE FROM sessions_v2 s USING doomed d WHERE s.id = d.id RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    // Per-interaction consent is useful only while its short-lived capability
    // can authorize a report. Keep it no longer than the product's configured
    // retention window. Ask-once's durable, opaque subject decision lives in
    // `feedback_consent_subjects` and is intentionally unaffected.
    let removed_consent_interactions = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT consent.interaction_id
          FROM feedback_consent_interactions consent
          JOIN product_environments environment ON environment.id = consent.environment_id
          WHERE consent.decided_at < NOW() - make_interval(days => environment.retention_days)
          ORDER BY consent.decided_at
          LIMIT $1
        ), removed AS (
          DELETE FROM feedback_consent_interactions consent
          USING doomed
          WHERE consent.interaction_id = doomed.interaction_id
          RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    let removed_explicitly_expired_signals = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT id FROM customer_signals
          WHERE expires_at IS NOT NULL AND expires_at <= NOW()
          ORDER BY expires_at, id LIMIT $1
        ), removed AS (
          DELETE FROM customer_signals signal USING doomed
          WHERE signal.id = doomed.id RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    let removed_context_retrievals = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT retrieval.id FROM customer_context_retrievals retrieval
          JOIN product_environments environment ON environment.id = retrieval.environment_id
          WHERE retrieval.created_at < NOW() - make_interval(days => environment.retention_days)
          ORDER BY retrieval.created_at, retrieval.id LIMIT $1
        ), removed AS (
          DELETE FROM customer_context_retrievals retrieval USING doomed
          WHERE retrieval.id = doomed.id RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    let removed_orphan_customers = sqlx::query_scalar::<_, i64>(
        r"WITH doomed AS (
          SELECT customer.id FROM customers customer
          WHERE customer.identity_level IN ('pseudonymous', 'ephemeral')
            AND customer.merged_into_customer_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM interactions_v2 interaction
              WHERE interaction.workspace_id = customer.workspace_id
                AND interaction.customer_id = customer.id)
            AND NOT EXISTS (SELECT 1 FROM customer_signals signal
              WHERE signal.workspace_id = customer.workspace_id
                AND signal.customer_id = customer.id
                AND (signal.expires_at IS NULL OR signal.expires_at > NOW()))
            AND NOT EXISTS (SELECT 1 FROM consent_grants grant_row
              WHERE grant_row.workspace_id = customer.workspace_id
                AND grant_row.customer_id = customer.id
                AND grant_row.state = 'approved'
                AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NOW()))
            AND NOT EXISTS (SELECT 1 FROM customer_resolution_events resolution
              WHERE resolution.workspace_id = customer.workspace_id
                AND (resolution.from_customer_id = customer.id
                  OR resolution.to_customer_id = customer.id))
          ORDER BY customer.last_seen_at, customer.id LIMIT $1
        ), removed AS (
          DELETE FROM customers customer USING doomed
          WHERE customer.id = doomed.id RETURNING 1
        ) SELECT COUNT(*) FROM removed",
    )
    .bind(limit)
    .fetch_one(pool)
    .await?;
    u64::try_from(
        removed_interactions
            + removed_sessions
            + removed_consent_interactions
            + removed_explicitly_expired_signals
            + removed_context_retrievals
            + removed_orphan_customers,
    )
    .map_err(ApiError::internal)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "bounded dashboard percentages and integer-backed duration percentiles are intentionally rounded to whole-number metrics"
)]
async fn dashboard_insights(
    pool: &PgPool,
    environment_id: Option<Uuid>,
    retained_since: Option<DateTime<Utc>>,
) -> Result<Insights, ApiError> {
    const WINDOW_DAYS: i32 = 30;
    const COMPARISON_DAYS: i32 = 7;
    let now = Utc::now();
    let window_start = retained_since.map_or_else(
        || now - Duration::days(WINDOW_DAYS.into()),
        |retained_since| retained_since.max(now - Duration::days(WINDOW_DAYS.into())),
    );
    let recent_start = now - Duration::days(COMPARISON_DAYS.into());
    let previous_start = retained_since.map_or_else(
        || recent_start - Duration::days(COMPARISON_DAYS.into()),
        |retained_since| retained_since.max(recent_start - Duration::days(COMPARISON_DAYS.into())),
    );
    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)>(
        r"SELECT
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $2),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $2
            AND (i.classification = 'confirmed' OR ec.id IS NOT NULL)),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $2),
          COUNT(DISTINCT r.id) FILTER (WHERE i.occurred_at >= $2 AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'severity' = 'blocking'
          )),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $2 AND r.workaround ->> 'used' = 'true'),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $3
            AND (i.classification = 'confirmed' OR ec.id IS NOT NULL)),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3
            AND (i.classification = 'confirmed' OR ec.id IS NOT NULL)),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3)
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $4",
    )
    .bind(environment_id)
    .bind(window_start)
    .bind(recent_start)
    .bind(previous_start)
    .fetch_one(pool)
    .await?;
    let duration_percentiles = sqlx::query_as::<_, (Option<f64>, Option<f64>)>(
        r"SELECT
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms),
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
        FROM interactions_v2
        WHERE environment_id = $1 AND occurred_at >= $2 AND duration_ms IS NOT NULL",
    )
    .bind(environment_id)
    .bind(window_start)
    .fetch_one(pool)
    .await?;
    let context_counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        r"WITH eligible_context AS (
          SELECT item.signal_id AS id, item.customer_id
          FROM enrichment_signal_items item
          JOIN customer_signals signal ON signal.id = item.signal_id
            AND signal.workspace_id = item.workspace_id
          JOIN enrichment_answers answer ON answer.id = item.enrichment_answer_id
            AND answer.workspace_id = item.workspace_id
          JOIN enrichment_requests request ON request.id = answer.request_id
            AND request.workspace_id = answer.workspace_id
          JOIN LATERAL (
            SELECT candidate.subject
            FROM consent_grants candidate
            WHERE candidate.environment_id = request.environment_id
              AND candidate.workspace_id = request.workspace_id
              AND candidate.enrichment_purpose = request.purpose
              AND (candidate.subject = request.consent_subject
                OR (item.customer_id IS NOT NULL AND candidate.customer_id = item.customer_id))
            ORDER BY candidate.decided_at DESC, candidate.revision DESC,
              CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
              candidate.subject, candidate.id LIMIT 1
          ) effective_consent ON TRUE
          JOIN consent_grants original_share ON original_share.id = signal.consent_grant_id
            AND original_share.workspace_id = signal.workspace_id
            AND original_share.enrichment_purpose = request.purpose
            AND original_share.state = 'approved'
            AND (original_share.expires_at IS NULL OR original_share.expires_at > NOW())
          JOIN consent_grants share_grant
            ON share_grant.environment_id = request.environment_id
            AND share_grant.subject = effective_consent.subject
            AND share_grant.scope = 'share_preferences'
            AND share_grant.enrichment_purpose = request.purpose
            AND share_grant.state = 'approved'
            AND (share_grant.expires_at IS NULL OR share_grant.expires_at > NOW())
          JOIN consent_grants purpose_grant
            ON purpose_grant.environment_id = request.environment_id
            AND purpose_grant.subject = effective_consent.subject
            AND purpose_grant.scope = 'personalize'
            AND purpose_grant.enrichment_purpose = request.purpose
            AND purpose_grant.state = 'approved'
            AND (purpose_grant.expires_at IS NULL OR purpose_grant.expires_at > NOW())
          JOIN consent_grants remember_grant
            ON remember_grant.environment_id = request.environment_id
            AND remember_grant.subject = effective_consent.subject
            AND remember_grant.scope = 'remember_preferences'
            AND remember_grant.enrichment_purpose = request.purpose
            AND remember_grant.state = 'approved'
            AND (remember_grant.expires_at IS NULL OR remember_grant.expires_at > NOW())
          WHERE item.environment_id = $1 AND item.collected_at >= $2
            AND item.customer_id IS NOT NULL
            AND item.provenance <> 'agent_inference'
            AND item.remembered AND item.expires_at > NOW()
        )
        SELECT
          (SELECT COUNT(*) FROM eligible_context),
          (SELECT COUNT(DISTINCT customer_id) FROM eligible_context),
          (SELECT COUNT(*) FROM customer_context_retrievals retrieval
            WHERE retrieval.environment_id = $1 AND retrieval.created_at >= $2),
          (SELECT COUNT(DISTINCT customer_id) FROM eligible_context),
          (SELECT COUNT(*) FROM personalization_decisions decision
            WHERE decision.environment_id = $1 AND decision.created_at >= $2),
          (SELECT COUNT(*) FROM personalization_outcomes outcome
            JOIN personalization_decisions decision ON decision.id = outcome.decision_id
            WHERE decision.environment_id = $1 AND outcome.occurred_at >= $2)",
    )
    .bind(environment_id)
    .bind(window_start)
    .fetch_one(pool)
    .await?;
    let insight_counts = |rows: Vec<(String, i64)>| {
        rows.into_iter()
            .map(|(name, count)| InsightCount { name, count })
            .collect::<Vec<_>>()
    };
    let top_operations = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT operation, COUNT(*) FROM interactions_v2
            WHERE environment_id = $1 AND occurred_at >= $2
            GROUP BY operation ORDER BY COUNT(*) DESC, operation LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    let surfaces = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT surface, COUNT(*) FROM interactions_v2
            WHERE environment_id = $1 AND occurred_at >= $2
            GROUP BY surface ORDER BY COUNT(*) DESC, surface LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    let impacts = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT COALESCE(r.impact, 'unspecified'), COUNT(*)
            FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
            WHERE i.environment_id = $1 AND i.occurred_at >= $2
            GROUP BY COALESCE(r.impact, 'unspecified')
            ORDER BY COUNT(*) DESC, COALESCE(r.impact, 'unspecified') LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    let finding_kinds = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT finding ->> 'kind', COUNT(*)
            FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
            LATERAL jsonb_array_elements(r.findings) finding
            WHERE i.environment_id = $1 AND i.occurred_at >= $2
            GROUP BY finding ->> 'kind'
            ORDER BY COUNT(*) DESC, finding ->> 'kind' LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    let topics = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT finding ->> 'topic', COUNT(*)
            FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
            LATERAL jsonb_array_elements(r.findings) finding
            WHERE i.environment_id = $1 AND i.occurred_at >= $2
            GROUP BY finding ->> 'topic'
            ORDER BY COUNT(*) DESC, finding ->> 'topic' LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    let blocking_topics = insight_counts(
        sqlx::query_as::<_, (String, i64)>(
            r"SELECT finding ->> 'topic', COUNT(*)
            FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
            LATERAL jsonb_array_elements(r.findings) finding
            WHERE i.environment_id = $1 AND i.occurred_at >= $2
              AND finding ->> 'severity' = 'blocking'
            GROUP BY finding ->> 'topic'
            ORDER BY COUNT(*) DESC, finding ->> 'topic' LIMIT 8",
        )
        .bind(environment_id)
        .bind(window_start)
        .fetch_all(pool)
        .await?,
    );
    Ok(Insights {
        window_days: WINDOW_DAYS,
        comparison_days: COMPARISON_DAYS,
        customer_context_items: context_counts.0,
        customers_with_context: context_counts.1,
        context_retrievals: context_counts.2,
        personalization_ready_customers: context_counts.3,
        personalization_decisions: context_counts.4,
        personalization_outcomes: context_counts.5,
        opportunities: counts.0,
        confirmed_interactions: counts.1,
        reports: counts.2,
        reports_with_blockers: counts.3,
        reports_with_workarounds: counts.4,
        recent_opportunities: counts.5,
        recent_confirmed_interactions: counts.6,
        recent_reports: counts.7,
        previous_opportunities: counts.8,
        previous_confirmed_interactions: counts.9,
        previous_reports: counts.10,
        confirmation_rate: if counts.0 == 0 {
            0
        } else {
            (counts.1 as f64 / counts.0 as f64 * 100.0).round() as i64
        },
        review_rate: if counts.1 == 0 {
            0
        } else {
            (counts.2 as f64 / counts.1 as f64 * 100.0).round() as i64
        },
        p50_duration_ms: duration_percentiles.0.map(|value| value.round() as i64),
        p95_duration_ms: duration_percentiles.1.map(|value| value.round() as i64),
        top_operations,
        surfaces,
        impacts,
        finding_kinds,
        topics,
        blocking_topics,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn dashboard(
    pool: &PgPool,
    context: DashboardContext,
    selected_product_id: Option<Uuid>,
    selected_environment_id: Option<Uuid>,
) -> Result<DashboardData, ApiError> {
    dashboard_with_limits(
        pool,
        context,
        selected_product_id,
        selected_environment_id,
        250,
        250,
        100,
    )
    .await
}

pub(crate) async fn dashboard_with_limits(
    pool: &PgPool,
    context: DashboardContext,
    selected_product_id: Option<Uuid>,
    selected_environment_id: Option<Uuid>,
    interaction_limit: i64,
    report_limit: i64,
    session_limit: i64,
) -> Result<DashboardData, ApiError> {
    let interaction_limit = interaction_limit.clamp(1, 10_000);
    let report_limit = report_limit.clamp(1, 10_000);
    let session_limit = session_limit.clamp(1, 10_000);
    let products = sqlx::query_as::<_, Product>(
        "SELECT * FROM products WHERE workspace_id = $1 ORDER BY created_at, name",
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let environments = sqlx::query_as::<_, ProductEnvironment>(
        "SELECT * FROM product_environments WHERE workspace_id = $1 ORDER BY created_at, name",
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let legacy_environment = selected_environment_id
        .and_then(|id| environments.iter().find(|environment| environment.id == id));
    let current_product = selected_product_id
        .and_then(|id| products.iter().find(|product| product.id == id))
        .or_else(|| {
            legacy_environment.and_then(|environment| {
                products
                    .iter()
                    .find(|product| product.id == environment.product_id)
            })
        })
        .or_else(|| products.first())
        .cloned();
    let current_environment = current_product
        .as_ref()
        .and_then(|product| {
            legacy_environment
                .filter(|environment| environment.product_id == product.id)
                .or_else(|| {
                    environments
                        .iter()
                        .find(|environment| environment.product_id == product.id)
                })
        })
        .cloned();
    let environment_id = current_environment
        .as_ref()
        .map(|environment| environment.id);
    let retained_since = current_environment
        .as_ref()
        .map(|environment| Utc::now() - Duration::days(environment.retention_days.into()));
    let activation_milestones = if let Some(product) = current_product.as_ref() {
        sqlx::query_as::<_, ProductActivationMilestones>(
            r"SELECT workspace_id, product_id, first_opportunity_at,
              first_confirmed_interaction_at, first_report_at
            FROM product_activation_milestones
            WHERE workspace_id = $1 AND product_id = $2",
        )
        .bind(context.workspace.id)
        .bind(product.id)
        .fetch_optional(pool)
        .await?
    } else {
        None
    };
    let api_keys = sqlx::query_as::<_, ApiKeyPublic>(
        r"SELECT k.id, k.environment_id, k.label, k.prefix, k.kind, k.created_at,
          k.last_used_at, k.revoked_at, k.expires_at,
          COALESCE(activity.interaction_count, 0) AS interaction_count,
          COALESCE(activity.report_count, 0) AS report_count
        FROM api_keys k
        LEFT JOIN (
          SELECT i.api_key_id, COUNT(DISTINCT i.id)::BIGINT AS interaction_count,
            COUNT(r.id)::BIGINT AS report_count
          FROM interactions_v2 i
          LEFT JOIN feedback_reports r ON r.interaction_id = i.id
          WHERE i.environment_id = $1 AND i.occurred_at >= $2
          GROUP BY i.api_key_id
        ) activity ON activity.api_key_id = k.id
        WHERE k.environment_id = $1
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())
        ORDER BY k.created_at DESC",
    )
    .bind(environment_id)
    .bind(retained_since)
    .fetch_all(pool)
    .await?;
    let interactions = sqlx::query_as::<_, ProductInteraction>(
        r"SELECT i.id, i.workspace_id, i.environment_id, i.api_key_id, i.session_id,
        i.surface, i.operation, i.status_code, i.duration_ms, i.customer_ref, i.customer_id,
        CASE WHEN ec.id IS NOT NULL THEN 'confirmed' ELSE i.classification END AS classification,
        COALESCE(i.confirmation_method, ec.method) AS confirmation_method,
        i.runtime_hint, i.runtime_hint_source, i.occurred_at, i.created_at, i.updated_at
        FROM interactions_v2 i
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        ORDER BY i.occurred_at DESC LIMIT $3",
    )
    .bind(environment_id)
    .bind(retained_since)
    .bind(interaction_limit)
    .fetch_all(pool)
    .await?;
    let reports = sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        COALESCE((
          SELECT jsonb_agg(
            CASE WHEN stored_hint.value ? 'verified' THEN stored_hint.value
              ELSE stored_hint.value || jsonb_build_object('verified', FALSE) END
            ORDER BY stored_hint.ordinality)
          FROM jsonb_array_elements(code_hints.hints)
            WITH ORDINALITY AS stored_hint(value, ordinality)
        ), '[]'::JSONB) AS code_hints,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        LEFT JOIN report_code_hints code_hints ON code_hints.report_id = r.id
        LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        ORDER BY r.created_at DESC LIMIT $3",
    )
    .bind(environment_id)
    .bind(retained_since)
    .bind(report_limit)
    .fetch_all(pool)
    .await?;
    let sessions = sqlx::query_as::<_, DashboardSessionSummary>(
        r"WITH selected_sessions AS (
          SELECT id, workspace_id, environment_id, source, ref_hint,
            started_at, last_seen_at, created_at
          FROM sessions_v2
          WHERE environment_id = $1 AND last_seen_at >= $2
          ORDER BY last_seen_at DESC
          LIMIT $3
        )
        SELECT s.id, s.workspace_id, s.environment_id, s.source, s.ref_hint,
          s.started_at, s.last_seen_at, s.created_at,
          COALESCE(activity.interaction_count, 0) AS interaction_count,
          COALESCE(activity.report_count, 0) AS report_count,
          activity.first_operation, activity.last_operation, activity.customer_ref,
          activity.strongest_impact
        FROM selected_sessions s
        LEFT JOIN LATERAL (
          SELECT
            COUNT(i.id)::BIGINT AS interaction_count,
            COUNT(r.id)::BIGINT AS report_count,
            (ARRAY_AGG(i.operation ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id)
              FILTER (WHERE i.id IS NOT NULL))[1] AS first_operation,
            (ARRAY_AGG(i.operation ORDER BY i.occurred_at DESC, i.client_sequence DESC NULLS LAST, i.id DESC)
              FILTER (WHERE i.id IS NOT NULL))[1] AS last_operation,
            (ARRAY_AGG(i.customer_ref ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id)
              FILTER (WHERE i.customer_ref IS NOT NULL))[1] AS customer_ref,
            (ARRAY_AGG(r.impact ORDER BY
              CASE r.impact
                WHEN 'blocked' THEN 5
                WHEN 'hindered' THEN 4
                WHEN 'helped_with_friction' THEN 3
                WHEN 'neutral' THEN 2
                WHEN 'unknown' THEN 1
                WHEN 'helped' THEN 0
                ELSE -1
              END DESC,
              r.created_at DESC)
              FILTER (WHERE r.impact IS NOT NULL))[1] AS strongest_impact
          FROM interactions_v2 i
          LEFT JOIN feedback_reports r ON r.interaction_id = i.id
          WHERE i.session_id = s.id AND i.occurred_at >= $2
        ) activity ON TRUE
        ORDER BY s.last_seen_at DESC",
    )
    .bind(environment_id)
    .bind(retained_since)
    .bind(session_limit)
    .fetch_all(pool)
    .await?;
    let insights = dashboard_insights(pool, environment_id, retained_since).await?;
    let (interactions_total, reports_total, sessions_total) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r"SELECT
              (SELECT COUNT(*) FROM interactions_v2
                WHERE environment_id = $1 AND occurred_at >= $2),
              (SELECT COUNT(*) FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
                WHERE i.environment_id = $1 AND i.occurred_at >= $2),
              (SELECT COUNT(*) FROM sessions_v2
                WHERE environment_id = $1 AND last_seen_at >= $2)",
        )
        .bind(environment_id)
        .bind(retained_since)
        .fetch_one(pool)
        .await?;
    let list_state = DashboardListState {
        interactions_total,
        reports_total,
        sessions_total,
        interactions_loaded: interactions.len(),
        reports_loaded: reports.len(),
        sessions_loaded: sessions.len(),
    };
    let team_members = sqlx::query_as::<_, TeamMember>(
        r"SELECT workspace_id, os_user_id, handle, email, display_name, role,
        joined_at, updated_at FROM workspace_members
        WHERE workspace_id = $1
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        LOWER(display_name), joined_at",
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let team_invitations = if context.role == "owner" || context.role == "admin" {
        sqlx::query_as::<_, TeamInvitation>(
            r"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
            role, created_at, expires_at FROM workspace_invitations
            WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              AND expires_at > NOW() AND invitee_kind <> 'link'
            ORDER BY created_at DESC",
        )
        .bind(context.workspace.id)
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };
    Ok(DashboardData {
        user: context.user,
        workspace: context.workspace,
        workspace_memberships: context.workspace_memberships,
        current_role: context.role,
        team_members,
        team_invitations,
        products,
        environments,
        current_product,
        current_environment,
        activation_milestones,
        api_keys,
        interactions,
        reports,
        sessions,
        insights,
        list_state,
    })
}

pub(crate) async fn dashboard_report_by_id(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    report_id: Uuid,
) -> Result<ProductFeedbackReportWithInteraction, ApiError> {
    sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        COALESCE((
          SELECT jsonb_agg(
            CASE WHEN stored_hint.value ? 'verified' THEN stored_hint.value
              ELSE stored_hint.value || jsonb_build_object('verified', FALSE) END
            ORDER BY stored_hint.ordinality)
          FROM jsonb_array_elements(code_hints.hints)
            WITH ORDINALITY AS stored_hint(value, ordinality)
        ), '[]'::JSONB) AS code_hints,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r
        JOIN interactions_v2 i ON i.id = r.interaction_id
        JOIN product_environments e ON e.id = i.environment_id
        LEFT JOIN report_code_hints code_hints ON code_hints.report_id = r.id
        LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
        WHERE r.id = $1 AND i.workspace_id = $2 AND e.product_id = $3
          AND i.occurred_at >= NOW() - make_interval(days => e.retention_days)",
    )
    .bind(report_id)
    .bind(workspace_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Feedback report not found"))
}

pub(crate) async fn update_feedback_workflow(
    pool: &PgPool,
    context: &DashboardContext,
    report_id: Uuid,
    input: UpdateFeedbackWorkflowInput,
) -> Result<(), ApiError> {
    if !["new", "investigating", "planned", "resolved", "wont_act"].contains(&input.status.as_str())
    {
        return Err(ApiError::bad_request("Invalid feedback status"));
    }
    if input.tags.len() > 8 {
        return Err(ApiError::bad_request("Feedback can have at most 8 tags"));
    }
    let mut tags = input
        .tags
        .into_iter()
        .map(|tag| {
            clean(&tag, 32)
                .to_ascii_lowercase()
                .replace(|character: char| !character.is_ascii_alphanumeric(), "-")
                .trim_matches('-')
                .to_string()
        })
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    let internal_note = input
        .internal_note
        .map(|note| clean(&note, 1_000))
        .filter(|note| !note.is_empty());
    if internal_note
        .as_deref()
        .is_some_and(contains_sensitive_report_text)
    {
        return Err(ApiError::bad_request(
            "Internal notes must not contain personal data or secrets",
        ));
    }
    if let Some(assignee) = input.assignee_os_user_id.as_deref() {
        let is_member: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND os_user_id = $2)",
        )
        .bind(context.workspace.id)
        .bind(assignee)
        .fetch_one(pool)
        .await?;
        if !is_member {
            return Err(ApiError::bad_request(
                "Assignee must be a current team member",
            ));
        }
    }
    let updated = sqlx::query(
        r"INSERT INTO feedback_report_workflow
        (report_id, workspace_id, status, assignee_os_user_id, tags, internal_note,
         updated_by_os_user_id, updated_at)
        SELECT r.id, r.workspace_id, $4, $5, $6, $7, $8, NOW()
        FROM feedback_reports r
        JOIN interactions_v2 i ON i.id = r.interaction_id
        JOIN product_environments e ON e.id = i.environment_id
        WHERE r.id = $1 AND r.workspace_id = $2 AND e.product_id = $3
          AND i.occurred_at >= NOW() - make_interval(days => e.retention_days)
        ON CONFLICT (report_id) DO UPDATE SET
          status = EXCLUDED.status,
          assignee_os_user_id = EXCLUDED.assignee_os_user_id,
          tags = EXCLUDED.tags,
          internal_note = EXCLUDED.internal_note,
          updated_by_os_user_id = EXCLUDED.updated_by_os_user_id,
          updated_at = NOW()",
    )
    .bind(report_id)
    .bind(context.workspace.id)
    .bind(input.product_id)
    .bind(input.status)
    .bind(input.assignee_os_user_id)
    .bind(tags)
    .bind(internal_note)
    .bind(&context.user.id)
    .execute(pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::not_found("Feedback report not found"));
    }
    Ok(())
}

pub(crate) async fn dashboard_interaction_by_id(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    interaction_id: Uuid,
) -> Result<ProductInteraction, ApiError> {
    sqlx::query_as::<_, ProductInteraction>(
        r"SELECT i.id, i.workspace_id, i.environment_id, i.api_key_id, i.session_id,
        i.surface, i.operation, i.status_code, i.duration_ms, i.customer_ref, i.customer_id,
        CASE WHEN ec.id IS NOT NULL THEN 'confirmed' ELSE i.classification END AS classification,
        COALESCE(i.confirmation_method, ec.method) AS confirmation_method,
        i.runtime_hint, i.runtime_hint_source,
        i.occurred_at, i.created_at, i.updated_at
        FROM interactions_v2 i JOIN product_environments e ON e.id = i.environment_id
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.id = $1 AND i.workspace_id = $2 AND e.product_id = $3
          AND i.occurred_at >= NOW() - make_interval(days => e.retention_days)",
    )
    .bind(interaction_id)
    .bind(workspace_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Interaction not found"))
}

pub(crate) async fn dashboard_session_by_id(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    session_id: Uuid,
) -> Result<DashboardSessionDetail, ApiError> {
    let session = sqlx::query_as::<_, ProductSession>(
        r"SELECT s.id, s.workspace_id, s.environment_id, s.source, s.ref_hint,
        s.started_at, s.last_seen_at, s.created_at
        FROM sessions_v2 s JOIN product_environments e ON e.id = s.environment_id
        WHERE s.id = $1 AND s.workspace_id = $2 AND e.product_id = $3
          AND s.last_seen_at >= NOW() - make_interval(days => e.retention_days)",
    )
    .bind(session_id)
    .bind(workspace_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Session not found"))?;
    let interactions = sqlx::query_as::<_, ProductInteraction>(
        r"SELECT i.id, i.workspace_id, i.environment_id, i.api_key_id, i.session_id, i.surface,
        i.operation, i.status_code, i.duration_ms, i.customer_ref, i.customer_id,
        CASE WHEN ec.id IS NOT NULL THEN 'confirmed' ELSE i.classification END AS classification,
        COALESCE(i.confirmation_method, ec.method) AS confirmation_method,
        i.runtime_hint, i.runtime_hint_source,
        i.occurred_at, i.created_at, i.updated_at
        FROM interactions_v2 i
        JOIN product_environments e ON e.id = i.environment_id
        LEFT JOIN enrichment_interaction_confirmations ec ON ec.interaction_id = i.id
        WHERE i.session_id = $1
          AND i.occurred_at >= NOW() - make_interval(days => e.retention_days)
        ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let reports = sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        COALESCE((
          SELECT jsonb_agg(
            CASE WHEN stored_hint.value ? 'verified' THEN stored_hint.value
              ELSE stored_hint.value || jsonb_build_object('verified', FALSE) END
            ORDER BY stored_hint.ordinality)
          FROM jsonb_array_elements(code_hints.hints)
            WITH ORDINALITY AS stored_hint(value, ordinality)
        ), '[]'::JSONB) AS code_hints,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        JOIN product_environments e ON e.id = i.environment_id
        LEFT JOIN report_code_hints code_hints ON code_hints.report_id = r.id
        LEFT JOIN feedback_report_workflow w ON w.report_id = r.id
        WHERE i.session_id = $1
          AND i.occurred_at >= NOW() - make_interval(days => e.retention_days)
        ORDER BY r.created_at",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(DashboardSessionDetail {
        session,
        interactions,
        reports,
    })
}

fn opaque_ref(value: Option<String>) -> Option<String> {
    let value = value.filter(|value| !value.trim().is_empty());
    value.filter(|value| {
        value.chars().count() <= 160
            && !value.contains('@')
            && !value.chars().any(char::is_whitespace)
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    })
}

fn session_evidence(
    session_ref: Option<String>,
    session_source: Option<String>,
) -> Result<Option<(String, String)>, ApiError> {
    let Some(session_ref) = opaque_ref(session_ref) else {
        return Ok(None);
    };
    let source = session_source.unwrap_or_else(|| "customer".into());
    if !["customer", "mcp", "continuation"].contains(&source.as_str()) {
        return Err(ApiError::bad_request("Invalid sessionSource"));
    }
    Ok(Some((session_ref, source)))
}

async fn resolve_v2_session(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    environment_id: Uuid,
    customer_scope_hash: &[u8],
    session_ref_hash: &[u8],
    session_source: &str,
    occurred_at: DateTime<Utc>,
) -> Result<Uuid, ApiError> {
    let session_id = Uuid::new_v4();
    let ref_hint = format!("session-{}", &session_id.simple().to_string()[..8]);
    let scoped_ref_hash = scoped_session_ref_hash(customer_scope_hash, session_ref_hash);
    let resolved = sqlx::query_scalar::<_, Uuid>(
        r"INSERT INTO sessions_v2
        (id, workspace_id, environment_id, customer_scope_hash, source, ref_hash,
         raw_ref_hash, ref_hint, started_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        ON CONFLICT (environment_id, source, ref_hash) DO UPDATE
        SET started_at = LEAST(sessions_v2.started_at, EXCLUDED.started_at),
            last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id",
    )
    .bind(session_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(customer_scope_hash)
    .bind(session_source)
    .bind(scoped_ref_hash)
    .bind(session_ref_hash)
    .bind(ref_hint)
    .bind(occurred_at)
    .fetch_one(&mut **tx)
    .await?;
    Ok(resolved)
}

fn scoped_session_ref_hash(customer_scope_hash: &[u8], session_ref_hash: &[u8]) -> Vec<u8> {
    // Including scope in the existing unique key preserves the legacy
    // three-column ON CONFLICT contract during a rolling deployment.
    let mut material = Vec::with_capacity(customer_scope_hash.len() + session_ref_hash.len());
    material.extend_from_slice(customer_scope_hash);
    material.extend_from_slice(session_ref_hash);
    sha256_bytes(&material)
}

fn customer_scope_hash(customer_ref: Option<&str>, customer_id: Option<Uuid>) -> Vec<u8> {
    customer_id.map_or_else(
        || {
            customer_ref.map_or_else(
                || sha256("scope:anonymous"),
                |customer_ref| sha256(&format!("scope:customer:{customer_ref}")),
            )
        },
        // Once Epode has a resolved customer, verified and first-party-
        // anonymous evidence must converge on one canonical session scope.
        |customer_id| sha256(&format!("scope:resolved-customer:{customer_id}")),
    )
}

fn validate_identity_ref(value: Option<&str>, field: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty()
        || value.len() > 160
        || value.trim() != value
        || value.contains('@')
        || value.chars().any(char::is_whitespace)
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    {
        return Err(ApiError::bad_request(format!(
            "{field} must be a bounded opaque identifier, never a name or email"
        )));
    }
    Ok(Some(value.to_owned()))
}

#[derive(Debug)]
#[allow(
    clippy::struct_field_names,
    reason = "wire-compatible identity fields intentionally retain the Ref suffix"
)]
struct ValidatedIdentityRefs {
    customer_ref: Option<String>,
    account_ref: Option<String>,
    user_ref: Option<String>,
    anonymous_ref: Option<String>,
}

fn validated_identity_refs(
    customer_ref: Option<&str>,
    account_ref: Option<&str>,
    user_ref: Option<&str>,
    anonymous_ref: Option<&str>,
) -> Result<ValidatedIdentityRefs, ApiError> {
    let refs = ValidatedIdentityRefs {
        customer_ref: validate_identity_ref(customer_ref, "customerRef")?,
        account_ref: validate_identity_ref(account_ref, "accountRef")?,
        user_ref: validate_identity_ref(user_ref, "userRef")?,
        anonymous_ref: validate_identity_ref(anonymous_ref, "anonymousRef")?,
    };
    if let Some(customer_ref) = refs.customer_ref.as_deref()
        && (refs.account_ref.as_deref() != Some(customer_ref) || refs.account_ref.is_none())
        && (refs.account_ref.is_some() || refs.user_ref.is_some())
    {
        return Err(ApiError::bad_request(
            "customerRef may accompany richer identity only when it exactly matches accountRef",
        ));
    }
    Ok(refs)
}

fn validate_identity_refs(
    input: &InteractionTelemetryInput,
) -> Result<ValidatedIdentityRefs, ApiError> {
    validated_identity_refs(
        input.customer_ref.as_deref(),
        input.account_ref.as_deref(),
        input.user_ref.as_deref(),
        input.anonymous_ref.as_deref(),
    )
}

fn customer_identifier_hash(
    identity_hmac_secret: &[u8],
    workspace_id: Uuid,
    product_id: Uuid,
    kind: &str,
    value: &str,
) -> Result<Vec<u8>, ApiError> {
    if identity_hmac_secret.len() < 32 {
        return Err(ApiError::internal(
            "EPODE_IDENTITY_HMAC_SECRET must contain at least 32 bytes",
        ));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(identity_hmac_secret)
        .map_err(|_| ApiError::internal("Invalid identity HMAC secret"))?;
    mac.update(b"customer-identifier-v1\0");
    mac.update(workspace_id.as_bytes());
    mac.update(b"\0");
    mac.update(product_id.as_bytes());
    mac.update(b"\0");
    mac.update(kind.as_bytes());
    mac.update(b"\0");
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn customer_identifier_hint(kind: &str, ref_hash: &[u8]) -> String {
    let encoded = URL_SAFE_NO_PAD.encode(ref_hash);
    format!("{}-{}", kind.trim_end_matches("_ref"), &encoded[..8])
}

#[derive(Debug, sqlx::FromRow)]
struct ResolvedCustomerRow {
    id: Uuid,
    kind: String,
    identity_level: String,
    parent_customer_id: Option<Uuid>,
    merged_into_customer_id: Option<Uuid>,
}

async fn existing_customer_for_identifier(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    product_id: Uuid,
    kind: &str,
    ref_hash: &[u8],
) -> Result<Option<ResolvedCustomerRow>, ApiError> {
    sqlx::query_as::<_, ResolvedCustomerRow>(
        r"SELECT customer.id, customer.kind, customer.identity_level,
          customer.parent_customer_id, customer.merged_into_customer_id
        FROM customer_identifiers identifier
        JOIN customers customer
          ON customer.id = identifier.customer_id
          AND customer.workspace_id = identifier.workspace_id
        WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
          AND identifier.kind = $3 AND identifier.ref_hash = $4
        FOR UPDATE OF customer",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(kind)
    .bind(ref_hash)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn upsert_customer_identifier(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    kind: &str,
    value: &str,
    parent_customer_id: Option<Uuid>,
    occurred_at: DateTime<Utc>,
) -> Result<Uuid, ApiError> {
    let workspace_id = auth.workspace.id;
    let product_id = auth.environment.product_id;
    let ref_hash =
        customer_identifier_hash(identity_hmac_secret, workspace_id, product_id, kind, value)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended(encode($1::BYTEA, 'hex'), 0))")
        .bind(&ref_hash)
        .execute(&mut **tx)
        .await?;
    if let Some(existing) =
        existing_customer_for_identifier(tx, workspace_id, product_id, kind, &ref_hash).await?
    {
        let customer_id = existing.merged_into_customer_id.unwrap_or(existing.id);
        if kind == "user_ref"
            && existing.parent_customer_id.is_some()
            && existing.parent_customer_id != parent_customer_id
        {
            return Err(ApiError::conflict(
                "userRef is already linked to a different accountRef",
            ));
        }
        sqlx::query(
            r"UPDATE customers SET
              parent_customer_id = COALESCE(parent_customer_id, $3),
              first_seen_at = LEAST(first_seen_at, $4),
              last_seen_at = GREATEST(last_seen_at, $4), updated_at = NOW()
            WHERE id = $1 AND workspace_id = $2",
        )
        .bind(customer_id)
        .bind(workspace_id)
        .bind(parent_customer_id)
        .bind(occurred_at)
        .execute(&mut **tx)
        .await?;
        return Ok(customer_id);
    }

    let (customer_kind, identity_level, confidence, provenance, verified_at) = match kind {
        "account_ref" => (
            "account",
            "verified",
            1.0,
            "company_authenticated",
            Some(occurred_at),
        ),
        "user_ref" => (
            "user",
            "verified",
            1.0,
            "company_authenticated",
            Some(occurred_at),
        ),
        "workspace_ref" => (
            "workspace",
            "verified",
            1.0,
            "company_authenticated",
            Some(occurred_at),
        ),
        "customer_ref" => (
            "generic",
            "verified",
            1.0,
            "company_authenticated",
            Some(occurred_at),
        ),
        "anonymous_ref" => (
            "anonymous",
            "pseudonymous",
            1.0,
            "first_party_anonymous",
            None,
        ),
        _ => return Err(ApiError::internal("Invalid customer identifier kind")),
    };
    let customer_id = Uuid::new_v4();
    sqlx::query(
        r"INSERT INTO customers
        (id, workspace_id, kind, identity_level, identity_confidence,
         parent_customer_id, first_seen_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)",
    )
    .bind(customer_id)
    .bind(workspace_id)
    .bind(customer_kind)
    .bind(identity_level)
    .bind(confidence)
    .bind(parent_customer_id)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r"INSERT INTO customer_identifiers
        (id, workspace_id, product_id, customer_id, kind, ref_hash,
         display_hint, identity_level, provenance, verified_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product_id)
    .bind(customer_id)
    .bind(kind)
    .bind(&ref_hash)
    .bind(customer_identifier_hint(kind, &ref_hash))
    .bind(identity_level)
    .bind(provenance)
    .bind(verified_at)
    .execute(&mut **tx)
    .await?;
    Ok(customer_id)
}

async fn merge_anonymous_customer(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    anonymous_customer_id: Uuid,
    known_customer_id: Uuid,
) -> Result<(), ApiError> {
    if anonymous_customer_id == known_customer_id {
        return Ok(());
    }
    let anonymous = sqlx::query_as::<_, ResolvedCustomerRow>(
        r"SELECT id, kind, identity_level, parent_customer_id, merged_into_customer_id
        FROM customers WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(anonymous_customer_id)
    .bind(auth.workspace.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::conflict("anonymousRef belongs to another workspace"))?;
    if anonymous.kind != "anonymous" || anonymous.identity_level != "pseudonymous" {
        return Err(ApiError::conflict(
            "anonymousRef is not a pseudonymous customer",
        ));
    }
    if let Some(merged_into) = anonymous.merged_into_customer_id {
        return if merged_into == known_customer_id {
            Ok(())
        } else {
            Err(ApiError::conflict(
                "anonymousRef is already linked to a different customer",
            ))
        };
    }
    let known_level = sqlx::query_scalar::<_, String>(
        "SELECT identity_level FROM customers WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(known_customer_id)
    .bind(auth.workspace.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::conflict("verified customer belongs to another workspace"))?;
    if known_level != "verified" {
        return Err(ApiError::conflict(
            "anonymousRef can only resolve to a verified customer",
        ));
    }

    sqlx::query(
        r"UPDATE customer_identifiers SET customer_id = $2, updated_at = NOW()
        WHERE workspace_id = $1 AND product_id = $3 AND customer_id = $4",
    )
    .bind(auth.workspace.id)
    .bind(known_customer_id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r"UPDATE interactions_v2 SET customer_id = $2, updated_at = NOW()
        WHERE workspace_id = $1 AND environment_id IN (
          SELECT id FROM product_environments
          WHERE workspace_id = $1 AND product_id = $3
        ) AND customer_id = $4",
    )
    .bind(auth.workspace.id)
    .bind(known_customer_id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r"UPDATE customer_signals SET customer_id = $2
        WHERE workspace_id = $1 AND product_id = $3 AND customer_id = $4",
    )
    .bind(auth.workspace.id)
    .bind(known_customer_id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r"UPDATE enrichment_signal_items SET customer_id = $2
        WHERE workspace_id = $1 AND product_id = $3 AND customer_id = $4",
    )
    .bind(auth.workspace.id)
    .bind(known_customer_id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .execute(&mut **tx)
    .await?;
    let anonymous_scope = customer_scope_hash(None, Some(anonymous_customer_id));
    let known_scope = customer_scope_hash(None, Some(known_customer_id));
    rekey_customer_sessions(tx, auth, &anonymous_scope, &known_scope).await?;
    sqlx::query(
        r"UPDATE consent_grants SET customer_id = $2
        WHERE workspace_id = $1 AND product_id = $3 AND customer_id = $4",
    )
    .bind(auth.workspace.id)
    .bind(known_customer_id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .execute(&mut **tx)
    .await?;
    for table in [
        "enrichment_requests",
        "enrichment_answers",
        "customer_context_retrievals",
        "personalization_decisions",
    ] {
        let statement = format!(
            "UPDATE {table} SET customer_id = $2 WHERE workspace_id = $1 AND product_id = $3 AND customer_id = $4"
        );
        sqlx::query(&statement)
            .bind(auth.workspace.id)
            .bind(known_customer_id)
            .bind(auth.environment.product_id)
            .bind(anonymous_customer_id)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        r"UPDATE customers SET merged_into_customer_id = $2, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $3",
    )
    .bind(anonymous_customer_id)
    .bind(known_customer_id)
    .bind(auth.workspace.id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r"INSERT INTO customer_resolution_events
        (id, workspace_id, product_id, from_customer_id, to_customer_id,
         method, provenance, confidence, api_key_id)
        VALUES ($1, $2, $3, $4, $5, 'company_deterministic',
          'company_authenticated', 1, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(anonymous_customer_id)
    .bind(known_customer_id)
    .bind(auth.api_key_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn rekey_customer_sessions(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    source_scope: &[u8],
    target_scope: &[u8],
) -> Result<(), ApiError> {
    let sessions =
        sqlx::query_as::<_, (Uuid, Uuid, String, Vec<u8>, DateTime<Utc>, DateTime<Utc>)>(
            r"SELECT session.id, session.environment_id, session.source,
          COALESCE(session.raw_ref_hash, session.ref_hash),
          session.started_at, session.last_seen_at
        FROM sessions_v2 session
        WHERE session.workspace_id = $1
          AND session.customer_scope_hash = $2
          AND session.environment_id IN (
            SELECT id FROM product_environments
            WHERE workspace_id = $1 AND product_id = $3
          )
        ORDER BY session.environment_id, session.source, session.ref_hash, session.id
        FOR UPDATE",
        )
        .bind(auth.workspace.id)
        .bind(source_scope)
        .bind(auth.environment.product_id)
        .fetch_all(&mut **tx)
        .await?;

    for (old_session_id, environment_id, source, raw_ref_hash, started_at, last_seen_at) in sessions
    {
        let target_session_id = resolve_v2_session(
            tx,
            auth.workspace.id,
            environment_id,
            target_scope,
            &raw_ref_hash,
            &source,
            started_at,
        )
        .await?;
        sqlx::query(
            r"UPDATE interactions_v2 SET session_id = $2, updated_at = NOW()
            WHERE session_id = $1 AND workspace_id = $3",
        )
        .bind(old_session_id)
        .bind(target_session_id)
        .bind(auth.workspace.id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r"UPDATE customer_signals SET session_id = $2
            WHERE session_id = $1 AND workspace_id = $3 AND product_id = $4",
        )
        .bind(old_session_id)
        .bind(target_session_id)
        .bind(auth.workspace.id)
        .bind(auth.environment.product_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r"UPDATE sessions_v2 SET
              started_at = LEAST(started_at, $2),
              last_seen_at = GREATEST(last_seen_at, $3)
            WHERE id = $1 AND workspace_id = $4",
        )
        .bind(target_session_id)
        .bind(started_at)
        .bind(last_seen_at)
        .bind(auth.workspace.id)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM sessions_v2 WHERE id = $1 AND workspace_id = $2")
            .bind(old_session_id)
            .bind(auth.workspace.id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn resolve_telemetry_customer(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    refs: &ValidatedIdentityRefs,
    occurred_at: DateTime<Utc>,
) -> Result<Option<Uuid>, ApiError> {
    let account_customer_id = if let Some(account_ref) = refs.account_ref.as_deref() {
        Some(
            upsert_customer_identifier(
                tx,
                auth,
                identity_hmac_secret,
                "account_ref",
                account_ref,
                None,
                occurred_at,
            )
            .await?,
        )
    } else {
        None
    };
    let known_customer_id = if let Some(user_ref) = refs.user_ref.as_deref() {
        Some(
            upsert_customer_identifier(
                tx,
                auth,
                identity_hmac_secret,
                "user_ref",
                user_ref,
                account_customer_id,
                occurred_at,
            )
            .await?,
        )
    } else if let Some(account_customer_id) = account_customer_id {
        Some(account_customer_id)
    } else if let Some(customer_ref) = refs.customer_ref.as_deref() {
        Some(
            upsert_customer_identifier(
                tx,
                auth,
                identity_hmac_secret,
                "customer_ref",
                customer_ref,
                None,
                occurred_at,
            )
            .await?,
        )
    } else {
        None
    };
    let anonymous_customer_id = if let Some(anonymous_ref) = refs.anonymous_ref.as_deref() {
        Some(
            upsert_customer_identifier(
                tx,
                auth,
                identity_hmac_secret,
                "anonymous_ref",
                anonymous_ref,
                None,
                occurred_at,
            )
            .await?,
        )
    } else {
        None
    };
    if let (Some(anonymous_customer_id), Some(known_customer_id)) =
        (anonymous_customer_id, known_customer_id)
    {
        merge_anonymous_customer(tx, auth, anonymous_customer_id, known_customer_id).await?;
        Ok(Some(known_customer_id))
    } else {
        Ok(known_customer_id.or(anonymous_customer_id))
    }
}

fn validate_telemetry(input: &InteractionTelemetryInput) -> Result<(), ApiError> {
    validate_identity_refs(input)?;
    if !["http_json", "http_html", "http_headers", "mcp"].contains(&input.surface.as_str()) {
        return Err(ApiError::bad_request("Invalid interaction surface"));
    }
    if input.operation.trim().is_empty()
        || input.operation.chars().count() > 160
        || input.operation.contains('@')
        || input.operation.contains('?')
        || input.operation.contains('#')
        || input.operation.chars().any(char::is_whitespace)
        || !input
            .operation
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/_:.-*{}".contains(character))
    {
        return Err(ApiError::bad_request(
            "operation must be a normalized route or tool name, never a raw URL or customer value",
        ));
    }
    if input
        .status_code
        .is_some_and(|value| !(100..=599).contains(&value))
        || input
            .duration_ms
            .is_some_and(|value| !(0..=86_400_000).contains(&value))
    {
        return Err(ApiError::bad_request("Invalid response status or duration"));
    }
    if input
        .sequence
        .is_some_and(|value| !(1..=9_007_199_254_740_991).contains(&value))
    {
        return Err(ApiError::bad_request("Invalid client interaction sequence"));
    }
    match (
        input.runtime_hint.as_deref(),
        input.runtime_hint_source.as_deref(),
    ) {
        (None, None) => {}
        (Some(hint), Some(source)) => {
            let expected_source = if input.surface == "mcp" {
                "mcp"
            } else {
                "http"
            };
            if source != expected_source {
                return Err(ApiError::bad_request(
                    "runtimeHintSource must match the interaction surface",
                ));
            }
            if hint.trim().is_empty()
                || hint.chars().count() > 200
                || hint.contains('@')
                || hint.chars().any(char::is_control)
                || contains_sensitive_report_text(hint)
            {
                return Err(ApiError::bad_request(
                    "runtimeHint must be a bounded, non-sensitive runtime label",
                ));
            }
        }
        _ => {
            return Err(ApiError::bad_request(
                "runtimeHint and runtimeHintSource must be provided together",
            ));
        }
    }
    let classification = input.classification.as_deref().unwrap_or("unclassified");
    if !["unclassified", "confirmed"].contains(&classification) {
        return Err(ApiError::bad_request("Invalid classification"));
    }
    if input.surface == "mcp" {
        if classification != "confirmed" || input.confirmation_method.as_deref() != Some("mcp") {
            return Err(ApiError::bad_request(
                "MCP interactions must be confirmed with confirmationMethod mcp",
            ));
        }
    } else if classification != "unclassified" || input.confirmation_method.is_some() {
        return Err(ApiError::bad_request(
            "HTTP telemetry is an unclassified opportunity until a feedback report is submitted",
        ));
    }
    Ok(())
}

pub(crate) async fn ingest_telemetry_batch(
    pool: &PgPool,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    input: TelemetryBatchInput,
) -> Result<TelemetryBatchResult, ApiError> {
    let event_count = input.events.len();
    if event_count == 0 || event_count > 100 {
        return Err(ApiError::bad_request(
            "events must contain between 1 and 100 interactions",
        ));
    }
    let mut accepted = 0;
    let mut dropped = 0;
    let mut accepted_confirmed_interaction = false;
    let mut accepted_interaction_ids = Vec::with_capacity(event_count);
    let mut changed_interaction_ids = Vec::with_capacity(event_count);
    let mut session_evidence_by_interaction = BTreeMap::new();
    let mut events = input.events;
    events.sort_by_key(|event| event.interaction_id);
    let mut tx = pool.begin().await?;
    for event in events {
        let mut event_tx = tx.begin().await?;
        match ingest_telemetry_event(&mut event_tx, auth, identity_hmac_secret, event).await {
            Ok(result) => {
                event_tx.commit().await?;
                if result.grouping_facts_changed {
                    changed_interaction_ids.push(result.interaction_id);
                }
                accepted_interaction_ids.push(result.interaction_id);
                let evidence = session_evidence_by_interaction
                    .entry(result.interaction_id)
                    .or_insert(None);
                if evidence.is_none() {
                    *evidence = result.session_evidence;
                }
                accepted_confirmed_interaction |= result.confirmed;
                accepted += 1;
            }
            Err(error) if error.status.is_client_error() => {
                event_tx.rollback().await?;
                // A dropped identity/session event must be fully atomic even
                // when the rest of its bounded batch remains acceptable.
                dropped += 1;
            }
            Err(error) => {
                event_tx.rollback().await?;
                return Err(error);
            }
        }
    }
    correlate_telemetry_sessions(&mut tx, auth, session_evidence_by_interaction).await?;
    reconcile_signal_links_for_interactions(&mut tx, auth, &accepted_interaction_ids).await?;
    regroup_changed_interaction_reports(&mut tx, &changed_interaction_ids).await?;
    if accepted > 0 {
        record_product_activation(
            &mut tx,
            auth.workspace.id,
            auth.environment.product_id,
            true,
            accepted_confirmed_interaction,
            false,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(TelemetryBatchResult { accepted, dropped })
}

async fn reconcile_signal_links_for_interactions(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    interaction_ids: &[Uuid],
) -> Result<(), ApiError> {
    if interaction_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r"UPDATE customer_signals signal SET
          customer_id = COALESCE(signal.customer_id, interaction.customer_id),
          session_id = COALESCE(signal.session_id, interaction.session_id)
        FROM interactions_v2 interaction
        WHERE signal.workspace_id = $1 AND signal.product_id = $2
          AND signal.interaction_id = interaction.id
          AND interaction.workspace_id = signal.workspace_id
          AND interaction.environment_id = $3
          AND interaction.id = ANY($4)
          AND ((signal.customer_id IS NULL AND interaction.customer_id IS NOT NULL)
            OR (signal.session_id IS NULL AND interaction.session_id IS NOT NULL))",
    )
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .bind(interaction_ids)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct TelemetryUpsertResult {
    id: Uuid,
    grouping_facts_changed: bool,
}

#[derive(Debug)]
struct AcceptedTelemetryEvent {
    interaction_id: Uuid,
    confirmed: bool,
    grouping_facts_changed: bool,
    session_evidence: Option<(String, String)>,
}

async fn ingest_telemetry_event(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    event: InteractionTelemetryInput,
) -> Result<AcceptedTelemetryEvent, ApiError> {
    validate_telemetry(&event)?;
    let occurred_at = event.occurred_at.unwrap_or_else(Utc::now);
    if occurred_at > Utc::now() + Duration::minutes(5)
        || occurred_at < Utc::now() - Duration::days(7)
    {
        return Err(ApiError::bad_request(
            "occurredAt is outside the accepted window",
        ));
    }
    let identity_refs = validate_identity_refs(&event)?;
    let session_evidence = session_evidence(event.session_ref, event.session_source)?;
    let customer_id =
        resolve_telemetry_customer(tx, auth, identity_hmac_secret, &identity_refs, occurred_at)
            .await?;
    let customer_ref = identity_refs.customer_ref;
    let confirmed = event.surface == "mcp";
    let classification = if confirmed {
        "confirmed".to_string()
    } else {
        "unclassified".to_string()
    };
    let confirmation_method = confirmed.then(|| "mcp".to_string());
    // The INSERT depends on the materialized `previous` CTE so PostgreSQL must
    // lock and capture the pre-state before the upsert returns its post-state.
    let row = sqlx::query_as::<_, TelemetryUpsertResult>(
        r"WITH previous AS MATERIALIZED (
          SELECT id, surface, operation, status_code
          FROM interactions_v2
          WHERE id = $1
          FOR UPDATE
        ),
        upserted AS (
          INSERT INTO interactions_v2
        (id, workspace_id, environment_id, api_key_id, session_id, surface, operation, status_code,
         duration_ms, customer_ref, customer_id, classification, confirmation_method, runtime_hint,
         runtime_hint_source, client_sequence, occurred_at)
        SELECT COALESCE(p.id, input.id), $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17
        FROM (VALUES ($1::uuid)) AS input(id)
        LEFT JOIN previous p ON p.id = input.id
        ON CONFLICT (id) DO UPDATE SET
          api_key_id = COALESCE(interactions_v2.api_key_id, EXCLUDED.api_key_id),
          session_id = COALESCE(interactions_v2.session_id, EXCLUDED.session_id),
          surface = CASE WHEN interactions_v2.surface = 'unknown' THEN EXCLUDED.surface ELSE interactions_v2.surface END,
          operation = CASE WHEN interactions_v2.operation = 'pending' THEN EXCLUDED.operation ELSE interactions_v2.operation END,
          status_code = COALESCE(interactions_v2.status_code, EXCLUDED.status_code),
          duration_ms = COALESCE(interactions_v2.duration_ms, EXCLUDED.duration_ms),
          customer_ref = COALESCE(interactions_v2.customer_ref, EXCLUDED.customer_ref),
          customer_id = COALESCE(interactions_v2.customer_id, EXCLUDED.customer_id),
          classification = CASE WHEN interactions_v2.classification = 'confirmed' THEN 'confirmed' ELSE EXCLUDED.classification END,
          confirmation_method = CASE WHEN EXCLUDED.confirmation_method = 'mcp' THEN 'mcp'
            ELSE COALESCE(interactions_v2.confirmation_method, EXCLUDED.confirmation_method) END,
          runtime_hint = COALESCE(interactions_v2.runtime_hint, EXCLUDED.runtime_hint),
          runtime_hint_source = COALESCE(interactions_v2.runtime_hint_source, EXCLUDED.runtime_hint_source),
          client_sequence = COALESCE(interactions_v2.client_sequence, EXCLUDED.client_sequence),
          occurred_at = CASE
            WHEN interactions_v2.surface = 'unknown' AND interactions_v2.operation = 'pending'
              THEN EXCLUDED.occurred_at
            ELSE LEAST(interactions_v2.occurred_at, EXCLUDED.occurred_at)
          END,
          updated_at = NOW()
        WHERE interactions_v2.environment_id = EXCLUDED.environment_id
          AND (interactions_v2.customer_id IS NULL OR EXCLUDED.customer_id IS NULL
            OR interactions_v2.customer_id = EXCLUDED.customer_id)
          AND (interactions_v2.customer_ref IS NULL OR EXCLUDED.customer_ref IS NULL
            OR interactions_v2.customer_ref = EXCLUDED.customer_ref)
          RETURNING id, surface, operation, status_code
        )
        SELECT u.id,
          p.id IS NOT NULL AND (
            p.surface IS DISTINCT FROM u.surface
            OR p.operation IS DISTINCT FROM u.operation
            OR p.status_code IS DISTINCT FROM u.status_code
          ) AS grouping_facts_changed
        FROM upserted u
        LEFT JOIN previous p ON TRUE",
    )
    .bind(event.interaction_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.id)
    .bind(auth.api_key_id)
    .bind(Option::<Uuid>::None)
    .bind(event.surface)
    .bind(clean(&event.operation, 160))
    .bind(event.status_code)
    .bind(event.duration_ms)
    .bind(customer_ref)
    .bind(customer_id)
    .bind(classification)
    .bind(confirmation_method)
    .bind(event.runtime_hint.map(|value| clean(&value, 200)))
    .bind(event.runtime_hint_source)
    .bind(event.sequence)
    .bind(occurred_at)
    .fetch_optional(&mut **tx)
    .await?;
    let row =
        row.ok_or_else(|| ApiError::conflict("interactionId belongs to another workspace"))?;
    Ok(AcceptedTelemetryEvent {
        interaction_id: row.id,
        confirmed,
        grouping_facts_changed: row.grouping_facts_changed,
        session_evidence,
    })
}

#[derive(Debug, sqlx::FromRow)]
struct InteractionSessionState {
    interaction_id: Uuid,
    occurred_at: DateTime<Utc>,
    customer_ref: Option<String>,
    customer_id: Option<Uuid>,
    session_id: Option<Uuid>,
    session_source: Option<String>,
    session_ref_hash: Option<Vec<u8>>,
    session_customer_scope_hash: Option<Vec<u8>>,
}

#[derive(Debug)]
struct SessionCorrelationAction {
    interaction_id: Uuid,
    occurred_at: DateTime<Utc>,
    session_id: Option<Uuid>,
    session_source: String,
    session_ref_hash: Vec<u8>,
    customer_scope_hash: Vec<u8>,
    sort_source: String,
    sort_customer_scope_hash: Vec<u8>,
    sort_ref_hash: Vec<u8>,
}

async fn correlate_telemetry_sessions(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    mut evidence_by_interaction: BTreeMap<Uuid, Option<(String, String)>>,
) -> Result<(), ApiError> {
    let interaction_ids = evidence_by_interaction.keys().copied().collect::<Vec<_>>();
    let states = sqlx::query_as::<_, InteractionSessionState>(
        r"SELECT i.id AS interaction_id, i.occurred_at, i.customer_ref, i.customer_id, i.session_id,
          s.source AS session_source, COALESCE(s.raw_ref_hash, s.ref_hash) AS session_ref_hash,
          s.customer_scope_hash AS session_customer_scope_hash
        FROM interactions_v2 i
        LEFT JOIN sessions_v2 s ON s.id = i.session_id
        WHERE i.id = ANY($1)",
    )
    .bind(&interaction_ids)
    .fetch_all(&mut **tx)
    .await?;
    if states.len() != interaction_ids.len() {
        return Err(ApiError::internal(
            "accepted telemetry interaction disappeared before session correlation",
        ));
    }

    let mut actions = Vec::with_capacity(states.len());
    for state in states {
        let evidence = evidence_by_interaction
            .remove(&state.interaction_id)
            .flatten();
        let desired_customer_scope_hash =
            customer_scope_hash(state.customer_ref.as_deref(), state.customer_id);
        let (session_source, session_ref_hash) = if state.session_id.is_some() {
            let source = state.session_source.clone().ok_or_else(|| {
                ApiError::internal("linked telemetry interaction has no session source")
            })?;
            let ref_hash = state.session_ref_hash.clone().ok_or_else(|| {
                ApiError::internal("linked telemetry interaction has no session ref hash")
            })?;
            (source, ref_hash)
        } else if let Some((session_ref, session_source)) = evidence.as_ref() {
            (session_source.clone(), sha256(session_ref))
        } else {
            continue;
        };
        let session_id = state.session_id.filter(|_| {
            state.session_customer_scope_hash.as_deref()
                == Some(desired_customer_scope_hash.as_slice())
        });
        actions.push(SessionCorrelationAction {
            interaction_id: state.interaction_id,
            occurred_at: state.occurred_at,
            session_id,
            session_source: session_source.clone(),
            session_ref_hash: session_ref_hash.clone(),
            customer_scope_hash: desired_customer_scope_hash,
            sort_source: session_source,
            sort_customer_scope_hash: customer_scope_hash(
                state.customer_ref.as_deref(),
                state.customer_id,
            ),
            sort_ref_hash: session_ref_hash,
        });
    }
    actions.sort_by(|left, right| {
        (
            &left.sort_source,
            &left.sort_customer_scope_hash,
            &left.sort_ref_hash,
            left.interaction_id,
        )
            .cmp(&(
                &right.sort_source,
                &right.sort_customer_scope_hash,
                &right.sort_ref_hash,
                right.interaction_id,
            ))
    });

    for action in actions {
        let session_id = if let Some(session_id) = action.session_id {
            session_id
        } else {
            let session_id = resolve_v2_session(
                tx,
                auth.workspace.id,
                auth.environment.id,
                &action.customer_scope_hash,
                &action.session_ref_hash,
                &action.session_source,
                action.occurred_at,
            )
            .await?;
            sqlx::query("UPDATE interactions_v2 SET session_id = $2 WHERE id = $1")
                .bind(action.interaction_id)
                .bind(session_id)
                .execute(&mut **tx)
                .await?;
            session_id
        };
        sqlx::query(
            r"UPDATE sessions_v2
            SET started_at = LEAST(started_at, $2), last_seen_at = GREATEST(last_seen_at, $2)
            WHERE id = $1",
        )
        .bind(session_id)
        .bind(action.occurred_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct ChangedInteractionReportRow {
    report_id: Uuid,
    workspace_id: Uuid,
    product_id: Uuid,
    operation: String,
    surface: String,
    status_code: Option<i32>,
    findings: serde_json::Value,
}

async fn regroup_changed_interaction_reports(
    tx: &mut Transaction<'_, Postgres>,
    changed_interaction_ids: &[Uuid],
) -> Result<(), ApiError> {
    if changed_interaction_ids.is_empty() {
        return Ok(());
    }

    let reports = sqlx::query_as::<_, ChangedInteractionReportRow>(
        r"SELECT r.id AS report_id, r.workspace_id, e.product_id,
          i.operation, i.surface, i.status_code, r.findings
        FROM interactions_v2 i
        JOIN feedback_reports r
          ON r.interaction_id = i.id AND r.workspace_id = i.workspace_id
        JOIN product_environments e
          ON e.id = i.environment_id AND e.workspace_id = i.workspace_id
        WHERE i.id = ANY($1)",
    )
    .bind(changed_interaction_ids)
    .fetch_all(&mut **tx)
    .await?;

    for report in reports {
        // Skip rather than fail: this runs inside telemetry ingest, so one
        // report whose stored findings no longer deserialize must not take down
        // an entire batch. Matches the backfill's skip-and-continue handling.
        let Ok(findings) = serde_json::from_value::<Vec<FeedbackFindingInput>>(report.findings)
        else {
            tracing::warn!(
                report_id = %report.report_id,
                "skipping report with unreadable findings during telemetry regroup"
            );
            continue;
        };
        assign_report_group(
            tx,
            &crate::grouping::FingerprintGrouper,
            report.workspace_id,
            report.report_id,
            &GroupInput {
                product_id: report.product_id,
                operation: &report.operation,
                surface: &report.surface,
                status_code: report.status_code,
                findings: &findings,
            },
        )
        .await?;
    }

    Ok(())
}

pub(crate) async fn feedback_consent_state(
    pool: &PgPool,
    auth: &ProductAuth,
    input: ConsentStateInput,
) -> Result<ConsentStateResponse, ApiError> {
    if !valid_consent_subject(&input.subject) {
        return Err(ApiError::bad_request("Invalid opaque consent subject"));
    }
    if auth.environment.feedback_mode != "ask_once" {
        return Ok(ConsentStateResponse {
            state: if auth.environment.feedback_mode == "never_ask" {
                "approved".to_owned()
            } else {
                "unknown".to_owned()
            },
            revision: 0,
        });
    }
    let state = sqlx::query_as::<_, (String, i64)>(
        "SELECT decision, revision FROM feedback_consent_subjects WHERE environment_id = $1 AND subject = $2",
    )
    .bind(auth.environment.id)
    .bind(input.subject)
    .fetch_optional(pool)
    .await?;
    let (state, revision) = state.unwrap_or_else(|| ("unknown".to_owned(), 0));
    Ok(ConsentStateResponse { state, revision })
}

pub(crate) async fn inspect_feedback_capability(
    pool: &PgPool,
    capability: &str,
) -> Result<CapabilityInspectionResponse, ApiError> {
    let parsed = parse_capability(capability)?;
    let key = sqlx::query_as::<_, (Vec<u8>, String, Uuid, String)>(
        r"SELECT k.key_hash, e.feedback_mode, e.id, p.name
        FROM api_keys k
        JOIN product_environments e ON e.id = k.environment_id
        JOIN products p ON p.id = e.product_id
        WHERE k.id = $1 AND k.kind = 'write' AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())",
    )
    .bind(parsed.key_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let claims = verify_capability(parsed, &key.0, Utc::now())?;
    let (state, consent_policy) = match key.1.as_str() {
        "off" => return Err(ApiError::gone("Feedback collection is disabled")),
        "never_ask" => ("feedback_ready".to_owned(), "none".to_owned()),
        "ask_once" => {
            if let Some(subject) = claims.s.as_deref() {
                let decision = sqlx::query_scalar::<_, String>(
                    "SELECT decision FROM feedback_consent_subjects WHERE environment_id = $1 AND subject = $2",
                )
                .bind(key.2)
                .bind(subject)
                .fetch_optional(pool)
                .await?;
                match decision.as_deref() {
                    Some("approved") => ("feedback_ready".to_owned(), "none".to_owned()),
                    Some("declined") => ("declined".to_owned(), "once".to_owned()),
                    _ => ("consent_required".to_owned(), "once".to_owned()),
                }
            } else {
                ("consent_required".to_owned(), "always".to_owned())
            }
        }
        "ask_always" => {
            let decision = sqlx::query_scalar::<_, String>(
                "SELECT decision FROM feedback_consent_interactions WHERE environment_id = $1 AND interaction_id = $2",
            )
            .bind(key.2)
            .bind(claims.i)
            .fetch_optional(pool)
            .await?;
            match decision.as_deref() {
                Some("approved") => ("feedback_ready".to_owned(), "none".to_owned()),
                Some("declined") => ("declined".to_owned(), "always".to_owned()),
                _ => ("consent_required".to_owned(), "always".to_owned()),
            }
        }
        _ => return Err(ApiError::internal("Invalid product feedback policy")),
    };
    let canonical_question = (state == "consent_required").then(|| {
        if consent_policy == "once" {
            format!(
                "May I send {}'s provider one short, privacy-safe outcome report after this use and future uses without asking again? Epode will remember your choice for this product. Your prompts and task content are never included; nothing is installed.",
                key.3
            )
        } else {
            format!(
                "May I send {}'s provider one short, privacy-safe outcome report about this use? Your prompts and task content will not be included.",
                key.3
            )
        }
    });
    let expires_at = DateTime::from_timestamp(claims.exp, 0).ok_or_else(ApiError::unauthorized)?;
    Ok(CapabilityInspectionResponse {
        state,
        configured_mode: key.1,
        consent_policy,
        product_name: key.3,
        canonical_question,
        expires_at,
    })
}

#[derive(Debug)]
pub(crate) struct ConsentDecisionOutcome {
    /// The standing decision after this call, which may be a prior decision.
    pub(crate) decision: String,
    pub(crate) configured_mode: String,
    pub(crate) expires_at: i64,
    /// When the standing decision was made.
    pub(crate) decided_at: DateTime<Utc>,
    /// True when this call recorded the standing decision, false when a prior
    /// decision already stood.
    pub(crate) changed: bool,
    /// True only when this capability may expose the follow-on report action.
    /// A stale Ask-once CAS can observe an approved current state without
    /// inheriting that approval.
    pub(crate) feedback_action_allowed: bool,
    /// True when the capability's interaction verifiably came through the MCP
    /// protocol-tool path (server-side telemetry confirmed the interaction
    /// with `surface = 'mcp'` and `confirmationMethod = 'mcp'`).
    pub(crate) protocol_tool: bool,
    /// The prior durable decision when this call flipped it (for example
    /// "declined" when a declined subject was flipped to approved through a
    /// manageConsent handle). None when nothing flipped.
    pub(crate) flipped_from: Option<String>,
}

#[allow(
    clippy::too_many_arguments,
    reason = "the consent audit write keeps every CAS fact explicit at its two call sites"
)]
async fn dual_write_share_outcome_consent(
    tx: &mut Transaction<'_, Postgres>,
    environment_id: Uuid,
    subject: &str,
    state: &str,
    revision: i64,
    decided_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    prior_state: Option<&str>,
    source: &str,
) -> Result<(), ApiError> {
    let (workspace_id, product_id) = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT workspace_id, product_id FROM product_environments WHERE id = $1",
    )
    .bind(environment_id)
    .fetch_one(&mut **tx)
    .await?;
    let grant_id = Uuid::new_v4();
    let grant_id = sqlx::query_scalar::<_, Uuid>(
        r"INSERT INTO consent_grants
        (id, workspace_id, product_id, environment_id, subject, scope, state,
         basis, revision, decided_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'share_outcome', $6,
          'user_consent', $7, $8, $9)
        ON CONFLICT (environment_id, subject, scope) DO UPDATE SET
          state = EXCLUDED.state, revision = EXCLUDED.revision,
          decided_at = EXCLUDED.decided_at, expires_at = EXCLUDED.expires_at,
          revoked_at = NULL, updated_at = NOW()
        WHERE consent_grants.revision < EXCLUDED.revision
        RETURNING id",
    )
    .bind(grant_id)
    .bind(workspace_id)
    .bind(product_id)
    .bind(environment_id)
    .bind(subject)
    .bind(state)
    .bind(revision)
    .bind(decided_at)
    .bind(expires_at)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        ApiError::internal("Consent grant revision did not advance after winning CAS")
    })?;
    sqlx::query(
        r"INSERT INTO consent_events
        (id, workspace_id, product_id, environment_id, consent_grant_id,
         subject, scope, prior_state, state, basis, revision, source, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'share_outcome', $7, $8,
          'user_consent', $9, $10, $11)",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product_id)
    .bind(environment_id)
    .bind(grant_id)
    .bind(subject)
    .bind(prior_state)
    .bind(state)
    .bind(revision)
    .bind(source)
    .bind(decided_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn record_feedback_consent_decision(
    pool: &PgPool,
    capability: &str,
    input: ConsentDecisionInput,
) -> Result<ConsentDecisionOutcome, ApiError> {
    if !["approved", "declined"].contains(&input.decision.as_str()) {
        return Err(ApiError::bad_request(
            "decision must be approved or declined",
        ));
    }
    let parsed = parse_capability(capability)?;
    let key = sqlx::query_as::<_, (Vec<u8>, String, Uuid)>(
        r"SELECT k.key_hash, e.feedback_mode, k.environment_id
        FROM api_keys k
        JOIN product_environments e ON e.id = k.environment_id
        WHERE k.id = $1 AND k.kind = 'write' AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())",
    )
    .bind(parsed.key_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let claims = verify_capability(parsed, &key.0, Utc::now())?;
    if !["ask_once", "ask_always"].contains(&key.1.as_str()) {
        return Err(ApiError::conflict(
            "This product does not currently require a consent decision",
        ));
    }
    if key.1 == "ask_once"
        && claims
            .s
            .as_deref()
            .is_some_and(|subject| !valid_consent_subject(subject))
    {
        return Err(ApiError::bad_request("Invalid opaque consent subject"));
    }

    let mut tx = pool.begin().await?;
    let inserted = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        r"INSERT INTO feedback_consent_interactions
        (interaction_id, environment_id, subject, decision)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (interaction_id) DO NOTHING
        RETURNING decision, decided_at",
    )
    .bind(claims.i)
    .bind(key.2)
    .bind(claims.s.as_deref())
    .bind(&input.decision)
    .fetch_optional(&mut *tx)
    .await?;
    let (decision, decided_at, changed, feedback_action_allowed, flipped_from) =
        if let Some((_, interaction_decided_at)) = inserted {
            if key.1 == "ask_once"
                && let Some(subject) = claims.s.as_deref()
            {
                let expected_revision = claims.r.unwrap_or_default();
                let applied = if expected_revision == 0 {
                    // Revision 0 (and legacy capabilities without `r`) means the
                    // signer observed no subject row. Such a capability may create
                    // revision 1, but ON CONFLICT deliberately cannot mutate a row
                    // that appeared before this decision arrived.
                    sqlx::query_as::<_, (String, DateTime<Utc>, i64, Option<String>)>(
                        r"INSERT INTO feedback_consent_subjects
                    (environment_id, subject, decision, decided_at, revision)
                    VALUES ($1, $2, $3, $4, 1)
                    ON CONFLICT (environment_id, subject) DO NOTHING
                    RETURNING decision, decided_at, revision, flipped_from",
                    )
                    .bind(key.2)
                    .bind(subject)
                    .bind(&input.decision)
                    .bind(interaction_decided_at)
                    .fetch_optional(&mut *tx)
                    .await?
                } else {
                    // The revision predicate is the compare-and-set. PostgreSQL's
                    // row update lock makes concurrent decisions for one revision
                    // serialize; after the winner increments it, every loser
                    // affects zero rows.
                    sqlx::query_as::<_, (String, DateTime<Utc>, i64, Option<String>)>(
                        r"UPDATE feedback_consent_subjects
                    SET decision = $3,
                      decided_at = $4,
                      flipped_from = CASE
                        WHEN decision IS DISTINCT FROM $3 THEN decision
                        ELSE NULL
                      END,
                      revision = revision + 1,
                      updated_at = NOW()
                    WHERE environment_id = $1 AND subject = $2 AND revision = $5
                    RETURNING decision, decided_at, revision, flipped_from",
                    )
                    .bind(key.2)
                    .bind(subject)
                    .bind(&input.decision)
                    .bind(interaction_decided_at)
                    .bind(expected_revision)
                    .fetch_optional(&mut *tx)
                    .await?
                };

                if let Some((decision, decided_at, revision, flipped_from)) = applied {
                    sqlx::query(
                        r"UPDATE feedback_consent_interactions
                    SET applied_subject_revision = $3
                    WHERE interaction_id = $1 AND environment_id = $2",
                    )
                    .bind(claims.i)
                    .bind(key.2)
                    .bind(revision)
                    .execute(&mut *tx)
                    .await?;
                    let feedback_action_allowed = decision == "approved";
                    (
                        decision,
                        decided_at,
                        true,
                        feedback_action_allowed,
                        flipped_from,
                    )
                } else {
                    // A failed CAS returns the current durable state, but the
                    // losing capability must not gain a report action even when
                    // that current state happens to be approved.
                    let current =
                        sqlx::query_as::<_, (String, DateTime<Utc>, i64, Option<String>)>(
                            r"SELECT decision, decided_at, revision, flipped_from
                    FROM feedback_consent_subjects
                    WHERE environment_id = $1 AND subject = $2",
                        )
                        .bind(key.2)
                        .bind(subject)
                        .fetch_optional(&mut *tx)
                        .await?;
                    if let Some((decision, decided_at, _, _)) = current {
                        (decision, decided_at, false, false, None)
                    } else {
                        (
                            "unknown".to_owned(),
                            interaction_decided_at,
                            false,
                            false,
                            None,
                        )
                    }
                }
            } else {
                let feedback_action_allowed = input.decision == "approved";
                (
                    input.decision.clone(),
                    interaction_decided_at,
                    true,
                    feedback_action_allowed,
                    None,
                )
            }
        } else {
            let (recorded_decision, interaction_decided_at, applied_subject_revision) =
                sqlx::query_as::<_, (String, DateTime<Utc>, Option<i64>)>(
                    r"SELECT decision, decided_at, applied_subject_revision
            FROM feedback_consent_interactions
            WHERE interaction_id = $1 AND environment_id = $2",
                )
                .bind(claims.i)
                .bind(key.2)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| {
                    ApiError::conflict("interactionId belongs to another product environment")
                })?;
            if key.1 == "ask_once"
                && let Some(subject) = claims.s.as_deref()
            {
                let current = sqlx::query_as::<_, (String, DateTime<Utc>, i64, Option<String>)>(
                    r"SELECT decision, decided_at, revision, flipped_from
                FROM feedback_consent_subjects
                WHERE environment_id = $1 AND subject = $2",
                )
                .bind(key.2)
                .bind(subject)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some((decision, decided_at, revision, flipped_from)) = current {
                    let still_applied = applied_subject_revision == Some(revision);
                    let feedback_action_allowed =
                        still_applied && recorded_decision == "approved" && decision == "approved";
                    (
                        decision,
                        decided_at,
                        false,
                        feedback_action_allowed,
                        still_applied.then_some(flipped_from).flatten(),
                    )
                } else {
                    (
                        "unknown".to_owned(),
                        interaction_decided_at,
                        false,
                        false,
                        None,
                    )
                }
            } else {
                let feedback_action_allowed = recorded_decision == "approved";
                (
                    recorded_decision,
                    interaction_decided_at,
                    false,
                    feedback_action_allowed,
                    None,
                )
            }
        };
    if changed
        && key.1 == "ask_once"
        && let Some(subject) = claims.s.as_deref()
    {
        let revision = sqlx::query_scalar::<_, i64>(
            r"SELECT revision FROM feedback_consent_subjects
            WHERE environment_id = $1 AND subject = $2",
        )
        .bind(key.2)
        .bind(subject)
        .fetch_one(&mut *tx)
        .await?;
        dual_write_share_outcome_consent(
            &mut tx,
            key.2,
            subject,
            &decision,
            revision,
            decided_at,
            None,
            flipped_from.as_deref(),
            "feedback_consent",
        )
        .await?;
    } else if changed && key.1 == "ask_always" {
        let interaction_subject = format!("afint1_{}", claims.i.simple());
        let expires_at = DateTime::from_timestamp(claims.exp, 0)
            .ok_or_else(|| ApiError::internal("Capability expiry is invalid"))?;
        dual_write_share_outcome_consent(
            &mut tx,
            key.2,
            &interaction_subject,
            &decision,
            1,
            decided_at,
            Some(expires_at),
            None,
            "feedback_consent",
        )
        .await?;
    }

    // The protocol-tool path is only claimed when server-side telemetry
    // confirmed this interaction as an MCP tool call. Absence of telemetry is
    // indistinguishable from a plain HTTP interaction, so this stays false for
    // MCP interactions whose telemetry has not arrived yet.
    let protocol_tool = sqlx::query_scalar::<_, bool>(
        r"SELECT EXISTS (
          SELECT 1 FROM interactions_v2
          WHERE id = $1 AND environment_id = $2
            AND surface = 'mcp' AND confirmation_method = 'mcp'
        )",
    )
    .bind(claims.i)
    .bind(key.2)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ConsentDecisionOutcome {
        decision,
        configured_mode: key.1,
        expires_at: claims.exp,
        decided_at,
        changed,
        feedback_action_allowed,
        protocol_tool,
        flipped_from,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct BackfillSummary {
    pub(crate) scanned: u64,
    pub(crate) grouped: u64,
    pub(crate) skipped: u64,
    pub(crate) skipped_findings: u64,
    /// False when a batch cap stopped the run before the table was walked out,
    /// so the caller can tell "nothing left to do" from "more remains".
    pub(crate) exhausted: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct UngroupedReportRow {
    id: Uuid,
    workspace_id: Uuid,
    findings: serde_json::Value,
    created_at: DateTime<Utc>,
    product_id: Option<Uuid>,
    operation: Option<String>,
    surface: Option<String>,
    status_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RegroupSummary {
    pub(crate) scanned: u64,
    pub(crate) moved: u64,
    pub(crate) unchanged: u64,
    pub(crate) skipped: u64,
    pub(crate) skipped_findings: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CustomerIntelligenceBackfillSummary {
    pub(crate) interactions_scanned: u64,
    pub(crate) interactions_linked: u64,
    pub(crate) reports_scanned: u64,
    pub(crate) reports_projected: u64,
    pub(crate) consent_subjects_scanned: u64,
    pub(crate) consent_grants_projected: u64,
    /// True only when every bounded source query returned fewer rows than the
    /// batch limit. Callers can safely repeat until this becomes true.
    pub(crate) exhausted: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct GroupedReportRow {
    id: Uuid,
    workspace_id: Uuid,
    findings: serde_json::Value,
    created_at: DateTime<Utc>,
    product_id: Option<Uuid>,
    operation: Option<String>,
    surface: Option<String>,
    status_code: Option<i32>,
    current_group_id: Uuid,
    current_merged_into_group_key: Option<String>,
}

pub(crate) async fn assign_report_group(
    tx: &mut Transaction<'_, Postgres>,
    grouper: &dyn ReportGrouper,
    workspace_id: Uuid,
    report_id: Uuid,
    input: &GroupInput<'_>,
) -> Result<Uuid, ApiError> {
    let assignment = grouper.assign(input);
    let (group_id, unresolved_lineage_group_key) = sqlx::query_as::<_, (Uuid, Option<String>)>(
        r"WITH assigned_group AS (
          INSERT INTO report_groups
          (id, workspace_id, product_id, group_key, grouper_name, grouper_version, explanation)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (group_key) DO UPDATE SET
            grouper_name = EXCLUDED.grouper_name,
            grouper_version = EXCLUDED.grouper_version,
            explanation = EXCLUDED.explanation,
            updated_at = NOW()
          RETURNING id, workspace_id, product_id, group_key, merged_into_group_key
        )
        SELECT COALESCE(merge_target.id, assigned_group.id),
          CASE
            WHEN assigned_group.merged_into_group_key IS NOT NULL
              AND merge_target.id IS NULL
            THEN assigned_group.group_key
          END
        FROM assigned_group
        LEFT JOIN report_groups merge_target
         ON merge_target.group_key = assigned_group.merged_into_group_key
         AND merge_target.workspace_id = assigned_group.workspace_id
         AND merge_target.product_id = assigned_group.product_id
         AND merge_target.merged_into_group_key IS NULL",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(input.product_id)
    .bind(assignment.group_key)
    .bind(grouper.name())
    .bind(grouper.version())
    .bind(assignment.explanation)
    .fetch_one(&mut **tx)
    .await?;
    if let Some(group_key) = unresolved_lineage_group_key {
        tracing::warn!(
            %group_key,
            "report group merge lineage did not resolve in one hop; using computed group"
        );
    }
    let updated = sqlx::query(
        "UPDATE feedback_reports SET group_id = $1 WHERE id = $2 AND workspace_id = $3",
    )
    .bind(group_id)
    .bind(report_id)
    .bind(workspace_id)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::internal(
            "report disappeared while assigning its group",
        ));
    }
    Ok(group_id)
}

async fn assign_report_to_lineage_target(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    product_id: Uuid,
    report_id: Uuid,
    target_group_key: &str,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        r"UPDATE feedback_reports report
        SET group_id = merge_target.id
        FROM report_groups merge_target
        WHERE report.id = $1
          AND report.workspace_id = $2
          AND merge_target.workspace_id = $2
          AND merge_target.product_id = $3
          AND merge_target.group_key = $4
          AND merge_target.merged_into_group_key IS NULL
        RETURNING report.group_id",
    )
    .bind(report_id)
    .bind(workspace_id)
    .bind(product_id)
    .bind(target_group_key)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::internal("current report group merge lineage did not resolve"))
}

/// Groups every report that has no group yet.
///
/// `max_batches` bounds the run: `None` walks the table to completion (both the
/// manual CLI path and the detached startup task), while `Some(n)` stops after
/// `n` batches and reports `exhausted = false` for callers that want a partial
/// pass. Either way the scan filters on `group_id IS NULL`, so a run always
/// resumes from wherever the last one stopped.
///
/// Between batches the task yields, so a long backfill running in the
/// background cannot monopolise the connection pool ahead of request traffic.
pub(crate) async fn backfill_report_groups(
    pool: &PgPool,
    grouper: &dyn ReportGrouper,
    max_batches: Option<u32>,
) -> Result<BackfillSummary, ApiError> {
    const BATCH_SIZE: i64 = 500;
    /// Emit a progress line periodically so a long background run is
    /// observable rather than silent until it finishes.
    const PROGRESS_LOG_EVERY_BATCHES: u32 = 10;

    let mut summary = BackfillSummary::default();
    let mut cursor_created_at = None;
    let mut cursor_id = None;
    let mut batches_run: u32 = 0;

    loop {
        if max_batches.is_some_and(|limit| batches_run >= limit) {
            summary.exhausted = false;
            return Ok(summary);
        }
        batches_run += 1;
        let mut tx = pool.begin().await?;
        let rows = sqlx::query_as::<_, UngroupedReportRow>(
            r"SELECT r.id, r.workspace_id, r.findings, r.created_at,
              p.id AS product_id, i.operation, i.surface, i.status_code
            FROM feedback_reports r
            LEFT JOIN interactions_v2 i
              ON i.id = r.interaction_id AND i.workspace_id = r.workspace_id
            LEFT JOIN product_environments e
              ON e.id = i.environment_id AND e.workspace_id = r.workspace_id
            LEFT JOIN products p
              ON p.id = e.product_id AND p.workspace_id = r.workspace_id
            WHERE r.group_id IS NULL
              AND (
                $1::timestamptz IS NULL
                OR r.created_at > $1
                OR (r.created_at = $1 AND r.id > $2)
              )
            ORDER BY r.created_at, r.id
            LIMIT $3",
        )
        .bind(cursor_created_at)
        .bind(cursor_id)
        .bind(BATCH_SIZE)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            tx.commit().await?;
            summary.exhausted = true;
            break;
        }

        summary.scanned += u64::try_from(rows.len()).map_err(ApiError::internal)?;
        let next_cursor = rows
            .last()
            .map(|row| (row.created_at, row.id))
            .ok_or_else(|| ApiError::internal("backfill batch unexpectedly empty"))?;

        for row in rows {
            let (Some(product_id), Some(operation), Some(surface)) = (
                row.product_id,
                row.operation.as_deref(),
                row.surface.as_deref(),
            ) else {
                summary.skipped += 1;
                continue;
            };
            let Ok(findings) = serde_json::from_value::<Vec<FeedbackFindingInput>>(row.findings)
            else {
                summary.skipped += 1;
                summary.skipped_findings += 1;
                tracing::warn!(
                    report_id = %row.id,
                    "skipping report with unreadable findings during group backfill"
                );
                continue;
            };
            assign_report_group(
                &mut tx,
                grouper,
                row.workspace_id,
                row.id,
                &GroupInput {
                    product_id,
                    operation,
                    surface,
                    status_code: row.status_code,
                    findings: &findings,
                },
            )
            .await?;
            summary.grouped += 1;
        }

        tx.commit().await?;
        cursor_created_at = Some(next_cursor.0);
        cursor_id = Some(next_cursor.1);

        if batches_run.is_multiple_of(PROGRESS_LOG_EVERY_BATCHES) {
            tracing::info!(
                scanned = summary.scanned,
                grouped = summary.grouped,
                skipped = summary.skipped,
                "report group backfill in progress"
            );
        }
        // Hand the connection pool back to request traffic before the next
        // batch: this loop can run for a long time on a large history.
        tokio::task::yield_now().await;
    }

    Ok(summary)
}

pub(crate) async fn regroup_report_groups(
    pool: &PgPool,
    grouper: &dyn ReportGrouper,
) -> Result<RegroupSummary, ApiError> {
    const BATCH_SIZE: i64 = 500;

    let mut summary = RegroupSummary::default();
    let mut cursor_created_at = None;
    let mut cursor_id = None;

    loop {
        let mut tx = pool.begin().await?;
        let rows = sqlx::query_as::<_, GroupedReportRow>(
            r"SELECT r.id, r.workspace_id, r.findings, r.created_at,
              p.id AS product_id, i.operation, i.surface, i.status_code,
              g.id AS current_group_id,
              g.merged_into_group_key AS current_merged_into_group_key
            FROM feedback_reports r
            JOIN report_groups g
              ON g.id = r.group_id AND g.workspace_id = r.workspace_id
            LEFT JOIN interactions_v2 i
              ON i.id = r.interaction_id AND i.workspace_id = r.workspace_id
            LEFT JOIN product_environments e
              ON e.id = i.environment_id AND e.workspace_id = r.workspace_id
            LEFT JOIN products p
              ON p.id = e.product_id AND p.workspace_id = r.workspace_id
            WHERE r.group_id IS NOT NULL
              AND (
                $1::timestamptz IS NULL
                OR r.created_at > $1
                OR (r.created_at = $1 AND r.id > $2)
              )
            ORDER BY r.created_at, r.id
            LIMIT $3",
        )
        .bind(cursor_created_at)
        .bind(cursor_id)
        .bind(BATCH_SIZE)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            tx.commit().await?;
            break;
        }

        summary.scanned += u64::try_from(rows.len()).map_err(ApiError::internal)?;
        let next_cursor = rows
            .last()
            .map(|row| (row.created_at, row.id))
            .ok_or_else(|| ApiError::internal("regroup batch unexpectedly empty"))?;

        for row in rows {
            let (Some(product_id), Some(operation), Some(surface)) = (
                row.product_id,
                row.operation.as_deref(),
                row.surface.as_deref(),
            ) else {
                summary.skipped += 1;
                continue;
            };
            let Ok(findings) = serde_json::from_value::<Vec<FeedbackFindingInput>>(row.findings)
            else {
                summary.skipped += 1;
                summary.skipped_findings += 1;
                tracing::warn!(
                    report_id = %row.id,
                    "skipping report with unreadable findings during report regroup"
                );
                continue;
            };
            let input = GroupInput {
                product_id,
                operation,
                surface,
                status_code: row.status_code,
                findings: &findings,
            };
            // A current manual merge wins over a newly computed fingerprint.
            // Otherwise always reassign: even an unchanged key may carry newer
            // grouper metadata, and the upsert refreshes that audit trail.
            let assigned_group_id =
                if let Some(target_group_key) = row.current_merged_into_group_key.as_deref() {
                    assign_report_to_lineage_target(
                        &mut tx,
                        row.workspace_id,
                        product_id,
                        row.id,
                        target_group_key,
                    )
                    .await?
                } else {
                    assign_report_group(&mut tx, grouper, row.workspace_id, row.id, &input).await?
                };
            let moved = assigned_group_id != row.current_group_id;
            if moved {
                summary.moved += 1;
            } else {
                summary.unchanged += 1;
            }
        }

        tx.commit().await?;
        cursor_created_at = Some(next_cursor.0);
        cursor_id = Some(next_cursor.1);
    }

    Ok(summary)
}

#[allow(
    clippy::too_many_arguments,
    reason = "the typed signal projection is a private explicit mapping from immutable report evidence"
)]
async fn project_feedback_signal(
    tx: &mut Transaction<'_, Postgres>,
    interaction: &ProductInteraction,
    report: &ProductFeedbackReport,
    product_id: Uuid,
    source_item_key: &str,
    signal_type: &str,
    summary: &str,
    detail: Option<&str>,
    feature_key: Option<&str>,
    attributes: &serde_json::Value,
    consent_grant_id: Option<Uuid>,
    collection_basis: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        r"INSERT INTO customer_signals
        (id, workspace_id, product_id, customer_id, session_id, interaction_id,
         feedback_report_id, feature_key, source_item_key, signal_type, summary,
         detail, attributes, provenance, confidence, collection_basis,
         consent_grant_id, consent_scope, collected_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          'agent_reports_current_task', $14, $15, $16,
          CASE WHEN $16::UUID IS NULL THEN NULL ELSE 'share_outcome' END, $17)
        ON CONFLICT (workspace_id, feedback_report_id, source_item_key) DO UPDATE SET
          customer_id = COALESCE(EXCLUDED.customer_id, customer_signals.customer_id),
          session_id = COALESCE(EXCLUDED.session_id, customer_signals.session_id),
          consent_grant_id = COALESCE(EXCLUDED.consent_grant_id,
            customer_signals.consent_grant_id),
          consent_scope = COALESCE(EXCLUDED.consent_scope,
            customer_signals.consent_scope),
          collection_basis = CASE
            WHEN EXCLUDED.consent_grant_id IS NOT NULL THEN EXCLUDED.collection_basis
            ELSE customer_signals.collection_basis END",
    )
    .bind(Uuid::new_v4())
    .bind(report.workspace_id)
    .bind(product_id)
    .bind(interaction.customer_id)
    .bind(interaction.session_id)
    .bind(interaction.id)
    .bind(report.id)
    .bind(feature_key)
    .bind(source_item_key)
    .bind(signal_type)
    .bind(clean(summary, 700))
    .bind(detail.map(|value| clean(value, 700)))
    .bind(attributes)
    .bind(report.confidence)
    .bind(collection_basis)
    .bind(consent_grant_id)
    .bind(report.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn project_feedback_signals(
    tx: &mut Transaction<'_, Postgres>,
    interaction: &ProductInteraction,
    report: &ProductFeedbackReport,
    product_id: Uuid,
    feedback_mode: &str,
) -> Result<(), ApiError> {
    let consent_grant_id = sqlx::query_scalar::<_, Uuid>(
        r"SELECT grant_row.id
        FROM feedback_consent_interactions interaction_consent
        JOIN consent_grants grant_row
          ON grant_row.environment_id = interaction_consent.environment_id
          AND grant_row.subject = COALESCE(
            interaction_consent.subject,
            'afint1_' || REPLACE(interaction_consent.interaction_id::TEXT, '-', '')
          )
          AND grant_row.scope = 'share_outcome'
          AND grant_row.state = 'approved'
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NOW())
        WHERE interaction_consent.interaction_id = $1
          AND interaction_consent.environment_id = $2
          AND interaction_consent.decision = 'approved'",
    )
    .bind(interaction.id)
    .bind(interaction.environment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let collection_basis = if feedback_mode == "never_ask" {
        "provider_feedback_policy"
    } else {
        "user_consent"
    };
    project_feedback_signal(
        tx,
        interaction,
        report,
        product_id,
        "outcome",
        "outcome",
        &report.summary,
        None,
        None,
        &serde_json::json!({ "impact": report.impact }),
        consent_grant_id,
        collection_basis,
    )
    .await?;

    let findings = serde_json::from_value::<Vec<FeedbackFindingInput>>(report.findings.clone())
        .map_err(|_| ApiError::internal("Stored feedback findings are invalid"))?;
    for (index, finding) in findings.into_iter().enumerate() {
        let signal_type = match finding.kind.as_str() {
            "friction" | "defect" => "friction",
            "gap" | "suggestion" => "feature_need",
            "strength" => "satisfaction",
            "uncertainty" => "constraint",
            _ => "outcome",
        };
        project_feedback_signal(
            tx,
            interaction,
            report,
            product_id,
            &format!("finding:{}", index + 1),
            signal_type,
            &finding.detail,
            Some(&finding.detail),
            Some(&finding.topic),
            &serde_json::json!({
                "findingKind": finding.kind,
                "topic": finding.topic,
                "severity": finding.severity,
            }),
            consent_grant_id,
            collection_basis,
        )
        .await?;
    }
    if let Some(workaround) = report.workaround.as_ref() {
        let used = workaround
            .get("used")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let detail = workaround.get("detail").and_then(serde_json::Value::as_str);
        project_feedback_signal(
            tx,
            interaction,
            report,
            product_id,
            "workaround",
            "workaround",
            if used {
                "A workaround was used"
            } else {
                "A workaround was considered"
            },
            detail,
            None,
            workaround,
            consent_grant_id,
            collection_basis,
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn backfill_customer_intelligence(
    pool: &PgPool,
    identity_hmac_secret: &[u8],
    batch_size: i64,
) -> Result<CustomerIntelligenceBackfillSummary, ApiError> {
    let limit = batch_size.clamp(1, 1_000);
    let mut summary = CustomerIntelligenceBackfillSummary::default();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtext('epode-customer-intelligence-backfill-v1'))",
    )
    .execute(&mut *tx)
    .await?;

    let interactions = sqlx::query_as::<_, ProductInteraction>(
        r"SELECT id, workspace_id, environment_id, api_key_id, session_id,
          surface, operation, status_code, duration_ms, customer_ref, customer_id,
          classification, confirmation_method, runtime_hint, runtime_hint_source,
          occurred_at, created_at, updated_at
        FROM interactions_v2
        WHERE customer_ref IS NOT NULL AND customer_id IS NULL
        ORDER BY occurred_at, id LIMIT $1 FOR UPDATE",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    let interaction_batch_exhausted =
        interactions.len() < usize::try_from(limit).map_err(ApiError::internal)?;
    summary.interactions_scanned = u64::try_from(interactions.len()).map_err(ApiError::internal)?;
    for interaction in interactions {
        let workspace = sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE id = $1")
            .bind(interaction.workspace_id)
            .fetch_one(&mut *tx)
            .await?;
        let environment = sqlx::query_as::<_, ProductEnvironment>(
            "SELECT * FROM product_environments WHERE id = $1 AND workspace_id = $2",
        )
        .bind(interaction.environment_id)
        .bind(interaction.workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        let refs = ValidatedIdentityRefs {
            customer_ref: interaction.customer_ref.clone(),
            account_ref: None,
            user_ref: None,
            anonymous_ref: None,
        };
        let auth = ProductAuth {
            workspace,
            environment,
            api_key_id: interaction.api_key_id.unwrap_or_else(Uuid::nil),
        };
        let customer_id = resolve_telemetry_customer(
            &mut tx,
            &auth,
            identity_hmac_secret,
            &refs,
            interaction.occurred_at,
        )
        .await?
        .ok_or_else(|| ApiError::internal("Legacy customerRef did not resolve a customer"))?;
        let linked = sqlx::query(
            r"UPDATE interactions_v2 SET customer_id = $2, updated_at = NOW()
            WHERE id = $1 AND workspace_id = $3 AND customer_id IS NULL",
        )
        .bind(interaction.id)
        .bind(customer_id)
        .bind(interaction.workspace_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        summary.interactions_linked += linked;
        let legacy_scope = customer_scope_hash(interaction.customer_ref.as_deref(), None);
        let resolved_scope = customer_scope_hash(None, Some(customer_id));
        rekey_customer_sessions(&mut tx, &auth, &legacy_scope, &resolved_scope).await?;
    }

    let report_ids = sqlx::query_scalar::<_, Uuid>(
        r"SELECT report.id FROM feedback_reports report
        WHERE NOT EXISTS (
          SELECT 1 FROM customer_signals signal
          WHERE signal.workspace_id = report.workspace_id
            AND signal.feedback_report_id = report.id
            AND signal.source_item_key = 'outcome'
        ) OR EXISTS (
          SELECT 1 FROM customer_signals signal
          JOIN interactions_v2 interaction ON interaction.id = report.interaction_id
          JOIN feedback_consent_interactions interaction_consent
            ON interaction_consent.interaction_id = interaction.id
            AND interaction_consent.environment_id = interaction.environment_id
            AND interaction_consent.decision = 'approved'
          JOIN consent_grants grant_row
            ON grant_row.environment_id = interaction.environment_id
            AND grant_row.subject = interaction_consent.subject
            AND grant_row.scope = 'share_outcome' AND grant_row.state = 'approved'
          WHERE signal.workspace_id = report.workspace_id
            AND signal.feedback_report_id = report.id
            AND signal.consent_grant_id IS NULL
        )
        ORDER BY report.created_at, report.id LIMIT $1 FOR UPDATE",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    let report_batch_exhausted =
        report_ids.len() < usize::try_from(limit).map_err(ApiError::internal)?;
    summary.reports_scanned = u64::try_from(report_ids.len()).map_err(ApiError::internal)?;
    for report_id in &report_ids {
        let report = sqlx::query_as::<_, ProductFeedbackReport>(
            "SELECT * FROM feedback_reports WHERE id = $1",
        )
        .bind(*report_id)
        .fetch_one(&mut *tx)
        .await?;
        let interaction = sqlx::query_as::<_, ProductInteraction>(
            r"SELECT id, workspace_id, environment_id, api_key_id, session_id,
              surface, operation, status_code, duration_ms, customer_ref, customer_id,
              classification, confirmation_method, runtime_hint, runtime_hint_source,
              occurred_at, created_at, updated_at
            FROM interactions_v2 WHERE id = $1 AND workspace_id = $2",
        )
        .bind(report.interaction_id)
        .bind(report.workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        let (product_id, feedback_mode) = sqlx::query_as::<_, (Uuid, String)>(
            r"SELECT product_id, feedback_mode FROM product_environments
            WHERE id = $1 AND workspace_id = $2",
        )
        .bind(interaction.environment_id)
        .bind(interaction.workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        project_feedback_signals(&mut tx, &interaction, &report, product_id, &feedback_mode)
            .await?;
        summary.reports_projected += 1;
    }

    let consent_subjects = sqlx::query_as::<_, (Uuid, String, String, DateTime<Utc>, i64)>(
        r"SELECT subject.environment_id, subject.subject, subject.decision,
          subject.decided_at, subject.revision
        FROM feedback_consent_subjects subject
        WHERE NOT EXISTS (
          SELECT 1 FROM consent_grants grant_row
          WHERE grant_row.environment_id = subject.environment_id
            AND grant_row.subject = subject.subject
            AND grant_row.scope = 'share_outcome'
        )
        ORDER BY subject.updated_at, subject.environment_id, subject.subject
        LIMIT $1 FOR UPDATE",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    let consent_batch_exhausted =
        consent_subjects.len() < usize::try_from(limit).map_err(ApiError::internal)?;
    summary.consent_subjects_scanned =
        u64::try_from(consent_subjects.len()).map_err(ApiError::internal)?;
    for (environment_id, subject, decision, decided_at, revision) in consent_subjects {
        dual_write_share_outcome_consent(
            &mut tx,
            environment_id,
            &subject,
            &decision,
            revision,
            decided_at,
            None,
            None,
            "migration",
        )
        .await?;
        let customer_ids = sqlx::query_scalar::<_, Uuid>(
            r"SELECT DISTINCT interaction.customer_id
            FROM feedback_consent_interactions interaction_consent
            JOIN interactions_v2 interaction
              ON interaction.id = interaction_consent.interaction_id
              AND interaction.environment_id = interaction_consent.environment_id
            WHERE interaction_consent.environment_id = $1
              AND interaction_consent.subject = $2
              AND interaction.customer_id IS NOT NULL",
        )
        .bind(environment_id)
        .bind(&subject)
        .fetch_all(&mut *tx)
        .await?;
        if customer_ids.len() > 1 {
            return Err(ApiError::conflict(
                "Consent subject maps to multiple customers during backfill",
            ));
        }
        if let Some(customer_id) = customer_ids.first() {
            sqlx::query(
                r"UPDATE consent_grants SET customer_id = $3, updated_at = NOW()
                WHERE environment_id = $1 AND subject = $2
                  AND scope = 'share_outcome' AND customer_id IS NULL",
            )
            .bind(environment_id)
            .bind(&subject)
            .bind(customer_id)
            .execute(&mut *tx)
            .await?;
        }
        summary.consent_grants_projected += 1;
    }
    summary.exhausted =
        interaction_batch_exhausted && report_batch_exhausted && consent_batch_exhausted;
    tx.commit().await?;
    Ok(summary)
}

pub(crate) async fn submit_product_feedback(
    pool: &PgPool,
    capability: &str,
    input: ProductFeedbackReportInput,
) -> Result<(ProductInteraction, ProductFeedbackReport), ApiError> {
    if input.summary.chars().count() > 700 {
        return Err(ApiError::bad_request(
            "summary must contain 8 to 700 characters",
        ));
    }
    let summary = clean(&input.summary, 700);
    if summary.len() < 8 {
        return Err(ApiError::bad_request(
            "summary must contain 8 to 700 characters",
        ));
    }
    if contains_sensitive_report_text(&summary) {
        return Err(ApiError::bad_request(
            "The feedback report appears to contain sensitive data",
        ));
    }
    if let Some(impact) = input.impact.as_deref()
        && ![
            "helped",
            "helped_with_friction",
            "neutral",
            "hindered",
            "blocked",
            "unknown",
        ]
        .contains(&impact)
    {
        return Err(ApiError::bad_request(
            "impact must be helped, helped_with_friction, neutral, hindered, blocked, or unknown",
        ));
    }
    if input
        .confidence
        .is_some_and(|confidence| !(0.0..=1.0).contains(&confidence))
    {
        return Err(ApiError::bad_request("confidence must be between 0 and 1"));
    }
    if input.findings.len() > 8 {
        return Err(ApiError::bad_request(
            "A feedback report can contain at most 8 findings",
        ));
    }
    let mut findings = Vec::with_capacity(input.findings.len());
    for mut finding in input.findings {
        if finding.topic.chars().count() > 64 || finding.detail.chars().count() > 350 {
            return Err(ApiError::bad_request(
                "Each finding requires a safe topic and 3 to 350 character detail",
            ));
        }
        if ![
            "strength",
            "friction",
            "defect",
            "gap",
            "suggestion",
            "uncertainty",
            "other",
        ]
        .contains(&finding.kind.as_str())
        {
            return Err(ApiError::bad_request("Invalid finding kind"));
        }
        if finding
            .severity
            .as_deref()
            .is_some_and(|severity| !["minor", "major", "blocking"].contains(&severity))
        {
            return Err(ApiError::bad_request("Invalid finding severity"));
        }
        finding.topic = clean(&finding.topic, 64)
            .to_ascii_lowercase()
            .replace(' ', "_");
        finding.detail = clean(&finding.detail, 350);
        if finding.topic.is_empty()
            || !finding
                .topic
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || !finding.topic.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || "-_".contains(character)
            })
            || finding.detail.len() < 3
        {
            return Err(ApiError::bad_request(
                "Each finding requires a safe topic and 3 to 350 character detail",
            ));
        }
        if contains_sensitive_report_text(&finding.detail) {
            return Err(ApiError::bad_request(
                "The feedback report appears to contain sensitive data",
            ));
        }
        findings.push(finding);
    }
    let workaround = if let Some(mut workaround) = input.workaround {
        if workaround
            .detail
            .as_deref()
            .is_some_and(|detail| detail.chars().count() > 350)
        {
            return Err(ApiError::bad_request(
                "A workaround detail must contain at most 350 characters",
            ));
        }
        workaround.detail = workaround
            .detail
            .map(|detail| clean(&detail, 350))
            .filter(|detail| !detail.is_empty());
        if workaround.used
            && workaround
                .detail
                .as_deref()
                .is_none_or(|detail| detail.len() < 3)
        {
            return Err(ApiError::bad_request(
                "A used workaround requires a 3 to 350 character detail",
            ));
        }
        if workaround
            .detail
            .as_deref()
            .is_some_and(contains_sensitive_report_text)
        {
            return Err(ApiError::bad_request(
                "The feedback report appears to contain sensitive data",
            ));
        }
        Some(workaround)
    } else {
        None
    };
    let findings_json = serde_json::to_value(&findings).map_err(ApiError::internal)?;
    let workaround = workaround
        .map(serde_json::to_value)
        .transpose()
        .map_err(ApiError::internal)?;

    let parsed = parse_capability(capability)?;
    let key = sqlx::query_as::<_, (Uuid, Vec<u8>, String, Uuid, Uuid)>(
        r"SELECT k.workspace_id, k.key_hash, e.feedback_mode, k.environment_id, e.product_id
        FROM api_keys k
        JOIN product_environments e ON e.id = k.environment_id
        WHERE k.id = $1 AND k.kind = 'write' AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())",
    )
    .bind(parsed.key_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let claims = verify_capability(parsed.clone(), &key.1, Utc::now())?;
    match key.2.as_str() {
        "off" => return Err(ApiError::gone("Feedback collection is disabled")),
        "never_ask" => {}
        "ask_once" => {
            let approved = if let Some(subject) = claims.s.as_deref() {
                sqlx::query_scalar::<_, bool>(
                    r"SELECT EXISTS (
                      SELECT 1 FROM feedback_consent_subjects
                      WHERE environment_id = $1 AND subject = $2 AND decision = 'approved'
                    )",
                )
                .bind(key.3)
                .bind(subject)
                .fetch_one(pool)
                .await?
            } else {
                sqlx::query_scalar::<_, bool>(
                    r"SELECT EXISTS (
                      SELECT 1 FROM feedback_consent_interactions
                      WHERE environment_id = $1 AND interaction_id = $2 AND decision = 'approved'
                    )",
                )
                .bind(key.3)
                .bind(claims.i)
                .fetch_one(pool)
                .await?
            };
            if !approved {
                return Err(ApiError::forbidden(
                    "Ask-once feedback requires an approved Epode consent decision",
                ));
            }
        }
        "ask_always" => {
            let approved = sqlx::query_scalar::<_, bool>(
                r"SELECT EXISTS (
                  SELECT 1 FROM feedback_consent_interactions
                  WHERE environment_id = $1 AND interaction_id = $2 AND decision = 'approved'
                )",
            )
            .bind(key.3)
            .bind(claims.i)
            .fetch_one(pool)
            .await?;
            if !approved {
                return Err(ApiError::forbidden(
                    "Ask-every-time feedback requires an approved decision for this interaction",
                ));
            }
        }
        _ => return Err(ApiError::internal("Invalid product feedback policy")),
    }

    let mut tx = pool.begin().await?;
    let interaction = sqlx::query_as::<_, ProductInteraction>(
        r"INSERT INTO interactions_v2
        (id, workspace_id, environment_id, api_key_id, surface, operation, classification,
         confirmation_method, capability_nonce_hash, occurred_at)
        VALUES ($1, $2, $3, $4, 'unknown', 'pending', 'confirmed',
          'feedback_report', $5, TO_TIMESTAMP($6))
        ON CONFLICT (id) DO UPDATE SET
          classification = 'confirmed',
          confirmation_method = COALESCE(interactions_v2.confirmation_method, 'feedback_report'),
          capability_nonce_hash = COALESCE(interactions_v2.capability_nonce_hash, EXCLUDED.capability_nonce_hash),
          updated_at = NOW()
        WHERE interactions_v2.environment_id = EXCLUDED.environment_id
        RETURNING id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
          status_code, duration_ms, customer_ref, customer_id, classification, confirmation_method,
          runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at",
    )
    .bind(claims.i)
    .bind(key.0)
    .bind(key.3)
    .bind(parsed.key_id)
    .bind(sha256(&claims.n))
    .bind(claims.iat)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::conflict("interactionId belongs to another product environment"))?;

    let grant_subject = claims
        .s
        .clone()
        .or_else(|| (key.2 == "ask_always").then(|| format!("afint1_{}", claims.i.simple())));
    if let (Some(subject), Some(customer_id)) = (grant_subject.as_deref(), interaction.customer_id)
    {
        let conflicting = sqlx::query_scalar::<_, bool>(
            r"SELECT EXISTS (
              SELECT 1 FROM consent_grants
              WHERE environment_id = $1 AND subject = $2 AND scope = 'share_outcome'
                AND customer_id IS NOT NULL AND customer_id <> $3
            )",
        )
        .bind(key.3)
        .bind(subject)
        .bind(customer_id)
        .fetch_one(&mut *tx)
        .await?;
        if conflicting {
            return Err(ApiError::conflict(
                "Consent subject is already linked to a different customer",
            ));
        }
        sqlx::query(
            r"UPDATE consent_grants SET customer_id = $3, updated_at = NOW()
            WHERE environment_id = $1 AND subject = $2 AND scope = 'share_outcome'
              AND customer_id IS NULL",
        )
        .bind(key.3)
        .bind(subject)
        .bind(customer_id)
        .execute(&mut *tx)
        .await?;
    }

    let inserted_report = sqlx::query_as::<_, ProductFeedbackReport>(
        r"INSERT INTO feedback_reports
        (id, workspace_id, interaction_id, summary, impact, confidence, findings, workaround)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (interaction_id) DO NOTHING
        RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(key.0)
    .bind(claims.i)
    .bind(summary)
    .bind(input.impact)
    .bind(input.confidence)
    .bind(findings_json)
    .bind(workaround)
    .fetch_optional(&mut *tx)
    .await?;
    record_product_activation(&mut tx, key.0, key.4, true, true, true).await?;
    let Some(report) = inserted_report else {
        // `ON CONFLICT` waits for an in-flight competing insert to finish.
        // Reading after it returns therefore makes simultaneous retries behave
        // exactly like sequential retries: both callers receive the first
        // accepted report and neither can replace it.
        let existing = sqlx::query_as::<_, ProductFeedbackReport>(
            "SELECT * FROM feedback_reports WHERE interaction_id = $1",
        )
        .bind(claims.i)
        .fetch_one(&mut *tx)
        .await?;
        project_feedback_signals(&mut tx, &interaction, &existing, key.4, &key.2).await?;
        tx.commit().await?;
        return Ok((interaction, existing));
    };
    // Only the transaction that creates the report creates its outbox event.
    // A duplicate capability submission returns the already-enqueued report
    // above; it must not reset a claim or schedule duplicate GitHub work.
    enqueue_code_match_if_mapped(&mut tx, report.id, key.4).await?;
    assign_report_group(
        &mut tx,
        &crate::grouping::FingerprintGrouper,
        key.0,
        report.id,
        &GroupInput {
            product_id: key.4,
            operation: &interaction.operation,
            surface: &interaction.surface,
            status_code: interaction.status_code,
            findings: &findings,
        },
    )
    .await?;
    project_feedback_signals(&mut tx, &interaction, &report, key.4, &key.2).await?;
    tx.commit().await?;
    Ok((interaction, report))
}

const ENRICHMENT_PURPOSES: &[&str] = &["product_personalization", "targeted_advertising"];
const ENRICHMENT_PROVENANCES: &[&str] = &[
    "agent_reports_user_statement",
    "agent_reports_current_task",
    "agent_inference",
];

#[derive(Debug, sqlx::FromRow)]
struct EnrichmentRequestRow {
    id: Uuid,
    workspace_id: Uuid,
    product_id: Uuid,
    environment_id: Uuid,
    interaction_id: Uuid,
    customer_id: Option<Uuid>,
    surface: String,
    purpose: String,
    remember: bool,
    consent_subject: String,
    expected_consent_revision: i64,
    identity_level: String,
    state: String,
    question: String,
    request_hash: Vec<u8>,
    capability_nonce_hash: Vec<u8>,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingEnrichmentInteractionRow {
    environment_id: Uuid,
    session_id: Option<Uuid>,
    surface: String,
    operation: String,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    customer_ref: Option<String>,
    customer_id: Option<Uuid>,
    runtime_hint: Option<String>,
}

fn validate_enrichment_purpose(value: &str) -> Result<(), ApiError> {
    if ENRICHMENT_PURPOSES.contains(&value) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "purpose must be product_personalization or targeted_advertising",
        ))
    }
}

fn validate_enrichment_surface(value: &str) -> Result<(&str, &str, Option<&str>), ApiError> {
    match value {
        "http_json" => Ok(("http_json", "unclassified", None)),
        "html" => Ok(("http_html", "unclassified", None)),
        "mcp" => Ok(("mcp", "confirmed", Some("mcp"))),
        _ => Err(ApiError::bad_request(
            "surface must be http_json, html, or mcp",
        )),
    }
}

fn validate_enrichment_runtime_hint(value: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.trim().is_empty()
        || value.chars().count() > 200
        || value.contains('@')
        || value.chars().any(char::is_control)
        || contains_sensitive_report_text(value)
    {
        return Err(ApiError::bad_request(
            "runtimeHint must be a bounded, non-sensitive runtime label",
        ));
    }
    Ok(Some(clean(value, 200)))
}

fn validate_opaque_event_id(value: &str, field: &str) -> Result<String, ApiError> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.:-".contains(character))
    {
        return Err(ApiError::bad_request(format!(
            "{field} must be a bounded opaque identifier"
        )));
    }
    Ok(value.to_owned())
}

fn validate_enrichment_operation(value: &str) -> Result<String, ApiError> {
    if value.trim().is_empty()
        || value.chars().count() > 160
        || value.contains('@')
        || value.contains('?')
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/_:.-*{}".contains(character))
    {
        return Err(ApiError::bad_request(
            "operation must be a normalized route or tool name",
        ));
    }
    Ok(value.to_owned())
}

#[allow(
    clippy::too_many_arguments,
    reason = "the request hash deliberately covers every externally supplied identity and interaction dimension"
)]
fn enrichment_request_hash(
    identity_hmac_secret: &[u8],
    auth: &ProductAuth,
    input: &EnrichmentRequestInput,
    operation: &str,
    runtime_hint: Option<&str>,
    session_ref_hash: Option<&[u8]>,
    refs: &ValidatedIdentityRefs,
    remember: bool,
) -> Result<Vec<u8>, ApiError> {
    let hash_ref = |kind: &str, value: Option<&str>| -> Result<Option<String>, ApiError> {
        value
            .map(|value| {
                customer_identifier_hash(
                    identity_hmac_secret,
                    auth.workspace.id,
                    auth.environment.product_id,
                    kind,
                    value,
                )
                .map(|digest| URL_SAFE_NO_PAD.encode(digest))
            })
            .transpose()
    };
    let material = serde_json::json!({
        "version": 1,
        "workspaceId": auth.workspace.id,
        "productId": auth.environment.product_id,
        "environmentId": auth.environment.id,
        "apiKeyId": auth.api_key_id,
        "interactionId": input.interaction_id,
        "operation": operation,
        "surface": &input.surface,
        "statusCode": input.status_code,
        "durationMs": input.duration_ms,
        "runtimeHint": runtime_hint,
        "sessionRefHash": session_ref_hash.map(|digest| URL_SAFE_NO_PAD.encode(digest)),
        "purpose": &input.purpose,
        "remember": remember,
        "customerRefHash": hash_ref("customer_ref", refs.customer_ref.as_deref())?,
        "accountRefHash": hash_ref("account_ref", refs.account_ref.as_deref())?,
        "userRefHash": hash_ref("user_ref", refs.user_ref.as_deref())?,
        "anonymousRefHash": hash_ref("anonymous_ref", refs.anonymous_ref.as_deref())?,
    });
    Ok(sha256_bytes(
        &serde_json::to_vec(&material).map_err(ApiError::internal)?,
    ))
}

fn enrichment_subject(
    identity_hmac_secret: &[u8],
    auth: &ProductAuth,
    customer_id: Option<Uuid>,
    interaction_id: Uuid,
    purpose: &str,
    remember: bool,
) -> Result<String, ApiError> {
    if !remember {
        let digest = customer_identifier_hash(
            identity_hmac_secret,
            auth.workspace.id,
            auth.environment.product_id,
            &format!("enrichment_interaction_consent:{purpose}"),
            &interaction_id.to_string(),
        )?;
        let scoped_id = Uuid::from_slice(&digest[..16]).map_err(ApiError::internal)?;
        return Ok(format!("afint1_{}", scoped_id.simple()));
    }
    customer_id.map_or_else(
        || Ok(format!("afint1_{}", interaction_id.simple())),
        |customer_id| {
            let digest = customer_identifier_hash(
                identity_hmac_secret,
                auth.workspace.id,
                auth.environment.product_id,
                &format!("enrichment_consent:{purpose}"),
                &customer_id.to_string(),
            )?;
            Ok(format!("afsub1_{}", URL_SAFE_NO_PAD.encode(digest)))
        },
    )
}

fn enrichment_question(product_name: &str, purpose: &str, remember: bool) -> String {
    let use_text = if purpose == "targeted_advertising" {
        "personalize marketing and advertising"
    } else {
        "personalize your product experience"
    };
    let memory_text = if remember {
        " and remember them for future visits"
    } else {
        " for this interaction only"
    };
    format!(
        "May I share relevant, non-sensitive preferences, interests, intent, or constraints with {product_name} so it can {use_text}{memory_text}?"
    )
}

fn answer_instruction(product_name: &str, purpose: &str, remember: bool) -> String {
    let use_text = if purpose == "targeted_advertising" {
        "marketing or advertising"
    } else {
        "this product experience"
    };
    let memory_text = if remember {
        " Mark only durable preferences as remembered; keep situational context interaction-scoped."
    } else {
        " Every item must remain interaction-scoped."
    };
    format!(
        "Provide only non-sensitive context the user explicitly shared or that is directly relevant to the current task for {use_text} by {product_name}.{memory_text} Never include prompts, transcripts, names, emails, credentials, or raw customer content."
    )
}

fn enrichment_consent_action(public_base_url: &str, token: &str) -> EnrichmentConsentAction {
    EnrichmentConsentAction {
        url: format!("{public_base_url}/api/v2/enrichment/consent/decisions"),
        method: "POST".to_owned(),
        authorization: format!("Bearer {token}"),
        content_type: "application/json".to_owned(),
        body_schema: EnrichmentConsentBodySchema {
            decision: vec!["approved".to_owned(), "declined".to_owned()],
        },
    }
}

fn enrichment_answer_action(public_base_url: &str, token: &str) -> EnrichmentAnswerAction {
    EnrichmentAnswerAction {
        url: format!("{public_base_url}/api/v2/enrichment/answers"),
        method: "POST".to_owned(),
        authorization: format!("Bearer {token}"),
        content_type: "application/json".to_owned(),
        body_schema: EnrichmentAnswerBodySchema {
            status: vec![
                "answered".to_owned(),
                "declined".to_owned(),
                "no_relevant_context".to_owned(),
            ],
            items: EnrichmentAnswerItemsSchema {
                maximum: 8,
                required: ["key", "type", "value", "provenance", "remember"]
                    .map(str::to_owned)
                    .to_vec(),
                signal_types: ["intent", "preference", "constraint"]
                    .map(str::to_owned)
                    .to_vec(),
                provenance: [
                    "agent_reports_user_statement",
                    "agent_reports_current_task",
                    "agent_inference",
                ]
                .map(str::to_owned)
                .to_vec(),
                catalog_version: "v1".to_owned(),
                catalog: enrichment_catalog_schema(),
            },
        },
    }
}

fn enrichment_stage_instruction(request: &EnrichmentRequestRow) -> String {
    match request.state.as_str() {
        "consent_required" => concat!(
            "Finish the user's product task first. Then ask the exact question once and stop. ",
            "Wait for the user's next explicit reply; never infer approval from silence, prior use, ",
            "or the current request. Submit approved only for an unambiguous yes, declined only for ",
            "an unambiguous no, and submit nothing when the reply is unclear."
        )
        .to_owned(),
        "answer_ready" => concat!(
            "Finish the user's product task first. Then submit at most one bounded answer using the ",
            "provided schema. Include only relevant, non-sensitive context allowed by the explicit ",
            "permission; do not infer identity or sensitive traits."
        )
        .to_owned(),
        _ => "No enrichment action is permitted for this request.".to_owned(),
    }
}

fn enrichment_response(
    public_base_url: &str,
    request: &EnrichmentRequestRow,
    token: &str,
) -> EnrichmentRequestResponse {
    let consent_required = request.state == "consent_required";
    let answer_ready = request.state == "answer_ready";
    EnrichmentRequestResponse {
        request_id: request.id,
        interaction_id: request.interaction_id,
        state: request.state.clone(),
        purpose: request.purpose.clone(),
        surface: request.surface.clone(),
        identity_level: request.identity_level.clone(),
        stage_instruction: enrichment_stage_instruction(request),
        question: consent_required.then(|| request.question.clone()),
        answer_instruction: answer_ready
            .then(|| answer_instruction("this company", &request.purpose, request.remember)),
        expires_at: request.expires_at,
        consent: Some(enrichment_consent_action(public_base_url, token)),
        submit: answer_ready.then(|| enrichment_answer_action(public_base_url, token)),
    }
}

async fn product_key_hash(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
) -> Result<Vec<u8>, ApiError> {
    sqlx::query_scalar::<_, Vec<u8>>(
        r"SELECT key_hash FROM api_keys
        WHERE id = $1 AND workspace_id = $2 AND environment_id = $3
          AND kind = 'write' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(auth.api_key_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::unauthorized)
}

async fn current_enrichment_consent(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    subject: &str,
    customer_id: Option<Uuid>,
    purpose: &str,
    remember: bool,
) -> Result<(String, i64, String), ApiError> {
    let customer_id = remember.then_some(customer_id).flatten();
    let mut required = vec!["share_preferences", "personalize"];
    if remember {
        required.push("remember_preferences");
    }
    let rows = sqlx::query_as::<_, (String, String, i64, bool, String, DateTime<Utc>)>(
        r"SELECT scope, state, revision,
          (expires_at IS NULL OR expires_at > NOW()) AS active
          , subject, decided_at
        FROM consent_grants grant_row
        WHERE environment_id = $1 AND workspace_id = $2
          AND (subject = $3 OR ($5::UUID IS NOT NULL AND customer_id = $5))
          AND scope = ANY($4) AND enrichment_purpose = $6
        ORDER BY decided_at DESC, revision DESC,
          CASE WHEN state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
          subject, id",
    )
    .bind(auth.environment.id)
    .bind(auth.workspace.id)
    .bind(subject)
    .bind(&required)
    .bind(customer_id)
    .bind(purpose)
    .fetch_all(&mut **tx)
    .await?;
    let resolved_subject = rows
        .first()
        .map_or_else(|| subject.to_owned(), |row| row.4.clone());
    let effective_rows = rows
        .iter()
        .filter(|row| row.4 == resolved_subject)
        .collect::<Vec<_>>();
    let revision = effective_rows.iter().map(|row| row.2).max().unwrap_or(0);
    if effective_rows
        .iter()
        .any(|row| row.3 && (row.1 == "declined" || row.1 == "revoked"))
    {
        return Ok(("declined".to_owned(), revision, resolved_subject));
    }
    if required.iter().all(|scope| {
        effective_rows
            .iter()
            .any(|row| row.0 == *scope && row.1 == "approved" && row.3)
    }) {
        Ok(("answer_ready".to_owned(), revision, resolved_subject))
    } else {
        Ok(("consent_required".to_owned(), revision, resolved_subject))
    }
}

pub(crate) async fn create_enrichment_request(
    pool: &PgPool,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    public_base_url: &str,
    input: EnrichmentRequestInput,
) -> Result<EnrichmentRequestResponse, ApiError> {
    validate_enrichment_purpose(&input.purpose)?;
    let (interaction_surface, classification, confirmation_method) =
        validate_enrichment_surface(&input.surface)?;
    if input
        .status_code
        .is_some_and(|value| !(100..=599).contains(&value))
        || input
            .duration_ms
            .is_some_and(|value| !(0..=86_400_000).contains(&value))
    {
        return Err(ApiError::bad_request("Invalid response status or duration"));
    }
    let session_ref = validate_identity_ref(input.session_ref.as_deref(), "sessionRef")?;
    let runtime_hint = validate_enrichment_runtime_hint(input.runtime_hint.as_deref())?;
    let operation = validate_enrichment_operation(&input.operation)?;
    let refs = validated_identity_refs(
        input.customer_ref.as_deref(),
        input.account_ref.as_deref(),
        input.user_ref.as_deref(),
        input.anonymous_ref.as_deref(),
    )?;
    let has_identity_ref = refs.customer_ref.is_some()
        || refs.account_ref.is_some()
        || refs.user_ref.is_some()
        || refs.anonymous_ref.is_some();
    let remember = input.remember && has_identity_ref;
    let session_ref_hash = session_ref
        .as_deref()
        .map(|session_ref| {
            customer_identifier_hash(
                identity_hmac_secret,
                auth.workspace.id,
                auth.environment.product_id,
                "session_ref",
                session_ref,
            )
        })
        .transpose()?;
    let request_hash = enrichment_request_hash(
        identity_hmac_secret,
        auth,
        &input,
        &operation,
        runtime_hint.as_deref(),
        session_ref_hash.as_deref(),
        &refs,
        remember,
    )?;
    let now = Utc::now();
    let expires_at = now + Duration::hours(2);
    let mut tx = pool.begin().await?;
    let key_hash = product_key_hash(&mut tx, auth).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "enrichment:{}:{}",
            auth.environment.id, input.interaction_id
        ))
        .execute(&mut *tx)
        .await?;
    let existing_request = sqlx::query_as::<_, EnrichmentRequestRow>(
        r"SELECT id, workspace_id, product_id, environment_id, interaction_id,
          customer_id, surface, purpose, remember, consent_subject, expected_consent_revision,
          identity_level, state, question, request_hash, capability_nonce_hash,
          expires_at, created_at
        FROM enrichment_requests
        WHERE environment_id = $1 AND interaction_id = $2 FOR UPDATE",
    )
    .bind(auth.environment.id)
    .bind(input.interaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(request) = existing_request {
        if request.request_hash != request_hash || request.expires_at <= now {
            return Err(ApiError::conflict(
                "interactionId was already used with a different or expired enrichment request",
            ));
        }
        let (token, expected_nonce_hash) = sign_deterministic_enrichment_capability(
            auth.api_key_id,
            &key_hash,
            request.id,
            request.interaction_id,
            request.created_at,
            request.expires_at,
        )?;
        if request.capability_nonce_hash != expected_nonce_hash {
            return Err(ApiError::conflict(
                "This enrichment request cannot be retried with the current product key",
            ));
        }
        tx.commit().await?;
        return Ok(enrichment_response(public_base_url, &request, &token));
    }
    let customer_id =
        resolve_telemetry_customer(&mut tx, auth, identity_hmac_secret, &refs, now).await?;
    let identity_level = if let Some(customer_id) = customer_id {
        sqlx::query_scalar::<_, String>(
            "SELECT identity_level FROM customers WHERE id = $1 AND workspace_id = $2",
        )
        .bind(customer_id)
        .bind(auth.workspace.id)
        .fetch_one(&mut *tx)
        .await?
    } else {
        "ephemeral".to_owned()
    };
    if remember != (input.remember && identity_level != "ephemeral") {
        return Err(ApiError::conflict(
            "Identity resolution changed the remember policy",
        ));
    }
    let customer_ref = refs.customer_ref.clone();
    let existing_interaction = sqlx::query_as::<_, ExistingEnrichmentInteractionRow>(
        r"SELECT environment_id, session_id, surface, operation, status_code,
          duration_ms, customer_ref, customer_id, runtime_hint
        FROM interactions_v2 WHERE id = $1 FOR UPDATE",
    )
    .bind(input.interaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = &existing_interaction {
        let scalar_compatible = existing.environment_id == auth.environment.id
            && existing.surface == interaction_surface
            && (existing.operation == "pending" || existing.operation == operation)
            && existing
                .status_code
                .is_none_or(|value| Some(value) == input.status_code)
            && existing
                .duration_ms
                .is_none_or(|value| Some(value) == input.duration_ms)
            && existing
                .runtime_hint
                .as_deref()
                .is_none_or(|value| Some(value) == runtime_hint.as_deref())
            && existing
                .customer_ref
                .as_deref()
                .is_none_or(|value| Some(value) == customer_ref.as_deref())
            && existing
                .customer_id
                .is_none_or(|value| Some(value) == customer_id);
        if !scalar_compatible {
            return Err(ApiError::conflict(
                "interactionId belongs to a different interaction payload",
            ));
        }
        match (existing.session_id, session_ref_hash.as_deref()) {
            (Some(existing_session_id), Some(expected_ref_hash)) => {
                let existing_ref_hash = sqlx::query_scalar::<_, Vec<u8>>(
                    "SELECT COALESCE(raw_ref_hash, ref_hash) FROM sessions_v2 WHERE id = $1 AND workspace_id = $2",
                )
                .bind(existing_session_id)
                .bind(auth.workspace.id)
                .fetch_one(&mut *tx)
                .await?;
                if existing_ref_hash != expected_ref_hash {
                    return Err(ApiError::conflict(
                        "interactionId belongs to a different session",
                    ));
                }
            }
            (Some(_), None) => {
                return Err(ApiError::conflict(
                    "interactionId belongs to a different session",
                ));
            }
            (None, _) => {}
        }
    }
    let session_id = if let Some(existing_session_id) =
        existing_interaction.as_ref().and_then(|row| row.session_id)
    {
        Some(existing_session_id)
    } else if let Some(session_ref_hash) = session_ref_hash.as_deref() {
        Some(
            resolve_v2_session(
                &mut tx,
                auth.workspace.id,
                auth.environment.id,
                &customer_scope_hash(customer_ref.as_deref(), customer_id),
                session_ref_hash,
                if input.surface == "mcp" {
                    "mcp"
                } else {
                    "customer"
                },
                now,
            )
            .await?,
        )
    } else {
        None
    };
    let runtime_hint_source = runtime_hint.as_ref().map(|_| {
        if input.surface == "mcp" {
            "mcp"
        } else {
            "http"
        }
    });
    let interaction = sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, Option<String>)>(
        r"INSERT INTO interactions_v2
        (id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
         status_code, duration_ms, customer_ref, customer_id, classification,
         confirmation_method, runtime_hint, runtime_hint_source, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          api_key_id = COALESCE(interactions_v2.api_key_id, EXCLUDED.api_key_id),
          session_id = COALESCE(interactions_v2.session_id, EXCLUDED.session_id),
          operation = CASE WHEN interactions_v2.operation = 'pending'
            THEN EXCLUDED.operation ELSE interactions_v2.operation END,
          status_code = COALESCE(interactions_v2.status_code, EXCLUDED.status_code),
          duration_ms = COALESCE(interactions_v2.duration_ms, EXCLUDED.duration_ms),
          customer_ref = COALESCE(interactions_v2.customer_ref, EXCLUDED.customer_ref),
          customer_id = COALESCE(interactions_v2.customer_id, EXCLUDED.customer_id),
          runtime_hint = COALESCE(interactions_v2.runtime_hint, EXCLUDED.runtime_hint),
          runtime_hint_source = COALESCE(
            interactions_v2.runtime_hint_source, EXCLUDED.runtime_hint_source
          ),
          classification = CASE WHEN EXCLUDED.classification = 'confirmed'
            THEN 'confirmed' ELSE interactions_v2.classification END,
          confirmation_method = CASE WHEN EXCLUDED.classification = 'confirmed'
            THEN EXCLUDED.confirmation_method ELSE interactions_v2.confirmation_method END,
          updated_at = NOW()
        WHERE interactions_v2.environment_id = EXCLUDED.environment_id
          AND interactions_v2.surface = EXCLUDED.surface
          AND (interactions_v2.operation = 'pending'
            OR interactions_v2.operation = EXCLUDED.operation)
          AND (interactions_v2.session_id IS NULL
            OR interactions_v2.session_id = EXCLUDED.session_id)
          AND (interactions_v2.status_code IS NULL
            OR interactions_v2.status_code = EXCLUDED.status_code)
          AND (interactions_v2.duration_ms IS NULL
            OR interactions_v2.duration_ms = EXCLUDED.duration_ms)
          AND (interactions_v2.runtime_hint IS NULL
            OR interactions_v2.runtime_hint = EXCLUDED.runtime_hint)
          AND (interactions_v2.customer_id IS NULL OR EXCLUDED.customer_id IS NULL
            OR interactions_v2.customer_id = EXCLUDED.customer_id)
          AND (interactions_v2.customer_ref IS NULL OR EXCLUDED.customer_ref IS NULL
            OR interactions_v2.customer_ref = EXCLUDED.customer_ref)
        RETURNING id, customer_id, surface, classification, confirmation_method",
    )
    .bind(input.interaction_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.id)
    .bind(auth.api_key_id)
    .bind(session_id)
    .bind(interaction_surface)
    .bind(&operation)
    .bind(input.status_code)
    .bind(input.duration_ms)
    .bind(customer_ref)
    .bind(customer_id)
    .bind(classification)
    .bind(confirmation_method)
    .bind(runtime_hint)
    .bind(runtime_hint_source)
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::conflict("interactionId belongs to another product context"))?;
    if interaction.1 != customer_id {
        return Err(ApiError::conflict(
            "interactionId is already linked to a different customer",
        ));
    }
    if interaction.2 != interaction_surface
        || (input.surface == "mcp"
            && (interaction.3 != "confirmed" || interaction.4.as_deref() != Some("mcp")))
    {
        return Err(ApiError::conflict(
            "interactionId is already linked to a different product surface",
        ));
    }
    let subject = enrichment_subject(
        identity_hmac_secret,
        auth,
        customer_id,
        input.interaction_id,
        &input.purpose,
        remember,
    )?;
    let (state, revision, subject) = current_enrichment_consent(
        &mut tx,
        auth,
        &subject,
        customer_id,
        &input.purpose,
        remember,
    )
    .await?;
    let product_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM products WHERE id = $1 AND workspace_id = $2",
    )
    .bind(auth.environment.product_id)
    .bind(auth.workspace.id)
    .fetch_one(&mut *tx)
    .await?;
    let proposed_request_id = Uuid::new_v4();
    let (_, proposed_nonce_hash) = sign_deterministic_enrichment_capability(
        auth.api_key_id,
        &key_hash,
        proposed_request_id,
        input.interaction_id,
        now,
        expires_at,
    )?;
    let question = enrichment_question(&product_name, &input.purpose, remember);
    let request = sqlx::query_as::<_, EnrichmentRequestRow>(
        r"INSERT INTO enrichment_requests
        (id, workspace_id, product_id, environment_id, interaction_id, api_key_id,
         customer_id, surface, purpose, remember, consent_subject, expected_consent_revision,
         identity_level, state, operation, question_key, question, request_hash,
         capability_nonce_hash, expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, 'customer_context.v1', $16, $17, $18, $19, $20, $20)
        ON CONFLICT (environment_id, interaction_id) DO UPDATE SET
          id = enrichment_requests.id
        RETURNING id, workspace_id, product_id, environment_id, interaction_id,
          customer_id, surface, purpose, remember, consent_subject, expected_consent_revision,
          identity_level, state, question, request_hash, capability_nonce_hash,
          expires_at, created_at",
    )
    .bind(proposed_request_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .bind(input.interaction_id)
    .bind(auth.api_key_id)
    .bind(customer_id)
    .bind(&input.surface)
    .bind(&input.purpose)
    .bind(remember)
    .bind(subject)
    .bind(revision)
    .bind(identity_level)
    .bind(state)
    .bind(operation)
    .bind(question)
    .bind(&request_hash)
    .bind(proposed_nonce_hash)
    .bind(expires_at)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    if request.request_hash != request_hash {
        return Err(ApiError::conflict(
            "interactionId was already used with a different enrichment request",
        ));
    }
    let (token, expected_nonce_hash) = sign_deterministic_enrichment_capability(
        auth.api_key_id,
        &key_hash,
        request.id,
        request.interaction_id,
        request.created_at,
        request.expires_at,
    )?;
    if request.capability_nonce_hash != expected_nonce_hash {
        return Err(ApiError::conflict(
            "This enrichment request cannot be retried with the current contract",
        ));
    }
    tx.commit().await?;
    Ok(enrichment_response(public_base_url, &request, &token))
}

async fn verified_enrichment_request(
    tx: &mut Transaction<'_, Postgres>,
    capability: &str,
) -> Result<(EnrichmentRequestRow, Vec<u8>), ApiError> {
    let parsed = parse_enrichment_capability(capability)?;
    let key_hash = sqlx::query_scalar::<_, Vec<u8>>(
        r"SELECT key_hash FROM api_keys WHERE id = $1 AND kind = 'write'
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(parsed.key_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let claims = verify_enrichment_capability(parsed, &key_hash, Utc::now())?;
    let request = sqlx::query_as::<_, EnrichmentRequestRow>(
        r"SELECT id, workspace_id, product_id, environment_id, interaction_id,
          customer_id, surface, purpose, remember, consent_subject, expected_consent_revision,
          identity_level, state, question, request_hash, capability_nonce_hash,
          expires_at, created_at
        FROM enrichment_requests WHERE id = $1 AND interaction_id = $2
          AND api_key_id = $3 FOR UPDATE",
    )
    .bind(claims.q)
    .bind(claims.i)
    .bind(parsed_enrichment_key_id(capability)?)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    if request.expires_at <= Utc::now() || request.capability_nonce_hash != sha256(&claims.n) {
        return Err(ApiError::unauthorized());
    }
    Ok((request, key_hash))
}

fn parsed_enrichment_key_id(capability: &str) -> Result<Uuid, ApiError> {
    parse_enrichment_capability(capability).map(|parsed| parsed.key_id)
}

async fn apply_enrichment_consent(
    tx: &mut Transaction<'_, Postgres>,
    request: &EnrichmentRequestRow,
    state: &str,
    decided_at: DateTime<Utc>,
) -> Result<bool, ApiError> {
    let mut scopes = vec!["share_preferences", "personalize"];
    if request.remember {
        scopes.push("remember_preferences");
    }
    let existing = sqlx::query_as::<_, (Uuid, String, String, i64)>(
        r"SELECT id, scope, state, revision FROM consent_grants
        WHERE environment_id = $1 AND subject = $2 AND scope = ANY($3)
        ORDER BY scope FOR UPDATE",
    )
    .bind(request.environment_id)
    .bind(&request.consent_subject)
    .bind(&scopes)
    .fetch_all(&mut **tx)
    .await?;
    let current_revision = existing.iter().map(|row| row.3).max().unwrap_or(0);
    let desired_is_current = scopes
        .iter()
        .all(|scope| existing.iter().any(|row| row.1 == *scope && row.2 == state));
    if desired_is_current || current_revision != request.expected_consent_revision {
        return Ok(false);
    }
    let revision = request.expected_consent_revision + 1;
    let expires_at =
        (!request.remember || request.identity_level == "ephemeral").then_some(request.expires_at);
    for scope in scopes {
        let prior_state = existing
            .iter()
            .find(|row| row.1 == scope)
            .map(|row| row.2.as_str());
        let grant_id = sqlx::query_scalar::<_, Uuid>(
            r"INSERT INTO consent_grants
            (id, workspace_id, product_id, environment_id, customer_id, subject,
             scope, enrichment_purpose, state, basis, revision, decided_at, expires_at, revoked_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
              'user_consent', $10, $11, $12, NULL)
            ON CONFLICT (environment_id, subject, scope) DO UPDATE SET
              customer_id = COALESCE(consent_grants.customer_id, EXCLUDED.customer_id),
              enrichment_purpose = EXCLUDED.enrichment_purpose,
              state = EXCLUDED.state, basis = EXCLUDED.basis,
              revision = EXCLUDED.revision, decided_at = EXCLUDED.decided_at,
              expires_at = EXCLUDED.expires_at, revoked_at = NULL, updated_at = NOW()
            WHERE consent_grants.revision = $13
            RETURNING id",
        )
        .bind(Uuid::new_v4())
        .bind(request.workspace_id)
        .bind(request.product_id)
        .bind(request.environment_id)
        .bind(request.customer_id)
        .bind(&request.consent_subject)
        .bind(scope)
        .bind(&request.purpose)
        .bind(state)
        .bind(revision)
        .bind(decided_at)
        .bind(expires_at)
        .bind(request.expected_consent_revision)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| ApiError::conflict("Enrichment permission changed; request it again"))?;
        sqlx::query(
            r"INSERT INTO enrichment_consent_events
            (id, workspace_id, product_id, environment_id, consent_grant_id,
             subject, scope, enrichment_purpose, prior_state, state, basis,
             revision, source, decided_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              'user_consent', $11, 'enrichment', $12)",
        )
        .bind(Uuid::new_v4())
        .bind(request.workspace_id)
        .bind(request.product_id)
        .bind(request.environment_id)
        .bind(grant_id)
        .bind(&request.consent_subject)
        .bind(scope)
        .bind(&request.purpose)
        .bind(prior_state)
        .bind(state)
        .bind(revision)
        .bind(decided_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(true)
}

pub(crate) async fn decide_enrichment_consent(
    pool: &PgPool,
    public_base_url: &str,
    capability: &str,
    input: EnrichmentConsentDecisionInput,
) -> Result<EnrichmentConsentDecisionResponse, ApiError> {
    if !["approved", "declined"].contains(&input.decision.as_str()) {
        return Err(ApiError::bad_request(
            "decision must be approved or declined",
        ));
    }
    let mut tx = pool.begin().await?;
    let (mut request, _) = verified_enrichment_request(&mut tx, capability).await?;
    let decided_at = Utc::now();
    let state = input.decision;
    let changed = apply_enrichment_consent(&mut tx, &request, &state, decided_at).await?;
    let auth = ProductAuth {
        workspace: sqlx::query_as("SELECT * FROM workspaces WHERE id = $1")
            .bind(request.workspace_id)
            .fetch_one(&mut *tx)
            .await?,
        environment: sqlx::query_as(
            "SELECT * FROM product_environments WHERE id = $1 AND workspace_id = $2",
        )
        .bind(request.environment_id)
        .bind(request.workspace_id)
        .fetch_one(&mut *tx)
        .await?,
        api_key_id: parsed_enrichment_key_id(capability)?,
    };
    let (resolved_state, _, _) = current_enrichment_consent(
        &mut tx,
        &auth,
        &request.consent_subject,
        request.customer_id,
        &request.purpose,
        request.remember,
    )
    .await?;
    if !["answered", "no_relevant_context"].contains(&request.state.as_str()) {
        request.state = resolved_state;
    }
    sqlx::query("UPDATE enrichment_requests SET state = $2, updated_at = NOW() WHERE id = $1")
        .bind(request.id)
        .bind(&request.state)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(EnrichmentConsentDecisionResponse {
        request_id: request.id,
        state: request.state.clone(),
        changed,
        stage_instruction: enrichment_stage_instruction(&request),
        answer_instruction: (request.state == "answer_ready")
            .then(|| answer_instruction("this company", &request.purpose, request.remember)),
        submit: (request.state == "answer_ready")
            .then(|| enrichment_answer_action(public_base_url, capability)),
    })
}

#[derive(Debug, Clone, Copy)]
struct EnrichmentCatalogDefinition {
    key: &'static str,
    signal_type: &'static str,
    allowed_values: &'static [&'static str],
    targeted_advertising_safe: bool,
}

const ENRICHMENT_CATALOG: &[EnrichmentCatalogDefinition] = &[
    EnrichmentCatalogDefinition {
        key: "shopping.priority",
        signal_type: "preference",
        allowed_values: &["price", "quality", "speed", "convenience", "sustainability"],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "shopping.sustainability",
        signal_type: "preference",
        allowed_values: &["low", "medium", "high"],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "shopping.budget_band",
        signal_type: "constraint",
        allowed_values: &["under_50", "50_150", "150_500", "over_500", "flexible"],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "shopping.delivery_window",
        signal_type: "constraint",
        allowed_values: &[
            "same_day",
            "next_day",
            "two_to_three_days",
            "within_week",
            "flexible",
        ],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "content.format",
        signal_type: "preference",
        allowed_values: &["short", "long_form", "video", "audio", "interactive"],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "content.topic_depth",
        signal_type: "preference",
        allowed_values: &["overview", "practical", "expert"],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "interest.topic",
        signal_type: "preference",
        allowed_values: &[
            "outdoor_travel",
            "technology",
            "wellness",
            "home",
            "entertainment",
        ],
        targeted_advertising_safe: true,
    },
    EnrichmentCatalogDefinition {
        key: "b2b.company_size",
        signal_type: "constraint",
        allowed_values: &["solo", "small", "mid_market", "enterprise"],
        targeted_advertising_safe: false,
    },
    EnrichmentCatalogDefinition {
        key: "b2b.primary_goal",
        signal_type: "intent",
        allowed_values: &[
            "evaluate",
            "integrate",
            "automate",
            "analyze",
            "collaborate",
        ],
        targeted_advertising_safe: false,
    },
    EnrichmentCatalogDefinition {
        key: "b2b.purchase_timeline",
        signal_type: "intent",
        allowed_values: &["now", "this_month", "this_quarter", "later", "exploring"],
        targeted_advertising_safe: false,
    },
    EnrichmentCatalogDefinition {
        key: "b2b.integration_priority",
        signal_type: "preference",
        allowed_values: &[
            "security",
            "reliability",
            "speed",
            "ease_of_use",
            "cost",
            "interoperability",
        ],
        targeted_advertising_safe: false,
    },
];

fn enrichment_catalog_schema() -> Vec<EnrichmentCatalogEntry> {
    ENRICHMENT_CATALOG
        .iter()
        .map(|definition| EnrichmentCatalogEntry {
            key: definition.key.to_owned(),
            signal_type: definition.signal_type.to_owned(),
            allowed_values: definition
                .allowed_values
                .iter()
                .map(ToString::to_string)
                .collect(),
            targeted_advertising_safe: definition.targeted_advertising_safe,
        })
        .collect()
}

fn catalog_summary(definition: &EnrichmentCatalogDefinition, value: &str) -> String {
    let label = definition.key.replace(['.', '_'], " ");
    let value = value.replace('_', " ");
    format!("{label}: {value}")
}

fn validate_enrichment_item(
    item: &crate::models::EnrichmentAnswerItemInput,
    purpose: &str,
) -> Result<&'static EnrichmentCatalogDefinition, ApiError> {
    let definition = ENRICHMENT_CATALOG
        .iter()
        .find(|definition| definition.key == item.key)
        .ok_or_else(|| ApiError::bad_request("Unknown customer context catalog key"))?;
    if definition.signal_type != item.signal_type
        || !definition.allowed_values.contains(&item.value.as_str())
    {
        return Err(ApiError::bad_request(
            "Customer context type or value is not allowed by the catalog",
        ));
    }
    if purpose == "targeted_advertising" && !definition.targeted_advertising_safe {
        return Err(ApiError::bad_request(
            "Customer context key is not approved for targeted advertising",
        ));
    }
    if !ENRICHMENT_PROVENANCES.contains(&item.provenance.as_str()) {
        return Err(ApiError::bad_request("Invalid customer context provenance"));
    }
    if item
        .confidence
        .is_some_and(|confidence| !(0.0..=1.0).contains(&confidence))
    {
        return Err(ApiError::bad_request("confidence must be between 0 and 1"));
    }
    Ok(definition)
}

async fn context_items_for_answer(
    tx: &mut Transaction<'_, Postgres>,
    answer_id: Uuid,
    purpose: &str,
) -> Result<Vec<CustomerContextItem>, ApiError> {
    sqlx::query_as::<_, CustomerContextItem>(
        r"SELECT signal.id AS signal_id, item.signal_key AS key,
          COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) AS signal_type,
          TO_JSONB(item.signal_value) AS value, signal.summary,
          signal.provenance, signal.confidence, item.expires_at,
          CASE WHEN signal.provenance = 'agent_inference' THEN ARRAY[]::TEXT[]
            ELSE ARRAY[$2::TEXT] END AS allowed_uses,
          item.remembered
        FROM enrichment_signal_items item
        JOIN customer_signals signal ON signal.id = item.signal_id
          AND signal.workspace_id = item.workspace_id
        WHERE item.enrichment_answer_id = $1 AND item.purpose = $2
        ORDER BY item.item_index",
    )
    .bind(answer_id)
    .bind(purpose)
    .fetch_all(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn active_enrichment_share_grant(
    tx: &mut Transaction<'_, Postgres>,
    request: &EnrichmentRequestRow,
    require_remember: bool,
) -> Result<Uuid, ApiError> {
    let mut required = vec!["share_preferences", "personalize"];
    if require_remember {
        required.push("remember_preferences");
    }
    let rows = sqlx::query_as::<_, (Uuid, String, String, bool)>(
        r"SELECT id, scope, state, (expires_at IS NULL OR expires_at > NOW()) AS active
        FROM consent_grants
        WHERE workspace_id = $1 AND environment_id = $2 AND subject = $3
          AND scope = ANY($4) AND enrichment_purpose = $5
        ORDER BY scope FOR UPDATE",
    )
    .bind(request.workspace_id)
    .bind(request.environment_id)
    .bind(&request.consent_subject)
    .bind(&required)
    .bind(&request.purpose)
    .fetch_all(&mut **tx)
    .await?;
    if !required.iter().all(|scope| {
        rows.iter()
            .any(|row| row.1 == *scope && row.2 == "approved" && row.3)
    }) {
        return Err(ApiError::forbidden(
            "Customer context permission is no longer active",
        ));
    }
    rows.into_iter()
        .find(|row| row.1 == "share_preferences")
        .map(|row| row.0)
        .ok_or_else(|| ApiError::forbidden("Preference sharing permission is not active"))
}

pub(crate) async fn submit_enrichment_answer(
    pool: &PgPool,
    capability: &str,
    input: EnrichmentAnswerInput,
) -> Result<EnrichmentAnswerResponse, ApiError> {
    if !["answered", "declined", "no_relevant_context"].contains(&input.status.as_str()) {
        return Err(ApiError::bad_request("Invalid enrichment answer status"));
    }
    if (input.status == "answered") == input.items.is_empty() || input.items.len() > 8 {
        return Err(ApiError::bad_request(
            "answered requires 1 to 8 items; other statuses require none",
        ));
    }
    let mut tx = pool.begin().await?;
    let (request, _) = verified_enrichment_request(&mut tx, capability).await?;
    for item in &input.items {
        validate_enrichment_item(item, &request.purpose)?;
    }
    let payload_hash = sha256_bytes(&serde_json::to_vec(&input).map_err(ApiError::internal)?);
    let existing = sqlx::query_as::<_, (Uuid, String, Vec<u8>)>(
        "SELECT id, status, payload_hash FROM enrichment_answers WHERE request_id = $1",
    )
    .bind(request.id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_none() && request.state != "answer_ready" {
        return Err(ApiError::forbidden(
            "Customer context sharing is not approved for this request",
        ));
    }
    let share_grant_id = active_enrichment_share_grant(
        &mut tx,
        &request,
        input.items.iter().any(|item| item.remember),
    )
    .await?;
    if let Some((answer_id, _, existing_hash)) = existing {
        if existing_hash != payload_hash {
            return Err(ApiError::conflict(
                "This enrichment request already has a different answer",
            ));
        }
        let signals = context_items_for_answer(&mut tx, answer_id, &request.purpose).await?;
        tx.commit().await?;
        return Ok(EnrichmentAnswerResponse {
            accepted: true,
            request_id: request.id,
            interaction_id: request.interaction_id,
            customer_id: request.customer_id,
            signals,
        });
    }
    if request.identity_level == "ephemeral" && input.items.iter().any(|item| item.remember) {
        return Err(ApiError::bad_request(
            "Ephemeral context cannot be remembered without a stable company reference",
        ));
    }
    if !request.remember && input.items.iter().any(|item| item.remember) {
        return Err(ApiError::bad_request(
            "This permission does not allow remembered context",
        ));
    }
    let answer_id = Uuid::new_v4();
    sqlx::query(
        r"INSERT INTO enrichment_answers
        (id, workspace_id, product_id, request_id, interaction_id, customer_id,
         status, payload_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(answer_id)
    .bind(request.workspace_id)
    .bind(request.product_id)
    .bind(request.id)
    .bind(request.interaction_id)
    .bind(request.customer_id)
    .bind(&input.status)
    .bind(&payload_hash)
    .execute(&mut *tx)
    .await?;
    let retained_until = Utc::now()
        + Duration::days(i64::from(
            sqlx::query_scalar::<_, i32>(
                "SELECT retention_days FROM product_environments WHERE id = $1",
            )
            .bind(request.environment_id)
            .fetch_one(&mut *tx)
            .await?,
        ));
    for (index, item) in input.items.iter().enumerate() {
        let definition = validate_enrichment_item(item, &request.purpose)?;
        let default_expiry = if item.remember {
            retained_until
        } else {
            request.expires_at
        };
        let expires_at = item.expires_at.unwrap_or(default_expiry);
        let maximum_expiry = if item.remember {
            retained_until
        } else {
            request.expires_at.min(retained_until)
        };
        if expires_at <= Utc::now() || expires_at > maximum_expiry {
            return Err(ApiError::bad_request(
                "expiresAt must be in the future and within the approved context lifetime",
            ));
        }
        let signal_id = Uuid::new_v4();
        let collected_at = Utc::now();
        sqlx::query(
            r"INSERT INTO customer_signals
            (id, workspace_id, product_id, customer_id, interaction_id,
             source_item_key, signal_type, summary, attributes, provenance, confidence,
             collection_basis, consent_grant_id, consent_scope, collected_at,
             expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
              'user_consent',$12,'share_preferences',$13,$14)",
        )
        .bind(signal_id)
        .bind(request.workspace_id)
        .bind(request.product_id)
        .bind(request.customer_id)
        .bind(request.interaction_id)
        .bind(format!("item:{}", index + 1))
        .bind(definition.signal_type)
        .bind(catalog_summary(definition, &item.value))
        .bind(serde_json::json!({
            "remembered": item.remember,
            "purpose": request.purpose,
            "enrichmentType": definition.signal_type,
            "catalogVersion": "v1",
        }))
        .bind(&item.provenance)
        .bind(item.confidence)
        .bind(share_grant_id)
        .bind(collected_at)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r"INSERT INTO enrichment_signal_items
            (signal_id, workspace_id, product_id, environment_id,
             enrichment_answer_id, customer_id, interaction_id, item_index,
             signal_key, signal_value, purpose, provenance, remembered,
             collected_at, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        )
        .bind(signal_id)
        .bind(request.workspace_id)
        .bind(request.product_id)
        .bind(request.environment_id)
        .bind(answer_id)
        .bind(request.customer_id)
        .bind(request.interaction_id)
        .bind(i16::try_from(index + 1).map_err(ApiError::internal)?)
        .bind(definition.key)
        .bind(&item.value)
        .bind(&request.purpose)
        .bind(&item.provenance)
        .bind(item.remember)
        .bind(collected_at)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
    }
    let request_state = if input.status == "answered" {
        "answered"
    } else if input.status == "no_relevant_context" {
        "no_relevant_context"
    } else {
        "declined"
    };
    sqlx::query(
        r"UPDATE enrichment_requests SET state = $2,
          answered_at = CASE WHEN $2 IN ('answered','no_relevant_context') THEN NOW() END,
          updated_at = NOW() WHERE id = $1",
    )
    .bind(request.id)
    .bind(request_state)
    .execute(&mut *tx)
    .await?;
    if input.status == "answered" {
        sqlx::query(
            r"INSERT INTO enrichment_interaction_confirmations
              (id, workspace_id, interaction_id, enrichment_answer_id, method, confirmed_at)
            VALUES ($1,$2,$3,$4,'enrichment_answer',NOW())
            ON CONFLICT (interaction_id) DO UPDATE SET
              confirmed_at = LEAST(
                enrichment_interaction_confirmations.confirmed_at,
                EXCLUDED.confirmed_at
              )",
        )
        .bind(Uuid::new_v4())
        .bind(request.workspace_id)
        .bind(request.interaction_id)
        .bind(answer_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE interactions_v2 SET updated_at = NOW() WHERE id = $1 AND workspace_id = $2",
        )
        .bind(request.interaction_id)
        .bind(request.workspace_id)
        .execute(&mut *tx)
        .await?;
    }
    let signals = context_items_for_answer(&mut tx, answer_id, &request.purpose).await?;
    tx.commit().await?;
    Ok(EnrichmentAnswerResponse {
        accepted: true,
        request_id: request.id,
        interaction_id: request.interaction_id,
        customer_id: request.customer_id,
        signals,
    })
}

async fn customer_for_identifier_value(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    kind: &str,
    value: Option<&str>,
) -> Result<Option<ResolvedCustomerRow>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let hash = customer_identifier_hash(
        identity_hmac_secret,
        auth.workspace.id,
        auth.environment.product_id,
        kind,
        value,
    )?;
    existing_customer_for_identifier(
        tx,
        auth.workspace.id,
        auth.environment.product_id,
        kind,
        &hash,
    )
    .await
}

async fn lookup_context_customer(
    tx: &mut Transaction<'_, Postgres>,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    refs: &ValidatedIdentityRefs,
) -> Result<Option<(Uuid, String)>, ApiError> {
    let user = customer_for_identifier_value(
        tx,
        auth,
        identity_hmac_secret,
        "user_ref",
        refs.user_ref.as_deref(),
    )
    .await?;
    let account = customer_for_identifier_value(
        tx,
        auth,
        identity_hmac_secret,
        "account_ref",
        refs.account_ref.as_deref(),
    )
    .await?;
    if let (Some(user), Some(account)) = (&user, &account)
        && user.parent_customer_id != Some(account.merged_into_customer_id.unwrap_or(account.id))
    {
        return Err(ApiError::conflict(
            "userRef is not linked to the supplied accountRef",
        ));
    }
    let generic = customer_for_identifier_value(
        tx,
        auth,
        identity_hmac_secret,
        "customer_ref",
        refs.customer_ref.as_deref(),
    )
    .await?;
    let known = user.or(account).or(generic);
    let anonymous = customer_for_identifier_value(
        tx,
        auth,
        identity_hmac_secret,
        "anonymous_ref",
        refs.anonymous_ref.as_deref(),
    )
    .await?;
    let canonical = |row: &ResolvedCustomerRow| row.merged_into_customer_id.unwrap_or(row.id);
    if let (Some(known), Some(anonymous)) = (&known, &anonymous)
        && canonical(known) != canonical(anonymous)
    {
        return Err(ApiError::conflict(
            "anonymousRef has not been deterministically linked to this customer",
        ));
    }
    let selected = known.or(anonymous);
    Ok(selected.map(|row| (canonical(&row), row.identity_level)))
}

pub(crate) async fn retrieve_customer_context(
    pool: &PgPool,
    auth: &ProductAuth,
    identity_hmac_secret: &[u8],
    input: CustomerContextInput,
) -> Result<CustomerContextResponse, ApiError> {
    validate_enrichment_purpose(&input.purpose)?;
    let refs = validated_identity_refs(
        input.customer_ref.as_deref(),
        input.account_ref.as_deref(),
        input.user_ref.as_deref(),
        input.anonymous_ref.as_deref(),
    )?;
    let has_refs = refs.customer_ref.is_some()
        || refs.account_ref.is_some()
        || refs.user_ref.is_some()
        || refs.anonymous_ref.is_some();
    if !has_refs && input.interaction_id.is_none() {
        return Err(ApiError::bad_request(
            "Provide a company identity reference or interactionId",
        ));
    }
    let mut tx = pool.begin().await?;
    let by_ref = lookup_context_customer(&mut tx, auth, identity_hmac_secret, &refs).await?;
    if has_refs && by_ref.is_none() {
        return Err(ApiError::not_found("Customer context not found"));
    }
    let by_interaction = if let Some(interaction_id) = input.interaction_id {
        Some(
            sqlx::query_as::<_, (Option<Uuid>, Option<String>)>(
                r"SELECT interaction.customer_id, customer.identity_level
                FROM interactions_v2 interaction
                LEFT JOIN customers customer ON customer.id = interaction.customer_id
                  AND customer.workspace_id = interaction.workspace_id
                WHERE interaction.id = $1 AND interaction.workspace_id = $2
                  AND interaction.environment_id = $3",
            )
            .bind(interaction_id)
            .bind(auth.workspace.id)
            .bind(auth.environment.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::not_found("Interaction not found"))?,
        )
    } else {
        None
    };
    if let (Some((ref_customer, _)), Some((interaction_customer, _))) = (&by_ref, &by_interaction)
        && *interaction_customer != Some(*ref_customer)
    {
        return Err(ApiError::conflict(
            "interactionId belongs to a different customer context",
        ));
    }
    let customer_id = by_ref
        .as_ref()
        .map(|value| value.0)
        .or_else(|| by_interaction.as_ref().and_then(|value| value.0));
    let identity_level = by_ref
        .as_ref()
        .map(|value| value.1.clone())
        .or_else(|| by_interaction.as_ref().and_then(|value| value.1.clone()))
        .unwrap_or_else(|| "ephemeral".to_owned());
    let items = sqlx::query_as::<_, CustomerContextItem>(
        r"SELECT DISTINCT ON (item.signal_key)
          signal.id AS signal_id, item.signal_key AS key,
          COALESCE(signal.attributes->>'enrichmentType', signal.signal_type) AS signal_type,
          TO_JSONB(item.signal_value) AS value, signal.summary,
          signal.provenance, signal.confidence, item.expires_at,
          ARRAY[request.purpose] AS allowed_uses,
          item.remembered
        FROM enrichment_signal_items item
        JOIN customer_signals signal ON signal.id = item.signal_id
          AND signal.workspace_id = item.workspace_id
        JOIN enrichment_answers answer ON answer.id = item.enrichment_answer_id
          AND answer.workspace_id = item.workspace_id
        JOIN enrichment_requests request ON request.id = answer.request_id
          AND request.workspace_id = answer.workspace_id
        JOIN LATERAL (
          SELECT candidate.subject
          FROM consent_grants candidate
          WHERE candidate.environment_id = request.environment_id
            AND candidate.workspace_id = request.workspace_id
            AND candidate.enrichment_purpose = request.purpose
            AND (candidate.subject = request.consent_subject
              OR (item.customer_id IS NOT NULL AND candidate.customer_id = item.customer_id))
          ORDER BY candidate.decided_at DESC, candidate.revision DESC,
            CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
            candidate.subject, candidate.id
          LIMIT 1
        ) effective_consent ON TRUE
        JOIN consent_grants original_share ON original_share.id = signal.consent_grant_id
          AND original_share.workspace_id = signal.workspace_id
          AND original_share.enrichment_purpose = request.purpose
          AND original_share.state = 'approved'
          AND (original_share.expires_at IS NULL OR original_share.expires_at > NOW())
        JOIN consent_grants share_grant ON share_grant.environment_id = request.environment_id
          AND share_grant.subject = effective_consent.subject
          AND share_grant.scope = 'share_preferences'
          AND share_grant.enrichment_purpose = request.purpose
          AND share_grant.state = 'approved'
          AND (share_grant.expires_at IS NULL OR share_grant.expires_at > NOW())
        JOIN consent_grants purpose_grant ON purpose_grant.environment_id = request.environment_id
          AND purpose_grant.subject = effective_consent.subject
          AND purpose_grant.scope = 'personalize'
          AND purpose_grant.enrichment_purpose = request.purpose
          AND purpose_grant.state = 'approved'
          AND (purpose_grant.expires_at IS NULL OR purpose_grant.expires_at > NOW())
        LEFT JOIN consent_grants remember_grant
          ON remember_grant.environment_id = request.environment_id
          AND remember_grant.subject = effective_consent.subject
          AND remember_grant.scope = 'remember_preferences'
          AND remember_grant.enrichment_purpose = request.purpose
          AND remember_grant.state = 'approved'
          AND (remember_grant.expires_at IS NULL OR remember_grant.expires_at > NOW())
        WHERE item.workspace_id = $1 AND item.product_id = $2
          AND item.environment_id = $3 AND item.purpose = $4
          AND item.provenance <> 'agent_inference' AND item.expires_at > NOW()
          AND (($5::UUID IS NOT NULL AND item.interaction_id = $5)
            OR ($6::UUID IS NOT NULL AND item.customer_id = $6
              AND item.remembered
              AND remember_grant.id IS NOT NULL))
        ORDER BY item.signal_key, item.collected_at DESC, item.signal_id DESC
        LIMIT 100",
    )
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .bind(&input.purpose)
    .bind(input.interaction_id)
    .bind(customer_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut version_material = input.purpose.as_bytes().to_vec();
    for item in &items {
        version_material.extend_from_slice(item.signal_id.as_bytes());
    }
    let context_version = format!(
        "ctx1_{}",
        URL_SAFE_NO_PAD.encode(sha256_bytes(&version_material))
    );
    let retrieval_id = Uuid::new_v4();
    sqlx::query(
        r"INSERT INTO customer_context_retrievals
        (id, workspace_id, product_id, environment_id, customer_id, interaction_id,
         purpose, identity_level, context_version, item_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(retrieval_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .bind(customer_id)
    .bind(input.interaction_id)
    .bind(&input.purpose)
    .bind(&identity_level)
    .bind(&context_version)
    .bind(i32::try_from(items.len()).map_err(ApiError::internal)?)
    .execute(&mut *tx)
    .await?;
    for item in &items {
        sqlx::query(
            r"INSERT INTO customer_context_retrieval_signals
            (workspace_id, retrieval_id, signal_id) VALUES ($1,$2,$3)",
        )
        .bind(auth.workspace.id)
        .bind(retrieval_id)
        .bind(item.signal_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(CustomerContextResponse {
        retrieval_id,
        identity_level,
        customer_id,
        interaction_id: input.interaction_id,
        context_version,
        items,
    })
}

async fn decision_response(
    tx: &mut Transaction<'_, Postgres>,
    decision_id: Uuid,
) -> Result<PersonalizationDecisionResponse, ApiError> {
    let row = sqlx::query_as::<_, (String, String, Option<String>, DateTime<Utc>)>(
        r"SELECT external_decision_id, purpose, variant, created_at
        FROM personalization_decisions WHERE id = $1",
    )
    .bind(decision_id)
    .fetch_one(&mut **tx)
    .await?;
    let signal_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT signal_id FROM personalization_decision_signals WHERE decision_id = $1 ORDER BY signal_id",
    )
    .bind(decision_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(PersonalizationDecisionResponse {
        decision: PersonalizationDecision {
            id: decision_id,
            external_decision_id: row.0,
            purpose: row.1,
            signal_ids,
            variant: row.2,
            created_at: row.3,
        },
    })
}

pub(crate) async fn record_personalization_decision(
    pool: &PgPool,
    auth: &ProductAuth,
    mut input: PersonalizationDecisionInput,
) -> Result<PersonalizationDecisionResponse, ApiError> {
    input.external_decision_id =
        validate_opaque_event_id(&input.external_decision_id, "externalDecisionId")?;
    input.variant = input
        .variant
        .map(|value| validate_opaque_event_id(&value, "variant"))
        .transpose()?;
    if input.signal_ids.is_empty() || input.signal_ids.len() > 50 {
        return Err(ApiError::bad_request(
            "signalIds must contain 1 to 50 items",
        ));
    }
    input.signal_ids.sort_unstable();
    input.signal_ids.dedup();
    let payload_hash = sha256_bytes(&serde_json::to_vec(&input).map_err(ApiError::internal)?);
    let mut tx = pool.begin().await?;
    let retrieval = sqlx::query_as::<_, (Option<Uuid>, Option<Uuid>, String)>(
        r"SELECT customer_id, interaction_id, purpose FROM customer_context_retrievals
        WHERE id = $1 AND workspace_id = $2 AND product_id = $3 AND environment_id = $4",
    )
    .bind(input.context_retrieval_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::not_found("Customer context retrieval not found"))?;
    // Serialize activation with consent changes. The following evidence query
    // runs after these locks are acquired, so a revoke either wins first and
    // rejects the decision or waits until this already-authorized decision
    // commits; it cannot race between validation and storage.
    sqlx::query_scalar::<_, Uuid>(
        r"SELECT grant_row.id
        FROM customer_context_retrieval_signals link
        JOIN enrichment_signal_items item ON item.signal_id = link.signal_id
          AND item.workspace_id = link.workspace_id
        JOIN customer_signals signal ON signal.id = item.signal_id
          AND signal.workspace_id = link.workspace_id
        JOIN enrichment_answers answer ON answer.id = item.enrichment_answer_id
          AND answer.workspace_id = signal.workspace_id
        JOIN enrichment_requests request ON request.id = answer.request_id
          AND request.workspace_id = answer.workspace_id
        JOIN LATERAL (
          SELECT candidate.subject
          FROM consent_grants candidate
          WHERE candidate.environment_id = request.environment_id
            AND candidate.workspace_id = request.workspace_id
            AND candidate.enrichment_purpose = request.purpose
            AND (candidate.subject = request.consent_subject
              OR (item.customer_id IS NOT NULL AND candidate.customer_id = item.customer_id))
          ORDER BY candidate.decided_at DESC, candidate.revision DESC,
            CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
            candidate.subject, candidate.id LIMIT 1
        ) effective_consent ON TRUE
        JOIN consent_grants grant_row ON grant_row.environment_id = request.environment_id
          AND grant_row.workspace_id = request.workspace_id
          AND grant_row.subject = effective_consent.subject
          AND grant_row.scope IN ('share_preferences', 'personalize', 'remember_preferences')
        WHERE link.workspace_id = $1 AND link.retrieval_id = $2
          AND link.signal_id = ANY($3)
        ORDER BY grant_row.id FOR UPDATE OF grant_row",
    )
    .bind(auth.workspace.id)
    .bind(input.context_retrieval_id)
    .bind(&input.signal_ids)
    .fetch_all(&mut *tx)
    .await?;
    let available = sqlx::query_scalar::<_, Uuid>(
        r"SELECT link.signal_id FROM customer_context_retrieval_signals link
        JOIN enrichment_signal_items item ON item.signal_id = link.signal_id
          AND item.workspace_id = link.workspace_id
        JOIN customer_signals signal ON signal.id = item.signal_id
          AND signal.workspace_id = link.workspace_id
        JOIN enrichment_answers answer ON answer.id = item.enrichment_answer_id
          AND answer.workspace_id = signal.workspace_id
        JOIN enrichment_requests request ON request.id = answer.request_id
          AND request.workspace_id = answer.workspace_id
        JOIN LATERAL (
          SELECT candidate.subject
          FROM consent_grants candidate
          WHERE candidate.environment_id = request.environment_id
            AND candidate.workspace_id = request.workspace_id
            AND candidate.enrichment_purpose = request.purpose
            AND (candidate.subject = request.consent_subject
              OR (item.customer_id IS NOT NULL AND candidate.customer_id = item.customer_id))
          ORDER BY candidate.decided_at DESC, candidate.revision DESC,
            CASE WHEN candidate.state IN ('declined', 'revoked') THEN 1 ELSE 0 END DESC,
            candidate.subject, candidate.id LIMIT 1
        ) effective_consent ON TRUE
        JOIN consent_grants original_share ON original_share.id = signal.consent_grant_id
          AND original_share.workspace_id = signal.workspace_id
          AND original_share.enrichment_purpose = request.purpose
          AND original_share.state = 'approved'
          AND (original_share.expires_at IS NULL OR original_share.expires_at > NOW())
        JOIN consent_grants share_grant ON share_grant.environment_id = request.environment_id
          AND share_grant.subject = effective_consent.subject
          AND share_grant.scope = 'share_preferences'
          AND share_grant.enrichment_purpose = request.purpose
          AND share_grant.state = 'approved'
          AND (share_grant.expires_at IS NULL OR share_grant.expires_at > NOW())
        JOIN consent_grants purpose_grant ON purpose_grant.environment_id = request.environment_id
          AND purpose_grant.subject = effective_consent.subject
          AND purpose_grant.scope = 'personalize'
          AND purpose_grant.enrichment_purpose = request.purpose
          AND purpose_grant.state = 'approved'
          AND (purpose_grant.expires_at IS NULL OR purpose_grant.expires_at > NOW())
        LEFT JOIN consent_grants remember_grant
          ON remember_grant.environment_id = request.environment_id
          AND remember_grant.subject = effective_consent.subject
          AND remember_grant.scope = 'remember_preferences'
          AND remember_grant.enrichment_purpose = request.purpose
          AND remember_grant.state = 'approved'
          AND (remember_grant.expires_at IS NULL OR remember_grant.expires_at > NOW())
        WHERE link.workspace_id = $1 AND link.retrieval_id = $2
          AND link.signal_id = ANY($3)
          AND item.provenance <> 'agent_inference'
          AND (
            NOT item.remembered
            OR remember_grant.id IS NOT NULL
          )
          AND item.expires_at > NOW()",
    )
    .bind(auth.workspace.id)
    .bind(input.context_retrieval_id)
    .bind(&input.signal_ids)
    .fetch_all(&mut *tx)
    .await?;
    let available = available.into_iter().collect::<BTreeSet<_>>();
    if input.signal_ids.iter().any(|id| !available.contains(id)) {
        return Err(ApiError::bad_request(
            "Every signalId must come from the specified context retrieval",
        ));
    }
    let (decision_id, existing_hash) = sqlx::query_as::<_, (Uuid, Vec<u8>)>(
        r"INSERT INTO personalization_decisions
        (id, workspace_id, product_id, environment_id, retrieval_id, interaction_id,
         customer_id, external_decision_id, purpose, variant, payload_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (workspace_id, product_id, external_decision_id) DO UPDATE SET
          external_decision_id = personalization_decisions.external_decision_id
        RETURNING id, payload_hash",
    )
    .bind(Uuid::new_v4())
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .bind(input.context_retrieval_id)
    .bind(retrieval.1)
    .bind(retrieval.0)
    .bind(&input.external_decision_id)
    .bind(&retrieval.2)
    .bind(&input.variant)
    .bind(&payload_hash)
    .fetch_one(&mut *tx)
    .await?;
    if existing_hash != payload_hash {
        return Err(ApiError::conflict(
            "externalDecisionId already has a different payload",
        ));
    }
    for signal_id in &input.signal_ids {
        sqlx::query(
            r"INSERT INTO personalization_decision_signals
            (workspace_id, decision_id, signal_id) VALUES ($1,$2,$3)
            ON CONFLICT (decision_id, signal_id) DO NOTHING",
        )
        .bind(auth.workspace.id)
        .bind(decision_id)
        .bind(signal_id)
        .execute(&mut *tx)
        .await?;
    }
    let response = decision_response(&mut tx, decision_id).await?;
    tx.commit().await?;
    Ok(response)
}

pub(crate) async fn record_personalization_outcome(
    pool: &PgPool,
    auth: &ProductAuth,
    mut input: PersonalizationOutcomeInput,
) -> Result<PersonalizationOutcomeResponse, ApiError> {
    input.external_outcome_id =
        validate_opaque_event_id(&input.external_outcome_id, "externalOutcomeId")?;
    if ![
        "conversion",
        "completion",
        "engagement",
        "dismissal",
        "abandonment",
    ]
    .contains(&input.outcome.as_str())
    {
        return Err(ApiError::bad_request("Invalid personalization outcome"));
    }
    let occurred_at = input.occurred_at.unwrap_or_else(Utc::now);
    if occurred_at > Utc::now() + Duration::minutes(5)
        || occurred_at < Utc::now() - Duration::days(7)
    {
        return Err(ApiError::bad_request(
            "occurredAt is outside the accepted window",
        ));
    }
    let payload_hash = sha256_bytes(&serde_json::to_vec(&input).map_err(ApiError::internal)?);
    let mut tx = pool.begin().await?;
    let decision_exists = sqlx::query_scalar::<_, bool>(
        r"SELECT EXISTS (SELECT 1 FROM personalization_decisions
          WHERE id = $1 AND workspace_id = $2 AND product_id = $3 AND environment_id = $4)",
    )
    .bind(input.decision_id)
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(auth.environment.id)
    .fetch_one(&mut *tx)
    .await?;
    if !decision_exists {
        return Err(ApiError::not_found("Personalization decision not found"));
    }
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            Uuid,
            String,
            DateTime<Utc>,
            DateTime<Utc>,
            Vec<u8>,
        ),
    >(
        r"INSERT INTO personalization_outcomes
        (id, workspace_id, product_id, decision_id, external_outcome_id,
         outcome, payload_hash, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (workspace_id, product_id, external_outcome_id) DO UPDATE SET
          external_outcome_id = personalization_outcomes.external_outcome_id
        RETURNING id, external_outcome_id, decision_id, outcome, occurred_at, created_at,
          payload_hash",
    )
    .bind(Uuid::new_v4())
    .bind(auth.workspace.id)
    .bind(auth.environment.product_id)
    .bind(input.decision_id)
    .bind(input.external_outcome_id)
    .bind(input.outcome)
    .bind(&payload_hash)
    .bind(occurred_at)
    .fetch_one(&mut *tx)
    .await?;
    if row.6 != payload_hash {
        return Err(ApiError::conflict(
            "externalOutcomeId already has a different payload",
        ));
    }
    let outcome = PersonalizationOutcome {
        id: row.0,
        external_outcome_id: row.1,
        decision_id: row.2,
        outcome: row.3,
        occurred_at: row.4,
        created_at: row.5,
    };
    tx.commit().await?;
    Ok(PersonalizationOutcomeResponse { outcome })
}

#[cfg(test)]
mod product_tests {
    #![allow(
        clippy::expect_used,
        reason = "test failures should abort at the assertion site with explicit context"
    )]

    use std::{
        str::FromStr,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use anyhow::Context as _;
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use crate::{
        PinnedCommitVerifier,
        code_match::{
            CodeMatchVerificationTracker, CodeSearchCandidate, CodeSearchMatches, CodeSearchQuery,
            CodeSearchVerification,
        },
        github::{
            GithubFileContentError, GithubFileContentFailureKind, GithubPinnedCommitError,
            GithubPinnedCommitFailureKind,
        },
        models::{ConsentDecisionInput, CurrentUser},
    };

    use super::*;

    const TEST_IDENTITY_HMAC_SECRET: &[u8] = b"epode-test-identity-hmac-secret-32-bytes-minimum";

    async fn ingest_telemetry_batch(
        pool: &PgPool,
        auth: &ProductAuth,
        input: TelemetryBatchInput,
    ) -> Result<TelemetryBatchResult, ApiError> {
        super::ingest_telemetry_batch(pool, auth, TEST_IDENTITY_HMAC_SECRET, input).await
    }

    fn test_error(error: ApiError) -> anyhow::Error {
        let ApiError { status, message } = error;
        anyhow::anyhow!("{status}: {message}")
    }

    #[derive(Debug)]
    struct TestPinnedCommitVerifier {
        available: AtomicBool,
        failure_kind: Mutex<GithubPinnedCommitFailureKind>,
        calls: Mutex<Vec<(String, String)>>,
        file_available: AtomicBool,
        file_failure_kind: Mutex<GithubFileContentFailureKind>,
        file_calls: Mutex<Vec<(String, String, String)>>,
    }

    impl TestPinnedCommitVerifier {
        fn new(available: bool) -> Self {
            Self {
                available: AtomicBool::new(available),
                failure_kind: Mutex::new(GithubPinnedCommitFailureKind::NotFound),
                calls: Mutex::new(Vec::new()),
                file_available: AtomicBool::new(true),
                file_failure_kind: Mutex::new(GithubFileContentFailureKind::Server),
                file_calls: Mutex::new(Vec::new()),
            }
        }

        fn set_available(&self, available: bool) {
            self.available.store(available, Ordering::SeqCst);
        }

        fn calls(&self) -> usize {
            self.calls
                .lock()
                .expect("call log lock should be live")
                .len()
        }

        fn set_failure_kind(&self, kind: GithubPinnedCommitFailureKind) {
            *self
                .failure_kind
                .lock()
                .expect("failure-kind lock should be live") = kind;
        }

        fn called_repos(&self) -> Vec<String> {
            self.calls
                .lock()
                .expect("call log lock should be live")
                .iter()
                .map(|(repo, _)| repo.clone())
                .collect()
        }

        fn set_file_available(&self, available: bool) {
            self.file_available.store(available, Ordering::SeqCst);
        }

        fn file_calls(&self) -> usize {
            self.file_calls
                .lock()
                .expect("file call log lock should be live")
                .len()
        }
    }

    impl PinnedCommitVerifier for TestPinnedCommitVerifier {
        async fn pinned_commit_is_fetchable(
            &self,
            repo_full_name: &str,
            computed_at_sha: &str,
        ) -> Result<(), GithubPinnedCommitError> {
            self.calls
                .lock()
                .expect("call log lock should be live")
                .push((repo_full_name.to_owned(), computed_at_sha.to_owned()));
            if self.available.load(Ordering::SeqCst) {
                return Ok(());
            }
            Err(GithubPinnedCommitError::for_test(
                *self
                    .failure_kind
                    .lock()
                    .expect("failure-kind lock should be live"),
            ))
        }

        async fn pinned_file_content(
            &self,
            repo_full_name: &str,
            file: &str,
            computed_at_sha: &str,
        ) -> Result<String, GithubFileContentError> {
            self.file_calls
                .lock()
                .expect("file call log lock should be live")
                .push((
                    repo_full_name.to_owned(),
                    file.to_owned(),
                    computed_at_sha.to_owned(),
                ));
            if self.file_available.load(Ordering::SeqCst) {
                return Ok("verified fragment".to_owned());
            }
            Err(GithubFileContentError::for_test(
                *self
                    .file_failure_kind
                    .lock()
                    .expect("file failure-kind lock should be live"),
            ))
        }
    }

    fn provisional_file_404_matches(count: usize) -> Vec<CodeSearchMatches> {
        vec![CodeSearchMatches {
            query: CodeSearchQuery::for_test("operation token"),
            candidates: (0..count)
                .map(|index| CodeSearchCandidate {
                    file: format!("src/missing-{index}.rs"),
                    line_start: None,
                    line_end: None,
                    verification: CodeSearchVerification::FileNotFound,
                })
                .collect(),
        }]
    }

    fn verified_code_matches(file: &str) -> Vec<CodeSearchMatches> {
        vec![CodeSearchMatches {
            query: CodeSearchQuery::for_test("operation token"),
            candidates: vec![CodeSearchCandidate {
                file: file.to_owned(),
                line_start: Some(1),
                line_end: Some(1),
                verification: CodeSearchVerification::Verified,
            }],
        }]
    }

    fn pending_code_verification(file: &str) -> serde_json::Value {
        let query = CodeSearchQuery::for_test("operation token");
        serde_json::to_value(crate::PendingCodeMatchVerification {
            pending: vec![crate::PendingGithubCodeSearchMatches {
                query: query.clone(),
                candidates: vec![
                    crate::github::GithubCodeSearchCandidate::with_fragment_for_test(
                        file,
                        "verified fragment",
                    ),
                ],
            }],
            resolved: vec![CodeSearchMatches {
                query,
                candidates: Vec::new(),
            }],
            verification: CodeMatchVerificationTracker::default(),
        })
        .expect("pending code verification should serialize")
    }

    async fn submit_mapped_code_match_report(
        pool: &PgPool,
        write_secret: &str,
        write_key_id: Uuid,
        summary: &str,
    ) -> anyhow::Result<(Uuid, ProductFeedbackReport)> {
        let interaction_id = Uuid::new_v4();
        let capability = test_capability(write_secret, write_key_id, interaction_id);
        let (_, report) = submit_product_feedback(pool, &capability, feedback_input(summary))
            .await
            .map_err(test_error)?;
        Ok((interaction_id, report))
    }

    fn api_key_headers(secret: &str) -> anyhow::Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {secret}"))?,
        );
        Ok(headers)
    }

    fn test_capability_with_subject(
        secret: &str,
        key_id: Uuid,
        interaction_id: Uuid,
        subject: Option<&str>,
    ) -> String {
        test_capability_with_subject_revision(secret, key_id, interaction_id, subject, None)
    }

    fn test_capability_with_subject_revision(
        secret: &str,
        key_id: Uuid,
        interaction_id: Uuid,
        subject: Option<&str>,
        revision: Option<i64>,
    ) -> String {
        test_capability_with_subject_revision_issued_at(
            secret,
            key_id,
            interaction_id,
            subject,
            revision,
            Utc::now().timestamp(),
        )
    }

    fn test_capability_with_subject_revision_issued_at(
        secret: &str,
        key_id: Uuid,
        interaction_id: Uuid,
        subject: Option<&str>,
        revision: Option<i64>,
        issued_at: i64,
    ) -> String {
        let claims = crate::security::CapabilityClaims {
            v: 1,
            i: interaction_id,
            iat: issued_at,
            exp: issued_at + Duration::hours(1).num_seconds(),
            n: format!("nonce-{}", Uuid::new_v4().simple()),
            s: subject.map(str::to_owned),
            r: revision,
        };
        let payload = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).expect("capability claims should serialize"));
        let signing_input = format!("afr2_{}.{payload}", key_id.simple());
        let mut mac = Hmac::<Sha256>::new_from_slice(&sha256(secret))
            .expect("HMAC accepts SHA-256 key material");
        mac.update(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn test_capability(secret: &str, key_id: Uuid, interaction_id: Uuid) -> String {
        test_capability_with_subject(secret, key_id, interaction_id, None)
    }

    fn feedback_input(summary: &str) -> ProductFeedbackReportInput {
        ProductFeedbackReportInput {
            summary: summary.into(),
            impact: Some("helped".into()),
            confidence: Some(0.95),
            findings: vec![],
            workaround: None,
        }
    }

    fn feedback_input_with_finding(summary: &str, topic: &str) -> ProductFeedbackReportInput {
        let mut input = feedback_input(summary);
        input.findings = vec![FeedbackFindingInput {
            kind: "defect".into(),
            topic: topic.into(),
            severity: Some("major".into()),
            detail: "Search failed for a valid request.".into(),
        }];
        input
    }

    fn grouping_telemetry_event(interaction_id: Uuid) -> InteractionTelemetryInput {
        InteractionTelemetryInput {
            interaction_id,
            sequence: Some(1),
            surface: "mcp".into(),
            operation: "search_reports".into(),
            status_code: Some(503),
            duration_ms: Some(25),
            customer_ref: None,
            account_ref: None,
            user_ref: None,
            anonymous_ref: None,
            classification: Some("confirmed".into()),
            confirmation_method: Some("mcp".into()),
            runtime_hint: None,
            runtime_hint_source: None,
            session_ref: None,
            session_source: None,
            occurred_at: Some(Utc::now()),
        }
    }

    fn http_telemetry_event(
        interaction_id: Uuid,
        occurred_at: DateTime<Utc>,
    ) -> InteractionTelemetryInput {
        InteractionTelemetryInput {
            interaction_id,
            sequence: Some(1),
            surface: "http_json".into(),
            operation: "/v1/search".into(),
            status_code: Some(200),
            duration_ms: Some(25),
            customer_ref: None,
            account_ref: None,
            user_ref: None,
            anonymous_ref: None,
            classification: None,
            confirmation_method: None,
            runtime_hint: None,
            runtime_hint_source: None,
            session_ref: None,
            session_source: None,
            occurred_at: Some(occurred_at),
        }
    }

    async fn activation_milestones(
        pool: &PgPool,
        workspace_id: Uuid,
        product_id: Uuid,
    ) -> anyhow::Result<ProductActivationMilestones> {
        sqlx::query_as::<_, ProductActivationMilestones>(
            r"SELECT workspace_id, product_id, first_opportunity_at,
              first_confirmed_interaction_at, first_report_at
            FROM product_activation_milestones
            WHERE workspace_id = $1 AND product_id = $2",
        )
        .bind(workspace_id)
        .bind(product_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    }

    #[derive(Debug)]
    struct MetadataRefreshingGrouper;

    impl ReportGrouper for MetadataRefreshingGrouper {
        fn name(&self) -> &'static str {
            "metadata-test"
        }

        fn version(&self) -> i32 {
            2
        }

        fn assign(&self, input: &GroupInput<'_>) -> crate::grouping::GroupAssignment {
            let mut assignment = crate::grouping::FingerprintGrouper.assign(input);
            assignment.explanation = "refreshed grouper explanation".into();
            assignment
        }
    }

    async fn telemetry_test_workspace(pool: &PgPool, label: &str) -> anyhow::Result<Workspace> {
        let workspace_id = Uuid::new_v4();
        sqlx::query_as::<_, Workspace>(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, $3, $4) RETURNING *",
        )
        .bind(workspace_id)
        .bind(format!("usr_telemetry_{}", workspace_id.simple()))
        .bind(label)
        .bind(format!(
            "telemetry-{}",
            &workspace_id.simple().to_string()[..12]
        ))
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    }

    async fn telemetry_test_product(
        pool: &PgPool,
        workspace: &Workspace,
        name: &str,
    ) -> anyhow::Result<(Product, ProductAuth)> {
        let (product, environment) =
            create_product(pool, workspace.id, CreateProductInput { name: name.into() })
                .await
                .map_err(test_error)?;
        let (key, _) = create_api_key(
            pool,
            workspace.id,
            environment.id,
            Some(format!("{name} telemetry")),
            None,
            None,
        )
        .await
        .map_err(test_error)?;
        Ok((
            product,
            ProductAuth {
                workspace: workspace.clone(),
                environment,
                api_key_id: key.id,
            },
        ))
    }

    fn mcp_telemetry_event(
        interaction_id: Uuid,
        sequence: Option<i64>,
        operation: &str,
        session_ref: Option<&str>,
        session_source: Option<&str>,
        occurred_at: DateTime<Utc>,
    ) -> InteractionTelemetryInput {
        InteractionTelemetryInput {
            interaction_id,
            sequence,
            surface: "mcp".into(),
            operation: operation.into(),
            status_code: Some(200),
            duration_ms: Some(10),
            customer_ref: None,
            account_ref: None,
            user_ref: None,
            anonymous_ref: None,
            classification: Some("confirmed".into()),
            confirmation_method: Some("mcp".into()),
            runtime_hint: None,
            runtime_hint_source: None,
            session_ref: session_ref.map(str::to_owned),
            session_source: session_source.map(str::to_owned),
            occurred_at: Some(occurred_at),
        }
    }

    async fn interaction_session(
        pool: &PgPool,
        interaction_id: Uuid,
    ) -> anyhow::Result<Option<Uuid>> {
        sqlx::query_scalar("SELECT session_id FROM interactions_v2 WHERE id = $1")
            .bind(interaction_id)
            .fetch_one(pool)
            .await
            .map_err(Into::into)
    }

    async fn github_test_workspace(pool: &PgPool, label: &str) -> anyhow::Result<Uuid> {
        let workspace_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, $3, $4)",
        )
        .bind(workspace_id)
        .bind(format!("usr_github_{}", workspace_id.simple()))
        .bind(label)
        .bind(format!(
            "github-{}",
            &workspace_id.simple().to_string()[..12]
        ))
        .execute(pool)
        .await?;
        Ok(workspace_id)
    }

    #[derive(Debug)]
    struct GithubIssueGroupFixture {
        workspace_id: Uuid,
        product_id: Uuid,
        environment_id: Uuid,
        group_id: Uuid,
        group_key: String,
        installation_id: i64,
    }

    async fn github_issue_group_fixture(
        pool: &PgPool,
        label: &str,
        report_count: usize,
    ) -> anyhow::Result<GithubIssueGroupFixture> {
        let workspace_id = github_test_workspace(pool, label).await?;
        let (product, environment) = create_product(
            pool,
            workspace_id,
            CreateProductInput {
                name: label.to_owned(),
            },
        )
        .await
        .map_err(test_error)?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);
        upsert_github_installation(
            pool,
            workspace_id,
            installation_id,
            "epode-test",
            "Organization",
        )
        .await
        .map_err(test_error)?;
        set_product_github_repo(
            pool,
            workspace_id,
            product.id,
            &ProductGithubRepoInput {
                installation_id,
                repo_full_name: "open-software/epode-test".to_owned(),
                default_branch: "main".to_owned(),
                path_prefix: None,
            },
        )
        .await
        .map_err(test_error)?;
        let group_id = Uuid::new_v4();
        let group_key = Uuid::new_v4().simple().to_string();
        sqlx::query(
            r"INSERT INTO report_groups
            (id, workspace_id, product_id, group_key, grouper_name, grouper_version, explanation)
            VALUES ($1, $2, $3, $4, 'fingerprint', 1, 'test issue filing group')",
        )
        .bind(group_id)
        .bind(workspace_id)
        .bind(product.id)
        .bind(&group_key)
        .execute(pool)
        .await?;
        for index in 0..report_count {
            let interaction_id = Uuid::new_v4();
            let occurred_at = Utc::now() + Duration::seconds(i64::try_from(index)?);
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, surface, operation, status_code,
                 classification, confirmation_method, occurred_at)
                VALUES ($1, $2, $3, 'mcp', 'search_reports', 503, 'confirmed', 'mcp', $4)",
            )
            .bind(interaction_id)
            .bind(workspace_id)
            .bind(environment.id)
            .bind(occurred_at)
            .execute(pool)
            .await?;
            sqlx::query(
                r"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, impact, findings, workaround, group_id)
                VALUES ($1, $2, $3, $4, 'blocked', $5, $6, $7)",
            )
            .bind(Uuid::new_v4())
            .bind(workspace_id)
            .bind(interaction_id)
            .bind(format!("GitHub issue fixture report number {index}."))
            .bind(serde_json::json!([{
                "kind": "defect",
                "topic": "search_failure",
                "severity": "major",
                "detail": "Search failed for a valid request."
            }]))
            .bind(serde_json::json!({
                "used": true,
                "detail": "Retried the request once."
            }))
            .bind(group_id)
            .execute(pool)
            .await?;
        }
        Ok(GithubIssueGroupFixture {
            workspace_id,
            product_id: product.id,
            environment_id: environment.id,
            group_id,
            group_key,
            installation_id,
        })
    }

    #[derive(Debug)]
    struct MergeGroupsFixture {
        workspace_id: Uuid,
        product_id: Uuid,
        write_key_id: Uuid,
        write_secret: String,
        source_report_id: Uuid,
        source_interaction_id: Uuid,
        source_group_id: Uuid,
        source_group_key: String,
        target_group_id: Uuid,
        target_group_key: String,
    }

    async fn report_group_for_report(
        pool: &PgPool,
        report_id: Uuid,
    ) -> anyhow::Result<(Uuid, String)> {
        Ok(sqlx::query_as::<_, (Uuid, String)>(
            r"SELECT report_group.id, report_group.group_key
            FROM feedback_reports report
            JOIN report_groups report_group ON report_group.id = report.group_id
            WHERE report.id = $1",
        )
        .bind(report_id)
        .fetch_one(pool)
        .await?)
    }

    async fn merge_groups_fixture(
        pool: &PgPool,
        label: &str,
    ) -> anyhow::Result<MergeGroupsFixture> {
        let workspace_id = github_test_workspace(pool, label).await?;
        let (product, environment) = create_product(
            pool,
            workspace_id,
            CreateProductInput {
                name: label.to_owned(),
            },
        )
        .await
        .map_err(test_error)?;
        let (write_key, write_secret) = create_api_key(
            pool,
            workspace_id,
            environment.id,
            Some("Merge group writer".into()),
            Some("write".into()),
            None,
        )
        .await
        .map_err(test_error)?;
        let source_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
        let target_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
        let (_, source_report) = submit_product_feedback(
            pool,
            &source_capability,
            feedback_input_with_finding(
                "The source report belongs to a manually merged group.",
                "source_failure",
            ),
        )
        .await
        .map_err(test_error)?;
        let (_, target_report) = submit_product_feedback(
            pool,
            &target_capability,
            feedback_input_with_finding(
                "The target report receives manually merged evidence.",
                "target_failure",
            ),
        )
        .await
        .map_err(test_error)?;
        let (source_group_id, source_group_key) =
            report_group_for_report(pool, source_report.id).await?;
        let (target_group_id, target_group_key) =
            report_group_for_report(pool, target_report.id).await?;
        anyhow::ensure!(source_group_id != target_group_id);

        Ok(MergeGroupsFixture {
            workspace_id,
            product_id: product.id,
            write_key_id: write_key.id,
            write_secret,
            source_report_id: source_report.id,
            source_interaction_id: source_report.interaction_id,
            source_group_id,
            source_group_key,
            target_group_id,
            target_group_key,
        })
    }

    async fn record_test_group_issue(
        pool: &PgPool,
        workspace_id: Uuid,
        group_key: &str,
        issue_number: i64,
        report_count: i64,
    ) -> anyhow::Result<()> {
        let link = GithubIssueLink {
            repo_full_name: "open-software/merge-test".to_owned(),
            issue_number,
            url: format!("https://github.com/open-software/merge-test/issues/{issue_number}"),
            state: "open".to_owned(),
        };
        let claim = claim_group_issue_filing(
            pool,
            GroupIssueFilingRequest {
                workspace_id,
                group_key,
                installation_id: 4_433_427,
                repo_full_name: &link.repo_full_name,
                created_by: "usr_merge_test",
                claim_report_count: report_count,
            },
            Utc::now() - Duration::minutes(5),
        )
        .await
        .map_err(test_error)?;
        anyhow::ensure!(matches!(claim, GroupIssueFilingClaim::Claimed));
        complete_group_issue_filing(pool, workspace_id, group_key, &link, report_count)
            .await
            .map_err(test_error)?;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn code_match_outbox_is_idempotent_reclaimable_and_retention_safe() -> anyhow::Result<()>
    {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        // The ignored suite shares its scratch database. No pre-existing test
        // observes this new queue, so clear it to make the claim assertions
        // independent of randomized test order.
        sqlx::query("DELETE FROM code_match_queue")
            .execute(&pool)
            .await?;

        let workspace_id = github_test_workspace(&pool, "Code match outbox test").await?;
        let (product, environment) = create_product(
            &pool,
            workspace_id,
            CreateProductInput {
                name: "Mapped product".to_owned(),
            },
        )
        .await
        .map_err(test_error)?;
        let (write_key, write_secret) = create_api_key(
            &pool,
            workspace_id,
            environment.id,
            Some("Code match writer".into()),
            Some("write".into()),
            None,
        )
        .await
        .map_err(test_error)?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);
        upsert_github_installation(
            &pool,
            workspace_id,
            installation_id,
            "code-match-test",
            "Organization",
        )
        .await
        .map_err(test_error)?;
        set_product_github_repo(
            &pool,
            workspace_id,
            product.id,
            &ProductGithubRepoInput {
                installation_id,
                repo_full_name: "open-software/code-match-test".to_owned(),
                default_branch: "main".to_owned(),
                path_prefix: Some("backend/src".to_owned()),
            },
        )
        .await
        .map_err(test_error)?;

        let interaction_id = Uuid::new_v4();
        let capability = test_capability(&write_secret, write_key.id, interaction_id);
        let (_, report) = submit_product_feedback(
            &pool,
            &capability,
            feedback_input("A mapped report is queued for deterministic code matching."),
        )
        .await
        .map_err(test_error)?;
        let first_queue_state = sqlx::query_as::<_, (Uuid, DateTime<Utc>, i32)>(
            r"SELECT product_id, enqueued_at, attempts FROM code_match_queue
            WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(first_queue_state.0 == product.id && first_queue_state.2 == 0);

        let (_, duplicate) = submit_product_feedback(
            &pool,
            &capability,
            feedback_input("A duplicate submission must reuse the original outbox event."),
        )
        .await
        .map_err(test_error)?;
        anyhow::ensure!(duplicate.id == report.id);
        let duplicate_queue_state = sqlx::query_as::<_, (i64, DateTime<Utc>)>(
            r"SELECT COUNT(*) OVER (), enqueued_at FROM code_match_queue
            WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            duplicate_queue_state.0 == 1 && duplicate_queue_state.1 == first_queue_state.1
        );

        // Holding the candidate row lock proves SKIP LOCKED returns promptly
        // instead of serializing another worker behind this claimant.
        let mut lock = pool.begin().await?;
        sqlx::query("SELECT report_id FROM code_match_queue WHERE report_id = $1 FOR UPDATE")
            .bind(report.id)
            .fetch_one(&mut *lock)
            .await?;
        let skipped = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5)),
        )
        .await?
        .map_err(test_error)?;
        anyhow::ensure!(skipped.iter().all(|job| job.report_id != report.id));
        lock.rollback().await?;

        let first_claim = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == report.id)
            .context("new report should be claimable")?;
        anyhow::ensure!(
            first_claim.attempts == 1
                && first_claim.installation_id == Some(installation_id)
                && first_claim.installation_active
                && first_claim.repo_full_name.as_deref() == Some("open-software/code-match-test")
                && first_claim.path_prefix.as_deref() == Some("backend/src")
        );
        sqlx::query(
            "UPDATE code_match_queue SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE report_id = $1",
        )
        .bind(report.id)
        .execute(&pool)
        .await?;
        let reclaimed = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == report.id)
            .context("stale report claim should be reclaimed")?;
        anyhow::ensure!(
            reclaimed.attempts == 2 && reclaimed.claim_token != first_claim.claim_token
        );

        let dead_lettered = dead_letter_code_match_job(
            &pool,
            report.id,
            reclaimed.claim_token,
            "permanent test failure",
        )
        .await
        .map_err(test_error)?;
        anyhow::ensure!(dead_lettered, "owned job should enter the dead letter");
        let dead_letter_state = sqlx::query_as::<
            _,
            (
                Option<DateTime<Utc>>,
                Option<String>,
                Option<DateTime<Utc>>,
                Option<Uuid>,
            ),
        >(
            r"SELECT dead_lettered_at, last_error, claimed_at, claim_token
            FROM code_match_queue WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            dead_letter_state.0.is_some()
                && dead_letter_state.1.as_deref() == Some("permanent test failure")
                && dead_letter_state.2.is_none()
                && dead_letter_state.3.is_none()
        );
        let parked = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?;
        anyhow::ensure!(parked.iter().all(|job| job.report_id != report.id));

        // Dead letters remain observable and can be explicitly re-driven
        // without recreating the report or its ingest event.
        sqlx::query(
            r"UPDATE code_match_queue SET dead_lettered_at = NULL, last_error = NULL,
              available_at = NOW() WHERE report_id = $1",
        )
        .bind(report.id)
        .execute(&pool)
        .await?;
        let redriven = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == report.id)
            .context("cleared dead letter should be claimable again")?;
        anyhow::ensure!(redriven.attempts == 3);

        let computed_at_sha = "0123456789abcdef0123456789abcdef01234567";
        let verifier = TestPinnedCommitVerifier::new(false);
        // Represent the search calls already spent by the first attempt. A
        // failed exact-commit proof must send later claims through preflight
        // without adding any more search-call rows.
        record_code_match_call(&pool, report.id, Some(8), true, 10)
            .await
            .map_err(test_error)?;
        record_code_match_call(&pool, report.id, Some(7), true, 11)
            .await
            .map_err(test_error)?;
        let mut first_verification = CodeMatchVerificationTracker::default();
        first_verification.observe_candidates(2);
        let first_outcome = crate::settle_and_complete_code_match_job(
            &pool,
            &verifier,
            &redriven,
            "open-software/code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha,
                matches: provisional_file_404_matches(2),
                verification: first_verification,
                verification_retry_count: 0,
            },
        )
        .await?;
        anyhow::ensure!(matches!(
            first_outcome,
            crate::CodeMatchJobOutcome::BackoffInstallation { .. }
        ));
        anyhow::ensure!(verifier.calls() == 1, "the exact commit must be fetched");
        let unsettled_state = sqlx::query_as::<
            _,
            (
                Option<DateTime<Utc>>,
                Option<String>,
                Option<DateTime<Utc>>,
                Option<Uuid>,
                i64,
                i64,
                Option<String>,
                i32,
            ),
        >(
            r"SELECT queue.dead_lettered_at, queue.verification_retry_sha,
              queue.claimed_at, queue.claim_token,
              (SELECT COUNT(*) FROM report_code_hints hints
                WHERE hints.report_id = queue.report_id),
              (SELECT COUNT(*) FROM code_match_verification_analytics analytics
                WHERE analytics.report_id = queue.report_id),
              queue.verification_retry_repo, queue.verification_retry_count
            FROM code_match_queue queue WHERE queue.report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            unsettled_state.0.is_none()
                && unsettled_state.1.as_deref() == Some(computed_at_sha)
                && unsettled_state.2.is_none()
                && unsettled_state.3.is_none()
                && unsettled_state.4 == 0
                && unsettled_state.5 == 0
                && unsettled_state.6.as_deref() == Some("open-software/code-match-test")
                && unsettled_state.7 == 1,
            "an unproven 404 must remain retryable without settling hints or analytics"
        );

        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(report.id)
            .execute(&pool)
            .await?;
        let verification_retry =
            claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
                .await
                .map_err(test_error)?
                .into_iter()
                .find(|job| job.report_id == report.id)
                .context("verification retry should remain claimable")?;
        anyhow::ensure!(
            verification_retry.attempts == 3,
            "pinned-commit proof polling must reuse the unsettled attempt slot"
        );
        let retry_preflight = crate::preflight_code_match_verification_retry(
            &pool,
            &verifier,
            &verification_retry,
            "open-software/code-match-test",
        )
        .await?;
        let crate::CodeMatchVerificationPreflight::Stop(retry_outcome) = retry_preflight else {
            anyhow::bail!("a failed proof should short-circuit before search");
        };
        anyhow::ensure!(matches!(
            retry_outcome,
            crate::CodeMatchJobOutcome::BackoffInstallation { .. }
        ));
        anyhow::ensure!(verifier.calls() == 2);
        let calls_after_failed_preflight = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM match_analytics WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            calls_after_failed_preflight == 2,
            "verification retries must not spend another search call"
        );

        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(report.id)
            .execute(&pool)
            .await?;
        let recovered = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == report.id)
            .context("reachable pinned commit should make the retry claimable")?;
        anyhow::ensure!(recovered.attempts == 3);
        verifier.set_available(true);
        let recovered_preflight = crate::preflight_code_match_verification_retry(
            &pool,
            &verifier,
            &recovered,
            "open-software/code-match-test",
        )
        .await?;
        let crate::CodeMatchVerificationPreflight::Proceed {
            retry_count: recovered_retry_count,
        } = recovered_preflight
        else {
            anyhow::bail!("a successful proof should resume the current attempt");
        };
        anyhow::ensure!(
            recovered_retry_count == 2,
            "preflight success must preserve the counter until settlement"
        );
        anyhow::ensure!(verifier.calls() == 3);

        let mut settled_verification = CodeMatchVerificationTracker::default();
        settled_verification.observe_candidates(2);
        let settled_outcome = crate::settle_and_complete_code_match_job(
            &pool,
            &verifier,
            &recovered,
            "open-software/code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha,
                matches: provisional_file_404_matches(2),
                verification: settled_verification,
                verification_retry_count: recovered_retry_count,
            },
        )
        .await?;
        anyhow::ensure!(matches!(
            settled_outcome,
            crate::CodeMatchJobOutcome::Continue
        ));
        anyhow::ensure!(
            verifier.calls() == 4,
            "all-404 settlement must issue a fresh per-job exact-commit call"
        );
        let stored_empty = sqlx::query_as::<_, (serde_json::Value, Option<String>)>(
            "SELECT hints, outcome FROM report_code_hints WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(stored_empty == (serde_json::json!([]), Some("proven_absent".into())));
        let verification_analytics = sqlx::query_as::<_, (i32, String, i64, i64, i64, i64)>(
            r"SELECT attempt, computed_at_sha, candidates_seen, dropped_as_absent,
              kept_verified, kept_unverified
            FROM code_match_verification_analytics WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            verification_analytics == (3, computed_at_sha.to_owned(), 2, 2, 0, 0,),
            "the settled all-404 attempt must remain distinguishable from a no-hit search"
        );
        let completed_queue_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM code_match_queue WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(completed_queue_count == 0);

        // A later settled attempt that legitimately sees no candidates writes
        // the same [] payload, but appends a zero-count outcome instead of
        // erasing the earlier all-absent evidence.
        sqlx::query("INSERT INTO code_match_queue (report_id, product_id) VALUES ($1, $2)")
            .bind(report.id)
            .bind(product.id)
            .execute(&pool)
            .await?;
        let no_hit_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == report.id)
            .context("legitimate no-hit attempt should be claimable")?;
        anyhow::ensure!(
            no_hit_job.verification_retry_count == 0,
            "a genuinely settled episode must not leak its counter into later work"
        );
        let no_hit_outcome = crate::settle_and_complete_code_match_job(
            &pool,
            &verifier,
            &no_hit_job,
            "open-software/code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha,
                matches: Vec::new(),
                verification: CodeMatchVerificationTracker::default(),
                verification_retry_count: 0,
            },
        )
        .await?;
        anyhow::ensure!(matches!(
            no_hit_outcome,
            crate::CodeMatchJobOutcome::Continue
        ));
        anyhow::ensure!(
            verifier.calls() == 4,
            "a no-hit attempt must not issue a pinned-commit proof"
        );
        let verification_outcomes = sqlx::query_as::<_, (i64, i64, i64, i64)>(
            r"SELECT candidates_seen, dropped_as_absent, kept_verified, kept_unverified
            FROM code_match_verification_analytics WHERE report_id = $1
            ORDER BY candidates_seen DESC, dropped_as_absent DESC, id",
        )
        .bind(report.id)
        .fetch_all(&pool)
        .await?;
        anyhow::ensure!(
            verification_outcomes == vec![(2, 2, 0, 0), (0, 0, 0, 0)],
            "append-only outcomes must distinguish all-absent from legitimate no-hit attempts"
        );
        let latest_hint_outcome = sqlx::query_scalar::<_, Option<String>>(
            "SELECT outcome FROM report_code_hints WHERE report_id = $1",
        )
        .bind(report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(latest_hint_outcome.as_deref() == Some("no_match"));

        // A transient commit-endpoint failure keeps the episode retryable but
        // does not advance the terminal counter. Definitive 404s do advance
        // it, and the Nth definitive probe performs one atomic terminal write.
        let (_, terminal_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "A permanently unavailable pinned commit must terminate visibly.",
        )
        .await?;
        let terminal_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == terminal_report.id)
            .context("terminal-path report should be claimable")?;
        let terminal_verifier = TestPinnedCommitVerifier::new(false);
        terminal_verifier.set_failure_kind(GithubPinnedCommitFailureKind::Server);
        let mut transient_verification = CodeMatchVerificationTracker::default();
        transient_verification.observe_candidates(1);
        let transient_outcome = crate::settle_and_complete_code_match_job(
            &pool,
            &terminal_verifier,
            &terminal_job,
            "open-software/code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha,
                matches: provisional_file_404_matches(1),
                verification: transient_verification,
                verification_retry_count: 0,
            },
        )
        .await?;
        anyhow::ensure!(matches!(
            transient_outcome,
            crate::CodeMatchJobOutcome::BackoffInstallation { .. }
        ));
        let transient_retry_count = sqlx::query_scalar::<_, i32>(
            "SELECT verification_retry_count FROM code_match_queue WHERE report_id = $1",
        )
        .bind(terminal_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            transient_retry_count == 0,
            "a transient pinned-commit failure must not consume the terminal ceiling"
        );

        terminal_verifier.set_failure_kind(GithubPinnedCommitFailureKind::NotFound);
        for definitive_probe in 1..=crate::CODE_MATCH_MAX_VERIFICATION_RETRIES {
            sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
                .bind(terminal_report.id)
                .execute(&pool)
                .await?;
            let retry = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
                .await
                .map_err(test_error)?
                .into_iter()
                .find(|job| job.report_id == terminal_report.id)
                .context("definitive pinned-commit retry should remain claimable until ceiling")?;
            let preflight = crate::preflight_code_match_verification_retry(
                &pool,
                &terminal_verifier,
                &retry,
                "open-software/code-match-test",
            )
            .await?;
            anyhow::ensure!(matches!(
                preflight,
                crate::CodeMatchVerificationPreflight::Stop(
                    crate::CodeMatchJobOutcome::BackoffInstallation { .. }
                )
            ));
            if definitive_probe < crate::CODE_MATCH_MAX_VERIFICATION_RETRIES {
                let persisted_count = sqlx::query_scalar::<_, i32>(
                    "SELECT verification_retry_count FROM code_match_queue WHERE report_id = $1",
                )
                .bind(terminal_report.id)
                .fetch_one(&pool)
                .await?;
                anyhow::ensure!(persisted_count == definitive_probe);
            }
        }
        anyhow::ensure!(
            terminal_verifier.calls()
                == usize::try_from(crate::CODE_MATCH_MAX_VERIFICATION_RETRIES)? + 1,
            "one transient probe plus the bounded definitive probes must stop at the ceiling"
        );
        let terminal_state = sqlx::query_as::<
            _,
            (
                Option<DateTime<Utc>>,
                Option<String>,
                i32,
                serde_json::Value,
                Option<String>,
                String,
                i64,
                i64,
                i64,
                i64,
            ),
        >(
            r"SELECT queue.dead_lettered_at, queue.verification_retry_sha,
              queue.verification_retry_count, hints.hints, hints.outcome,
              hints.computed_at_sha, analytics.candidates_seen,
              analytics.dropped_as_absent, analytics.kept_verified,
              analytics.kept_unverified
            FROM code_match_queue queue
            JOIN report_code_hints hints ON hints.report_id = queue.report_id
            JOIN code_match_verification_analytics analytics
              ON analytics.report_id = queue.report_id
            WHERE queue.report_id = $1",
        )
        .bind(terminal_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            terminal_state.0.is_some()
                && terminal_state.1.is_none()
                && terminal_state.2 == 0
                && terminal_state.3 == serde_json::json!([])
                && terminal_state.4.as_deref() == Some("terminal_unverifiable")
                && terminal_state.5 == computed_at_sha
                && (
                    terminal_state.6,
                    terminal_state.7,
                    terminal_state.8,
                    terminal_state.9
                ) == (0, 0, 0, 0),
            "terminal verification must atomically retain a dead letter, empty hints, and explicit zero-count outcome"
        );
        let terminal_reclaim =
            claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
                .await
                .map_err(test_error)?;
        anyhow::ensure!(
            terminal_reclaim
                .iter()
                .all(|job| job.report_id != terminal_report.id),
            "the verification loop must stop after the bounded terminal probe"
        );
        let terminal_search_calls = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM match_analytics WHERE report_id = $1",
        )
        .bind(terminal_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            terminal_search_calls == 0,
            "preflight retries through the terminal probe must not spend search quota"
        );

        // Casing-only changes normalize identically and keep the episode. A
        // real remap clears it once, preserves the claim, and makes a later
        // failure enter a new episode from zero against the new repository.
        let (_, remap_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "A repository remap must discard old pinned-commit verification state.",
        )
        .await?;
        let remap_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == remap_report.id)
            .context("remap-path report should be claimable")?;
        let remap_verifier = TestPinnedCommitVerifier::new(false);
        let mut remap_verification = CodeMatchVerificationTracker::default();
        remap_verification.observe_candidates(1);
        crate::settle_and_complete_code_match_job(
            &pool,
            &remap_verifier,
            &remap_job,
            "open-software/code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha,
                matches: provisional_file_404_matches(1),
                verification: remap_verification,
                verification_retry_count: 0,
            },
        )
        .await?;
        set_product_github_repo(
            &pool,
            workspace_id,
            product.id,
            &ProductGithubRepoInput {
                installation_id,
                repo_full_name: "Open-Software/Code-Match-Test".to_owned(),
                default_branch: "main".to_owned(),
                path_prefix: Some("backend/src".to_owned()),
            },
        )
        .await
        .map_err(test_error)?;
        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(remap_report.id)
            .execute(&pool)
            .await?;
        let casing_retry = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == remap_report.id)
            .context("casing-only mapping retry should remain claimable")?;
        let casing_preflight = crate::preflight_code_match_verification_retry(
            &pool,
            &remap_verifier,
            &casing_retry,
            "Open-Software/Code-Match-Test",
        )
        .await?;
        anyhow::ensure!(matches!(
            casing_preflight,
            crate::CodeMatchVerificationPreflight::Stop(
                crate::CodeMatchJobOutcome::BackoffInstallation { .. }
            )
        ));
        let casing_state = sqlx::query_as::<_, (Option<String>, i32)>(
            r"SELECT verification_retry_repo, verification_retry_count
            FROM code_match_queue WHERE report_id = $1",
        )
        .bind(remap_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            casing_state == (Some("open-software/code-match-test".into()), 2),
            "operator casing must not masquerade as a repository remap"
        );

        set_product_github_repo(
            &pool,
            workspace_id,
            product.id,
            &ProductGithubRepoInput {
                installation_id,
                repo_full_name: "open-software/remapped-code-match-test".to_owned(),
                default_branch: "main".to_owned(),
                path_prefix: Some("backend/src".to_owned()),
            },
        )
        .await
        .map_err(test_error)?;
        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(remap_report.id)
            .execute(&pool)
            .await?;
        let remapped = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == remap_report.id)
            .context("actually remapped report should remain claimable")?;
        let calls_before_remap_reset = remap_verifier.calls();
        let remapped_preflight = crate::preflight_code_match_verification_retry(
            &pool,
            &remap_verifier,
            &remapped,
            "open-software/remapped-code-match-test",
        )
        .await?;
        let crate::CodeMatchVerificationPreflight::Proceed {
            retry_count: remapped_retry_count,
        } = remapped_preflight
        else {
            anyhow::bail!("a real remap must discard the old verification episode");
        };
        anyhow::ensure!(
            remapped_retry_count == 0 && remap_verifier.calls() == calls_before_remap_reset,
            "remap discard must not probe the old SHA in the new repository"
        );
        let reset_state = sqlx::query_as::<_, (Option<String>, Option<String>, i32)>(
            r"SELECT verification_retry_sha, verification_retry_repo,
              verification_retry_count FROM code_match_queue WHERE report_id = $1",
        )
        .bind(remap_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(reset_state == (None, None, 0));

        let remapped_sha = "fedcba9876543210fedcba9876543210fedcba98";
        let mut fresh_remap_verification = CodeMatchVerificationTracker::default();
        fresh_remap_verification.observe_candidates(1);
        crate::settle_and_complete_code_match_job(
            &pool,
            &remap_verifier,
            &remapped,
            "open-software/remapped-code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha: remapped_sha,
                matches: provisional_file_404_matches(1),
                verification: fresh_remap_verification,
                verification_retry_count: remapped_retry_count,
            },
        )
        .await?;
        let fresh_retry_state = sqlx::query_as::<_, (Option<String>, i32)>(
            r"SELECT verification_retry_repo, verification_retry_count
            FROM code_match_queue WHERE report_id = $1",
        )
        .bind(remap_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            fresh_retry_state == (Some("open-software/remapped-code-match-test".into()), 1),
            "the remapped repository must enter exactly one fresh episode from zero"
        );
        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(remap_report.id)
            .execute(&pool)
            .await?;
        let remapped_retry = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == remap_report.id)
            .context("fresh remapped episode should be claimable")?;
        remap_verifier.set_available(true);
        let fresh_preflight = crate::preflight_code_match_verification_retry(
            &pool,
            &remap_verifier,
            &remapped_retry,
            "open-software/remapped-code-match-test",
        )
        .await?;
        let crate::CodeMatchVerificationPreflight::Proceed {
            retry_count: fresh_retry_count,
        } = fresh_preflight
        else {
            anyhow::bail!("the fresh remapped episode should recover");
        };
        anyhow::ensure!(fresh_retry_count == 1);
        let mut remapped_settlement = CodeMatchVerificationTracker::default();
        remapped_settlement.observe_candidates(1);
        crate::settle_and_complete_code_match_job(
            &pool,
            &remap_verifier,
            &remapped_retry,
            "open-software/remapped-code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha: remapped_sha,
                matches: provisional_file_404_matches(1),
                verification: remapped_settlement,
                verification_retry_count: fresh_retry_count,
            },
        )
        .await?;
        anyhow::ensure!(
            remap_verifier
                .called_repos()
                .iter()
                .rev()
                .take(3)
                .all(|repo| repo == "open-software/remapped-code-match-test"),
            "fresh verification after remap must use only the new normalized repository"
        );
        let remapped_stored = sqlx::query_as::<_, (String, serde_json::Value, Option<String>)>(
            r"SELECT computed_at_sha, hints, outcome FROM report_code_hints
            WHERE report_id = $1",
        )
        .bind(remap_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            remapped_stored
                == (
                    remapped_sha.into(),
                    serde_json::json!([]),
                    Some("proven_absent".into()),
                )
        );

        let (_, retryable_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "An unproven pinned commit remains visibly retryable before its ceiling.",
        )
        .await?;
        let retryable_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == retryable_report.id)
            .context("retryable-state report should be claimable")?;
        let retryable_verifier = TestPinnedCommitVerifier::new(false);
        let mut retryable_verification = CodeMatchVerificationTracker::default();
        retryable_verification.observe_candidates(1);
        crate::settle_and_complete_code_match_job(
            &pool,
            &retryable_verifier,
            &retryable_job,
            "open-software/remapped-code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha: remapped_sha,
                matches: provisional_file_404_matches(1),
                verification: retryable_verification,
                verification_retry_count: 0,
            },
        )
        .await?;
        let retryable_stored_state = sqlx::query_as::<_, (i64, i64, Option<DateTime<Utc>>, Option<String>, i32)>(
            r"SELECT
              (SELECT COUNT(*) FROM report_code_hints WHERE report_id = queue.report_id),
              (SELECT COUNT(*) FROM code_match_verification_analytics WHERE report_id = queue.report_id),
              queue.dead_lettered_at, queue.verification_retry_repo,
              queue.verification_retry_count
            FROM code_match_queue queue WHERE queue.report_id = $1",
        )
        .bind(retryable_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            retryable_stored_state
                == (
                    0,
                    0,
                    None,
                    Some("open-software/remapped-code-match-test".into()),
                    1,
                ),
            "retryable, proven-absent, and terminal-unverifiable states must remain distinguishable from stored state alone"
        );

        // Class 1: fragmentless candidates never enter verification. An
        // all-fragmentless result settles empty without retrying and records
        // why it differs from both no-hit and proven absence.
        let (_, fragmentless_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "Fragmentless search candidates are dropped without storage.",
        )
        .await?;
        let fragmentless_job =
            claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
                .await
                .map_err(test_error)?
                .into_iter()
                .find(|job| job.report_id == fragmentless_report.id)
                .context("fragmentless report should be claimable")?;
        let mut fragmentless_verification = CodeMatchVerificationTracker::default();
        fragmentless_verification.observe_unverified_drop(2);
        crate::settle_and_complete_code_match_job(
            &pool,
            &TestPinnedCommitVerifier::new(true),
            &fragmentless_job,
            "open-software/remapped-code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha: remapped_sha,
                matches: vec![CodeSearchMatches {
                    query: CodeSearchQuery::for_test("fragmentless search hit"),
                    candidates: Vec::new(),
                }],
                verification: fragmentless_verification,
                verification_retry_count: 0,
            },
        )
        .await?;
        let fragmentless_state = sqlx::query_as::<
            _,
            (serde_json::Value, Option<String>, i64, i64),
        >(
            r"SELECT hints.hints, hints.outcome,
              (SELECT COUNT(*) FROM code_match_queue queue
                WHERE queue.report_id = hints.report_id),
              (SELECT kept_unverified FROM code_match_verification_analytics analytics
                WHERE analytics.report_id = hints.report_id ORDER BY created_at DESC, id DESC LIMIT 1)
            FROM report_code_hints hints WHERE hints.report_id = $1",
        )
        .bind(fragmentless_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            fragmentless_state
                == (
                    serde_json::json!([]),
                    Some("unverified_dropped".into()),
                    0,
                    0,
                ),
            "all-fragmentless results must settle empty without retry or dead letter"
        );

        // Class 2: known capacity shortfall requeues through the shared
        // counter. Its next claim preflights capacity before any search and
        // can settle normally once the FIFO-prioritized job has enough budget.
        let (_, budget_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "Content capacity must recover without storing an unverified hint.",
        )
        .await?;
        let budget_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == budget_report.id)
            .context("content-budget report should be claimable")?;
        let budget_incomplete = crate::IncompleteCodeMatchContent {
            reason: "content_budget".to_owned(),
            file: None,
            required_content: 2,
            pending_verification: None,
            error: "test content budget exhausted".to_owned(),
        };
        crate::release_code_match_after_incomplete_content(
            &pool,
            &budget_job,
            remapped_sha,
            "open-software/remapped-code-match-test",
            0,
            &budget_incomplete,
        )
        .await?;
        let budget_retry_state = sqlx::query_as::<_, (Option<String>, i32, i64, i64)>(
            r"SELECT verification_retry_reason, verification_retry_count,
              (SELECT COUNT(*) FROM report_code_hints hints WHERE hints.report_id = queue.report_id),
              (SELECT COUNT(*) FROM match_analytics calls WHERE calls.report_id = queue.report_id)
            FROM code_match_queue queue WHERE report_id = $1",
        )
        .bind(budget_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            budget_retry_state == (Some("content_budget".into()), 1, 0, 0),
            "capacity retry must count once without storing a hint or spending search quota"
        );
        sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
            .bind(budget_report.id)
            .execute(&pool)
            .await?;
        let budget_retry = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == budget_report.id)
            .context("content-budget retry should be claimable")?;
        let budget_verifier = TestPinnedCommitVerifier::new(true);
        let mut recovered_budget = crate::InstallationContentBudget::new();
        let mut recovered_cache = BTreeMap::new();
        let budget_preflight = crate::preflight_code_match_content_retry(
            &pool,
            &budget_verifier,
            &budget_retry,
            "open-software/remapped-code-match-test",
            budget_retry.verification_retry_count,
            &mut recovered_budget,
            &mut recovered_cache,
        )
        .await?;
        let crate::CodeMatchContentPreflight::RetrySha {
            computed_at_sha: budget_sha,
            retry_count: budget_retry_count,
        } = budget_preflight
        else {
            anyhow::bail!("capacity retry should proceed once its budget is available");
        };
        anyhow::ensure!(budget_verifier.file_calls() == 0 && budget_retry_count == 1);
        let mut budget_verification = CodeMatchVerificationTracker::default();
        budget_verification.observe_candidates(1);
        crate::settle_and_complete_code_match_job(
            &pool,
            &budget_verifier,
            &budget_retry,
            "open-software/remapped-code-match-test",
            crate::CodeMatchSettlement {
                computed_at_sha: &budget_sha,
                matches: verified_code_matches("src/recovered.rs"),
                verification: budget_verification,
                verification_retry_count: budget_retry_count,
            },
        )
        .await?;
        let budget_stored = sqlx::query_as::<_, (serde_json::Value, Option<String>)>(
            "SELECT hints, outcome FROM report_code_hints WHERE report_id = $1",
        )
        .bind(budget_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            budget_stored.1.as_deref() == Some("matched") && budget_stored.0[0]["verified"] == true,
            "recovered capacity must store only a verified-at-SHA hint"
        );

        // Class 3: an actual contents failure preflights the failed file ahead
        // of search on every retry. Every release counts, then the Nth writes
        // the existing atomic terminal state with no unverified hint.
        let (_, fetch_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "A persistently incomplete content fetch terminates visibly.",
        )
        .await?;
        let fetch_job = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?
            .into_iter()
            .find(|job| job.report_id == fetch_report.id)
            .context("content-fetch report should be claimable")?;
        let fetch_pending = pending_code_verification("src/flaky.rs");
        let fetch_incomplete = crate::IncompleteCodeMatchContent {
            reason: "content_fetch".to_owned(),
            file: Some("src/flaky.rs".to_owned()),
            required_content: 1,
            pending_verification: Some(fetch_pending),
            error: "test pinned contents transport failure".to_owned(),
        };
        crate::release_code_match_after_incomplete_content(
            &pool,
            &fetch_job,
            remapped_sha,
            "open-software/remapped-code-match-test",
            0,
            &fetch_incomplete,
        )
        .await?;
        let fetch_verifier = TestPinnedCommitVerifier::new(true);
        fetch_verifier.set_file_available(false);
        for expected_count in 2..=crate::CODE_MATCH_MAX_VERIFICATION_RETRIES {
            sqlx::query("UPDATE code_match_queue SET available_at = NOW() WHERE report_id = $1")
                .bind(fetch_report.id)
                .execute(&pool)
                .await?;
            let retry = claim_code_match_batch(&pool, 100, Utc::now() - Duration::minutes(5))
                .await
                .map_err(test_error)?
                .into_iter()
                .find(|job| job.report_id == fetch_report.id)
                .context("content-fetch retry should remain claimable until its ceiling")?;
            let mut retry_budget = crate::InstallationContentBudget::new();
            let mut retry_cache = BTreeMap::new();
            let preflight = crate::preflight_code_match_content_retry(
                &pool,
                &fetch_verifier,
                &retry,
                "open-software/remapped-code-match-test",
                retry.verification_retry_count,
                &mut retry_budget,
                &mut retry_cache,
            )
            .await?;
            anyhow::ensure!(matches!(
                preflight,
                crate::CodeMatchContentPreflight::Stop(
                    crate::CodeMatchJobOutcome::BackoffInstallation { .. }
                )
            ));
            if expected_count < crate::CODE_MATCH_MAX_VERIFICATION_RETRIES {
                let count = sqlx::query_scalar::<_, i32>(
                    "SELECT verification_retry_count FROM code_match_queue WHERE report_id = $1",
                )
                .bind(fetch_report.id)
                .fetch_one(&pool)
                .await?;
                anyhow::ensure!(count == expected_count);
            }
        }
        let fetch_terminal = sqlx::query_as::<
            _,
            (
                Option<DateTime<Utc>>,
                serde_json::Value,
                Option<String>,
                i64,
                i64,
            ),
        >(
            r"SELECT queue.dead_lettered_at, hints.hints, hints.outcome,
              analytics.kept_unverified,
              (SELECT COUNT(*) FROM match_analytics calls WHERE calls.report_id = queue.report_id)
            FROM code_match_queue queue
            JOIN report_code_hints hints ON hints.report_id = queue.report_id
            JOIN code_match_verification_analytics analytics
              ON analytics.report_id = queue.report_id
            WHERE queue.report_id = $1",
        )
        .bind(fetch_report.id)
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(
            fetch_terminal.0.is_some()
                && fetch_terminal.1 == serde_json::json!([])
                && fetch_terminal.2.as_deref() == Some("terminal_unverifiable")
                && fetch_terminal.3 == 0
                && fetch_terminal.4 == 0
                && fetch_verifier.file_calls()
                    == usize::try_from(crate::CODE_MATCH_MAX_VERIFICATION_RETRIES - 1)?,
            "content fetch retries must stop at the shared ceiling without re-spending search"
        );

        // The database makes the invariant structural: neither an explicit
        // false value nor a missing verified key can be written by any path.
        for invalid_hints in [
            serde_json::json!([{"file": "src/false.rs", "verified": false}]),
            serde_json::json!([{"file": "src/missing.rs"}]),
        ] {
            let rejected =
                sqlx::query("UPDATE report_code_hints SET hints = $2 WHERE report_id = $1")
                    .bind(budget_report.id)
                    .bind(invalid_hints)
                    .execute(&pool)
                    .await;
            anyhow::ensure!(
                rejected.is_err(),
                "unverified stored hints must be rejected"
            );
        }
        let nonzero_unverified = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM code_match_verification_analytics WHERE kept_unverified <> 0",
        )
        .fetch_one(&pool)
        .await?;
        anyhow::ensure!(nonzero_unverified == 0);

        // FIFO is the starvation control: release never changes enqueued_at,
        // and claim order chooses the older available row first.
        let (_, oldest_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "The oldest starved report must win content capacity.",
        )
        .await?;
        let (_, newer_report) = submit_mapped_code_match_report(
            &pool,
            &write_secret,
            write_key.id,
            "A newer report must wait behind the starved report.",
        )
        .await?;
        sqlx::query(
            r"UPDATE code_match_queue SET available_at = NOW() + INTERVAL '1 hour'
            WHERE dead_lettered_at IS NULL AND report_id <> ALL($1)",
        )
        .bind(vec![oldest_report.id, newer_report.id])
        .execute(&pool)
        .await?;
        sqlx::query(
            r"UPDATE code_match_queue SET
              available_at = CASE WHEN report_id = $1
                THEN NOW() - INTERVAL '1 minute' ELSE NOW() - INTERVAL '2 minutes' END,
              enqueued_at = CASE WHEN report_id = $1
                THEN NOW() - INTERVAL '2 hours' ELSE NOW() - INTERVAL '1 hour' END
            WHERE report_id = ANY($2)",
        )
        .bind(oldest_report.id)
        .bind(vec![oldest_report.id, newer_report.id])
        .execute(&pool)
        .await?;
        let fifo_claim = claim_code_match_batch(&pool, 1, Utc::now() - Duration::minutes(5))
            .await
            .map_err(test_error)?;
        anyhow::ensure!(fifo_claim[0].report_id == oldest_report.id);
        sqlx::query("DELETE FROM code_match_queue WHERE report_id = ANY($1)")
            .bind(vec![oldest_report.id, newer_report.id])
            .execute(&pool)
            .await?;

        // Retention deletes interactions, which cascades through reports. All
        // code-intelligence state must disappear with that report.
        sqlx::query(r"UPDATE report_code_hints SET hints = $2 WHERE report_id = $1")
            .bind(report.id)
            .bind(serde_json::json!([{
                "file": "backend/src/store.rs",
                "line_start": 7988,
                "line_end": 7992,
                "match_reason": "exact operation identifier `search_reports`",
                "verified": true
            }]))
            .execute(&pool)
            .await?;
        record_code_match_call(&pool, report.id, Some(9), false, 12)
            .await
            .map_err(test_error)?;
        let dashboard_report = dashboard_report_by_id(&pool, workspace_id, product.id, report.id)
            .await
            .map_err(test_error)?;
        anyhow::ensure!(
            dashboard_report.code_hints[0]["file"] == "backend/src/store.rs"
                && dashboard_report.code_hints[0]["line_start"] == 7988
                && dashboard_report.code_hints[0]["verified"] == true
        );
        sqlx::query("DELETE FROM interactions_v2 WHERE id = $1")
            .bind(interaction_id)
            .execute(&pool)
            .await?;
        for table in [
            "code_match_queue",
            "report_code_hints",
            "match_analytics",
            "code_match_verification_analytics",
        ] {
            let count = match table {
                "code_match_queue" => {
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM code_match_queue WHERE report_id = $1",
                    )
                    .bind(report.id)
                    .fetch_one(&pool)
                    .await?
                }
                "report_code_hints" => {
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM report_code_hints WHERE report_id = $1",
                    )
                    .bind(report.id)
                    .fetch_one(&pool)
                    .await?
                }
                "match_analytics" => {
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM match_analytics WHERE report_id = $1",
                    )
                    .bind(report.id)
                    .fetch_one(&pool)
                    .await?
                }
                "code_match_verification_analytics" => sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM code_match_verification_analytics WHERE report_id = $1",
                )
                .bind(report.id)
                .fetch_one(&pool)
                .await?,
                _ => 1,
            };
            anyhow::ensure!(count == 0, "{table} should cascade with the report");
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn recording_one_group_issue_twice_returns_the_existing_link() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Issue idempotency test", 2).await?;

        let result = Box::pin(async {
            let link = GithubIssueLink {
                repo_full_name: "open-software/epode-test".to_owned(),
                issue_number: 42,
                url: "https://github.com/open-software/epode-test/issues/42".to_owned(),
                state: "open".to_owned(),
            };
            let stale_cutoff = Utc::now() - Duration::minutes(5);
            let first_claim = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: 4_433_427,
                    repo_full_name: &link.repo_full_name,
                    created_by: "usr_test",
                    claim_report_count: 2,
                },
                stale_cutoff,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(first_claim, GroupIssueFilingClaim::Claimed));

            // A concurrent filer must be turned away while the claim is fresh,
            // so only one GitHub issue is ever created.
            let contended = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: 4_433_427,
                    repo_full_name: &link.repo_full_name,
                    created_by: "usr_other",
                    claim_report_count: 2,
                },
                stale_cutoff,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(contended, GroupIssueFilingClaim::InProgress));

            let first = complete_group_issue_filing(
                &pool,
                fixture.workspace_id,
                &fixture.group_key,
                &link,
                2,
            )
            .await
            .map_err(test_error)?;

            // Once filed, a later attempt returns the existing issue instead of
            // claiming again.
            let second = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: 4_433_427,
                    repo_full_name: &link.repo_full_name,
                    created_by: "usr_other",
                    claim_report_count: 2,
                },
                stale_cutoff,
            )
            .await
            .map_err(test_error)?;
            let GroupIssueFilingClaim::AlreadyFiled(second) = second else {
                anyhow::bail!("expected the second claim to see an already filed issue");
            };

            anyhow::ensure!(first.link() == link);
            anyhow::ensure!(second.link() == link);
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM group_github_issues WHERE group_key = $1")
                    .bind(&fixture.group_key)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(count == 1);
            Ok::<(), anyhow::Error>(())
        })
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn ambiguous_filing_refuses_a_subsequent_claim() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Ambiguous filing test", 2).await?;

        let result = async {
            let claim = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: fixture.installation_id,
                    repo_full_name: "open-software/epode-test",
                    created_by: "usr_test",
                    claim_report_count: 2,
                },
                Utc::now() - Duration::minutes(5),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(claim, GroupIssueFilingClaim::Claimed));
            let claim_time: DateTime<Utc> = sqlx::query_scalar(
                "SELECT claimed_at FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(
                mark_group_issue_filing_for_reconciliation(
                    &pool,
                    fixture.workspace_id,
                    &fixture.group_key,
                )
                .await
                .map_err(test_error)?
            );

            let filing_state: String = sqlx::query_scalar(
                "SELECT filing_state FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(filing_state == "needs_reconciliation");
            let retained_claim_time: DateTime<Utc> = sqlx::query_scalar(
                "SELECT claimed_at FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(retained_claim_time == claim_time);

            let retry = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: fixture.installation_id,
                    repo_full_name: "open-software/epode-test",
                    created_by: "usr_retry",
                    claim_report_count: 2,
                },
                Utc::now() - Duration::minutes(5),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(retry, GroupIssueFilingClaim::NeedsReconciliation));
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn reconciliation_adopts_the_found_issue_and_claim_report_count() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Issue adoption test", 2).await?;

        let result = async {
            let claim = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: fixture.installation_id,
                    repo_full_name: "open-software/epode-test",
                    created_by: "usr_test",
                    claim_report_count: 2,
                },
                Utc::now() - Duration::minutes(5),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(claim, GroupIssueFilingClaim::Claimed));
            let claim_time: DateTime<Utc> = sqlx::query_scalar(
                "SELECT claimed_at FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(
                mark_group_issue_filing_for_reconciliation(
                    &pool,
                    fixture.workspace_id,
                    &fixture.group_key,
                )
                .await
                .map_err(test_error)?
            );
            let retained_claim_time: DateTime<Utc> = sqlx::query_scalar(
                "SELECT claimed_at FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(retained_claim_time == claim_time);
            let interim_interaction_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, surface, operation, status_code,
                 classification, confirmation_method, occurred_at)
                VALUES ($1, $2, $3, 'mcp', 'search_reports', 503, 'confirmed', 'mcp', NOW())",
            )
            .bind(interim_interaction_id)
            .bind(fixture.workspace_id)
            .bind(fixture.environment_id)
            .execute(&pool)
            .await?;
            sqlx::query(
                r"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, impact, findings, workaround, group_id)
                VALUES ($1, $2, $3, 'Interim report after the filing claim.', 'blocked',
                  '[]'::JSONB, NULL, $4)",
            )
            .bind(Uuid::new_v4())
            .bind(fixture.workspace_id)
            .bind(interim_interaction_id)
            .bind(fixture.group_id)
            .execute(&pool)
            .await?;
            let reconciliation = claim_group_issue_reconciliation(
                &pool,
                fixture.workspace_id,
                &fixture.group_key,
                Utc::now(),
            )
            .await
            .map_err(test_error)?
            .ok_or_else(|| anyhow::anyhow!("reconciliation should be claimable"))?;
            anyhow::ensure!(reconciliation.claim_report_count == 2);
            let live_report_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM feedback_reports WHERE workspace_id = $1 AND group_id = $2",
            )
            .bind(fixture.workspace_id)
            .bind(fixture.group_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(live_report_count == 3);

            let link = GithubIssueLink {
                repo_full_name: "open-software/epode-test".to_owned(),
                issue_number: 142,
                url: "https://github.com/open-software/epode-test/issues/142".to_owned(),
                state: "open".to_owned(),
            };
            anyhow::ensure!(
                complete_group_issue_reconciliation(
                    &pool,
                    fixture.workspace_id,
                    &fixture.group_key,
                    reconciliation.reconciliation_claimed_at,
                    &link,
                    reconciliation.claim_report_count,
                )
                .await
                .map_err(test_error)?
            );

            let adopted = get_group_github_issue(&pool, fixture.workspace_id, &fixture.group_key)
                .await
                .map_err(test_error)?
                .ok_or_else(|| anyhow::anyhow!("adopted issue should be filed"))?;
            anyhow::ensure!(adopted.link() == link);
            let report_count: i64 = sqlx::query_scalar(
                "SELECT last_commented_report_count FROM group_github_issues WHERE group_key = $1",
            )
            .bind(&fixture.group_key)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(report_count == 2);
            let mut tx = pool.begin().await?;
            let sync = group_issue_sync_context(&mut tx, fixture.workspace_id, &fixture.group_key)
                .await
                .map_err(test_error)?
                .ok_or_else(|| anyhow::anyhow!("adopted issue should be syncable"))?;
            anyhow::ensure!(sync.observed_report_count == 2);
            anyhow::ensure!(sync.current_report_count == 3);
            tx.rollback().await?;
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn product_mapping_rejects_another_workspaces_installation() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let original_workspace = github_test_workspace(&pool, "Mapping owner").await?;
        let other_workspace = github_test_workspace(&pool, "Mapping attacker").await?;
        let (other_product, _) = create_product(
            &pool,
            other_workspace,
            CreateProductInput {
                name: "Other workspace product".to_owned(),
            },
        )
        .await
        .map_err(test_error)?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);
        upsert_github_installation(
            &pool,
            original_workspace,
            installation_id,
            "mapping-owner",
            "Organization",
        )
        .await
        .map_err(test_error)?;

        let error = set_product_github_repo(
            &pool,
            other_workspace,
            other_product.id,
            &ProductGithubRepoInput {
                installation_id,
                repo_full_name: "open-software/private".to_owned(),
                default_branch: "main".to_owned(),
                path_prefix: None,
            },
        )
        .await
        .expect_err("a foreign installation must not be accepted");
        anyhow::ensure!(error.status == StatusCode::NOT_FOUND);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM product_github_repos WHERE product_id = $1")
                .bind(other_product.id)
                .fetch_one(&pool)
                .await?;
        anyhow::ensure!(count == 0);

        sqlx::query("DELETE FROM workspaces WHERE id = $1 OR id = $2")
            .bind(original_workspace)
            .bind(other_workspace)
            .execute(&pool)
            .await?;
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn product_group_listing_includes_counts_and_linked_issue() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Group listing test", 2).await?;

        let result = async {
            let context = group_issue_context(
                &pool,
                fixture.workspace_id,
                &fixture.group_key,
                "https://app.epode.test/?view=feedback&group=test".to_owned(),
            )
            .await
            .map_err(test_error)?
            .ok_or_else(|| anyhow::anyhow!("fixture group should be found"))?;
            anyhow::ensure!(context.installation_id == Some(fixture.installation_id));
            anyhow::ensure!(context.installation_active);
            anyhow::ensure!(context.template.report_count == 2);
            anyhow::ensure!(context.template.findings[0].count == 2);

            let link = GithubIssueLink {
                repo_full_name: "open-software/epode-test".to_owned(),
                issue_number: 84,
                url: "https://github.com/open-software/epode-test/issues/84".to_owned(),
                state: "open".to_owned(),
            };
            let claim = claim_group_issue_filing(
                &pool,
                GroupIssueFilingRequest {
                    workspace_id: fixture.workspace_id,
                    group_key: &fixture.group_key,
                    installation_id: 4_433_427,
                    repo_full_name: &link.repo_full_name,
                    created_by: "usr_test",
                    claim_report_count: 2,
                },
                Utc::now() - Duration::minutes(5),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(matches!(claim, GroupIssueFilingClaim::Claimed));
            complete_group_issue_filing(&pool, fixture.workspace_id, &fixture.group_key, &link, 2)
                .await
                .map_err(test_error)?;

            let page = list_product_groups(&pool, fixture.workspace_id, fixture.product_id, 50, 0)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(!page.has_more);
            anyhow::ensure!(page.groups.len() == 1);
            let listed_group = &page.groups[0];
            anyhow::ensure!(listed_group.last_commented_report_count == Some(2));
            let group = &listed_group.group;
            anyhow::ensure!(group.report_count == 2);
            anyhow::ensure!(group.latest_occurred_at.is_some());
            anyhow::ensure!(group.github_issue.as_ref() == Some(&link));
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn report_group_merge_survives_regroup_and_routes_future_reports() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = merge_groups_fixture(&pool, "Durable report group merge").await?;

        let result = async {
            let summary = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                &fixture.target_group_key,
                "usr_merge_actor",
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                summary
                    == MergeReportGroupsResponse {
                        reports_moved: 1,
                        target_group_key: fixture.target_group_key.clone(),
                    }
            );

            let lineage =
                sqlx::query_as::<_, (Option<String>, Option<DateTime<Utc>>, Option<String>)>(
                    r"SELECT merged_into_group_key, merged_at, merged_by
                FROM report_groups WHERE id = $1",
                )
                .bind(fixture.source_group_id)
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(lineage.0.as_deref() == Some(fixture.target_group_key.as_str()));
            anyhow::ensure!(lineage.1.is_some());
            anyhow::ensure!(lineage.2.as_deref() == Some("usr_merge_actor"));
            let retained_source_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM report_groups WHERE id = $1")
                    .bind(fixture.source_group_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(retained_source_count == 1);
            let merged_report_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(fixture.source_report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(merged_report_group == Some(fixture.target_group_id));

            regroup_report_groups(&pool, &crate::grouping::FingerprintGrouper)
                .await
                .map_err(test_error)?;
            let regrouped_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(fixture.source_report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(regrouped_group == Some(fixture.target_group_id));

            // Exercise repair of a report still pointing at the retained
            // source even when its newly computed fingerprint no longer names
            // that source: current merge lineage remains authoritative.
            sqlx::query("UPDATE feedback_reports SET group_id = $1 WHERE id = $2")
                .bind(fixture.source_group_id)
                .bind(fixture.source_report_id)
                .execute(&pool)
                .await?;
            sqlx::query(
                "UPDATE interactions_v2 SET operation = 'changed_after_merge' WHERE id = $1",
            )
            .bind(fixture.source_interaction_id)
            .execute(&pool)
            .await?;
            regroup_report_groups(&pool, &crate::grouping::FingerprintGrouper)
                .await
                .map_err(test_error)?;
            let repaired_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(fixture.source_report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(repaired_group == Some(fixture.target_group_id));

            let future_capability =
                test_capability(&fixture.write_secret, fixture.write_key_id, Uuid::new_v4());
            let (_, future_report) = submit_product_feedback(
                &pool,
                &future_capability,
                feedback_input_with_finding(
                    "A future matching report follows durable merge lineage.",
                    "source_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let future_group = report_group_for_report(&pool, future_report.id).await?;
            anyhow::ensure!(future_group.0 == fixture.target_group_id);

            let page = list_product_groups(&pool, fixture.workspace_id, fixture.product_id, 50, 0)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(page.groups.len() == 1);
            anyhow::ensure!(page.groups[0].group.group_key == fixture.target_group_key);
            anyhow::ensure!(page.groups[0].group.report_count == 3);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn unresolvable_report_group_lineage_preserves_future_report() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = merge_groups_fixture(&pool, "Broken report group lineage").await?;

        let result = async {
            let terminal_capability =
                test_capability(&fixture.write_secret, fixture.write_key_id, Uuid::new_v4());
            let (_, terminal_report) = submit_product_feedback(
                &pool,
                &terminal_capability,
                feedback_input_with_finding(
                    "A terminal group makes the malformed lineage two hops long.",
                    "terminal_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let (_, terminal_group_key) =
                report_group_for_report(&pool, terminal_report.id).await?;

            // Product code prevents chains, so construct one directly to
            // exercise ingestion's last-resort preservation behavior.
            sqlx::query(
                r"UPDATE report_groups
                SET merged_into_group_key = $1, merged_at = NOW(), merged_by = 'test_corruption'
                WHERE id = $2",
            )
            .bind(&terminal_group_key)
            .bind(fixture.target_group_id)
            .execute(&pool)
            .await?;
            sqlx::query(
                r"UPDATE report_groups
                SET merged_into_group_key = $1, merged_at = NOW(), merged_by = 'test_corruption'
                WHERE id = $2",
            )
            .bind(&fixture.target_group_key)
            .bind(fixture.source_group_id)
            .execute(&pool)
            .await?;

            let future_capability =
                test_capability(&fixture.write_secret, fixture.write_key_id, Uuid::new_v4());
            let (_, future_report) = submit_product_feedback(
                &pool,
                &future_capability,
                feedback_input_with_finding(
                    "A matching report remains available despite malformed lineage.",
                    "source_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let future_group = report_group_for_report(&pool, future_report.id).await?;
            anyhow::ensure!(future_group.0 == fixture.source_group_id);

            let context = group_issue_context(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                "https://app.epode.test/?view=feedback&group=source".to_owned(),
            )
            .await
            .map_err(test_error)?
            .ok_or_else(|| anyhow::anyhow!("source group should remain addressable"))?;
            anyhow::ensure!(
                context.merged_into_group_key.as_deref() == Some(fixture.target_group_key.as_str())
            );
            anyhow::ensure!(context.repo_full_name.is_none());
            anyhow::ensure!(context.template.report_count == 2);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn report_group_merge_rejects_invalid_relationships() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = merge_groups_fixture(&pool, "Merge relationship validation").await?;

        let result = async {
            let self_merge = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                &fixture.source_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("a group cannot merge into itself");
            anyhow::ensure!(self_merge.status == StatusCode::BAD_REQUEST);

            let third_capability =
                test_capability(&fixture.write_secret, fixture.write_key_id, Uuid::new_v4());
            let (_, third_report) = submit_product_feedback(
                &pool,
                &third_capability,
                feedback_input_with_finding(
                    "A third group remains available for lineage validation.",
                    "third_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let (_, third_group_key) = report_group_for_report(&pool, third_report.id).await?;

            let (other_product, other_environment) = create_product(
                &pool,
                fixture.workspace_id,
                CreateProductInput {
                    name: "Other merge product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (other_key, other_secret) = create_api_key(
                &pool,
                fixture.workspace_id,
                other_environment.id,
                Some("Other merge writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let other_capability = test_capability(&other_secret, other_key.id, Uuid::new_v4());
            let (_, other_report) = submit_product_feedback(
                &pool,
                &other_capability,
                feedback_input_with_finding(
                    "A different product cannot share report group lineage.",
                    "other_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let (_, other_group_key) = report_group_for_report(&pool, other_report.id).await?;
            anyhow::ensure!(other_product.id != fixture.product_id);

            let cross_product = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                &other_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("cross-product merges must be rejected");
            anyhow::ensure!(cross_product.status == StatusCode::CONFLICT);
            anyhow::ensure!(cross_product.message.contains("different products"));

            merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                &fixture.target_group_key,
                "usr_merge_actor",
            )
            .await
            .map_err(test_error)?;

            let merged_source = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.source_group_key,
                &third_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("an already-merged source must be rejected");
            anyhow::ensure!(merged_source.status == StatusCode::CONFLICT);
            anyhow::ensure!(merged_source.message.contains("Source feedback group"));

            let merged_target = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &third_group_key,
                &fixture.source_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("an already-merged target must be rejected");
            anyhow::ensure!(merged_target.status == StatusCode::CONFLICT);
            anyhow::ensure!(merged_target.message.contains("Target feedback group"));

            let final_target = merge_report_groups(
                &pool,
                fixture.workspace_id,
                &fixture.target_group_key,
                &third_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("a final target cannot be merged away into a chain");
            anyhow::ensure!(final_target.status == StatusCode::CONFLICT);
            anyhow::ensure!(final_target.message.contains("final target"));
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    /// A filing that begins AFTER a merge has checked for issue rows but BEFORE
    /// the merge commits its lineage must not slip through and open a public
    /// issue on a group that is about to be merged away. Row locks cannot close
    /// this: at that instant the filing has no row to lock and the merge's
    /// lineage write is not yet visible. The shared advisory lock is what makes
    /// the two mutually exclusive.
    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn filing_cannot_race_past_an_uncommitted_merge() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = merge_groups_fixture(&pool, "Merge filing race").await?;

        let result = async {
            // Stand in for a merge mid-flight: hold the advisory lock and write
            // the lineage without committing.
            let mut merging = pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(&fixture.source_group_key)
                .execute(&mut *merging)
                .await?;
            sqlx::query(
                r"UPDATE report_groups
                SET merged_into_group_key = $1, merged_at = NOW(), merged_by = 'usr_race'
                WHERE workspace_id = $2 AND group_key = $3",
            )
            .bind(&fixture.target_group_key)
            .bind(fixture.workspace_id)
            .bind(&fixture.source_group_key)
            .execute(&mut *merging)
            .await?;

            // Start the filing while the merge is still open. It must block on
            // the advisory lock rather than observe the pre-merge lineage.
            let racing_pool = pool.clone();
            let workspace_id = fixture.workspace_id;
            let racing_key = fixture.source_group_key.clone();
            let filing = tokio::spawn(async move {
                claim_group_issue_filing(
                    &racing_pool,
                    GroupIssueFilingRequest {
                        workspace_id,
                        group_key: &racing_key,
                        installation_id: 4_433_427,
                        repo_full_name: "open-software/merge-test",
                        created_by: "usr_race",
                        claim_report_count: 1,
                    },
                    Utc::now() - Duration::minutes(5),
                )
                .await
            });
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
            anyhow::ensure!(!filing.is_finished(), "filing must wait for the merge");

            merging.commit().await?;

            let claim = filing.await?;
            let error = claim.expect_err("filing must refuse a merged-away group");
            anyhow::ensure!(error.status == StatusCode::CONFLICT, "{}", error.message);
            anyhow::ensure!(error.message.contains("merged into"), "{}", error.message);

            // Nothing may have been claimed for the merged-away group.
            let rows: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM group_github_issues WHERE group_key = $1")
                    .bind(&fixture.source_group_key)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(rows == 0, "a merged-away group must hold no filing claim");
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn report_group_merge_moves_one_issue_but_rejects_two() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let moving_fixture = merge_groups_fixture(&pool, "Merge source issue").await?;
        let conflict_fixture = merge_groups_fixture(&pool, "Merge two issues").await?;

        let result = async {
            record_test_group_issue(
                &pool,
                moving_fixture.workspace_id,
                &moving_fixture.source_group_key,
                9_101,
                1,
            )
            .await?;
            merge_report_groups(
                &pool,
                moving_fixture.workspace_id,
                &moving_fixture.source_group_key,
                &moving_fixture.target_group_key,
                "usr_merge_actor",
            )
            .await
            .map_err(test_error)?;
            let moved_issue = sqlx::query_as::<_, (String, i64, i64)>(
                r"SELECT group_key, issue_number, last_commented_report_count
                FROM group_github_issues WHERE workspace_id = $1",
            )
            .bind(moving_fixture.workspace_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(moved_issue == (moving_fixture.target_group_key.clone(), 9_101, 0,));

            // A filing still in flight (issue_number NULL) must block the merge
            // rather than fail to decode or slip through as "no issue".
            let pending_fixture = merge_groups_fixture(&pool, "Merge pending").await?;
            sqlx::query(
                r"INSERT INTO group_github_issues
                (group_key, workspace_id, installation_id, repo_full_name, created_by,
                 filing_state, claimed_at, last_commented_report_count)
                VALUES ($1, $2, 4_433_427, 'open-software/epode-test', 'usr_test',
                 'pending', NOW(), 0)",
            )
            .bind(&pending_fixture.source_group_key)
            .bind(pending_fixture.workspace_id)
            .execute(&pool)
            .await?;
            let pending = merge_report_groups(
                &pool,
                pending_fixture.workspace_id,
                &pending_fixture.source_group_key,
                &pending_fixture.target_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("a merge must refuse while a filing is in flight");
            anyhow::ensure!(pending.status == StatusCode::CONFLICT);
            anyhow::ensure!(pending.message.contains("still in progress"));
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(pending_fixture.workspace_id)
                .execute(&pool)
                .await?;

            record_test_group_issue(
                &pool,
                conflict_fixture.workspace_id,
                &conflict_fixture.source_group_key,
                9_102,
                1,
            )
            .await?;
            record_test_group_issue(
                &pool,
                conflict_fixture.workspace_id,
                &conflict_fixture.target_group_key,
                9_103,
                1,
            )
            .await?;
            let conflict = merge_report_groups(
                &pool,
                conflict_fixture.workspace_id,
                &conflict_fixture.source_group_key,
                &conflict_fixture.target_group_key,
                "usr_merge_actor",
            )
            .await
            .expect_err("two filed issues must block the merge");
            anyhow::ensure!(conflict.status == StatusCode::CONFLICT);
            anyhow::ensure!(conflict.message.contains("#9102"));
            anyhow::ensure!(conflict.message.contains("#9103"));

            let untouched_issues = sqlx::query_as::<_, (String, i64)>(
                r"SELECT group_key, issue_number
                FROM group_github_issues
                WHERE workspace_id = $1
                ORDER BY issue_number",
            )
            .bind(conflict_fixture.workspace_id)
            .fetch_all(&pool)
            .await?;
            anyhow::ensure!(
                untouched_issues
                    == vec![
                        (conflict_fixture.source_group_key.clone(), 9_102),
                        (conflict_fixture.target_group_key.clone(), 9_103),
                    ]
            );
            let source_report_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(conflict_fixture.source_report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(source_report_group == Some(conflict_fixture.source_group_id));
            let target_report_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM feedback_reports WHERE group_id = $1")
                    .bind(conflict_fixture.target_group_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(target_report_count == 1);
            let source_lineage: Option<String> =
                sqlx::query_scalar("SELECT merged_into_group_key FROM report_groups WHERE id = $1")
                    .bind(conflict_fixture.source_group_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(source_lineage.is_none());
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1 OR id = $2")
            .bind(moving_fixture.workspace_id)
            .bind(conflict_fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn matching_report_fingerprints_share_group_row() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "Report grouping test").await?;

        let result = async {
            let (product, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Grouped feedback".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Grouping writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;

            let first_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            let second_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            let (_, first_report) = submit_product_feedback(
                &pool,
                &first_capability,
                feedback_input("The first matching report groups successfully."),
            )
            .await
            .map_err(test_error)?;
            let (_, second_report) = submit_product_feedback(
                &pool,
                &second_capability,
                feedback_input("The second matching report groups successfully."),
            )
            .await
            .map_err(test_error)?;

            let first_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(first_report.id)
                    .fetch_one(&pool)
                    .await?;
            let second_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(second_report.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(first_group.is_some());
            anyhow::ensure!(first_group == second_group);
            let group_identity = sqlx::query_as::<_, (String, i32)>(
                "SELECT grouper_name, grouper_version FROM report_groups WHERE id = $1",
            )
            .bind(first_group)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(group_identity == ("fingerprint".to_owned(), 1));
            let group_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM report_groups WHERE product_id = $1")
                    .bind(product.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(group_count == 1);

            let mut tx = pool.begin().await?;
            assign_report_group(
                &mut tx,
                &MetadataRefreshingGrouper,
                workspace_id,
                first_report.id,
                &GroupInput {
                    product_id: product.id,
                    operation: "pending",
                    surface: "unknown",
                    status_code: None,
                    findings: &[],
                },
            )
            .await
            .map_err(test_error)?;
            tx.commit().await?;
            let refreshed_identity = sqlx::query_as::<_, (String, i32, String)>(
                r"SELECT grouper_name, grouper_version, explanation
                FROM report_groups WHERE id = $1",
            )
            .bind(first_group)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(
                refreshed_identity
                    == (
                        "metadata-test".to_owned(),
                        2,
                        "refreshed grouper explanation".to_owned()
                    )
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn feedback_topics_are_canonicalized_before_storage_and_grouping() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "Topic canonicalization test").await?;

        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Canonical topics".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Topic writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;

            let capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            let (_, report) = submit_product_feedback(
                &pool,
                &capability,
                feedback_input_with_finding(
                    "A mixed-case topic is accepted and canonicalized.",
                    "Auth Failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let stored_findings: serde_json::Value =
                sqlx::query_scalar("SELECT findings FROM feedback_reports WHERE id = $1")
                    .bind(report.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(
                stored_findings
                    .pointer("/0/topic")
                    .and_then(serde_json::Value::as_str)
                    == Some("auth_failure")
            );
            let explanation: String = sqlx::query_scalar(
                r"SELECT g.explanation
                FROM feedback_reports r
                JOIN report_groups g ON g.id = r.group_id
                WHERE r.id = $1",
            )
            .bind(report.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(explanation.contains("defect/auth_failure"));

            let invalid_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            let invalid = submit_product_feedback(
                &pool,
                &invalid_capability,
                feedback_input_with_finding(
                    "A non-slug topic remains invalid after canonicalization.",
                    "auth/failure",
                ),
            )
            .await
            .expect_err("slash-containing topics must remain invalid");
            anyhow::ensure!(invalid.status == StatusCode::BAD_REQUEST);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn telemetry_late_fill_and_regroup_repair_placeholder_assignments() -> anyhow::Result<()>
    {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "Late telemetry grouping test").await?;

        let result = async {
            let workspace =
                sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE id = $1")
                    .bind(workspace_id)
                    .fetch_one(&pool)
                    .await?;
            let (product, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Late telemetry".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Late telemetry writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let auth = ProductAuth {
                workspace,
                environment: environment.clone(),
                api_key_id: write_key.id,
            };

            let report_first_interaction = Uuid::new_v4();
            let report_first_capability =
                test_capability(&write_secret, write_key.id, report_first_interaction);
            let (_, report_first) = submit_product_feedback(
                &pool,
                &report_first_capability,
                feedback_input_with_finding(
                    "This report arrives before its interaction telemetry.",
                    "search_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let placeholder_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(report_first.id)
                    .fetch_one(&pool)
                    .await?;
            let placeholder_group = placeholder_group
                .ok_or_else(|| anyhow::anyhow!("report-first fixture should have a group"))?;

            let telemetry_result = ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![grouping_telemetry_event(report_first_interaction)],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(telemetry_result.accepted == 1);
            anyhow::ensure!(telemetry_result.dropped == 0);
            let regrouped_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(report_first.id)
                    .fetch_one(&pool)
                    .await?;
            let regrouped_group = regrouped_group
                .ok_or_else(|| anyhow::anyhow!("late-filled report should retain a group"))?;
            anyhow::ensure!(regrouped_group != placeholder_group);
            let regrouped_explanation: String =
                sqlx::query_scalar("SELECT explanation FROM report_groups WHERE id = $1")
                    .bind(regrouped_group)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(regrouped_explanation.contains("operation search_reports"));
            anyhow::ensure!(regrouped_explanation.contains("surface mcp"));
            anyhow::ensure!(regrouped_explanation.ends_with(" · 5xx"));

            let telemetry_first_interaction = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![grouping_telemetry_event(telemetry_first_interaction)],
                },
            )
            .await
            .map_err(test_error)?;
            let telemetry_first_capability =
                test_capability(&write_secret, write_key.id, telemetry_first_interaction);
            let (_, telemetry_first_report) = submit_product_feedback(
                &pool,
                &telemetry_first_capability,
                feedback_input_with_finding(
                    "This matching report arrives after its interaction telemetry.",
                    "search_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let telemetry_first_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(telemetry_first_report.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(telemetry_first_group == Some(regrouped_group));

            let historical_interaction = Uuid::new_v4();
            let historical_capability =
                test_capability(&write_secret, write_key.id, historical_interaction);
            let (_, historical_report) = submit_product_feedback(
                &pool,
                &historical_capability,
                feedback_input_with_finding(
                    "This historical report needs the explicit regroup repair.",
                    "search_failure",
                ),
            )
            .await
            .map_err(test_error)?;
            let historical_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(historical_report.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(historical_group == Some(placeholder_group));
            sqlx::query(
                r"UPDATE interactions_v2
                SET surface = 'mcp', operation = 'search_reports', status_code = 503,
                  classification = 'confirmed', confirmation_method = 'mcp', updated_at = NOW()
                WHERE id = $1",
            )
            .bind(historical_interaction)
            .execute(&pool)
            .await?;

            let first_regroup = regroup_report_groups(&pool, &crate::grouping::FingerprintGrouper)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(first_regroup.moved >= 1);
            anyhow::ensure!(first_regroup.unchanged >= 2);
            let repaired_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(historical_report.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(repaired_group == Some(regrouped_group));

            let second_regroup = regroup_report_groups(&pool, &crate::grouping::FingerprintGrouper)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(second_regroup.moved == 0);
            let group_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM report_groups WHERE product_id = $1")
                    .bind(product.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(group_count == 2);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn report_group_backfill_is_idempotent() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "Report backfill test").await?;

        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Backfilled feedback".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let interaction_id = Uuid::new_v4();
            let report_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, surface, operation, status_code,
                 classification, confirmation_method, occurred_at)
                VALUES ($1, $2, $3, 'mcp', 'search_reports', 503, 'confirmed', 'mcp', NOW())",
            )
            .bind(interaction_id)
            .bind(workspace_id)
            .bind(environment.id)
            .execute(&pool)
            .await?;
            sqlx::query(
                r"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, findings)
                VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(report_id)
            .bind(workspace_id)
            .bind(interaction_id)
            .bind("This existing report should be grouped by the backfill.")
            .bind(serde_json::json!([{
                "kind": "defect",
                "topic": "search_failure",
                "severity": "major",
                "detail": "Search failed for a valid request."
            }]))
            .execute(&pool)
            .await?;

            let malformed_interaction_id = Uuid::new_v4();
            let malformed_report_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, surface, operation, status_code,
                 classification, confirmation_method, occurred_at)
                VALUES ($1, $2, $3, 'mcp', 'search_reports', 503, 'confirmed', 'mcp', NOW())",
            )
            .bind(malformed_interaction_id)
            .bind(workspace_id)
            .bind(environment.id)
            .execute(&pool)
            .await?;
            sqlx::query(
                r"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, findings)
                VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(malformed_report_id)
            .bind(workspace_id)
            .bind(malformed_interaction_id)
            .bind("This malformed report must not block later backfill rows.")
            .bind(serde_json::json!([{
                "kind": "defect",
                "topic": "missing_detail"
            }]))
            .execute(&pool)
            .await?;

            let first = backfill_report_groups(&pool, &crate::grouping::FingerprintGrouper, None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(first.grouped >= 1);
            anyhow::ensure!(first.skipped >= 1);
            anyhow::ensure!(first.skipped_findings >= 1);
            let first_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(first_group.is_some());
            let malformed_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(malformed_report_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(malformed_group.is_none());
            let first_group_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM report_groups")
                .fetch_one(&pool)
                .await?;

            let second = backfill_report_groups(&pool, &crate::grouping::FingerprintGrouper, None)
                .await
                .map_err(test_error)?;
            let second_group: Option<Uuid> =
                sqlx::query_scalar("SELECT group_id FROM feedback_reports WHERE id = $1")
                    .bind(report_id)
                    .fetch_one(&pool)
                    .await?;
            let second_group_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM report_groups")
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(second.grouped == 0);
            anyhow::ensure!(second.skipped_findings >= 1);
            anyhow::ensure!(second_group == first_group);
            anyhow::ensure!(second_group_count == first_group_count);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn github_same_workspace_reinstall_updates_metadata_and_revives() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "GitHub reinstall test").await?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);

        let result = async {
            anyhow::ensure!(
                upsert_github_installation(&pool, workspace_id, installation_id, "before", "User",)
                    .await
                    .map_err(test_error)?
                    == GithubInstallationUpsert::Bound
            );
            revoke_github_installation(&pool, installation_id)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(
                upsert_github_installation(
                    &pool,
                    workspace_id,
                    installation_id,
                    "after",
                    "Organization",
                )
                .await
                .map_err(test_error)?
                    == GithubInstallationUpsert::Bound
            );

            let row = sqlx::query_as::<_, (Uuid, String, String, Option<DateTime<Utc>>)>(
                r"SELECT workspace_id, account_login, account_type, revoked_at
                FROM github_installations WHERE installation_id = $1",
            )
            .bind(installation_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(row.0 == workspace_id);
            anyhow::ensure!(row.1 == "after");
            anyhow::ensure!(row.2 == "Organization");
            anyhow::ensure!(row.3.is_none());
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn github_installation_cannot_move_between_workspaces() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let original_workspace = github_test_workspace(&pool, "GitHub original tenant").await?;
        let other_workspace = github_test_workspace(&pool, "GitHub other tenant").await?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);

        let result = async {
            anyhow::ensure!(
                upsert_github_installation(
                    &pool,
                    original_workspace,
                    installation_id,
                    "original",
                    "Organization",
                )
                .await
                .map_err(test_error)?
                    == GithubInstallationUpsert::Bound
            );
            anyhow::ensure!(
                upsert_github_installation(
                    &pool,
                    other_workspace,
                    installation_id,
                    "attacker",
                    "User",
                )
                .await
                .map_err(test_error)?
                    == GithubInstallationUpsert::ConflictingWorkspace
            );

            let row = sqlx::query_as::<_, (Uuid, String, String)>(
                r"SELECT workspace_id, account_login, account_type
                FROM github_installations WHERE installation_id = $1",
            )
            .bind(installation_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(row.0 == original_workspace);
            anyhow::ensure!(row.1 == "original");
            anyhow::ensure!(row.2 == "Organization");
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1 OR id = $2")
            .bind(original_workspace)
            .bind(other_workspace)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn revoked_github_installation_disappears_from_active_list() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = github_test_workspace(&pool, "GitHub revoke test").await?;
        let installation_id = i64::from(Uuid::new_v4().as_fields().0);

        let result = async {
            anyhow::ensure!(
                upsert_github_installation(
                    &pool,
                    workspace_id,
                    installation_id,
                    "revoked",
                    "Organization",
                )
                .await
                .map_err(test_error)?
                    == GithubInstallationUpsert::Bound
            );
            anyhow::ensure!(
                list_github_installations(&pool, workspace_id)
                    .await
                    .map_err(test_error)?
                    .iter()
                    .any(|installation| installation.installation_id == installation_id)
            );

            revoke_github_installation(&pool, installation_id)
                .await
                .map_err(test_error)?;
            let revoked_at: Option<DateTime<Utc>> = sqlx::query_scalar(
                "SELECT revoked_at FROM github_installations WHERE installation_id = $1",
            )
            .bind(installation_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(revoked_at.is_some());
            anyhow::ensure!(
                list_github_installations(&pool, workspace_id)
                    .await
                    .map_err(test_error)?
                    .iter()
                    .all(|installation| installation.installation_id != installation_id)
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[test]
    fn sensitive_report_filter_allows_credential_descriptions_but_not_credentials() {
        assert!(!contains_sensitive_report_text(
            "The SDK described an HTTP request authenticated with a bearer token."
        ));
        assert!(contains_sensitive_report_text(
            "The request exposed Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature"
        ));
        assert!(contains_sensitive_report_text(
            "The response exposed customer@example.com"
        ));
        assert!(!contains_sensitive_report_text(
            "Request 123e4567-e89b-12d3-a456-426614174000 failed after retry"
        ));
    }

    #[test]
    fn feedback_cursor_is_opaque_and_retention_bounded() -> anyhow::Result<()> {
        let occurred_at = Utc::now() - Duration::hours(1);
        let id = Uuid::new_v4();
        let encoded = encode_feedback_cursor(occurred_at, id).map_err(test_error)?;
        anyhow::ensure!(!encoded.contains(&id.to_string()));
        let decoded = decode_feedback_cursor(Some(&encoded), Utc::now() - Duration::days(1))
            .map_err(test_error)?
            .expect("encoded cursor should decode to a cursor");
        anyhow::ensure!(decoded.id == id);
        anyhow::ensure!(decoded.occurred_at == occurred_at);
        let expired = decode_feedback_cursor(Some(&encoded), Utc::now())
            .expect_err("cursor outside the retained window should be rejected");
        anyhow::ensure!(expired.status == StatusCode::GONE);
        anyhow::ensure!(
            decode_feedback_cursor(Some("not-a-cursor"), Utc::now() - Duration::days(1))
                .expect_err("malformed cursor should be rejected")
                .status
                == StatusCode::BAD_REQUEST
        );
        Ok(())
    }

    #[tokio::test]
    async fn dashboard_list_filters_fail_before_database_access() -> anyhow::Result<()> {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://epode:epode@127.0.0.1:1/validation_only")?;
        let workspace_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();

        let invalid_status = dashboard_feedback_page(
            &pool,
            workspace_id,
            product_id,
            DashboardFeedbackFilters {
                statuses: Some(vec!["deleted".into()]),
                ..DashboardFeedbackFilters::default()
            },
        )
        .await
        .expect_err("invalid feedback status must fail before a database call");
        anyhow::ensure!(invalid_status.status == StatusCode::BAD_REQUEST);

        let invalid_range = dashboard_feedback_page(
            &pool,
            workspace_id,
            product_id,
            DashboardFeedbackFilters {
                since: Some(Utc::now()),
                until: Some(Utc::now() - Duration::days(1)),
                ..DashboardFeedbackFilters::default()
            },
        )
        .await
        .expect_err("reversed feedback time range must fail before a database call");
        anyhow::ensure!(invalid_range.status == StatusCode::BAD_REQUEST);

        let invalid_session_kind = dashboard_sessions_page(
            &pool,
            workspace_id,
            product_id,
            DashboardSessionFilters {
                kind: Some("replayed".into()),
                ..DashboardSessionFilters::default()
            },
        )
        .await
        .expect_err("invalid session kind must fail before a database call");
        anyhow::ensure!(invalid_session_kind.status == StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn dashboard_feedback_group_filter_returns_exact_evidence() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Dashboard group evidence", 2).await?;

        let result = async {
            let page = dashboard_feedback_page(
                &pool,
                fixture.workspace_id,
                fixture.product_id,
                DashboardFeedbackFilters {
                    group_key: Some(fixture.group_key.clone()),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(page.total == 2 && page.reports.len() == 2);
            anyhow::ensure!(
                page.reports
                    .iter()
                    .all(|report| report.operation == "search_reports")
            );
            anyhow::ensure!(
                page.facets
                    .topic
                    .iter()
                    .any(|topic| topic.name == "search_failure" && topic.count == 2)
            );

            let missing = dashboard_feedback_page(
                &pool,
                fixture.workspace_id,
                fixture.product_id,
                DashboardFeedbackFilters {
                    group_key: Some(Uuid::new_v4().simple().to_string()),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(missing.total == 0 && missing.reports.is_empty());
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(fixture.workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn product_activation_milestones_survive_windows_retention_and_retries()
    -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Durable product activation").await?;

        let result = async {
            let (product, environment) = create_product(
                &pool,
                workspace.id,
                CreateProductInput {
                    name: "Durably activated product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace.id,
                environment.id,
                Some("Activation writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let auth = ProductAuth {
                workspace: workspace.clone(),
                environment: environment.clone(),
                api_key_id: write_key.id,
            };
            let initial = activation_milestones(&pool, workspace.id, product.id).await?;
            anyhow::ensure!(initial.first_opportunity_at.is_none());
            anyhow::ensure!(initial.first_confirmed_interaction_at.is_none());
            anyhow::ensure!(initial.first_report_at.is_none());

            let opportunity_id = Uuid::new_v4();
            let opportunity_event = http_telemetry_event(opportunity_id, Utc::now());
            let opportunity = ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![opportunity_event],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(opportunity.accepted == 1 && opportunity.dropped == 0);
            let after_opportunity = activation_milestones(&pool, workspace.id, product.id).await?;
            let first_opportunity_at = after_opportunity
                .first_opportunity_at
                .ok_or_else(|| anyhow::anyhow!("accepted telemetry did not mark opportunity"))?;
            anyhow::ensure!(after_opportunity.first_confirmed_interaction_at.is_none());
            anyhow::ensure!(after_opportunity.first_report_at.is_none());

            let retry = ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![http_telemetry_event(opportunity_id, Utc::now())],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(retry.accepted == 1 && retry.dropped == 0);
            let after_retry = activation_milestones(&pool, workspace.id, product.id).await?;
            anyhow::ensure!(after_retry.first_opportunity_at == Some(first_opportunity_at));

            let confirmed_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![grouping_telemetry_event(confirmed_id)],
                },
            )
            .await
            .map_err(test_error)?;
            let after_confirmation =
                activation_milestones(&pool, workspace.id, product.id).await?;
            let first_confirmed_at = after_confirmation
                .first_confirmed_interaction_at
                .ok_or_else(|| anyhow::anyhow!("accepted MCP telemetry did not mark confirmation"))?;
            anyhow::ensure!(after_confirmation.first_opportunity_at == Some(first_opportunity_at));
            anyhow::ensure!(after_confirmation.first_report_at.is_none());

            let report_interaction_id = Uuid::new_v4();
            let capability =
                test_capability(&write_secret, write_key.id, report_interaction_id);
            submit_product_feedback(
                &pool,
                &capability,
                feedback_input("A durable activation report completed the product loop."),
            )
            .await
            .map_err(test_error)?;
            let after_report = activation_milestones(&pool, workspace.id, product.id).await?;
            let first_report_at = after_report
                .first_report_at
                .ok_or_else(|| anyhow::anyhow!("accepted report did not mark activation"))?;
            anyhow::ensure!(after_report.first_opportunity_at == Some(first_opportunity_at));
            anyhow::ensure!(
                after_report.first_confirmed_interaction_at == Some(first_confirmed_at)
            );

            submit_product_feedback(
                &pool,
                &capability,
                feedback_input("A retry cannot replace the first accepted activation report."),
            )
            .await
            .map_err(test_error)?;
            let after_report_retry =
                activation_milestones(&pool, workspace.id, product.id).await?;
            anyhow::ensure!(after_report_retry.first_opportunity_at == Some(first_opportunity_at));
            anyhow::ensure!(
                after_report_retry.first_confirmed_interaction_at == Some(first_confirmed_at)
            );
            anyhow::ensure!(after_report_retry.first_report_at == Some(first_report_at));

            sqlx::query(
                "UPDATE interactions_v2 SET occurred_at = NOW() - INTERVAL '400 days' WHERE environment_id = $1",
            )
            .bind(environment.id)
            .execute(&pool)
            .await?;
            sqlx::query(
                "UPDATE product_environments SET retention_days = 1 WHERE id = $1",
            )
            .bind(environment.id)
            .execute(&pool)
            .await?;
            let removed = purge_expired_product_data(&pool, 100)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(removed >= 3);

            let after_purge = activation_milestones(&pool, workspace.id, product.id).await?;
            anyhow::ensure!(after_purge.first_opportunity_at == Some(first_opportunity_at));
            anyhow::ensure!(
                after_purge.first_confirmed_interaction_at == Some(first_confirmed_at)
            );
            anyhow::ensure!(after_purge.first_report_at == Some(first_report_at));

            let dashboard = dashboard_with_limits(
                &pool,
                DashboardContext {
                    user: CurrentUser {
                        id: workspace.os_user_id.clone(),
                        handle: "activation-owner".into(),
                        email: None,
                        display_name: "Activation Owner".into(),
                    },
                    workspace: workspace.clone(),
                    role: "owner".into(),
                    workspace_memberships: vec![],
                },
                Some(product.id),
                None,
                10,
                10,
                10,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(dashboard.insights.opportunities == 0);
            anyhow::ensure!(dashboard.insights.confirmed_interactions == 0);
            anyhow::ensure!(dashboard.insights.reports == 0);
            let durable = dashboard
                .activation_milestones
                .ok_or_else(|| anyhow::anyhow!("dashboard omitted durable activation"))?;
            anyhow::ensure!(durable.first_opportunity_at == Some(first_opportunity_at));
            anyhow::ensure!(
                durable.first_confirmed_interaction_at == Some(first_confirmed_at)
            );
            anyhow::ensure!(durable.first_report_at == Some(first_report_at));

            let (sibling, sibling_auth) =
                telemetry_test_product(&pool, &workspace, "Unactivated sibling").await?;
            let mut invalid_event = http_telemetry_event(Uuid::new_v4(), Utc::now());
            invalid_event.operation = "/v1/search?customer=raw".into();
            let invalid = ingest_telemetry_batch(
                &pool,
                &sibling_auth,
                TelemetryBatchInput {
                    events: vec![invalid_event],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(invalid.accepted == 0 && invalid.dropped == 1);
            let sibling_activation =
                activation_milestones(&pool, workspace.id, sibling.id).await?;
            anyhow::ensure!(sibling_activation.first_opportunity_at.is_none());
            anyhow::ensure!(sibling_activation.first_confirmed_interaction_at.is_none());
            anyhow::ensure!(sibling_activation.first_report_at.is_none());

            let sibling_dashboard = dashboard_with_limits(
                &pool,
                DashboardContext {
                    user: CurrentUser {
                        id: workspace.os_user_id.clone(),
                        handle: "activation-owner".into(),
                        email: None,
                        display_name: "Activation Owner".into(),
                    },
                    workspace: workspace.clone(),
                    role: "owner".into(),
                    workspace_memberships: vec![],
                },
                Some(sibling.id),
                None,
                10,
                10,
                10,
            )
            .await
            .map_err(test_error)?;
            let sibling_durable = sibling_dashboard
                .activation_milestones
                .ok_or_else(|| anyhow::anyhow!("dashboard omitted sibling activation record"))?;
            anyhow::ensure!(sibling_durable.product_id == sibling.id);
            anyhow::ensure!(sibling_durable.first_opportunity_at.is_none());

            delete_product(
                &pool,
                workspace.id,
                product.id,
                DeleteProductInput {
                    confirmation: product.name.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            let remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM product_activation_milestones WHERE product_id = $1",
            )
            .bind(product.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(remaining == 0);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn dashboard_pages_filter_paginate_and_isolate_complete_datasets() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Dashboard pagination conformance").await?;
        let isolated_workspace =
            telemetry_test_workspace(&pool, "Dashboard pagination isolation").await?;

        let result = async {
            let (product, environment) = create_product(
                &pool,
                workspace.id,
                CreateProductInput {
                    name: "High volume primary".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (sibling, sibling_environment) = create_product(
                &pool,
                workspace.id,
                CreateProductInput {
                    name: "High volume sibling".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (isolated_product, isolated_environment) = create_product(
                &pool,
                isolated_workspace.id,
                CreateProductInput {
                    name: "High volume isolated".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let now = Utc::now();
            let checkout_session = Uuid::new_v4();
            let search_session = Uuid::new_v4();
            let expired_session = Uuid::new_v4();
            for (id, environment_id, source, hint, started_at, last_seen_at) in [
                (
                    checkout_session,
                    environment.id,
                    "mcp",
                    "checkout-session",
                    now - Duration::minutes(5),
                    now - Duration::minutes(2),
                ),
                (
                    search_session,
                    environment.id,
                    "customer",
                    "search-session",
                    now - Duration::minutes(4),
                    now - Duration::minutes(3),
                ),
                (
                    expired_session,
                    environment.id,
                    "mcp",
                    "expired-session",
                    now - Duration::days(31),
                    now - Duration::days(31),
                ),
            ] {
                sqlx::query(
                    r"INSERT INTO sessions_v2
                    (id, workspace_id, environment_id, source, ref_hash, ref_hint,
                     started_at, last_seen_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                )
                .bind(id)
                .bind(workspace.id)
                .bind(environment_id)
                .bind(source)
                .bind(sha256(hint))
                .bind(hint)
                .bind(started_at)
                .bind(last_seen_at)
                .execute(&pool)
                .await?;
            }
            let checkout = Uuid::new_v4();
            let checkout_retry = Uuid::new_v4();
            let search = Uuid::new_v4();
            let expired_mixed_interaction = Uuid::new_v4();
            let expired_interaction = Uuid::new_v4();
            let sibling_interaction = Uuid::new_v4();
            let isolated_interaction = Uuid::new_v4();
            for (id, owning_workspace, environment_id, session_id, operation, customer_ref, occurred_at) in [
                (checkout, workspace.id, environment.id, Some(checkout_session), "checkout", "tenant-a", now - Duration::minutes(5)),
                (checkout_retry, workspace.id, environment.id, Some(checkout_session), "checkout_retry", "tenant-a", now - Duration::minutes(2)),
                (search, workspace.id, environment.id, Some(search_session), "search", "tenant-b", now - Duration::minutes(3)),
                (expired_mixed_interaction, workspace.id, environment.id, Some(checkout_session), "expired_checkout_history", "tenant-old", now - Duration::days(31)),
                (expired_interaction, workspace.id, environment.id, Some(expired_session), "expired_operation", "tenant-old", now - Duration::days(31)),
                (sibling_interaction, workspace.id, sibling_environment.id, None, "checkout", "tenant-a", now - Duration::minutes(1)),
                (isolated_interaction, isolated_workspace.id, isolated_environment.id, None, "checkout", "tenant-a", now),
            ] {
                sqlx::query(
                    r"INSERT INTO interactions_v2
                    (id, workspace_id, environment_id, session_id, surface, operation,
                     status_code, customer_ref, classification, confirmation_method, occurred_at)
                    VALUES ($1, $2, $3, $4, 'mcp', $5, 200, $6, 'confirmed', 'mcp', $7)",
                )
                .bind(id)
                .bind(owning_workspace)
                .bind(environment_id)
                .bind(session_id)
                .bind(operation)
                .bind(customer_ref)
                .bind(occurred_at)
                .execute(&pool)
                .await?;
            }
            let checkout_report = Uuid::new_v4();
            let search_report = Uuid::new_v4();
            let expired_mixed_report = Uuid::new_v4();
            let expired_report = Uuid::new_v4();
            let sibling_report = Uuid::new_v4();
            let isolated_report = Uuid::new_v4();
            for (id, owning_workspace, interaction_id, summary, impact, findings, created_at) in [
                (checkout_report, workspace.id, checkout, "Checkout timed out before confirmation.", "blocked", serde_json::json!([{"kind":"defect","topic":"timeout","severity":"blocking","detail":"The agent could not complete checkout."}]), now - Duration::minutes(5)),
                (search_report, workspace.id, search, "Search returned the expected current result.", "helped", serde_json::json!([{"kind":"strength","topic":"freshness","severity":"minor","detail":"The newest document was returned."}]), now - Duration::minutes(3)),
                (expired_mixed_report, workspace.id, expired_mixed_interaction, "Expired checkout history must remain hidden.", "hindered", serde_json::json!([{"kind":"friction","topic":"expired_mixed_topic","severity":"major","detail":"Expired evidence must not affect a retained session."}]), now),
                (expired_report, workspace.id, expired_interaction, "A late report must not resurrect expired evidence.", "blocked", serde_json::json!([{"kind":"defect","topic":"expired_topic","severity":"blocking","detail":"The interaction is outside retention."}]), now),
                (sibling_report, workspace.id, sibling_interaction, "Sibling checkout timed out before confirmation.", "blocked", serde_json::json!([]), now - Duration::minutes(1)),
                (isolated_report, isolated_workspace.id, isolated_interaction, "Isolated checkout timed out before confirmation.", "blocked", serde_json::json!([]), now),
            ] {
                sqlx::query(
                    r"INSERT INTO feedback_reports
                    (id, workspace_id, interaction_id, summary, impact, findings, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(id)
                .bind(owning_workspace)
                .bind(interaction_id)
                .bind(summary)
                .bind(impact)
                .bind(findings)
                .bind(created_at)
                .execute(&pool)
                .await?;
            }
            for (report_id, owning_workspace, status) in [
                (checkout_report, workspace.id, "investigating"),
                (search_report, workspace.id, "resolved"),
                (expired_mixed_report, workspace.id, "planned"),
                (expired_report, workspace.id, "new"),
                (sibling_report, workspace.id, "new"),
                (isolated_report, isolated_workspace.id, "new"),
            ] {
                sqlx::query(
                    r"INSERT INTO feedback_report_workflow
                    (report_id, workspace_id, status) VALUES ($1, $2, $3)",
                )
                .bind(report_id)
                .bind(owning_workspace)
                .bind(status)
                .execute(&pool)
                .await?;
            }
            sqlx::query(
                r"INSERT INTO enrichment_requests
                (id, workspace_id, product_id, environment_id, interaction_id,
                 surface, purpose, remember, consent_subject, identity_level, state,
                 operation, question_key, question, request_hash, capability_nonce_hash,
                 expires_at, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, 'mcp', 'product_personalization', FALSE,
                  'afint1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ephemeral',
                  'consent_required', 'checkout', 'customer_context.v1',
                  'What should the product prioritize for this customer?',
                  decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'),
                  $6, $7, $7)",
            )
            .bind(Uuid::new_v4())
            .bind(workspace.id)
            .bind(product.id)
            .bind(environment.id)
            .bind(checkout)
            .bind(now + Duration::hours(1))
            .bind(now - Duration::minutes(4))
            .execute(&pool)
            .await?;

            let first = dashboard_feedback_page(
                &pool,
                workspace.id,
                product.id,
                DashboardFeedbackFilters {
                    limit: Some(1),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(first.total == 2 && first.reports.len() == 1);
            anyhow::ensure!(
                first
                    .facets
                    .status
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("investigating", 1), ("resolved", 1)])
            );
            anyhow::ensure!(
                first
                    .facets
                    .topic
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("freshness", 1), ("timeout", 1)])
            );
            let second = dashboard_feedback_page(
                &pool,
                workspace.id,
                product.id,
                DashboardFeedbackFilters {
                    limit: Some(1),
                    cursor: first.next_cursor.clone(),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(second.total == 2 && second.reports.len() == 1);
            anyhow::ensure!(first.reports[0].id != second.reports[0].id);

            let status_filtered = dashboard_feedback_page(
                &pool,
                workspace.id,
                product.id,
                DashboardFeedbackFilters {
                    statuses: Some(vec!["investigating".into()]),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(status_filtered.total == 1);
            anyhow::ensure!(
                status_filtered
                    .facets
                    .status
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("investigating", 1), ("resolved", 1)])
            );
            anyhow::ensure!(
                status_filtered
                    .facets
                    .impact
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("blocked", 1)])
            );
            anyhow::ensure!(
                status_filtered
                    .facets
                    .topic
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("timeout", 1)])
            );

            let incompatible_facets = dashboard_feedback_page(
                &pool,
                workspace.id,
                product.id,
                DashboardFeedbackFilters {
                    statuses: Some(vec!["investigating".into()]),
                    impacts: Some(vec!["helped".into()]),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(incompatible_facets.total == 0);
            anyhow::ensure!(
                incompatible_facets
                    .facets
                    .status
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("resolved", 1)])
            );
            anyhow::ensure!(
                incompatible_facets
                    .facets
                    .impact
                    .iter()
                    .map(|item| (item.name.as_str(), item.count))
                    .collect::<BTreeMap<_, _>>()
                    == BTreeMap::from([("blocked", 1)])
            );
            anyhow::ensure!(incompatible_facets.facets.topic.is_empty());

            let filtered = dashboard_feedback_page(
                &pool,
                workspace.id,
                product.id,
                DashboardFeedbackFilters {
                    query: Some("timed out".into()),
                    statuses: Some(vec!["investigating".into()]),
                    impacts: Some(vec!["blocked".into()]),
                    operation: Some("checkout".into()),
                    customer_ref: Some("tenant-a".into()),
                    since: Some(now - Duration::hours(1)),
                    until: Some(now),
                    ..DashboardFeedbackFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(filtered.total == 1 && filtered.reports[0].id == checkout_report);
            anyhow::ensure!(
                filtered
                    .facets
                    .status
                    .iter()
                    .any(|item| item.name == "investigating" && item.count == 1)
            );

            let sessions = dashboard_sessions_page(
                &pool,
                workspace.id,
                product.id,
                DashboardSessionFilters {
                    query: Some("checkout".into()),
                    kind: Some("multi".into()),
                    impacts: Some(vec!["blocked".into()]),
                    operation: Some("checkout".into()),
                    customer_ref: Some("tenant-a".into()),
                    since: Some(now - Duration::hours(1)),
                    until: Some(now),
                    ..DashboardSessionFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(sessions.rollup.sessions == 1);
            anyhow::ensure!(sessions.rollup.interactions == 2);
            anyhow::ensure!(sessions.rollup.multi_step_sessions == 1);
            anyhow::ensure!(sessions.sessions[0].id == checkout_session);

            let all_sessions = dashboard_sessions_page(
                &pool,
                workspace.id,
                product.id,
                DashboardSessionFilters::default(),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(all_sessions.rollup.sessions == 2);
            anyhow::ensure!(all_sessions.rollup.interactions == 3);
            anyhow::ensure!(all_sessions.rollup.multi_step_sessions == 1);
            anyhow::ensure!(
                all_sessions
                    .sessions
                    .iter()
                    .all(|session| session.id != expired_session)
            );
            let sessions_with_responses = dashboard_sessions_page(
                &pool,
                workspace.id,
                product.id,
                DashboardSessionFilters {
                    kind: Some("response".into()),
                    ..DashboardSessionFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(sessions_with_responses.rollup.sessions == 1);
            anyhow::ensure!(sessions_with_responses.sessions.len() == 1);
            anyhow::ensure!(sessions_with_responses.sessions[0].id == checkout_session);
            let sessions_without_responses = dashboard_sessions_page(
                &pool,
                workspace.id,
                product.id,
                DashboardSessionFilters {
                    kind: Some("no_response".into()),
                    ..DashboardSessionFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(sessions_without_responses.rollup.sessions == 1);
            anyhow::ensure!(sessions_without_responses.sessions.len() == 1);
            anyhow::ensure!(sessions_without_responses.sessions[0].id == search_session);
            let checkout_summary = all_sessions
                .sessions
                .iter()
                .find(|session| session.id == checkout_session)
                .expect("retained checkout session should be listed");
            anyhow::ensure!(checkout_summary.interaction_count == 2);
            anyhow::ensure!(checkout_summary.report_count == 1);
            anyhow::ensure!(checkout_summary.first_operation.as_deref() == Some("checkout"));

            let expired_activity_filter = dashboard_sessions_page(
                &pool,
                workspace.id,
                product.id,
                DashboardSessionFilters {
                    operation: Some("expired_checkout_history".into()),
                    ..DashboardSessionFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(expired_activity_filter.rollup.sessions == 0);
            anyhow::ensure!(expired_activity_filter.sessions.is_empty());

            let context = DashboardContext {
                user: CurrentUser {
                    id: "usr_dashboard_retention".into(),
                    handle: "dashboard-retention".into(),
                    email: None,
                    display_name: "Dashboard Retention".into(),
                },
                workspace: workspace.clone(),
                role: "owner".into(),
                workspace_memberships: vec![],
            };
            let bootstrap = dashboard_with_limits(
                &pool,
                context,
                Some(product.id),
                None,
                100,
                100,
                100,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(bootstrap.list_state.interactions_total == 3);
            anyhow::ensure!(bootstrap.list_state.reports_total == 2);
            anyhow::ensure!(bootstrap.list_state.sessions_total == 2);
            anyhow::ensure!(bootstrap.insights.opportunities == 3);
            anyhow::ensure!(bootstrap.insights.reports == 2);
            anyhow::ensure!(
                bootstrap
                    .interactions
                    .iter()
                    .all(|interaction| interaction.id != expired_interaction
                        && interaction.id != expired_mixed_interaction)
            );
            anyhow::ensure!(
                bootstrap
                    .reports
                    .iter()
                    .all(|report| report.id != expired_report && report.id != expired_mixed_report)
            );
            let bootstrap_checkout = bootstrap
                .sessions
                .iter()
                .find(|session| session.id == checkout_session)
                .expect("bootstrap should include the retained checkout session");
            anyhow::ensure!(bootstrap_checkout.interaction_count == 2);
            anyhow::ensure!(bootstrap_checkout.report_count == 1);

            let expired_report_error = dashboard_report_by_id(
                &pool,
                workspace.id,
                product.id,
                expired_report,
            )
            .await
            .expect_err("expired reports must not be addressable before purge");
            anyhow::ensure!(expired_report_error.status == StatusCode::NOT_FOUND);
            let expired_interaction_error = dashboard_interaction_by_id(
                &pool,
                workspace.id,
                product.id,
                expired_interaction,
            )
            .await
            .expect_err("expired interactions must not be addressable before purge");
            anyhow::ensure!(expired_interaction_error.status == StatusCode::NOT_FOUND);
            let expired_session_error = dashboard_session_by_id(
                &pool,
                workspace.id,
                product.id,
                expired_session,
            )
            .await
            .expect_err("expired sessions must not be addressable before purge");
            anyhow::ensure!(expired_session_error.status == StatusCode::NOT_FOUND);
            let checkout_detail = dashboard_session_by_id(
                &pool,
                workspace.id,
                product.id,
                checkout_session,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(checkout_detail.interactions.len() == 2);
            anyhow::ensure!(checkout_detail.reports.len() == 1);
            anyhow::ensure!(
                checkout_detail
                    .interactions
                    .iter()
                    .all(|interaction| interaction.id != expired_mixed_interaction)
            );

            let sibling_page = dashboard_feedback_page(
                &pool,
                workspace.id,
                sibling.id,
                DashboardFeedbackFilters::default(),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(sibling_page.total == 1 && sibling_page.reports[0].id == sibling_report);
            let isolation_error = dashboard_feedback_page(
                &pool,
                workspace.id,
                isolated_product.id,
                DashboardFeedbackFilters::default(),
            )
            .await
            .expect_err("another workspace's product must not be queryable");
            anyhow::ensure!(isolation_error.status == StatusCode::NOT_FOUND);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        for workspace_id in [workspace.id, isolated_workspace.id] {
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(workspace_id)
                .execute(&pool)
                .await?;
        }
        result
    }

    #[test]
    fn telemetry_evidence_matrix_is_fail_closed() {
        let event = |surface: &str, classification: Option<&str>, method: Option<&str>| {
            InteractionTelemetryInput {
                interaction_id: Uuid::new_v4(),
                sequence: Some(1),
                surface: surface.into(),
                operation: "/search/:id".into(),
                status_code: Some(200),
                duration_ms: Some(10),
                customer_ref: None,
                account_ref: None,
                user_ref: None,
                anonymous_ref: None,
                classification: classification.map(str::to_owned),
                confirmation_method: method.map(str::to_owned),
                runtime_hint: None,
                runtime_hint_source: None,
                session_ref: None,
                session_source: None,
                occurred_at: None,
            }
        };
        assert!(validate_telemetry(&event("http_json", None, None)).is_ok());
        assert!(validate_telemetry(&event("http_html", Some("unclassified"), None)).is_ok());
        assert!(validate_telemetry(&event("mcp", Some("confirmed"), Some("mcp"))).is_ok());
        assert!(validate_telemetry(&event("http_json", Some("confirmed"), Some("mcp"))).is_err());
        assert!(validate_telemetry(&event("http_json", Some("confirmed"), None)).is_err());
        assert!(validate_telemetry(&event("mcp", Some("unclassified"), None)).is_err());
        assert!(validate_telemetry(&event("mcp", Some("confirmed"), None)).is_err());
        assert!(validate_telemetry(&event("http_json", None, Some("mcp"))).is_err());
        assert!(validate_telemetry(&event("http_json", None, None)).is_ok());
        assert!(
            validate_telemetry(&InteractionTelemetryInput {
                runtime_hint: Some("Mozilla/5.0 (compatible; Epode test)".into()),
                runtime_hint_source: Some("http".into()),
                ..event("http_json", None, None)
            })
            .is_ok()
        );
        for (surface, hint, source) in [
            ("http_json", Some("codex"), None),
            ("http_json", None, Some("http")),
            ("http_json", Some("codex"), Some("mcp")),
            ("mcp", Some("claude"), Some("http")),
            ("mcp", Some("customer@example.com"), Some("mcp")),
            ("mcp", Some("af_live_not_a_runtime"), Some("mcp")),
        ] {
            assert!(
                validate_telemetry(&InteractionTelemetryInput {
                    runtime_hint: hint.map(str::to_owned),
                    runtime_hint_source: source.map(str::to_owned),
                    ..event(
                        surface,
                        (surface == "mcp").then_some("confirmed"),
                        (surface == "mcp").then_some("mcp")
                    )
                })
                .is_err()
            );
        }
        assert!(
            validate_telemetry(&InteractionTelemetryInput {
                runtime_hint: Some("x".repeat(201)),
                runtime_hint_source: Some("http".into()),
                ..event("http_json", None, None)
            })
            .is_err()
        );
        assert!(
            validate_telemetry(&InteractionTelemetryInput {
                operation: "/users/alice@example.com".into(),
                ..event("http_json", None, None)
            })
            .is_err()
        );
        assert_eq!(
            session_evidence(Some("workflow_42".into()), None).expect("valid session evidence"),
            Some(("workflow_42".into(), "customer".into()))
        );
        assert_eq!(
            session_evidence(Some("   ".into()), Some("mcp".into()))
                .expect("blank session refs are omitted"),
            None
        );
        for invalid_ref in [
            " workflow_42".into(),
            "workflow 42".into(),
            "customer@example.com".into(),
            "workflow/42".into(),
            "x".repeat(161),
        ] {
            assert_eq!(
                session_evidence(Some(invalid_ref.clone()), Some("mcp".into()))
                    .expect("invalid optional session refs are omitted"),
                None
            );
            assert_eq!(opaque_ref(Some(invalid_ref)), None);
        }
        assert!(session_evidence(Some("workflow_42".into()), Some("transport".into())).is_err());
    }

    #[tokio::test]
    async fn feedback_report_limits_reject_instead_of_silently_truncating() -> anyhow::Result<()> {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://epode:epode@127.0.0.1:1/validation_only")?;
        let capability = "afr2_invalid.invalid.invalid";

        let oversized_summary = feedback_input(&"s".repeat(701));
        let error = submit_product_feedback(&pool, capability, oversized_summary)
            .await
            .expect_err("oversized summary must fail before database access");
        anyhow::ensure!(error.status == StatusCode::BAD_REQUEST);

        let mut oversized_topic = feedback_input("The product returned a useful result.");
        oversized_topic.findings = vec![FeedbackFindingInput {
            kind: "strength".into(),
            topic: "t".repeat(65),
            severity: Some("minor".into()),
            detail: "The result was accurate.".into(),
        }];
        let error = submit_product_feedback(&pool, capability, oversized_topic)
            .await
            .expect_err("oversized topic must fail before database access");
        anyhow::ensure!(error.status == StatusCode::BAD_REQUEST);

        let mut oversized_detail = feedback_input("The product returned a useful result.");
        oversized_detail.findings = vec![FeedbackFindingInput {
            kind: "strength".into(),
            topic: "accuracy".into(),
            severity: Some("minor".into()),
            detail: "d".repeat(351),
        }];
        let error = submit_product_feedback(&pool, capability, oversized_detail)
            .await
            .expect_err("oversized finding detail must fail before database access");
        anyhow::ensure!(error.status == StatusCode::BAD_REQUEST);

        let mut oversized_workaround = feedback_input("The product returned a useful result.");
        oversized_workaround.workaround = Some(crate::models::FeedbackWorkaroundInput {
            used: true,
            detail: Some("w".repeat(351)),
        });
        let error = submit_product_feedback(&pool, capability, oversized_workaround)
            .await
            .expect_err("oversized workaround must fail before database access");
        anyhow::ensure!(error.status == StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn tenant_scoped_sessions_preserve_the_legacy_upsert_during_rollout() -> anyhow::Result<()>
    {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Session rollout compatibility").await?;

        let result = async {
            let (_, auth) = telemetry_test_product(&pool, &workspace, "Session rollout").await?;
            let occurred_at = Utc::now();
            let canonical_ref = "workflow:overlap_42";
            let raw_ref_hash = sha256(canonical_ref);
            let legacy_session_id = Uuid::new_v4();
            let legacy_upsert = r"INSERT INTO sessions_v2
                (id, workspace_id, environment_id, source, ref_hash, ref_hint,
                 started_at, last_seen_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
                ON CONFLICT (environment_id, source, ref_hash) DO UPDATE
                SET started_at = LEAST(sessions_v2.started_at, EXCLUDED.started_at),
                    last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
                RETURNING id";

            let first_legacy_result: Uuid = sqlx::query_scalar(legacy_upsert)
                .bind(legacy_session_id)
                .bind(workspace.id)
                .bind(auth.environment.id)
                .bind("mcp")
                .bind(&raw_ref_hash)
                .bind("legacy-overlap")
                .bind(occurred_at)
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(first_legacy_result == legacy_session_id);

            let acme_id = Uuid::new_v4();
            let globex_id = Uuid::new_v4();
            let mut tenant_a = mcp_telemetry_event(
                acme_id,
                Some(1),
                "tenant_a_overlap",
                Some(canonical_ref),
                Some("mcp"),
                occurred_at,
            );
            tenant_a.customer_ref = Some("tenant-a".into());
            let mut tenant_b = mcp_telemetry_event(
                globex_id,
                Some(2),
                "tenant_b_overlap",
                Some(canonical_ref),
                Some("mcp"),
                occurred_at,
            );
            tenant_b.customer_ref = Some("tenant-b".into());
            let accepted = ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![tenant_a, tenant_b],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(accepted.accepted == 2 && accepted.dropped == 0);

            let acme_session = interaction_session(&pool, acme_id)
                .await?
                .expect("tenant A should receive a scoped session");
            let globex_session = interaction_session(&pool, globex_id)
                .await?
                .expect("tenant B should receive a scoped session");
            anyhow::ensure!(acme_session != globex_session);
            anyhow::ensure!(acme_session != legacy_session_id);
            anyhow::ensure!(globex_session != legacy_session_id);

            let retried_legacy_result: Uuid = sqlx::query_scalar(legacy_upsert)
                .bind(Uuid::new_v4())
                .bind(workspace.id)
                .bind(auth.environment.id)
                .bind("mcp")
                .bind(&raw_ref_hash)
                .bind("legacy-overlap-retry")
                .bind(occurred_at + Duration::seconds(1))
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(retried_legacy_result == legacy_session_id);

            let legacy_constraint_present: bool = sqlx::query_scalar(
                r"SELECT EXISTS(
                  SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'sessions_v2'::regclass
                    AND conname = 'sessions_v2_environment_source_ref_hash_key'
                    AND contype = 'u'
                )",
            )
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(legacy_constraint_present);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn session_correlation_is_proof_backed_end_to_end() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Session correlation conformance").await?;

        let result = async {
            let (primary_product, primary_auth) =
                telemetry_test_product(&pool, &workspace, "Session primary").await?;
            let (_, isolated_auth) =
                telemetry_test_product(&pool, &workspace, "Session isolated").await?;
            let occurred_at = Utc::now();
            let canonical_ref = "workflow:canonical_42";
            let create_id = Uuid::new_v4();
            let followup_id = Uuid::new_v4();
            let dedup_id = Uuid::new_v4();
            let customer_default_id = Uuid::new_v4();
            let customer_explicit_id = Uuid::new_v4();
            let different_ref_id = Uuid::new_v4();
            let missing_ref_id = Uuid::new_v4();
            let blank_ref_id = Uuid::new_v4();
            let acme_interaction_id = Uuid::new_v4();
            let acme_followup_id = Uuid::new_v4();
            let globex_interaction_id = Uuid::new_v4();

            let mut tenant_a = mcp_telemetry_event(
                acme_interaction_id,
                Some(9),
                "tenant_a_start",
                Some(canonical_ref),
                Some("mcp"),
                occurred_at,
            );
            tenant_a.customer_ref = Some("tenant-a".into());
            let mut tenant_a_followup = mcp_telemetry_event(
                acme_followup_id,
                Some(10),
                "tenant_a_followup",
                Some(canonical_ref),
                Some("mcp"),
                occurred_at,
            );
            tenant_a_followup.customer_ref = Some("tenant-a".into());
            let mut tenant_b = mcp_telemetry_event(
                globex_interaction_id,
                Some(11),
                "tenant_b_start",
                Some(canonical_ref),
                Some("mcp"),
                occurred_at,
            );
            tenant_b.customer_ref = Some("tenant-b".into());

            let primary = ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            create_id,
                            Some(1),
                            "summarize",
                            Some(canonical_ref),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            followup_id,
                            Some(2),
                            "get_summary",
                            Some(canonical_ref),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            dedup_id,
                            Some(3),
                            "summarize_cached",
                            Some(canonical_ref),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            customer_default_id,
                            Some(4),
                            "customer_default",
                            Some(canonical_ref),
                            None,
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            customer_explicit_id,
                            Some(5),
                            "customer_explicit",
                            Some(canonical_ref),
                            Some("customer"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            different_ref_id,
                            Some(6),
                            "different_workflow",
                            Some("workflow:different_43"),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            missing_ref_id,
                            Some(7),
                            "missing_workflow",
                            None,
                            None,
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            blank_ref_id,
                            Some(8),
                            "blank_workflow",
                            Some("   "),
                            Some("mcp"),
                            occurred_at,
                        ),
                        tenant_a,
                        tenant_a_followup,
                        tenant_b,
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(primary.accepted == 11 && primary.dropped == 0);

            let isolated_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &isolated_auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        isolated_id,
                        Some(1),
                        "summarize",
                        Some(canonical_ref),
                        Some("mcp"),
                        occurred_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;

            let mcp_session = interaction_session(&pool, create_id)
                .await?
                .expect("explicit MCP proof should create a session");
            anyhow::ensure!(interaction_session(&pool, followup_id).await? == Some(mcp_session));
            anyhow::ensure!(interaction_session(&pool, dedup_id).await? == Some(mcp_session));
            let customer_session = interaction_session(&pool, customer_default_id)
                .await?
                .expect("default source should create a customer session");
            anyhow::ensure!(
                interaction_session(&pool, customer_explicit_id).await? == Some(customer_session)
            );
            anyhow::ensure!(customer_session != mcp_session);
            anyhow::ensure!(
                interaction_session(&pool, different_ref_id)
                    .await?
                    .is_some_and(|session_id| session_id != mcp_session)
            );
            anyhow::ensure!(interaction_session(&pool, missing_ref_id).await?.is_none());
            anyhow::ensure!(interaction_session(&pool, blank_ref_id).await?.is_none());
            let acme_session = interaction_session(&pool, acme_interaction_id)
                .await?
                .expect("tenant A proof should create a session");
            let globex_session = interaction_session(&pool, globex_interaction_id)
                .await?
                .expect("tenant B proof should create a session");
            anyhow::ensure!(
                interaction_session(&pool, acme_followup_id).await? == Some(acme_session)
            );
            anyhow::ensure!(acme_session != globex_session);
            anyhow::ensure!(acme_session != mcp_session && globex_session != mcp_session);
            anyhow::ensure!(
                interaction_session(&pool, isolated_id)
                    .await?
                    .is_some_and(|session_id| session_id != mcp_session)
            );

            let (ref_hash, raw_ref_hash, scope_hash, ref_hint): (
                Vec<u8>,
                Option<Vec<u8>>,
                Vec<u8>,
                String,
            ) = sqlx::query_as(
                "SELECT ref_hash, raw_ref_hash, customer_scope_hash, ref_hint FROM sessions_v2 WHERE id = $1",
            )
                    .bind(mcp_session)
                    .fetch_one(&pool)
                    .await?;
            let expected_raw_ref_hash = sha256(canonical_ref);
            anyhow::ensure!(raw_ref_hash.as_deref() == Some(expected_raw_ref_hash.as_slice()));
            anyhow::ensure!(
                ref_hash == scoped_session_ref_hash(&scope_hash, &expected_raw_ref_hash)
            );
            anyhow::ensure!(!ref_hint.contains(canonical_ref));
            let detail =
                dashboard_session_by_id(&pool, workspace.id, primary_product.id, mcp_session)
                    .await
                    .map_err(test_error)?;
            anyhow::ensure!(!serde_json::to_string(&detail)?.contains(canonical_ref));

            let malformed_session_id = Uuid::new_v4();
            let malformed_customer_id = Uuid::new_v4();
            let mut malformed_customer = mcp_telemetry_event(
                malformed_customer_id,
                Some(10),
                "malformed_customer",
                None,
                None,
                occurred_at,
            );
            malformed_customer.customer_ref = Some("customer@example.com".into());
            let malformed = ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            malformed_session_id,
                            Some(9),
                            "malformed_workflow",
                            Some("customer@example.com"),
                            Some("mcp"),
                            occurred_at,
                        ),
                        malformed_customer,
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(malformed.accepted == 1 && malformed.dropped == 1);
            let malformed_rows: Vec<(Uuid, Option<Uuid>, Option<String>)> = sqlx::query_as(
                r"SELECT id, session_id, customer_ref FROM interactions_v2
                WHERE id = ANY($1) ORDER BY id",
            )
            .bind(vec![malformed_session_id, malformed_customer_id])
            .fetch_all(&pool)
            .await?;
            anyhow::ensure!(malformed_rows.len() == 1);
            anyhow::ensure!(
                malformed_rows[0].0 == malformed_session_id
                    && malformed_rows[0].1.is_none()
                    && malformed_rows[0].2.is_none()
            );
            let malformed_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM interactions_v2 WHERE id = ANY($1)")
                    .bind(vec![malformed_session_id, malformed_customer_id])
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(malformed_count == 1);
            let session_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sessions_v2 WHERE workspace_id = $1")
                    .bind(workspace.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(session_count == 6);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn telemetry_idempotency_does_not_create_orphan_sessions() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Session idempotency conformance").await?;

        let result = async {
            let (_, primary_auth) =
                telemetry_test_product(&pool, &workspace, "Idempotency primary").await?;
            let (_, isolated_auth) =
                telemetry_test_product(&pool, &workspace, "Idempotency isolated").await?;
            let interaction_id = Uuid::new_v4();
            let first_at = Utc::now();
            ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        interaction_id,
                        Some(1),
                        "summarize",
                        Some("workflow:first"),
                        Some("mcp"),
                        first_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;
            let first_session = interaction_session(&pool, interaction_id)
                .await?
                .expect("first delivery should link a session");

            let retry_at = first_at - Duration::hours(1);
            let retry = ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        interaction_id,
                        Some(99),
                        "changed_operation",
                        Some("workflow:retry_must_not_create"),
                        Some("mcp"),
                        retry_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(retry.accepted == 1 && retry.dropped == 0);
            anyhow::ensure!(
                interaction_session(&pool, interaction_id).await? == Some(first_session)
            );
            let (operation, occurred_at): (String, DateTime<Utc>) =
                sqlx::query_as("SELECT operation, occurred_at FROM interactions_v2 WHERE id = $1")
                    .bind(interaction_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(operation == "summarize");
            anyhow::ensure!(
                occurred_at
                    .signed_duration_since(retry_at)
                    .num_microseconds()
                    == Some(0)
            );
            let (started_at, last_seen_at): (DateTime<Utc>, DateTime<Utc>) =
                sqlx::query_as("SELECT started_at, last_seen_at FROM sessions_v2 WHERE id = $1")
                    .bind(first_session)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(
                started_at
                    .signed_duration_since(retry_at)
                    .num_microseconds()
                    == Some(0)
            );
            anyhow::ensure!(
                last_seen_at
                    .signed_duration_since(first_at)
                    .num_microseconds()
                    == Some(0)
            );
            let retry_session_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1")
                    .bind(primary_auth.environment.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(retry_session_count == 1);

            let unlinked_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        unlinked_id,
                        Some(2),
                        "created_without_proof",
                        None,
                        None,
                        first_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(interaction_session(&pool, unlinked_id).await?.is_none());
            ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        unlinked_id,
                        Some(2),
                        "created_without_proof",
                        Some("workflow:recovered"),
                        Some("mcp"),
                        first_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(interaction_session(&pool, unlinked_id).await?.is_some());

            let coalesced_id = Uuid::new_v4();
            let coalesced = ingest_telemetry_batch(
                &pool,
                &primary_auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            coalesced_id,
                            Some(3),
                            "coalesced_evidence",
                            None,
                            None,
                            first_at,
                        ),
                        mcp_telemetry_event(
                            coalesced_id,
                            Some(3),
                            "coalesced_evidence",
                            Some("workflow:first_valid_proof"),
                            Some("mcp"),
                            first_at,
                        ),
                        mcp_telemetry_event(
                            coalesced_id,
                            Some(3),
                            "coalesced_evidence",
                            Some("workflow:later_proof"),
                            Some("mcp"),
                            first_at,
                        ),
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(coalesced.accepted == 3 && coalesced.dropped == 0);
            let (coalesced_ref_hash, coalesced_raw_ref_hash, coalesced_scope_hash): (
                Vec<u8>,
                Option<Vec<u8>>,
                Vec<u8>,
            ) = sqlx::query_as(
                r"SELECT s.ref_hash, s.raw_ref_hash, s.customer_scope_hash FROM sessions_v2 s
                JOIN interactions_v2 i ON i.session_id = s.id
                WHERE i.id = $1",
            )
            .bind(coalesced_id)
            .fetch_one(&pool)
            .await?;
            let expected_raw_ref_hash = sha256("workflow:first_valid_proof");
            anyhow::ensure!(
                coalesced_raw_ref_hash.as_deref() == Some(expected_raw_ref_hash.as_slice())
            );
            anyhow::ensure!(
                coalesced_ref_hash
                    == scoped_session_ref_hash(&coalesced_scope_hash, &expected_raw_ref_hash)
            );

            let isolated_valid_id = Uuid::new_v4();
            let cross_environment = ingest_telemetry_batch(
                &pool,
                &isolated_auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            interaction_id,
                            Some(1),
                            "cross_environment_retry",
                            Some("workflow:cross_environment"),
                            Some("mcp"),
                            first_at,
                        ),
                        mcp_telemetry_event(
                            isolated_valid_id,
                            Some(2),
                            "valid_after_dropped_conflict",
                            None,
                            None,
                            first_at,
                        ),
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(cross_environment.accepted == 1 && cross_environment.dropped == 1);
            let isolated_valid_environment: Uuid =
                sqlx::query_scalar("SELECT environment_id FROM interactions_v2 WHERE id = $1")
                    .bind(isolated_valid_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(isolated_valid_environment == isolated_auth.environment.id);
            let isolated_sessions: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1")
                    .bind(isolated_auth.environment.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(isolated_sessions == 0);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn concurrent_session_retries_create_exactly_one_linked_session() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Concurrent session conformance").await?;

        let result = async {
            let (_, auth) = telemetry_test_product(&pool, &workspace, "Concurrent product").await?;
            let interaction_id = Uuid::new_v4();
            let occurred_at = Utc::now();
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![mcp_telemetry_event(
                        interaction_id,
                        Some(1),
                        "created_without_proof",
                        None,
                        None,
                        occurred_at,
                    )],
                },
            )
            .await
            .map_err(test_error)?;

            let mut blocker = pool.begin().await?;
            sqlx::query("SELECT id FROM interactions_v2 WHERE id = $1 FOR UPDATE")
                .bind(interaction_id)
                .execute(&mut *blocker)
                .await?;

            let first_pool = pool.clone();
            let first_auth = auth.clone();
            let first = tokio::spawn(async move {
                ingest_telemetry_batch(
                    &first_pool,
                    &first_auth,
                    TelemetryBatchInput {
                        events: vec![mcp_telemetry_event(
                            interaction_id,
                            Some(1),
                            "created_without_proof",
                            Some("workflow:concurrent_first"),
                            Some("mcp"),
                            occurred_at,
                        )],
                    },
                )
                .await
            });
            let second_pool = pool.clone();
            let second_auth = auth.clone();
            let second = tokio::spawn(async move {
                ingest_telemetry_batch(
                    &second_pool,
                    &second_auth,
                    TelemetryBatchInput {
                        events: vec![mcp_telemetry_event(
                            interaction_id,
                            Some(1),
                            "created_without_proof",
                            Some("workflow:concurrent_second"),
                            Some("mcp"),
                            occurred_at,
                        )],
                    },
                )
                .await
            });

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            anyhow::ensure!(!first.is_finished() && !second.is_finished());
            blocker.commit().await?;

            for delivery in [first, second] {
                let result = tokio::time::timeout(std::time::Duration::from_secs(5), delivery)
                    .await
                    .map_err(|_| anyhow::anyhow!("concurrent telemetry delivery timed out"))??
                    .map_err(test_error)?;
                anyhow::ensure!(result.accepted == 1 && result.dropped == 0);
            }

            let linked_session = interaction_session(&pool, interaction_id)
                .await?
                .expect("one concurrent retry should establish the session link");
            let session_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1")
                    .bind(auth.environment.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(session_count == 1);
            let orphan_count: i64 = sqlx::query_scalar(
                r"SELECT COUNT(*) FROM sessions_v2 s
                WHERE s.environment_id = $1
                  AND NOT EXISTS (SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id)",
            )
            .bind(auth.environment.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(orphan_count == 0);
            let stored_session: Uuid =
                sqlx::query_scalar("SELECT session_id FROM interactions_v2 WHERE id = $1")
                    .bind(interaction_id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(stored_session == linked_session);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn batch_session_correlation_avoids_interaction_session_deadlock() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Batch lock ordering conformance").await?;

        let result = async {
            let (_, auth) = telemetry_test_product(&pool, &workspace, "Batch lock product").await?;
            let occurred_at = Utc::now();
            let mut interaction_ids = [Uuid::new_v4(), Uuid::new_v4()];
            interaction_ids.sort();
            let [first_id, blocked_id] = interaction_ids;
            let session_ref = "workflow:batch_lock_order";
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            first_id,
                            Some(1),
                            "first_interaction",
                            Some(session_ref),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            blocked_id,
                            Some(2),
                            "blocked_interaction",
                            Some(session_ref),
                            Some("mcp"),
                            occurred_at,
                        ),
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            let session_id = interaction_session(&pool, first_id)
                .await?
                .expect("initial batch should link both interactions");
            anyhow::ensure!(interaction_session(&pool, blocked_id).await? == Some(session_id));

            let mut blocker = pool.begin().await?;
            sqlx::query("SELECT id FROM interactions_v2 WHERE id = $1 FOR UPDATE")
                .bind(blocked_id)
                .execute(&mut *blocker)
                .await?;
            let delivery_application_name = format!("epode-deadlock-{}", workspace.id.simple());
            let delivery_options = PgConnectOptions::from_str(&database_url)?
                .application_name(&delivery_application_name);
            let delivery_pool = PgPoolOptions::new()
                .max_connections(1)
                .connect_with(delivery_options)
                .await?;
            let delivery_auth = auth.clone();
            let delivery = tokio::spawn(async move {
                ingest_telemetry_batch(
                    &delivery_pool,
                    &delivery_auth,
                    TelemetryBatchInput {
                        events: vec![
                            mcp_telemetry_event(
                                first_id,
                                Some(1),
                                "first_interaction",
                                Some(session_ref),
                                Some("mcp"),
                                occurred_at,
                            ),
                            mcp_telemetry_event(
                                blocked_id,
                                Some(2),
                                "blocked_interaction",
                                Some(session_ref),
                                Some("mcp"),
                                occurred_at,
                            ),
                        ],
                    },
                )
                .await
            });

            let mut waiting_on_interaction = false;
            for _ in 0..100 {
                waiting_on_interaction = sqlx::query_scalar(
                    r"SELECT EXISTS(
                      SELECT 1 FROM pg_stat_activity
                      WHERE datname = current_database()
                        AND pid <> pg_backend_pid()
                        AND application_name = $1
                        AND wait_event_type = 'Lock'
                        AND query LIKE '%WITH previous AS MATERIALIZED%'
                    )",
                )
                .bind(&delivery_application_name)
                .fetch_one(&pool)
                .await?;
                if waiting_on_interaction {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if !waiting_on_interaction {
                blocker.rollback().await?;
                delivery.abort();
                return Err(anyhow::anyhow!(
                    "telemetry batch did not block on the second interaction"
                ));
            }

            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                sqlx::query("UPDATE sessions_v2 SET last_seen_at = last_seen_at WHERE id = $1")
                    .bind(session_id)
                    .execute(&mut *blocker),
            )
            .await
            .map_err(|_| anyhow::anyhow!("session lock acquisition timed out"))??;
            blocker.commit().await?;
            let delivery_result = tokio::time::timeout(std::time::Duration::from_secs(5), delivery)
                .await
                .map_err(|_| anyhow::anyhow!("telemetry batch timed out after lock release"))??
                .map_err(test_error)?;
            anyhow::ensure!(delivery_result.accepted == 2 && delivery_result.dropped == 0);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn session_timeline_uses_sequence_for_equal_timestamps() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Session timeline conformance").await?;

        let result = async {
            let (product, auth) =
                telemetry_test_product(&pool, &workspace, "Timeline product").await?;
            let occurred_at = Utc::now();
            let sequence_two_id = Uuid::new_v4();
            let no_sequence_id = Uuid::new_v4();
            let sequence_one_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![
                        mcp_telemetry_event(
                            sequence_two_id,
                            Some(2),
                            "sequence_two",
                            Some("workflow:timeline"),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            no_sequence_id,
                            None,
                            "no_sequence",
                            Some("workflow:timeline"),
                            Some("mcp"),
                            occurred_at,
                        ),
                        mcp_telemetry_event(
                            sequence_one_id,
                            Some(1),
                            "sequence_one",
                            Some("workflow:timeline"),
                            Some("mcp"),
                            occurred_at,
                        ),
                    ],
                },
            )
            .await
            .map_err(test_error)?;
            let session_id = interaction_session(&pool, sequence_one_id)
                .await?
                .expect("timeline interactions should be linked");
            let detail = dashboard_session_by_id(&pool, workspace.id, product.id, session_id)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(
                detail
                    .interactions
                    .iter()
                    .map(|interaction| interaction.operation.as_str())
                    .collect::<Vec<_>>()
                    == vec!["sequence_one", "sequence_two", "no_sequence"]
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn legacy_prototype_tables_are_absent() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        for table in [
            "feedback_receipts",
            "feedback",
            "agent_events",
            "agent_sessions",
        ] {
            let relation: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
                .bind(format!("public.{table}"))
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(relation.is_none(), "legacy table {table} still exists");
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn simultaneous_report_retries_return_the_first_receipt() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Concurrent report retries', $3)",
        )
        .bind(workspace_id)
        .bind(format!("usr_report_retry_{}", workspace_id.simple()))
        .bind(format!(
            "report-retry-{}",
            &workspace_id.simple().to_string()[..8]
        ))
        .execute(&pool)
        .await?;
        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Concurrent report product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Concurrent report writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let interaction_id = Uuid::new_v4();
            let capability = test_capability(&write_secret, write_key.id, interaction_id);
            let first = submit_product_feedback(
                &pool,
                &capability,
                feedback_input("The first simultaneous report described a useful result."),
            );
            let second = submit_product_feedback(
                &pool,
                &capability,
                feedback_input("The second simultaneous report must not replace the first."),
            );
            let (first, second) = tokio::join!(first, second);
            let first = first.map_err(test_error)?.1;
            let second = second.map_err(test_error)?.1;
            anyhow::ensure!(first.id == second.id);
            anyhow::ensure!(first.summary == second.summary);
            let report_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM feedback_reports WHERE interaction_id = $1",
            )
            .bind(interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(report_count == 1);
            Ok::<(), anyhow::Error>(())
        }
        .await;
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn feedback_policy_and_key_kind_are_enforced_end_to_end() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Consent acceptance', $3)",
        )
        .bind(workspace_id)
        .bind(format!("usr_consent_{}", workspace_id.simple()))
        .bind(format!(
            "consent-{}",
            &workspace_id.simple().to_string()[..8]
        ))
        .execute(&pool)
        .await?;
        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Consent product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let (read_key, read_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Reader".into()),
                Some("read".into()),
                None,
            )
            .await
            .map_err(test_error)?;

            let autonomous = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            submit_product_feedback(
                &pool,
                &autonomous,
                feedback_input("The autonomous report was accepted successfully."),
            )
            .await
            .map_err(test_error)?;
            let uuid_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            let uuid_summary = "Request 123e4567-e89b-12d3-a456-426614174000 failed after retry";
            let (_, uuid_report) =
                submit_product_feedback(&pool, &uuid_capability, feedback_input(uuid_summary))
                    .await
                    .map_err(test_error)?;
            anyhow::ensure!(uuid_report.summary == uuid_summary);

            update_policy(
                &pool,
                workspace_id,
                PolicyInput {
                    environment_id: environment.id,
                    feedback_mode: "ask_once".into(),
                    collect_event_summaries: false,
                    retention_days: 30,
                },
            )
            .await
            .map_err(test_error)?;
            let once_subject = format!("afsub1_{}", "a".repeat(43));
            let once_capability = test_capability_with_subject(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&once_subject),
            );
            anyhow::ensure!(
                submit_product_feedback(
                    &pool,
                    &once_capability,
                    feedback_input("Missing consent must be rejected by the server."),
                )
                .await
                .expect_err("ask-once feedback without consent should be rejected")
                .status
                    == StatusCode::FORBIDDEN
            );
            let once_outcome = record_feedback_consent_decision(
                &pool,
                &once_capability,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                once_outcome.decision == "approved"
                    && once_outcome.configured_mode == "ask_once"
                    && once_outcome.changed
                    && !once_outcome.protocol_tool
            );
            submit_product_feedback(
                &pool,
                &once_capability,
                feedback_input("Stored product approval accepted this useful report."),
            )
            .await
            .map_err(test_error)?;

            update_policy(
                &pool,
                workspace_id,
                PolicyInput {
                    environment_id: environment.id,
                    feedback_mode: "ask_always".into(),
                    collect_event_summaries: false,
                    retention_days: 30,
                },
            )
            .await
            .map_err(test_error)?;
            let always_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            anyhow::ensure!(
                submit_product_feedback(
                    &pool,
                    &always_capability,
                    feedback_input("Missing fresh permission cannot authorize this report."),
                )
                .await
                .expect_err("stored consent should not satisfy ask-always policy")
                .status
                    == StatusCode::FORBIDDEN
            );
            record_feedback_consent_decision(
                &pool,
                &always_capability,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            submit_product_feedback(
                &pool,
                &always_capability,
                feedback_input("Fresh approval accepted this ask every time report."),
            )
            .await
            .map_err(test_error)?;

            let read_capability = test_capability(&read_secret, read_key.id, Uuid::new_v4());
            anyhow::ensure!(
                submit_product_feedback(
                    &pool,
                    &read_capability,
                    feedback_input("Read keys must never write feedback reports."),
                )
                .await
                .expect_err("read credentials should not submit feedback")
                .status
                    == StatusCode::UNAUTHORIZED
            );

            update_policy(
                &pool,
                workspace_id,
                PolicyInput {
                    environment_id: environment.id,
                    feedback_mode: "off".into(),
                    collect_event_summaries: false,
                    retention_days: 30,
                },
            )
            .await
            .map_err(test_error)?;
            let off_capability = test_capability(&write_secret, write_key.id, Uuid::new_v4());
            anyhow::ensure!(
                submit_product_feedback(
                    &pool,
                    &off_capability,
                    feedback_input("Disabled collection rejects this feedback report."),
                )
                .await
                .expect_err("disabled feedback collection should reject reports")
                .status
                    == StatusCode::GONE
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn ask_once_subject_revisions_reject_stale_replayed_and_concurrent_decisions()
    -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Revision consent ordering").await?;

        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace.id,
                CreateProductInput {
                    name: "Revision consent product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace.id,
                environment.id,
                Some("Consent writer".into()),
                Some("write".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            update_policy(
                &pool,
                workspace.id,
                PolicyInput {
                    environment_id: environment.id,
                    feedback_mode: "ask_once".into(),
                    collect_event_summaries: false,
                    retention_days: 30,
                },
            )
            .await
            .map_err(test_error)?;

            let subject = format!("afsub1_{}", "z".repeat(43));
            let auth = agent_product_auth(&pool, &api_key_headers(&write_secret)?)
                .await
                .map_err(test_error)?;
            let unknown = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(unknown.state == "unknown" && unknown.revision == 0);

            let revision_zero_approval = test_capability_with_subject_revision(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(0),
            );
            let approved = record_feedback_consent_decision(
                &pool,
                &revision_zero_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                approved.decision == "approved"
                    && approved.changed
                    && approved.feedback_action_allowed
            );
            let revision_one = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(revision_one.state == "approved" && revision_one.revision == 1);

            let replayed_approval = record_feedback_consent_decision(
                &pool,
                &revision_zero_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                replayed_approval.decision == "approved"
                    && !replayed_approval.changed
                    && replayed_approval.feedback_action_allowed
            );
            let after_replay = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(after_replay.revision == 1);

            let revision_one_issued_at = Utc::now().timestamp();
            let revision_one_revoke = test_capability_with_subject_revision_issued_at(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(1),
                revision_one_issued_at,
            );
            let delayed_revision_one_approval = test_capability_with_subject_revision_issued_at(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(1),
                revision_one_issued_at,
            );

            let revoked = record_feedback_consent_decision(
                &pool,
                &revision_one_revoke,
                ConsentDecisionInput {
                    decision: "declined".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                revoked.decision == "declined"
                    && revoked.changed
                    && !revoked.feedback_action_allowed
                    && revoked.flipped_from.as_deref() == Some("approved")
            );
            let revision_two = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(revision_two.state == "declined" && revision_two.revision == 2);

            let superseded_approval_replay = record_feedback_consent_decision(
                &pool,
                &revision_zero_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                superseded_approval_replay.decision == "declined"
                    && !superseded_approval_replay.changed
                    && !superseded_approval_replay.feedback_action_allowed
            );

            let stale_approval = record_feedback_consent_decision(
                &pool,
                &delayed_revision_one_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                stale_approval.decision == "declined"
                    && !stale_approval.changed
                    && !stale_approval.feedback_action_allowed
            );
            let after_stale = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(after_stale.state == "declined" && after_stale.revision == 2);

            let fresh_revision_two_approval = test_capability_with_subject_revision(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(2),
            );
            let reapproved = record_feedback_consent_decision(
                &pool,
                &fresh_revision_two_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                reapproved.decision == "approved"
                    && reapproved.changed
                    && reapproved.feedback_action_allowed
                    && reapproved.flipped_from.as_deref() == Some("declined")
            );
            let revision_three = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(revision_three.state == "approved" && revision_three.revision == 3);

            // The same losing r1 handle remains rejected after the state has
            // gone approved -> declined -> approved (the ABA case). It may
            // observe the current state, but cannot reveal a report action.
            let aba_replay = record_feedback_consent_decision(
                &pool,
                &delayed_revision_one_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                aba_replay.decision == "approved"
                    && !aba_replay.changed
                    && !aba_replay.feedback_action_allowed
            );

            let replayed_fresh_approval = record_feedback_consent_decision(
                &pool,
                &fresh_revision_two_approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                replayed_fresh_approval.decision == "approved"
                    && !replayed_fresh_approval.changed
                    && replayed_fresh_approval.feedback_action_allowed
            );
            let after_fresh_replay = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(after_fresh_replay.revision == 3);

            // Legacy handles have the same insert-only safety as explicit r0.
            let legacy_subject = format!("afsub1_{}", "l".repeat(43));
            let legacy_create = test_capability_with_subject(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&legacy_subject),
            );
            let legacy_approved = record_feedback_consent_decision(
                &pool,
                &legacy_create,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(legacy_approved.changed && legacy_approved.feedback_action_allowed);
            let legacy_stale = test_capability_with_subject(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&legacy_subject),
            );
            let legacy_decline = record_feedback_consent_decision(
                &pool,
                &legacy_stale,
                ConsentDecisionInput {
                    decision: "declined".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                legacy_decline.decision == "approved"
                    && !legacy_decline.changed
                    && !legacy_decline.feedback_action_allowed
            );
            let legacy_current = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: legacy_subject,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(legacy_current.state == "approved" && legacy_current.revision == 1);

            // Opposite r1 decisions race on a separate subject. The revision
            // predicate guarantees exactly one winner regardless of arrival
            // order, and replaying either handle cannot advance revision 2.
            let concurrent_subject = format!("afsub1_{}", "c".repeat(43));
            let concurrent_seed = test_capability_with_subject_revision(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&concurrent_subject),
                Some(0),
            );
            record_feedback_consent_decision(
                &pool,
                &concurrent_seed,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let concurrent_approval = test_capability_with_subject_revision(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&concurrent_subject),
                Some(1),
            );
            let concurrent_decline = test_capability_with_subject_revision(
                &write_secret,
                write_key.id,
                Uuid::new_v4(),
                Some(&concurrent_subject),
                Some(1),
            );
            let (approval_result, decline_result) = tokio::join!(
                record_feedback_consent_decision(
                    &pool,
                    &concurrent_approval,
                    ConsentDecisionInput {
                        decision: "approved".into(),
                    },
                ),
                record_feedback_consent_decision(
                    &pool,
                    &concurrent_decline,
                    ConsentDecisionInput {
                        decision: "declined".into(),
                    },
                ),
            );
            let approval_result = approval_result.map_err(test_error)?;
            let decline_result = decline_result.map_err(test_error)?;
            anyhow::ensure!(approval_result.changed ^ decline_result.changed);
            let (winner, loser, winner_capability, winner_input) = if approval_result.changed {
                (
                    &approval_result,
                    &decline_result,
                    &concurrent_approval,
                    "approved",
                )
            } else {
                (
                    &decline_result,
                    &approval_result,
                    &concurrent_decline,
                    "declined",
                )
            };
            anyhow::ensure!(loser.decision == winner.decision);
            anyhow::ensure!(!loser.feedback_action_allowed);
            let concurrent_state = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: concurrent_subject.clone(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                concurrent_state.state == winner.decision && concurrent_state.revision == 2
            );
            let winner_replay = record_feedback_consent_decision(
                &pool,
                winner_capability,
                ConsentDecisionInput {
                    decision: winner_input.into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(!winner_replay.changed);
            anyhow::ensure!(winner_replay.feedback_action_allowed == (winner_input == "approved"));
            let concurrent_after_replay = feedback_consent_state(
                &pool,
                &auth,
                ConsentStateInput {
                    subject: concurrent_subject,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(concurrent_after_replay.revision == 2);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn read_key_auth_kind_caps_and_expiration() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        let workspace_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Read key acceptance', $3)",
        )
        .bind(workspace_id)
        .bind(format!("usr_test_{}", workspace_id.simple()))
        .bind(format!(
            "read-key-{}",
            &workspace_id.simple().to_string()[..8]
        ))
        .execute(&pool)
        .await?;

        let result = async {
            let (_, environment) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Read key product".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (read_key, read_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Reader".into()),
                Some("read".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(read_key.kind == "read");
            anyhow::ensure!(read_key.prefix.starts_with("af_read_"));
            anyhow::ensure!(read_secret.starts_with(&format!("af_read_{}_", read_key.id.simple())));
            let (write_key, write_secret) = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Writer".into()),
                None,
                None,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(write_key.kind == "write");
            anyhow::ensure!(write_key.prefix.starts_with("af_live_"));

            let read_headers = api_key_headers(&read_secret)?;
            let write_headers = api_key_headers(&write_secret)?;
            let read_auth = read_product_auth(&pool, &read_headers)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(read_auth.api_key_id == read_key.id);
            let read_on_write = agent_product_auth(&pool, &read_headers)
                .await
                .expect_err("read credentials should not authorize writes");
            anyhow::ensure!(read_on_write.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(read_on_write.message == "Invalid API key");
            let write_on_read = read_product_auth(&pool, &write_headers)
                .await
                .expect_err("write credentials should not authorize feedback reads");
            anyhow::ensure!(write_on_read.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(write_on_read.message == "Invalid API key");

            let reviewed_id = Uuid::new_v4();
            let unreviewed_id = Uuid::new_v4();
            let retained_times = [
                (reviewed_id, Utc::now() - Duration::minutes(1), "search"),
                (
                    unreviewed_id,
                    Utc::now() - Duration::minutes(2),
                    "fetch",
                ),
                (
                    Uuid::new_v4(),
                    Utc::now() - Duration::days(31),
                    "retained-but-hidden",
                ),
            ];
            for (interaction_id, occurred_at, operation) in retained_times {
                sqlx::query(
                    r"INSERT INTO interactions_v2
                    (id, workspace_id, environment_id, api_key_id, surface, operation,
                     customer_ref, classification, confirmation_method, occurred_at)
                    VALUES ($1, $2, $3, $4, 'mcp', $5, 'acct_1',
                            'confirmed', 'mcp', $6)",
                )
                .bind(interaction_id)
                .bind(workspace_id)
                .bind(environment.id)
                .bind(write_key.id)
                .bind(operation)
                .bind(occurred_at)
                .execute(&pool)
                .await?;
            }
            sqlx::query(
                r#"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, impact, confidence, findings, workaround)
                VALUES ($1, $2, $3, 'The operation completed and returned the requested result.',
                        'helped', 0.95,
                        '[{"kind":"strength","topic":"relevance","detail":"The result directly answered the request."}]'::jsonb,
                        '{"used":false}'::jsonb)"#,
            )
            .bind(Uuid::new_v4())
            .bind(workspace_id)
            .bind(reviewed_id)
            .execute(&pool)
            .await?;

            let summary = feedback_list_reports(
                &pool,
                &read_auth,
                FeedbackListReportsInput {
                    summary: Some(true),
                    since: None,
                    impact: Some(vec!["blocked".into()]),
                    finding_kind: Some(vec!["defect".into()]),
                    severity: Some(vec!["blocking".into()]),
                    topic: Some("ignored".into()),
                    operation: Some("ignored".into()),
                    customer_ref: Some("ignored".into()),
                    limit: Some(101),
                    cursor: Some("ignored".into()),
                },
            )
            .await
            .map_err(test_error)?;
            let FeedbackReportsResponse::Summary(summary) = summary else {
                anyhow::bail!("summary:true returned a paginated response");
            };
            anyhow::ensure!(summary.product == "Read key product");
            anyhow::ensure!(summary.interactions == 2);
            anyhow::ensure!(summary.reviewed == 1);
            anyhow::ensure!((summary.review_rate - 0.5).abs() < f64::EPSILON);
            anyhow::ensure!((summary.confirmation_rate - 1.0).abs() < f64::EPSILON);
            anyhow::ensure!(summary.impacts.get("helped") == Some(&1));
            anyhow::ensure!(summary.finding_kinds.get("strength") == Some(&1));

            let reports = feedback_list_reports(
                &pool,
                &read_auth,
                FeedbackListReportsInput {
                    summary: None,
                    since: None,
                    impact: Some(vec!["helped".into()]),
                    finding_kind: Some(vec!["strength".into()]),
                    severity: None,
                    topic: Some("relevance".into()),
                    operation: Some("search".into()),
                    customer_ref: Some("acct_1".into()),
                    limit: None,
                    cursor: None,
                },
            )
            .await
            .map_err(test_error)?;
            let FeedbackReportsResponse::Page(reports) = reports else {
                anyhow::bail!("list call returned a summary response");
            };
            anyhow::ensure!(reports.reports.len() == 1);
            anyhow::ensure!(reports.reports[0].interaction_id == reviewed_id);

            let first_page = feedback_list_interactions(
                &pool,
                &read_auth,
                FeedbackListInteractionsInput {
                    since: None,
                    reviewed: None,
                    operation: None,
                    customer_ref: Some("acct_1".into()),
                    surface: Some(vec!["mcp".into()]),
                    limit: Some(1),
                    cursor: None,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(first_page.interactions.len() == 1);
            anyhow::ensure!(first_page.interactions[0].id == reviewed_id);
            let next_cursor = first_page
                .next_cursor
                .ok_or_else(|| anyhow::anyhow!("first page did not return a cursor"))?;
            let second_page = feedback_list_interactions(
                &pool,
                &read_auth,
                FeedbackListInteractionsInput {
                    since: None,
                    reviewed: Some(false),
                    operation: None,
                    customer_ref: Some("acct_1".into()),
                    surface: Some(vec!["mcp".into()]),
                    limit: Some(1),
                    cursor: Some(next_cursor),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(second_page.interactions.len() == 1);
            anyhow::ensure!(second_page.interactions[0].id == unreviewed_id);
            let old_interaction_still_exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM interactions_v2 WHERE operation = 'retained-but-hidden' AND environment_id = $1)",
            )
            .bind(environment.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(old_interaction_still_exists);

            for index in 1..10 {
                create_api_key(
                    &pool,
                    workspace_id,
                    environment.id,
                    Some(format!("Reader {index}")),
                    Some("read".into()),
                    None,
                )
                .await
                .map_err(test_error)?;
                create_api_key(
                    &pool,
                    workspace_id,
                    environment.id,
                    Some(format!("Writer {index}")),
                    Some("write".into()),
                    None,
                )
                .await
                .map_err(test_error)?;
            }
            let read_cap = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Reader 11".into()),
                Some("read".into()),
                None,
            )
            .await
            .expect_err("read credential limit should be enforced");
            anyhow::ensure!(read_cap.status == StatusCode::CONFLICT);
            let write_cap = create_api_key(
                &pool,
                workspace_id,
                environment.id,
                Some("Writer 11".into()),
                Some("write".into()),
                None,
            )
            .await
            .expect_err("write credential limit should be enforced");
            anyhow::ensure!(write_cap.status == StatusCode::CONFLICT);

            sqlx::query(
                "UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
            )
            .bind(read_key.id)
            .execute(&pool)
            .await?;
            let expired = read_product_auth(&pool, &read_headers)
                .await
                .expect_err("expired read credentials should be rejected");
            anyhow::ensure!(expired.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(expired.message == "API key expired");
            let invalid_headers = api_key_headers("af_read_missing")?;
            let invalid = read_product_auth(&pool, &invalid_headers)
                .await
                .expect_err("unknown read credentials should be rejected");
            anyhow::ensure!(invalid.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(invalid.message == "Invalid API key");
            anyhow::ensure!(expired.message != invalid.message);
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn product_scope_isolated_end_to_end() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        let workspace_id = Uuid::new_v4();
        let workspace = sqlx::query_as::<_, Workspace>(
            r"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Hierarchy acceptance', $3) RETURNING *",
        )
        .bind(workspace_id)
        .bind(format!("usr_test_{}", workspace_id.simple()))
        .bind(format!(
            "hierarchy-{}",
            &workspace_id.simple().to_string()[..8]
        ))
        .fetch_one(&pool)
        .await?;

        let result = async {
            let (search, search_settings) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Search".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (docs, docs_settings) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Documentation".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (key, _) = create_api_key(
                &pool,
                workspace_id,
                search_settings.id,
                Some("Express".into()),
                None,
                None,
            )
            .await
            .map_err(test_error)?;
            let interaction_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &ProductAuth {
                    workspace: workspace.clone(),
                    environment: search_settings.clone(),
                    api_key_id: key.id,
                },
                TelemetryBatchInput {
                    events: vec![InteractionTelemetryInput {
                        interaction_id,
                        sequence: Some(1),
                        surface: "http_json".into(),
                        operation: "/search".into(),
                        status_code: Some(200),
                        duration_ms: Some(12),
                        customer_ref: None,
                        account_ref: None,
                        user_ref: None,
                        anonymous_ref: None,
                        classification: Some("unclassified".into()),
                        confirmation_method: None,
                        runtime_hint: None,
                        runtime_hint_source: None,
                        session_ref: None,
                        session_source: None,
                        occurred_at: Some(Utc::now()),
                    }],
                },
            )
            .await
            .map_err(test_error)?;

            let renamed_workspace = rename_workspace(
                &pool,
                workspace_id,
                UpdateNameInput {
                    name: "Platform team".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(renamed_workspace.id == workspace_id);
            anyhow::ensure!(renamed_workspace.name == "Platform team");

            let renamed_search = rename_product(
                &pool,
                workspace_id,
                search.id,
                UpdateNameInput {
                    name: "Search v2".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(renamed_search.id == search.id);
            anyhow::ensure!(renamed_search.name == "Search v2");
            anyhow::ensure!(
                rename_product(
                    &pool,
                    Uuid::new_v4(),
                    search.id,
                    UpdateNameInput {
                        name: "Wrong workspace".into(),
                    },
                )
                .await
                .is_err()
            );

            let context = || DashboardContext {
                user: CurrentUser {
                    id: "usr_test".into(),
                    handle: "test".into(),
                    email: None,
                    display_name: "Test".into(),
                },
                workspace: renamed_workspace.clone(),
                role: "owner".into(),
                workspace_memberships: vec![],
            };
            let search_dashboard = dashboard(&pool, context(), Some(search.id), None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(search_dashboard.products.len() == 2);
            let current_product = search_dashboard
                .current_product
                .expect("selected search product should be present");
            anyhow::ensure!(current_product.id == search.id);
            anyhow::ensure!(current_product.name == "Search v2");
            anyhow::ensure!(search_dashboard.interactions.len() == 1);
            anyhow::ensure!(search_dashboard.api_keys.len() == 1);
            anyhow::ensure!(search_dashboard.api_keys[0].interaction_count == 1);
            anyhow::ensure!(search_dashboard.api_keys[0].report_count == 0);

            let docs_dashboard = dashboard(&pool, context(), Some(docs.id), None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(
                docs_dashboard
                    .current_product
                    .expect("selected documentation product should be present")
                    .id
                    == docs.id
            );
            anyhow::ensure!(docs_dashboard.interactions.is_empty());
            anyhow::ensure!(docs_dashboard.api_keys.is_empty());

            let updated = update_policy(
                &pool,
                workspace_id,
                PolicyInput {
                    environment_id: docs_settings.id,
                    feedback_mode: "ask_once".into(),
                    collect_event_summaries: false,
                    retention_days: 7,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(updated.feedback_mode == "ask_once");
            anyhow::ensure!(search_settings.feedback_mode == "never_ask");

            anyhow::ensure!(
                delete_product(
                    &pool,
                    workspace_id,
                    search.id,
                    DeleteProductInput {
                        confirmation: "wrong name".into(),
                    },
                )
                .await
                .is_err()
            );
            anyhow::ensure!(
                delete_product(
                    &pool,
                    Uuid::new_v4(),
                    search.id,
                    DeleteProductInput {
                        confirmation: "Search v2".into(),
                    },
                )
                .await
                .is_err()
            );
            let deleted_search = delete_product(
                &pool,
                workspace_id,
                search.id,
                DeleteProductInput {
                    confirmation: "Search v2".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(deleted_search.id == search.id);
            let interaction_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM interactions_v2 WHERE environment_id = $1",
            )
            .bind(search_settings.id)
            .fetch_one(&pool)
            .await?;
            let key_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE environment_id = $1")
                    .bind(search_settings.id)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(interaction_count == 0);
            anyhow::ensure!(key_count == 0);
            let remaining = dashboard(&pool, context(), Some(search.id), None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(remaining.products.len() == 1);
            anyhow::ensure!(
                remaining
                    .current_product
                    .expect("remaining documentation product should be selected")
                    .id
                    == docs.id
            );

            delete_product(
                &pool,
                workspace_id,
                docs.id,
                DeleteProductInput {
                    confirmation: "Documentation".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let empty_dashboard = dashboard(&pool, context(), None, None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(empty_dashboard.products.is_empty());
            anyhow::ensure!(empty_dashboard.current_product.is_none());
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }

    #[test]
    fn customer_identity_refs_and_hmac_are_fail_closed_and_tenant_scoped() -> anyhow::Result<()> {
        let base = http_telemetry_event(Uuid::new_v4(), Utc::now());
        anyhow::ensure!(validate_identity_refs(&base).is_ok());
        for value in [
            "",
            " customer",
            "customer ",
            "customer name",
            "person@example.com",
        ] {
            let mut malformed = base.clone();
            malformed.customer_ref = Some(value.into());
            anyhow::ensure!(validate_identity_refs(&malformed).is_err());
        }
        let mut conflicting = base;
        conflicting.customer_ref = Some("legacy_1".into());
        conflicting.user_ref = Some("user_1".into());
        anyhow::ensure!(validate_identity_refs(&conflicting).is_err());
        conflicting.account_ref = Some("account_1".into());
        anyhow::ensure!(validate_identity_refs(&conflicting).is_err());
        conflicting.customer_ref = Some("account_1".into());
        anyhow::ensure!(validate_identity_refs(&conflicting).is_ok());

        let workspace = Uuid::new_v4();
        let product = Uuid::new_v4();
        let hash = customer_identifier_hash(
            TEST_IDENTITY_HMAC_SECRET,
            workspace,
            product,
            "user_ref",
            "user_1",
        )
        .map_err(test_error)?;
        anyhow::ensure!(hash.len() == 32);
        anyhow::ensure!(
            hash == customer_identifier_hash(
                TEST_IDENTITY_HMAC_SECRET,
                workspace,
                product,
                "user_ref",
                "user_1",
            )
            .map_err(test_error)?
        );
        anyhow::ensure!(
            hash != customer_identifier_hash(
                TEST_IDENTITY_HMAC_SECRET,
                Uuid::new_v4(),
                product,
                "user_ref",
                "user_1",
            )
            .map_err(test_error)?
        );
        anyhow::ensure!(
            customer_identifier_hash(b"too-short", workspace, product, "user_ref", "user_1")
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn enrichment_contract_rejects_sensitive_or_unbounded_customer_context() -> anyhow::Result<()> {
        let valid = crate::models::EnrichmentAnswerItemInput {
            key: "shopping.budget_band".into(),
            signal_type: "constraint".into(),
            value: "50_150".into(),
            _summary: None,
            provenance: "agent_reports_user_statement".into(),
            confidence: Some(0.95),
            remember: true,
            expires_at: Some(Utc::now() + Duration::days(30)),
        };
        let definition =
            validate_enrichment_item(&valid, "product_personalization").map_err(test_error)?;
        anyhow::ensure!(
            catalog_summary(definition, &valid.value) == "shopping budget band: 50 150"
        );
        for (key, value) in [
            ("community.affinity", "black"),
            ("relationship.status", "married"),
            ("medical_condition", "asthma"),
            ("shopping.preference", "political affiliation"),
            ("email", "person@example.com"),
            ("precise_location", "home"),
            ("date_of_birth", "1990-01-01"),
            ("demographics.gender", "woman"),
            ("household_income", "over 100000"),
            ("creditworthiness", "excellent"),
            ("shipping.zip", "10001"),
            ("citizenship", "citizen"),
            ("immigration_status", "temporary visa"),
            ("veteran_status", "veteran"),
            ("union_membership", "union member"),
            ("legal_history", "prior arrest"),
            ("genetic_profile", "dna marker"),
            ("audience", "teenager"),
            ("shopping.segment", "women"),
            ("account.status", "US citizen"),
            ("risk.label", "felony conviction"),
            ("shopping.preference", "gay"),
            ("shopping.preference", "Christian"),
            ("shopping.preference", "Muslim"),
            ("shopping.preference", "HIV positive"),
            ("shopping.preference", "has cancer"),
            ("shopping.preference", "Democrat"),
            ("accessibility.preference", "uses a wheelchair"),
            ("travel.constraint", "mobility impaired"),
            ("shopping.preference", "identifies as B.l.a.c.k"),
            ("shopping.preference", "expecting a baby"),
            ("shopping.preference", "family planning"),
            ("shopping.preference", "pr3gn4nt"),
            ("shopping.preference", "wh33lch41r user"),
            ("shopping.preference", "f4m1ly pl4nn1ng"),
        ] {
            let mut unsafe_item = valid.clone();
            unsafe_item.key = key.into();
            unsafe_item.value = value.into();
            anyhow::ensure!(
                validate_enrichment_item(&unsafe_item, "product_personalization").is_err()
            );
        }
        let mut inference = valid.clone();
        inference.provenance = "user_explicit".into();
        anyhow::ensure!(validate_enrichment_item(&inference, "product_personalization").is_err());
        anyhow::ensure!(validate_enrichment_item(&valid, "targeted_advertising").is_ok());
        let advertising_interest = crate::models::EnrichmentAnswerItemInput {
            key: "interest.topic".into(),
            signal_type: "preference".into(),
            value: "outdoor_travel".into(),
            _summary: None,
            provenance: "agent_reports_user_statement".into(),
            confidence: Some(1.0),
            remember: true,
            expires_at: Some(Utc::now() + Duration::days(30)),
        };
        let advertising_definition =
            validate_enrichment_item(&advertising_interest, "targeted_advertising")
                .map_err(test_error)?;
        anyhow::ensure!(
            catalog_summary(advertising_definition, &advertising_interest.value)
                == "interest topic: outdoor travel"
        );
        let mut b2b = valid;
        b2b.key = "b2b.company_size".into();
        b2b.signal_type = "constraint".into();
        b2b.value = "enterprise".into();
        anyhow::ensure!(validate_enrichment_item(&b2b, "product_personalization").is_ok());
        anyhow::ensure!(validate_enrichment_item(&b2b, "targeted_advertising").is_err());
        let default_surface: EnrichmentRequestInput = serde_json::from_value(serde_json::json!({
            "interactionId": Uuid::new_v4(),
            "operation": "/search",
            "purpose": "product_personalization",
            "remember": false
        }))?;
        anyhow::ensure!(default_surface.surface == "http_json");
        anyhow::ensure!(validate_enrichment_purpose("product_personalization").is_ok());
        anyhow::ensure!(validate_enrichment_purpose("targeted_advertising").is_ok());
        anyhow::ensure!(validate_enrichment_purpose("generic_tracking").is_err());
        anyhow::ensure!(validate_opaque_event_id("decision_123", "id").is_ok());
        anyhow::ensure!(validate_opaque_event_id("person@example.com", "id").is_err());
        Ok(())
    }

    #[test]
    fn enrichment_contract_is_interaction_scoped_without_memory_and_has_exact_actions()
    -> anyhow::Result<()> {
        let workspace_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let interaction_id = Uuid::new_v4();
        let customer_id = Uuid::new_v4();
        let auth = ProductAuth {
            workspace: Workspace {
                id: workspace_id,
                os_user_id: "test-user".into(),
                name: "Workspace".into(),
                slug: "workspace".into(),
                feedback_mode: "ask_once".into(),
                collect_event_summaries: true,
                retention_days: 30,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
            environment: ProductEnvironment {
                id: Uuid::new_v4(),
                workspace_id,
                product_id,
                name: "Production".into(),
                slug: "production".into(),
                feedback_mode: "ask_once".into(),
                collect_event_summaries: true,
                retention_days: 30,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
            api_key_id: Uuid::new_v4(),
        };
        let transient = enrichment_subject(
            TEST_IDENTITY_HMAC_SECRET,
            &auth,
            Some(customer_id),
            interaction_id,
            "product_personalization",
            false,
        )
        .map_err(test_error)?;
        let remembered = enrichment_subject(
            TEST_IDENTITY_HMAC_SECRET,
            &auth,
            Some(customer_id),
            interaction_id,
            "product_personalization",
            true,
        )
        .map_err(test_error)?;
        anyhow::ensure!(transient.starts_with("afint1_"));
        anyhow::ensure!(remembered.starts_with("afsub1_") && remembered != transient);

        let mut row = EnrichmentRequestRow {
            id: Uuid::new_v4(),
            workspace_id,
            product_id,
            environment_id: auth.environment.id,
            interaction_id,
            customer_id: Some(customer_id),
            surface: "http_json".into(),
            purpose: "targeted_advertising".into(),
            remember: false,
            consent_subject: transient,
            expected_consent_revision: 0,
            identity_level: "verified".into(),
            state: "consent_required".into(),
            question: "May I share context?".into(),
            request_hash: vec![0; 32],
            capability_nonce_hash: vec![0; 32],
            expires_at: Utc::now() + Duration::hours(2),
            created_at: Utc::now(),
        };
        let response = enrichment_response("https://app.epode.ai", &row, "aqr1_test");
        let json = serde_json::to_value(response)?;
        anyhow::ensure!(
            json["consent"]["bodySchema"]["decision"]
                == serde_json::json!(["approved", "declined"])
        );
        anyhow::ensure!(
            json["stageInstruction"]
                .as_str()
                .is_some_and(|value| value.contains("never infer approval"))
        );
        anyhow::ensure!(json["submit"].is_null());
        row.state = "answer_ready".into();
        let answer_json = serde_json::to_value(enrichment_response(
            "https://app.epode.ai",
            &row,
            "aqr1_test",
        ))?;
        anyhow::ensure!(
            answer_json["submit"]["bodySchema"]["status"]
                == serde_json::json!(["answered", "declined", "no_relevant_context"])
        );
        anyhow::ensure!(answer_json["submit"]["bodySchema"]["items"]["maximum"] == 8);
        anyhow::ensure!(
            answer_json["stageInstruction"]
                .as_str()
                .is_some_and(|value| value.contains("submit at most one bounded answer"))
        );
        row.state = "declined".into();
        let declined_json = serde_json::to_value(enrichment_response(
            "https://app.epode.ai",
            &row,
            "aqr1_test",
        ))?;
        anyhow::ensure!(
            declined_json["stageInstruction"]
                .as_str()
                .is_some_and(|value| value.contains("No enrichment action is permitted"))
        );
        anyhow::ensure!(declined_json["answerInstruction"].is_null());
        anyhow::ensure!(declined_json["submit"].is_null());
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn enrichment_context_personalization_is_permissioned_idempotent_and_tenant_safe()
    -> anyhow::Result<()> {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_a = telemetry_test_workspace(&pool, "Enrichment A").await?;
        let workspace_b = telemetry_test_workspace(&pool, "Enrichment B").await?;
        let (_product_a, auth_a) = telemetry_test_product(&pool, &workspace_a, "Retail A").await?;
        let (_product_b, auth_b) = telemetry_test_product(&pool, &workspace_b, "Retail B").await?;
        let result = Box::pin(async {
            let interaction_id = Uuid::new_v4();
            let request_input = EnrichmentRequestInput {
                interaction_id,
                operation: "/search".into(),
                surface: "html".into(),
                status_code: Some(200),
                duration_ms: Some(24),
                session_ref: Some("journey_retail_1".into()),
                runtime_hint: Some("codex/1".into()),
                purpose: "product_personalization".into(),
                remember: true,
                customer_ref: None,
                account_ref: None,
                user_ref: None,
                anonymous_ref: Some("anon_retail_1".into()),
            };
            let (first_request, retry_request) = tokio::join!(
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    request_input.clone(),
                ),
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    request_input,
                )
            );
            let request = first_request.map_err(test_error)?;
            let retry_request = retry_request.map_err(test_error)?;
            anyhow::ensure!(request.request_id == retry_request.request_id);
            anyhow::ensure!(
                request.consent.as_ref().map(|action| &action.authorization)
                    == retry_request
                        .consent
                        .as_ref()
                        .map(|action| &action.authorization)
            );
            anyhow::ensure!(request.state == "consent_required");
            anyhow::ensure!(request.identity_level == "pseudonymous");
            anyhow::ensure!(request.surface == "html");
            anyhow::ensure!(request.submit.is_none() && request.consent.is_some());
            let first_interaction = sqlx::query_as::<
                _,
                (String, String, Option<String>, Option<i32>, Option<i64>, Option<String>, Option<Uuid>),
            >(
                r"SELECT surface, classification, confirmation_method, status_code,
                  duration_ms, runtime_hint, session_id
                FROM interactions_v2 WHERE id = $1",
            )
            .bind(interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(first_interaction.0 == "http_html");
            anyhow::ensure!(first_interaction.1 == "unclassified");
            anyhow::ensure!(first_interaction.2.is_none());
            anyhow::ensure!(first_interaction.3 == Some(200));
            anyhow::ensure!(first_interaction.4 == Some(24));
            anyhow::ensure!(first_interaction.5.as_deref() == Some("codex/1"));
            anyhow::ensure!(first_interaction.6.is_some());
            let capability = request
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing enrichment capability"))?;
            let consent = decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                capability,
                EnrichmentConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(consent.changed && consent.state == "answer_ready");
            anyhow::ensure!(
                consent
                    .stage_instruction
                    .contains("submit at most one bounded answer")
            );
            anyhow::ensure!(consent.answer_instruction.is_some() && consent.submit.is_some());
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT bool_and(enrichment_purpose = 'product_personalization')
                    FROM consent_grants
                    WHERE environment_id = $1 AND subject = (
                      SELECT consent_subject FROM enrichment_requests WHERE id = $2
                    )",
                )
                .bind(auth_a.environment.id)
                .bind(request.request_id)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT bool_and(enrichment_purpose = 'product_personalization')
                    FROM enrichment_consent_events
                    WHERE environment_id = $1 AND subject = (
                      SELECT consent_subject FROM enrichment_requests WHERE id = $2
                    )",
                )
                .bind(auth_a.environment.id)
                .bind(request.request_id)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT bool_and(source = 'enrichment')
                    FROM enrichment_consent_events
                    WHERE environment_id = $1 AND subject = (
                      SELECT consent_subject FROM enrichment_requests WHERE id = $2
                    )",
                )
                .bind(auth_a.environment.id)
                .bind(request.request_id)
                .fetch_one(&pool)
                .await?
            );
            let feedback_subject = format!("afsub1_{}", "f".repeat(43));
            let mut feedback_tx = pool.begin().await?;
            dual_write_share_outcome_consent(
                &mut feedback_tx,
                auth_a.environment.id,
                &feedback_subject,
                "approved",
                1,
                Utc::now(),
                None,
                None,
                "feedback_consent",
            )
            .await
            .map_err(test_error)?;
            feedback_tx.commit().await?;
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT enrichment_purpose IS NULL FROM consent_grants
                    WHERE environment_id = $1 AND subject = $2",
                )
                .bind(auth_a.environment.id)
                .bind(&feedback_subject)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT enrichment_purpose IS NULL FROM consent_events
                    WHERE environment_id = $1 AND subject = $2",
                )
                .bind(auth_a.environment.id)
                .bind(&feedback_subject)
                .fetch_one(&pool)
                .await?
            );
            let answer_input = EnrichmentAnswerInput {
                status: "answered".into(),
                items: vec![crate::models::EnrichmentAnswerItemInput {
                    key: "shopping.budget_band".into(),
                    signal_type: "constraint".into(),
                    value: "50_150".into(),
                    _summary: Some("Customer belongs to the Black community".into()),
                    provenance: "agent_reports_user_statement".into(),
                    confidence: Some(0.98),
                    remember: true,
                    expires_at: None,
                }, crate::models::EnrichmentAnswerItemInput {
                    key: "content.format".into(),
                    signal_type: "preference".into(),
                    value: "short".into(),
                    _summary: None,
                    provenance: "agent_inference".into(),
                    confidence: Some(0.55),
                    remember: true,
                    expires_at: None,
                }],
            };
            let answer = submit_enrichment_answer(&pool, capability, answer_input.clone())
                .await
                .map_err(test_error)?;
            anyhow::ensure!(answer.customer_id.is_some() && answer.signals.len() == 2);
            anyhow::ensure!(answer.signals[0].remembered);
            anyhow::ensure!(answer.signals[0].summary == "shopping budget band: 50 150");
            anyhow::ensure!(answer.signals[0].allowed_uses == ["product_personalization"]);
            anyhow::ensure!(answer.signals[1].provenance == "agent_inference");
            anyhow::ensure!(answer.signals[1].allowed_uses.is_empty());
            anyhow::ensure!(
                sqlx::query_scalar::<_, String>(
                    "SELECT method FROM enrichment_interaction_confirmations WHERE interaction_id = $1",
                )
                .bind(interaction_id)
                .fetch_one(&pool)
                .await?
                    == "enrichment_answer"
            );
            let retry = submit_enrichment_answer(&pool, capability, answer_input)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(retry.signals[0].signal_id == answer.signals[0].signal_id);

            let mcp_interaction_id = Uuid::new_v4();
            let mcp_request = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: mcp_interaction_id,
                    operation: "catalog_search".into(),
                    surface: "mcp".into(),
                    status_code: Some(200),
                    duration_ms: Some(11),
                    session_ref: Some("journey_retail_1".into()),
                    runtime_hint: Some("mcp-client/1".into()),
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: Some("anon_retail_1".into()),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(mcp_request.surface == "mcp");
            anyhow::ensure!(mcp_request.state == "answer_ready");
            let mcp_evidence = sqlx::query_as::<_, (String, String, Option<String>)>(
                "SELECT surface, classification, confirmation_method FROM interactions_v2 WHERE id = $1",
            )
            .bind(mcp_interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(mcp_evidence.0 == "mcp");
            anyhow::ensure!(mcp_evidence.1 == "confirmed");
            anyhow::ensure!(mcp_evidence.2.as_deref() == Some("mcp"));

            let context_input = CustomerContextInput {
                customer_ref: None,
                account_ref: None,
                user_ref: None,
                anonymous_ref: Some("anon_retail_1".into()),
                interaction_id: None,
                purpose: "product_personalization".into(),
            };
            let context = retrieve_customer_context(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                context_input.clone(),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(context.identity_level == "pseudonymous");
            anyhow::ensure!(context.items.len() == 1);
            anyhow::ensure!(
                retrieve_customer_context(
                    &pool,
                    &auth_b,
                    TEST_IDENTITY_HMAC_SECRET,
                    context_input,
                )
                .await
                .is_err()
            );

            let decision_input = PersonalizationDecisionInput {
                external_decision_id: "decision_1".into(),
                context_retrieval_id: context.retrieval_id,
                signal_ids: vec![context.items[0].signal_id],
                variant: Some("under_150_results".into()),
            };
            let (decision, decision_retry) = tokio::join!(
                record_personalization_decision(&pool, &auth_a, decision_input.clone()),
                record_personalization_decision(&pool, &auth_a, decision_input.clone())
            );
            let decision = decision.map_err(test_error)?;
            let decision_retry = decision_retry.map_err(test_error)?;
            anyhow::ensure!(decision.decision.id == decision_retry.decision.id);
            let mut conflicting_decision_a = decision_input.clone();
            conflicting_decision_a.external_decision_id = "decision_conflict".into();
            conflicting_decision_a.variant = Some("variant_a".into());
            let mut conflicting_decision_b = conflicting_decision_a.clone();
            conflicting_decision_b.variant = Some("variant_b".into());
            let (conflict_a, conflict_b) = tokio::join!(
                record_personalization_decision(&pool, &auth_a, conflicting_decision_a),
                record_personalization_decision(&pool, &auth_a, conflicting_decision_b)
            );
            anyhow::ensure!(conflict_a.is_ok() ^ conflict_b.is_ok());
            let outcome_input = PersonalizationOutcomeInput {
                external_outcome_id: "outcome_1".into(),
                decision_id: decision.decision.id,
                outcome: "conversion".into(),
                occurred_at: Some(Utc::now()),
            };
            let (outcome, outcome_retry) = tokio::join!(
                record_personalization_outcome(&pool, &auth_a, outcome_input.clone()),
                record_personalization_outcome(&pool, &auth_a, outcome_input.clone())
            );
            let outcome = outcome.map_err(test_error)?;
            let outcome_retry = outcome_retry.map_err(test_error)?;
            anyhow::ensure!(outcome.outcome.id == outcome_retry.outcome.id);
            let mut conflicting_outcome_a = outcome_input.clone();
            conflicting_outcome_a.external_outcome_id = "outcome_conflict".into();
            conflicting_outcome_a.outcome = "engagement".into();
            let mut conflicting_outcome_b = conflicting_outcome_a.clone();
            conflicting_outcome_b.outcome = "dismissal".into();
            let (outcome_conflict_a, outcome_conflict_b) = tokio::join!(
                record_personalization_outcome(&pool, &auth_a, conflicting_outcome_a),
                record_personalization_outcome(&pool, &auth_a, conflicting_outcome_b)
            );
            anyhow::ensure!(outcome_conflict_a.is_ok() ^ outcome_conflict_b.is_ok());

            let resolved_interaction_id = Uuid::new_v4();
            let resolved = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: resolved_interaction_id,
                    operation: "/search".into(),
                    surface: "http_json".into(),
                    status_code: Some(200),
                    duration_ms: Some(18),
                    session_ref: Some("journey_retail_1".into()),
                    runtime_hint: Some("claude-code/1".into()),
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("user_retail_1".into()),
                    anonymous_ref: Some("anon_retail_1".into()),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(resolved.identity_level == "verified");
            anyhow::ensure!(resolved.state == "answer_ready");
            let resolved_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(resolved_interaction_id)
            .fetch_one(&pool)
            .await?;
            let grouped_sessions = sqlx::query_as::<_, (Option<Uuid>, Option<Uuid>)>(
                r"SELECT
                  (SELECT session_id FROM interactions_v2 WHERE id = $1),
                  (SELECT session_id FROM interactions_v2 WHERE id = $2)",
            )
            .bind(interaction_id)
            .bind(resolved_interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(grouped_sessions.0.is_some());
            anyhow::ensure!(grouped_sessions.0 == grouped_sessions.1);
            anyhow::ensure!(
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT customer_id FROM enrichment_answers WHERE id = (SELECT enrichment_answer_id FROM enrichment_signal_items WHERE signal_id = $1)",
                )
                .bind(answer.signals[0].signal_id)
                .fetch_one(&pool)
                .await?
                    == resolved_customer_id
            );
            let known_context = retrieve_customer_context(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                CustomerContextInput {
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("user_retail_1".into()),
                    anonymous_ref: None,
                    interaction_id: None,
                    purpose: "product_personalization".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(known_context.items.len() == 1);
            let customer_detail = dashboard_customer_by_id(
                &pool,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                resolved_customer_id,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(customer_detail.consent.iter().any(|grant| {
                grant.enrichment_purpose.as_deref() == Some("product_personalization")
            }));
            anyhow::ensure!(customer_detail.consent_history.iter().any(|event| {
                event.enrichment_purpose.as_deref() == Some("product_personalization")
            }));
            sqlx::query(
                r"UPDATE consent_grants SET state = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE environment_id = $1
                  AND subject = (SELECT consent_subject FROM enrichment_requests WHERE id = $2)
                  AND scope = 'remember_preferences'",
            )
            .bind(auth_a.environment.id)
            .bind(resolved.request_id)
            .execute(&pool)
            .await?;
            anyhow::ensure!(
                record_personalization_decision(
                    &pool,
                    &auth_a,
                    PersonalizationDecisionInput {
                        external_decision_id: "decision_after_memory_revoke".into(),
                        context_retrieval_id: known_context.retrieval_id,
                        signal_ids: vec![known_context.items[0].signal_id],
                        variant: None,
                    },
                )
                .await
                .is_err()
            );
            let revoke_capability = resolved
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing manage capability"))?;
            let revoked = decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                revoke_capability,
                EnrichmentConsentDecisionInput {
                    decision: "declined".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(revoked.changed && revoked.state == "declined");
            anyhow::ensure!(
                revoked
                    .stage_instruction
                    .contains("No enrichment action is permitted")
            );
            anyhow::ensure!(revoked.answer_instruction.is_none() && revoked.submit.is_none());
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    r"SELECT COUNT(*) FROM enrichment_consent_events
                    WHERE environment_id = $1 AND subject = (
                      SELECT consent_subject FROM enrichment_requests WHERE id = $2
                    ) AND state = 'declined'
                      AND enrichment_purpose = 'product_personalization'",
                )
                .bind(auth_a.environment.id)
                .bind(resolved.request_id)
                .fetch_one(&pool)
                .await?
                    >= 2
            );
            let after_revoke = retrieve_customer_context(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                CustomerContextInput {
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: Some("anon_retail_1".into()),
                    interaction_id: None,
                    purpose: "product_personalization".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(after_revoke.items.is_empty());

            let transient_known_interaction = Uuid::new_v4();
            let transient_known = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: transient_known_interaction,
                    operation: "/recommend".into(),
                    surface: "http_json".into(),
                    status_code: None,
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: false,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("user_retail_1".into()),
                    anonymous_ref: None,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(transient_known.state == "consent_required");
            let transient_subject = sqlx::query_scalar::<_, String>(
                "SELECT consent_subject FROM enrichment_requests WHERE id = $1",
            )
            .bind(transient_known.request_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(transient_subject.starts_with("afint1_"));
            let transient_capability = transient_known
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing transient capability"))?;
            decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                transient_capability,
                EnrichmentConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    r"SELECT bool_and(expires_at IS NOT NULL) FROM consent_grants
                    WHERE environment_id = $1 AND subject = $2",
                )
                .bind(auth_a.environment.id)
                .bind(&transient_subject)
                .fetch_one(&pool)
                .await?
            );
            let second_transient_known = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: Uuid::new_v4(),
                    operation: "/recommend".into(),
                    surface: "http_json".into(),
                    status_code: None,
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: false,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("user_retail_1".into()),
                    anonymous_ref: None,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(second_transient_known.state == "consent_required");
            sqlx::query(
                r"UPDATE consent_grants SET state = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE environment_id = $1 AND subject = $2 AND scope = $3",
            )
            .bind(auth_a.environment.id)
            .bind(&transient_subject)
            .bind("personalize")
            .execute(&pool)
            .await?;
            anyhow::ensure!(
                submit_enrichment_answer(
                    &pool,
                    transient_capability,
                    EnrichmentAnswerInput {
                        status: "answered".into(),
                        items: vec![crate::models::EnrichmentAnswerItemInput {
                            key: "shopping.priority".into(),
                            signal_type: "preference".into(),
                            value: "quality".into(),
                            _summary: None,
                            provenance: "agent_reports_user_statement".into(),
                            confidence: Some(1.0),
                            remember: false,
                            expires_at: None,
                        }],
                    },
                )
                .await
                .is_err()
            );

            let transient_anonymous_interaction = Uuid::new_v4();
            let transient_anonymous = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: transient_anonymous_interaction,
                    operation: "/recommend".into(),
                    surface: "http_json".into(),
                    status_code: None,
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: false,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: Some("anon_transient".into()),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(transient_anonymous.identity_level == "pseudonymous");
            anyhow::ensure!(
                sqlx::query_scalar::<_, String>(
                    "SELECT consent_subject FROM enrichment_requests WHERE id = $1",
                )
                .bind(transient_anonymous.request_id)
                .fetch_one(&pool)
                .await?
                    .starts_with("afint1_")
            );

            let preexisting_interaction_id = Uuid::new_v4();
            let preexisting_session_hash = customer_identifier_hash(
                TEST_IDENTITY_HMAC_SECRET,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                "session_ref",
                "preexisting_session",
            )
            .map_err(test_error)?;
            let mut preexisting_tx = pool.begin().await?;
            let preexisting_session_id = resolve_v2_session(
                &mut preexisting_tx,
                auth_a.workspace.id,
                auth_a.environment.id,
                &customer_scope_hash(None, Some(resolved_customer_id)),
                &preexisting_session_hash,
                "customer",
                Utc::now(),
            )
            .await
            .map_err(test_error)?;
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, api_key_id, session_id,
                 surface, operation, status_code, duration_ms, customer_id,
                 classification, runtime_hint, runtime_hint_source, occurred_at)
                VALUES ($1,$2,$3,$4,$5,'http_json','/preexisting',200,7,$6,
                  'unclassified','codex/1','http',NOW())",
            )
            .bind(preexisting_interaction_id)
            .bind(auth_a.workspace.id)
            .bind(auth_a.environment.id)
            .bind(auth_a.api_key_id)
            .bind(preexisting_session_id)
            .bind(resolved_customer_id)
            .execute(&mut *preexisting_tx)
            .await?;
            preexisting_tx.commit().await?;
            let preexisting_input = EnrichmentRequestInput {
                interaction_id: preexisting_interaction_id,
                operation: "/preexisting".into(),
                surface: "http_json".into(),
                status_code: Some(200),
                duration_ms: Some(7),
                session_ref: Some("preexisting_session".into()),
                runtime_hint: Some("codex/1".into()),
                purpose: "product_personalization".into(),
                remember: true,
                customer_ref: None,
                account_ref: None,
                user_ref: Some("user_retail_1".into()),
                anonymous_ref: None,
            };
            create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                preexisting_input.clone(),
            )
            .await
            .map_err(test_error)?;
            let session_count_before = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1",
            )
            .bind(auth_a.environment.id)
            .fetch_one(&pool)
            .await?;
            let mut mismatched_preexisting = preexisting_input;
            mismatched_preexisting.session_ref = Some("preexisting_other".into());
            anyhow::ensure!(
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    mismatched_preexisting,
                )
                .await
                .is_err()
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1",
                )
                .bind(auth_a.environment.id)
                .fetch_one(&pool)
                .await?
                    == session_count_before
            );

            let merge_anonymous = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: Uuid::new_v4(),
                    operation: "/consent-merge".into(),
                    surface: "http_json".into(),
                    status_code: Some(200),
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: Some("consent_merge_anon".into()),
                },
            )
            .await
            .map_err(test_error)?;
            let merge_anonymous_capability = merge_anonymous
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing anonymous merge capability"))?;
            decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                merge_anonymous_capability,
                EnrichmentConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let merge_answer = submit_enrichment_answer(
                &pool,
                merge_anonymous_capability,
                EnrichmentAnswerInput {
                    status: "answered".into(),
                    items: vec![crate::models::EnrichmentAnswerItemInput {
                        key: "shopping.priority".into(),
                        signal_type: "preference".into(),
                        value: "price".into(),
                        _summary: None,
                        provenance: "agent_reports_user_statement".into(),
                        confidence: Some(1.0),
                        remember: true,
                        expires_at: None,
                    }],
                },
            )
            .await
            .map_err(test_error)?;
            let merge_old_context = retrieve_customer_context(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                CustomerContextInput {
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: Some("consent_merge_anon".into()),
                    interaction_id: None,
                    purpose: "product_personalization".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(merge_old_context.items.len() == 1);
            let ready_before_merge = dashboard_insights(
                &pool,
                Some(auth_a.environment.id),
                None,
            )
            .await
            .map_err(test_error)?
            .personalization_ready_customers;
            anyhow::ensure!(ready_before_merge >= 1);
            let merge_known = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: Uuid::new_v4(),
                    operation: "/consent-merge".into(),
                    surface: "http_json".into(),
                    status_code: Some(200),
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("consent_merge_user".into()),
                    anonymous_ref: None,
                },
            )
            .await
            .map_err(test_error)?;
            let merge_known_capability = merge_known
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing known merge capability"))?;
            decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                merge_known_capability,
                EnrichmentConsentDecisionInput {
                    decision: "declined".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let merged_consent = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: Uuid::new_v4(),
                    operation: "/consent-merge".into(),
                    surface: "http_json".into(),
                    status_code: Some(200),
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("consent_merge_user".into()),
                    anonymous_ref: Some("consent_merge_anon".into()),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(merged_consent.state == "declined");
            let merged_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(merged_consent.interaction_id)
            .fetch_one(&pool)
            .await?;
            let merged_customer_detail = dashboard_customer_by_id(
                &pool,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                merged_customer_id,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(merged_customer_detail.customer.consent_state == "declined");
            let merged_signal = merged_customer_detail
                .signals
                .iter()
                .find(|signal| signal.id == merge_answer.signals[0].signal_id)
                .ok_or_else(|| anyhow::anyhow!("missing merged dashboard signal"))?;
            anyhow::ensure!(merged_signal.consent_state.as_deref() == Some("declined"));
            anyhow::ensure!(merged_signal.allowed_uses.is_empty());
            let ready_after_merge = dashboard_insights(
                &pool,
                Some(auth_a.environment.id),
                None,
            )
            .await
            .map_err(test_error)?
            .personalization_ready_customers;
            anyhow::ensure!(ready_after_merge < ready_before_merge);
            let blocked_merged_context = retrieve_customer_context(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                CustomerContextInput {
                    customer_ref: None,
                    account_ref: None,
                    user_ref: Some("consent_merge_user".into()),
                    anonymous_ref: None,
                    interaction_id: None,
                    purpose: "product_personalization".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(blocked_merged_context.items.is_empty());
            anyhow::ensure!(
                record_personalization_decision(
                    &pool,
                    &auth_a,
                    PersonalizationDecisionInput {
                        external_decision_id: "blocked_after_identity_merge".into(),
                        context_retrieval_id: merge_old_context.retrieval_id,
                        signal_ids: vec![merge_answer.signals[0].signal_id],
                        variant: None,
                    },
                )
                .await
                .is_err()
            );
            let stale_replay = decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                merge_anonymous_capability,
                EnrichmentConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(!stale_replay.changed);

            let conflicting_request_interaction = Uuid::new_v4();
            let conflicting_request = EnrichmentRequestInput {
                interaction_id: conflicting_request_interaction,
                operation: "/recommend".into(),
                surface: "http_json".into(),
                status_code: None,
                duration_ms: None,
                session_ref: Some("conflict_session_a".into()),
                runtime_hint: None,
                purpose: "targeted_advertising".into(),
                remember: false,
                customer_ref: None,
                account_ref: None,
                user_ref: Some("user_retail_1".into()),
                anonymous_ref: None,
            };
            let mut different_payload = conflicting_request.clone();
            different_payload.operation = "/different-operation".into();
            different_payload.session_ref = Some("conflict_session_b".into());
            let conflict_session_a_hash = customer_identifier_hash(
                TEST_IDENTITY_HMAC_SECRET,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                "session_ref",
                "conflict_session_a",
            )
            .map_err(test_error)?;
            let alternate_ref_hash = customer_identifier_hash(
                TEST_IDENTITY_HMAC_SECRET,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                "session_ref",
                "conflict_session_b",
            )
            .map_err(test_error)?;
            let (request_conflict_a, request_conflict_b) = tokio::join!(
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    conflicting_request.clone(),
                ),
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    different_payload.clone(),
                )
            );
            anyhow::ensure!(request_conflict_a.is_ok() ^ request_conflict_b.is_ok());
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    r"SELECT COUNT(*) FROM sessions_v2
                    WHERE environment_id = $1
                      AND COALESCE(raw_ref_hash, ref_hash) IN ($2, $3)",
                )
                .bind(auth_a.environment.id)
                .bind(conflict_session_a_hash)
                .bind(alternate_ref_hash)
                .fetch_one(&pool)
                .await?
                    == 1
            );
            let (retry_a, retry_b) = tokio::join!(
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    conflicting_request,
                ),
                create_enrichment_request(
                    &pool,
                    &auth_a,
                    TEST_IDENTITY_HMAC_SECRET,
                    "https://app.epode.ai",
                    different_payload,
                )
            );
            anyhow::ensure!(retry_a.is_ok() ^ retry_b.is_ok());

            let ephemeral_interaction_id = Uuid::new_v4();
            let ephemeral = create_enrichment_request(
                &pool,
                &auth_a,
                TEST_IDENTITY_HMAC_SECRET,
                "https://app.epode.ai",
                EnrichmentRequestInput {
                    interaction_id: ephemeral_interaction_id,
                    operation: "/recommend".into(),
                    surface: "http_json".into(),
                    status_code: None,
                    duration_ms: None,
                    session_ref: None,
                    runtime_hint: None,
                    purpose: "product_personalization".into(),
                    remember: true,
                    customer_ref: None,
                    account_ref: None,
                    user_ref: None,
                    anonymous_ref: None,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(ephemeral.identity_level == "ephemeral");
            anyhow::ensure!(
                ephemeral
                    .question
                    .as_deref()
                    .is_some_and(|question| question.contains("for this interaction only"))
            );
            anyhow::ensure!(
                sqlx::query_as::<_, (Option<Uuid>, bool)>(
                    "SELECT customer_id, remember FROM enrichment_requests WHERE id = $1",
                )
                .bind(ephemeral.request_id)
                .fetch_one(&pool)
                .await?
                    == (None, false)
            );
            let ephemeral_capability = ephemeral
                .consent
                .as_ref()
                .and_then(|action| action.authorization.strip_prefix("Bearer "))
                .ok_or_else(|| anyhow::anyhow!("missing ephemeral capability"))?;
            decide_enrichment_consent(
                &pool,
                "https://app.epode.ai",
                ephemeral_capability,
                EnrichmentConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let ephemeral_answer = submit_enrichment_answer(
                &pool,
                ephemeral_capability,
                EnrichmentAnswerInput {
                    status: "answered".into(),
                    items: vec![crate::models::EnrichmentAnswerItemInput {
                        key: "shopping.priority".into(),
                        signal_type: "preference".into(),
                        value: "quality".into(),
                        _summary: None,
                        provenance: "agent_reports_current_task".into(),
                        confidence: Some(1.0),
                        remember: false,
                        expires_at: None,
                    }],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(!ephemeral_answer.signals[0].remembered);

            let response_page = dashboard_responses_page(
                &pool,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                DashboardResponseFilters {
                    query: Some("quality".into()),
                    statuses: Some(vec!["answered".into()]),
                    limit: Some(1),
                    ..DashboardResponseFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(response_page.responses.len() == 1);
            anyhow::ensure!(response_page.responses[0].id == ephemeral.request_id);
            anyhow::ensure!(response_page.responses[0].status == "answered");
            anyhow::ensure!(response_page.responses[0].answers.len() == 1);
            anyhow::ensure!(response_page.responses[0].answers[0].value == "quality");
            anyhow::ensure!(response_page.rollup.questions > 1);

            let first_response_page = dashboard_responses_page(
                &pool,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                DashboardResponseFilters {
                    limit: Some(1),
                    ..DashboardResponseFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            let response_cursor = first_response_page
                .next_cursor
                .ok_or_else(|| anyhow::anyhow!("first response page did not return a cursor"))?;
            let second_response_page = dashboard_responses_page(
                &pool,
                auth_a.workspace.id,
                auth_a.environment.product_id,
                DashboardResponseFilters {
                    limit: Some(1),
                    cursor: Some(response_cursor),
                    ..DashboardResponseFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(second_response_page.responses.len() == 1);
            anyhow::ensure!(
                second_response_page.responses[0].id != first_response_page.responses[0].id
            );
            Ok::<(), anyhow::Error>(())
        })
        .await;
        for workspace in [&workspace_a, &workspace_b] {
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(workspace.id)
                .execute(&pool)
                .await?;
        }
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn customer_identity_resolution_is_progressive_and_tenant_scoped() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace_a = telemetry_test_workspace(&pool, "Identity tenant A").await?;
        let (product_a, auth_a) =
            telemetry_test_product(&pool, &workspace_a, "Identity product A").await?;
        let workspace_b = telemetry_test_workspace(&pool, "Identity tenant B").await?;
        let (product_b, auth_b) =
            telemetry_test_product(&pool, &workspace_b, "Identity product B").await?;

        let result = async {
            let anonymous_interaction_id = Uuid::new_v4();
            let mut anonymous =
                http_telemetry_event(anonymous_interaction_id, Utc::now() - Duration::seconds(2));
            anonymous.anonymous_ref = Some("browser_installation_1".into());
            anonymous.session_ref = Some("journey_1".into());
            anonymous.session_source = Some("customer".into());
            let accepted = ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![anonymous],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(accepted.accepted == 1 && accepted.dropped == 0);
            let anonymous_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(anonymous_interaction_id)
            .fetch_one(&pool)
            .await?;

            let verified_interaction_id = Uuid::new_v4();
            let mut verified = http_telemetry_event(verified_interaction_id, Utc::now());
            verified.user_ref = Some("user_42".into());
            verified.account_ref = Some("account_7".into());
            verified.customer_ref = Some("account_7".into());
            verified.anonymous_ref = Some("browser_installation_1".into());
            verified.session_ref = Some("journey_1".into());
            verified.session_source = Some("customer".into());
            ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![verified],
                },
            )
            .await
            .map_err(test_error)?;
            let verified_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(verified_interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(verified_customer_id != anonymous_customer_id);
            let prior_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(anonymous_interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(prior_customer_id == verified_customer_id);

            let later_anonymous_interaction_id = Uuid::new_v4();
            let mut later_anonymous =
                http_telemetry_event(later_anonymous_interaction_id, Utc::now());
            later_anonymous.anonymous_ref = Some("browser_installation_1".into());
            later_anonymous.session_ref = Some("journey_1".into());
            later_anonymous.session_source = Some("customer".into());
            ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![later_anonymous],
                },
            )
            .await
            .map_err(test_error)?;
            let resolved_session_ids = sqlx::query_scalar::<_, Uuid>(
                "SELECT session_id FROM interactions_v2 WHERE id = ANY($1) ORDER BY id",
            )
            .bind([
                anonymous_interaction_id,
                verified_interaction_id,
                later_anonymous_interaction_id,
            ])
            .fetch_all(&pool)
            .await?;
            anyhow::ensure!(resolved_session_ids.len() == 3);
            anyhow::ensure!(resolved_session_ids.iter().all(|id| *id == resolved_session_ids[0]));
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM sessions_v2 WHERE workspace_id = $1 AND environment_id = $2",
                )
                .bind(workspace_a.id)
                .bind(auth_a.environment.id)
                .fetch_one(&pool)
                .await?
                    == 1
            );
            let (level, parent_customer_id) = sqlx::query_as::<_, (String, Option<Uuid>)>(
                "SELECT identity_level, parent_customer_id FROM customers WHERE id = $1",
            )
            .bind(verified_customer_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(level == "verified" && parent_customer_id.is_some());
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM customer_resolution_events WHERE from_customer_id = $1 AND to_customer_id = $2",
                )
                .bind(anonymous_customer_id)
                .bind(verified_customer_id)
                .fetch_one(&pool)
                .await?
                    == 1
            );

            let isolated_interaction_id = Uuid::new_v4();
            let mut isolated = http_telemetry_event(isolated_interaction_id, Utc::now());
            isolated.user_ref = Some("user_42".into());
            ingest_telemetry_batch(
                &pool,
                &auth_b,
                TelemetryBatchInput {
                    events: vec![isolated],
                },
            )
            .await
            .map_err(test_error)?;
            let isolated_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(isolated_interaction_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(isolated_customer_id != verified_customer_id);

            let customers = dashboard_customers_page(
                &pool,
                workspace_a.id,
                product_a.id,
                DashboardCustomerFilters::default(),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                customers
                    .customers
                    .iter()
                    .any(|customer| customer.id == verified_customer_id)
            );
            anyhow::ensure!(customers.rollup.verified == 2);
            dashboard_customers_page(
                &pool,
                workspace_a.id,
                product_a.id,
                DashboardCustomerFilters {
                    query: Some("user\\_%".into()),
                    ..DashboardCustomerFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            let detail = dashboard_customer_by_id(
                &pool,
                workspace_a.id,
                product_a.id,
                verified_customer_id,
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(detail.customer.identity_level == "verified");
            anyhow::ensure!(detail.customer.kind == "user");
            anyhow::ensure!(detail.customer.parent_customer_id.is_some());
            anyhow::ensure!(detail.customer.member_count == 0);
            anyhow::ensure!(detail.identifiers.len() == 2);
            anyhow::ensure!(
                dashboard_customer_by_id(
                    &pool,
                    workspace_b.id,
                    product_b.id,
                    verified_customer_id,
                )
                .await
                .is_err()
            );
            let signals = dashboard_signals_page(
                &pool,
                workspace_a.id,
                product_a.id,
                DashboardSignalFilters {
                    customer_id: Some(verified_customer_id),
                    ..DashboardSignalFilters::default()
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(signals.total == 0 && signals.signals.is_empty());
            dashboard_signals_page(
                &pool,
                workspace_a.id,
                product_a.id,
                DashboardSignalFilters {
                    query: Some("signal\\_%".into()),
                    ..DashboardSignalFilters::default()
                },
            )
            .await
            .map_err(test_error)?;

            let customer_count_before = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM customers WHERE workspace_id = $1",
            )
            .bind(workspace_a.id)
            .fetch_one(&pool)
            .await?;
            let mut invalid_session = http_telemetry_event(Uuid::new_v4(), Utc::now());
            invalid_session.user_ref = Some("must_not_persist".into());
            invalid_session.session_ref = Some("valid_session".into());
            invalid_session.session_source = Some("invalid_source".into());
            let invalid_session_result = ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![invalid_session],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(invalid_session_result.dropped == 1);
            let mut conflicting_replay =
                http_telemetry_event(verified_interaction_id, Utc::now());
            conflicting_replay.user_ref = Some("different_user".into());
            let replay_result = ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![conflicting_replay],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(replay_result.dropped == 1);
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM customers WHERE workspace_id = $1",
                )
                .bind(workspace_a.id)
                .fetch_one(&pool)
                .await?
                    == customer_count_before
            );

            let conflicting_interaction_id = Uuid::new_v4();
            let mut conflicting = http_telemetry_event(conflicting_interaction_id, Utc::now());
            conflicting.customer_ref = Some("legacy_42".into());
            conflicting.user_ref = Some("user_42".into());
            let rejected = ingest_telemetry_batch(
                &pool,
                &auth_a,
                TelemetryBatchInput {
                    events: vec![conflicting],
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(rejected.accepted == 0 && rejected.dropped == 1);
            anyhow::ensure!(
                !sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM interactions_v2 WHERE id = $1)",
                )
                .bind(conflicting_interaction_id)
                .fetch_one(&pool)
                .await?
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;

        for workspace in [&workspace_a, &workspace_b] {
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(workspace.id)
                .execute(&pool)
                .await?;
        }
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn feedback_projects_idempotent_signals_and_winning_consent_cas_only()
    -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Signal projection tenant").await?;
        let (_product, mut environment) = create_product(
            &pool,
            workspace.id,
            CreateProductInput {
                name: "Signals".into(),
            },
        )
        .await
        .map_err(test_error)?;
        environment = update_policy(
            &pool,
            workspace.id,
            PolicyInput {
                environment_id: environment.id,
                feedback_mode: "ask_once".into(),
                collect_event_summaries: false,
                retention_days: 30,
            },
        )
        .await
        .map_err(test_error)?;
        let (key, secret) = create_api_key(
            &pool,
            workspace.id,
            environment.id,
            Some("Signals write".into()),
            None,
            None,
        )
        .await
        .map_err(test_error)?;
        let auth = ProductAuth {
            workspace: workspace.clone(),
            environment: environment.clone(),
            api_key_id: key.id,
        };
        let result = async {
            let interaction_id = Uuid::new_v4();
            let mut event = http_telemetry_event(interaction_id, Utc::now());
            event.customer_ref = Some("customer_42".into());
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![event],
                },
            )
            .await
            .map_err(test_error)?;
            let subject = format!("afsub1_{}", "A".repeat(43));
            let approval = test_capability_with_subject_revision(
                &secret,
                key.id,
                interaction_id,
                Some(&subject),
                Some(0),
            );
            let decision = record_feedback_consent_decision(
                &pool,
                &approval,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(decision.changed && decision.feedback_action_allowed);
            let mut feedback = feedback_input_with_finding(
                "The search worked after one recoverable issue.",
                "search_recovery",
            );
            feedback.workaround = Some(crate::models::FeedbackWorkaroundInput {
                used: true,
                detail: Some("Retried with a narrower search term.".into()),
            });
            let (_, report) = submit_product_feedback(&pool, &approval, feedback)
                .await
                .map_err(test_error)?;
            let customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(interaction_id)
            .fetch_one(&pool)
            .await?;
            let signal_rows = sqlx::query_as::<_, (String, String, Option<Uuid>, Option<String>)>(
                r"SELECT signal_type, provenance, consent_grant_id, consent_scope
                FROM customer_signals WHERE workspace_id = $1 AND feedback_report_id = $2
                ORDER BY source_item_key",
            )
            .bind(workspace.id)
            .bind(report.id)
            .fetch_all(&pool)
            .await?;
            anyhow::ensure!(signal_rows.len() == 3);
            anyhow::ensure!(signal_rows.iter().all(|row| {
                row.1 == "agent_reports_current_task"
                    && row.2.is_some()
                    && row.3.as_deref() == Some("share_outcome")
            }));
            anyhow::ensure!(
                sqlx::query_scalar::<_, Option<Uuid>>(
                    r"SELECT customer_id FROM consent_grants
                    WHERE environment_id = $1 AND subject = $2 AND scope = 'share_outcome'",
                )
                .bind(environment.id)
                .bind(&subject)
                .fetch_one(&pool)
                .await?
                    == Some(customer_id)
            );

            let (_, retry_report) = submit_product_feedback(
                &pool,
                &approval,
                feedback_input("A retry must return the original report."),
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(retry_report.id == report.id);
            anyhow::ensure!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM customer_signals WHERE feedback_report_id = $1",
                )
                .bind(report.id)
                .fetch_one(&pool)
                .await?
                    == 3
            );

            let revoke = test_capability_with_subject_revision(
                &secret,
                key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(1),
            );
            anyhow::ensure!(
                record_feedback_consent_decision(
                    &pool,
                    &revoke,
                    ConsentDecisionInput {
                        decision: "declined".into(),
                    },
                )
                .await
                .map_err(test_error)?
                .changed
            );
            let stale = test_capability_with_subject_revision(
                &secret,
                key.id,
                Uuid::new_v4(),
                Some(&subject),
                Some(1),
            );
            let stale_result = record_feedback_consent_decision(
                &pool,
                &stale,
                ConsentDecisionInput {
                    decision: "approved".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(!stale_result.changed && !stale_result.feedback_action_allowed);
            let (grant_state, grant_revision, event_count) =
                sqlx::query_as::<_, (String, i64, i64)>(
                    r"SELECT grant_row.state, grant_row.revision,
                      (SELECT COUNT(*) FROM consent_events event
                        WHERE event.consent_grant_id = grant_row.id)::BIGINT
                    FROM consent_grants grant_row
                    WHERE grant_row.environment_id = $1 AND grant_row.subject = $2
                      AND grant_row.scope = 'share_outcome'",
                )
                .bind(environment.id)
                .bind(&subject)
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(grant_state == "declined" && grant_revision == 2 && event_count == 2);

            update_policy(
                &pool,
                workspace.id,
                PolicyInput {
                    environment_id: environment.id,
                    feedback_mode: "ask_always".into(),
                    collect_event_summaries: false,
                    retention_days: 30,
                },
            )
            .await
            .map_err(test_error)?;
            let always_interaction_id = Uuid::new_v4();
            let mut always_event = http_telemetry_event(always_interaction_id, Utc::now());
            always_event.customer_ref = Some("customer_42".into());
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![always_event],
                },
            )
            .await
            .map_err(test_error)?;
            let always_capability = test_capability(&secret, key.id, always_interaction_id);
            anyhow::ensure!(
                record_feedback_consent_decision(
                    &pool,
                    &always_capability,
                    ConsentDecisionInput {
                        decision: "approved".into(),
                    },
                )
                .await
                .map_err(test_error)?
                .changed
            );
            let (_, always_report) = submit_product_feedback(
                &pool,
                &always_capability,
                feedback_input("Ask always permission remains linked evidence."),
            )
            .await
            .map_err(test_error)?;
            let (always_basis, always_scope, always_state) =
                sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
                    r"SELECT signal.collection_basis, signal.consent_scope, grant_row.state
                    FROM customer_signals signal
                    LEFT JOIN consent_grants grant_row ON grant_row.id = signal.consent_grant_id
                    WHERE signal.feedback_report_id = $1 AND signal.source_item_key = 'outcome'",
                )
                .bind(always_report.id)
                .fetch_one(&pool)
                .await?;
            anyhow::ensure!(
                always_basis == "user_consent"
                    && always_scope.as_deref() == Some("share_outcome")
                    && always_state.as_deref() == Some("approved")
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn customer_intelligence_backfill_is_bounded_and_idempotent() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Backfill tenant").await?;
        let (product, auth) = telemetry_test_product(&pool, &workspace, "Backfill product").await?;
        let result = async {
            let interaction_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO interactions_v2
                (id, workspace_id, environment_id, api_key_id, surface, operation,
                 status_code, customer_ref, classification, occurred_at)
                VALUES ($1, $2, $3, $4, 'http_json', '/legacy', 200,
                  'legacy_customer_1', 'unclassified', NOW())",
            )
            .bind(interaction_id)
            .bind(workspace.id)
            .bind(auth.environment.id)
            .bind(auth.api_key_id)
            .execute(&pool)
            .await?;
            let report_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO feedback_reports
                (id, workspace_id, interaction_id, summary, impact, confidence, findings)
                VALUES ($1, $2, $3, 'Legacy report should become typed evidence.',
                  'helped_with_friction', 0.8, $4)",
            )
            .bind(report_id)
            .bind(workspace.id)
            .bind(interaction_id)
            .bind(serde_json::json!([{
                "kind": "gap",
                "topic": "legacy_gap",
                "severity": "major",
                "detail": "A legacy gap was observed."
            }]))
            .execute(&pool)
            .await?;
            let subject = format!("afsub1_{}", "B".repeat(43));
            sqlx::query(
                r"INSERT INTO feedback_consent_subjects
                (environment_id, subject, decision, revision)
                VALUES ($1, $2, 'approved', 1)",
            )
            .bind(auth.environment.id)
            .bind(&subject)
            .execute(&pool)
            .await?;

            let first = backfill_customer_intelligence(&pool, TEST_IDENTITY_HMAC_SECRET, 1)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(!first.exhausted);
            anyhow::ensure!(
                first.interactions_scanned == 1
                    && first.interactions_linked == 1
                    && first.reports_scanned == 1
                    && first.reports_projected == 1
                    && first.consent_subjects_scanned == 1
                    && first.consent_grants_projected == 1
            );
            let second = backfill_customer_intelligence(&pool, TEST_IDENTITY_HMAC_SECRET, 1)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(second.exhausted);
            anyhow::ensure!(
                second.interactions_scanned == 0
                    && second.reports_scanned == 0
                    && second.consent_subjects_scanned == 0
            );
            let counts = sqlx::query_as::<_, (i64, i64, i64)>(
                r"SELECT
                  (SELECT COUNT(*) FROM customers WHERE workspace_id = $1),
                  (SELECT COUNT(*) FROM customer_signals WHERE workspace_id = $1
                    AND feedback_report_id = $2),
                  (SELECT COUNT(*) FROM consent_grants WHERE workspace_id = $1
                    AND product_id = $3 AND scope = 'share_outcome')",
            )
            .bind(workspace.id)
            .bind(report_id)
            .bind(product.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(counts == (1, 2, 1));
            let third = backfill_customer_intelligence(&pool, TEST_IDENTITY_HMAC_SECRET, 10)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(third.exhausted);
            let unchanged = sqlx::query_as::<_, (i64, i64, i64)>(
                r"SELECT
                  (SELECT COUNT(*) FROM customers WHERE workspace_id = $1),
                  (SELECT COUNT(*) FROM customer_signals WHERE workspace_id = $1),
                  (SELECT COUNT(*) FROM consent_events WHERE workspace_id = $1)",
            )
            .bind(workspace.id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(unchanged == (1, 2, 1));
            Ok::<(), anyhow::Error>(())
        }
        .await;
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn customer_intelligence_retention_removes_expired_optional_data_only()
    -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let workspace = telemetry_test_workspace(&pool, "Retention tenant").await?;
        let (product, auth) =
            telemetry_test_product(&pool, &workspace, "Retention product").await?;
        let result = async {
            let interaction_id = Uuid::new_v4();
            let mut event = http_telemetry_event(interaction_id, Utc::now());
            event.anonymous_ref = Some("retained_browser".into());
            ingest_telemetry_batch(
                &pool,
                &auth,
                TelemetryBatchInput {
                    events: vec![event],
                },
            )
            .await
            .map_err(test_error)?;
            let retained_customer_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT customer_id FROM interactions_v2 WHERE id = $1",
            )
            .bind(interaction_id)
            .fetch_one(&pool)
            .await?;
            let expired_signal_id = Uuid::new_v4();
            sqlx::query(
                r"INSERT INTO customer_signals
                (id, workspace_id, product_id, customer_id, interaction_id,
                 source_item_key, signal_type, summary, provenance,
                 collection_basis, collected_at, expires_at)
                VALUES ($1, $2, $3, $4, $5, 'expired_preference', 'preference',
                  'An expired preference', 'company_assertion',
                  'required_product_data', NOW() - INTERVAL '2 days',
                  NOW() - INTERVAL '1 day')",
            )
            .bind(expired_signal_id)
            .bind(workspace.id)
            .bind(product.id)
            .bind(retained_customer_id)
            .bind(interaction_id)
            .execute(&pool)
            .await?;
            let orphan_pseudonymous_id = Uuid::new_v4();
            let verified_id = Uuid::new_v4();
            for (id, kind, level) in [
                (orphan_pseudonymous_id, "anonymous", "pseudonymous"),
                (verified_id, "generic", "verified"),
            ] {
                sqlx::query(
                    r"INSERT INTO customers
                    (id, workspace_id, kind, identity_level, identity_confidence,
                     first_seen_at, last_seen_at)
                    VALUES ($1, $2, $3, $4, 1, NOW(), NOW())",
                )
                .bind(id)
                .bind(workspace.id)
                .bind(kind)
                .bind(level)
                .execute(&pool)
                .await?;
            }
            anyhow::ensure!(
                purge_expired_product_data(&pool, 100)
                    .await
                    .map_err(test_error)?
                    >= 2
            );
            anyhow::ensure!(
                !sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM customer_signals WHERE id = $1)",
                )
                .bind(expired_signal_id)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                !sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1)",
                )
                .bind(orphan_pseudonymous_id)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1)",
                )
                .bind(verified_id)
                .fetch_one(&pool)
                .await?
            );
            anyhow::ensure!(
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1)",
                )
                .bind(retained_customer_id)
                .fetch_one(&pool)
                .await?
            );
            Ok::<(), anyhow::Error>(())
        }
        .await;
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace.id)
            .execute(&pool)
            .await?;
        result
    }

    #[test]
    fn team_invitee_emails_are_normalized() -> anyhow::Result<()> {
        anyhow::ensure!(
            normalize_invitee_email("Person@Example.com").map_err(test_error)?
                == "person@example.com"
        );
        anyhow::ensure!(normalize_invitee_email("@teammate").is_err());
        anyhow::ensure!(normalize_invitee_email("not an email").is_err());
        Ok(())
    }

    #[test]
    fn team_and_product_names_are_normalized_and_validated() -> anyhow::Result<()> {
        anyhow::ensure!(
            validated_name("  Search   API  ", "Product").map_err(test_error)? == "Search API"
        );
        anyhow::ensure!(validated_name("x", "Team").is_err());
        anyhow::ensure!(validated_name("   ", "Product").is_err());
        anyhow::ensure!(
            validated_name(&"a".repeat(100), "Product")
                .map_err(test_error)?
                .len()
                == 80
        );
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn team_invitation_role_and_removal_flow() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let suffix = Uuid::new_v4().simple().to_string();
        let owner = OsUser {
            id: format!("usr_owner_{suffix}"),
            handle: format!("owner_{}", &suffix[..8]),
            email: Some(format!("owner_{}@example.com", &suffix[..8])),
            display_name: Some("Team Owner".into()),
            avatar_url: None,
        };
        let teammate = OsUser {
            id: format!("usr_member_{suffix}"),
            handle: format!("member_{}", &suffix[..8]),
            email: Some(format!("member_{}@example.com", &suffix[..8])),
            display_name: Some("Team Member".into()),
            avatar_url: None,
        };
        let guest = OsUser {
            id: format!("usr_guest_{suffix}"),
            handle: format!("guest_{}", &suffix[..8]),
            email: Some(format!("guest_{}@example.com", &suffix[..8])),
            display_name: Some("Team Guest".into()),
            avatar_url: None,
        };

        let result = async {
            let (workspace, role, memberships) = resolve_workspace_access(&pool, &owner, None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(role == "owner");
            let owner_context = DashboardContext {
                user: CurrentUser {
                    id: owner.id.clone(),
                    handle: owner.handle.clone(),
                    email: owner.email.clone(),
                    display_name: owner
                        .display_name
                        .clone()
                        .expect("team owner fixture should have a display name"),
                },
                workspace: workspace.clone(),
                role,
                workspace_memberships: memberships,
            };
            let invitation = create_team_invitation(
                &pool,
                &owner_context,
                CreateTeamInvitationInput {
                    invitee: teammate.email.clone(),
                    role: "admin".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(
                accept_team_invitation(&pool, &guest, invitation.id)
                    .await
                    .is_err()
            );
            let accepted_workspace = accept_team_invitation(&pool, &teammate, invitation.id)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(accepted_workspace == workspace.id);
            let (_, teammate_role, teammate_memberships) =
                resolve_workspace_access(&pool, &teammate, Some(workspace.id))
                    .await
                    .map_err(test_error)?;
            anyhow::ensure!(teammate_role == "admin");
            anyhow::ensure!(teammate_memberships.len() == 2);

            let updated = update_team_member_role(
                &pool,
                &owner_context,
                &teammate.id,
                UpdateTeamMemberInput {
                    role: "member".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(updated.role == "member");
            remove_team_member(&pool, &owner_context, &teammate.id)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(
                resolve_workspace_access(&pool, &teammate, Some(workspace.id))
                    .await
                    .is_err()
            );
            let link_invitation = create_team_invitation(
                &pool,
                &owner_context,
                CreateTeamInvitationInput {
                    invitee: None,
                    role: "member".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(link_invitation.invitee_kind == "link");
            anyhow::ensure!(link_invitation.expires_at <= Utc::now() + Duration::hours(24));
            anyhow::ensure!(link_invitation.expires_at > Utc::now() + Duration::hours(23));
            let copied_link = create_team_invitation(
                &pool,
                &owner_context,
                CreateTeamInvitationInput {
                    invitee: None,
                    role: "member".into(),
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(copied_link.id == link_invitation.id);
            anyhow::ensure!(
                accept_team_invitation(&pool, &guest, link_invitation.id)
                    .await
                    .map_err(test_error)?
                    == workspace.id
            );
            anyhow::ensure!(
                accept_team_invitation(&pool, &teammate, link_invitation.id)
                    .await
                    .map_err(test_error)?
                    == workspace.id
            );
            let (_, guest_role, _) = resolve_workspace_access(&pool, &guest, Some(workspace.id))
                .await
                .map_err(test_error)?;
            anyhow::ensure!(guest_role == "member");
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query(
            "DELETE FROM workspaces WHERE os_user_id = $1 OR os_user_id = $2 OR os_user_id = $3",
        )
        .bind(&owner.id)
        .bind(&teammate.id)
        .bind(&guest.id)
        .execute(&pool)
        .await?;
        result
    }
}
