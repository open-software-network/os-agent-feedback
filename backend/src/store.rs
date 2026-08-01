#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::collections::BTreeMap;

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::ApiError,
    github::validate_repo_full_name,
    grouping::{GroupInput, ReportGrouper},
    issue_template::{
        IssueCount, IssueFindingRollup, IssueTemplateData, contains_sensitive_report_text,
    },
    models::{
        ApiKeyPublic, CapabilityInspectionResponse, ConsentDecisionInput, ConsentStateInput,
        ConsentStateResponse, CreateProductInput, CreateTeamInvitationInput, DashboardContext,
        DashboardData, DashboardFeedbackFacets, DashboardFeedbackFilters, DashboardFeedbackPage,
        DashboardListState, DashboardSessionDetail, DashboardSessionFilters,
        DashboardSessionRollup, DashboardSessionSummary, DashboardSessionsPage, DeleteProductInput,
        FeedbackFindingInput, FeedbackInteractionItem, FeedbackInteractionsPage,
        FeedbackListInteractionsInput, FeedbackListReportsInput, FeedbackOperationSummary,
        FeedbackReportItem, FeedbackReportsPage, FeedbackReportsResponse, FeedbackSummary,
        FeedbackSurfaceSummary, FeedbackWindow, GithubIssueLink, InsightCount, Insights,
        InteractionTelemetryInput, MergeReportGroupsResponse, PolicyInput, Product,
        ProductActivationMilestones, ProductAuth, ProductEnvironment, ProductFeedbackReport,
        ProductFeedbackReportInput, ProductFeedbackReportWithInteraction, ProductGithubRepo,
        ProductGithubRepoInput, ProductInteraction, ProductReportGroup, ProductSession,
        TeamInvitation, TeamMember, TelemetryBatchInput, TelemetryBatchResult,
        UpdateFeedbackWorkflowInput, UpdateNameInput, UpdateTeamMemberInput, Workspace,
        WorkspaceMembership,
    },
    os_accounts::OsUser,
    security::{
        bearer_token, parse_capability, random_token, sha256, valid_consent_subject,
        verify_capability,
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
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r
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
        .is_some_and(|kind| !["all", "multi", "feedback", "no_feedback"].contains(&kind))
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
                OR ($5 = 'feedback' AND activity.report_count > 0)
                OR ($5 = 'no_feedback' AND activity.report_count = 0))
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
            OR ($5 = 'feedback' AND activity.report_count > 0)
            OR ($5 = 'no_feedback' AND activity.report_count = 0))
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
        COUNT(i.id) FILTER (WHERE i.classification = 'confirmed'),
        COUNT(r.id) FILTER (WHERE r.workaround ->> 'used' = 'true'),
        COUNT(r.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.findings) finding
          WHERE finding ->> 'severity' = 'blocking'
        ))
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
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
        r"SELECT i.id, i.operation, i.customer_ref, i.surface, i.classification,
        i.duration_ms, i.status_code, i.occurred_at
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
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
    u64::try_from(removed_interactions + removed_sessions + removed_consent_interactions)
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
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $2 AND i.classification = 'confirmed'),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $2),
          COUNT(DISTINCT r.id) FILTER (WHERE i.occurred_at >= $2 AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.findings) finding
            WHERE finding ->> 'severity' = 'blocking'
          )),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $2 AND r.workaround ->> 'used' = 'true'),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $3 AND i.classification = 'confirmed'),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3),
          COUNT(i.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3 AND i.classification = 'confirmed'),
          COUNT(r.id) FILTER (WHERE i.occurred_at >= $4 AND i.occurred_at < $3)
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
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
        r"SELECT id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
        status_code, duration_ms, customer_ref, classification, confirmation_method,
        runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at
        FROM interactions_v2 WHERE environment_id = $1 AND occurred_at >= $2
        ORDER BY occurred_at DESC LIMIT $3",
    )
    .bind(environment_id)
    .bind(retained_since)
    .bind(interaction_limit)
    .fetch_all(pool)
    .await?;
    let reports = sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
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
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r
        JOIN interactions_v2 i ON i.id = r.interaction_id
        JOIN product_environments e ON e.id = i.environment_id
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
        i.surface, i.operation, i.status_code, i.duration_ms, i.customer_ref,
        i.classification, i.confirmation_method, i.runtime_hint, i.runtime_hint_source,
        i.occurred_at, i.created_at, i.updated_at
        FROM interactions_v2 i JOIN product_environments e ON e.id = i.environment_id
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
        i.operation, i.status_code, i.duration_ms, i.customer_ref, i.classification,
        i.confirmation_method, i.runtime_hint, i.runtime_hint_source,
        i.occurred_at, i.created_at, i.updated_at
        FROM interactions_v2 i
        JOIN product_environments e ON e.id = i.environment_id
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
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at,
        COALESCE(w.status, 'new') AS workflow_status, w.assignee_os_user_id,
        COALESCE(w.tags, '{}'::TEXT[]) AS tags, w.internal_note,
        w.updated_at AS workflow_updated_at
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        JOIN product_environments e ON e.id = i.environment_id
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
    let resolved = sqlx::query_scalar::<_, Uuid>(
        r"INSERT INTO sessions_v2
        (id, workspace_id, environment_id, customer_scope_hash, source, ref_hash,
         ref_hint, started_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        ON CONFLICT (environment_id, customer_scope_hash, source, ref_hash) DO UPDATE
        SET started_at = LEAST(sessions_v2.started_at, EXCLUDED.started_at),
            last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id",
    )
    .bind(session_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(customer_scope_hash)
    .bind(session_source)
    .bind(session_ref_hash)
    .bind(ref_hint)
    .bind(occurred_at)
    .fetch_one(&mut **tx)
    .await?;
    Ok(resolved)
}

fn customer_scope_hash(customer_ref: Option<&str>) -> Vec<u8> {
    customer_ref.map_or_else(
        || sha256("scope:anonymous"),
        |customer_ref| sha256(&format!("scope:customer:{customer_ref}")),
    )
}

fn validate_telemetry(input: &InteractionTelemetryInput) -> Result<(), ApiError> {
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
    let mut changed_interaction_ids = Vec::with_capacity(event_count);
    let mut session_evidence_by_interaction = BTreeMap::new();
    let mut events = input.events;
    events.sort_by_key(|event| event.interaction_id);
    let mut tx = pool.begin().await?;
    for event in events {
        match ingest_telemetry_event(&mut tx, auth, event).await {
            Ok(result) => {
                if result.grouping_facts_changed {
                    changed_interaction_ids.push(result.interaction_id);
                }
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
                // Every client-error path in `ingest_telemetry_event` either
                // validates before the upsert or is the conflict result of an
                // upsert that changed no row. Continuing therefore cannot
                // preserve a partial event write and does not need a nested
                // transaction. Avoiding per-event savepoints also keeps a
                // cancelled request from desynchronizing SQLx's local
                // transaction depth from PostgreSQL while releasing one.
                dropped += 1;
            }
            Err(error) => return Err(error),
        }
    }
    correlate_telemetry_sessions(&mut tx, auth, session_evidence_by_interaction).await?;
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
    let customer_ref = opaque_ref(event.customer_ref);
    let session_evidence = session_evidence(event.session_ref, event.session_source)?;
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
         duration_ms, customer_ref, classification, confirmation_method, runtime_hint,
         runtime_hint_source, client_sequence, occurred_at)
        SELECT COALESCE(p.id, input.id), $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16
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
        r"SELECT i.id AS interaction_id, i.occurred_at, i.customer_ref, i.session_id,
          s.source AS session_source, s.ref_hash AS session_ref_hash,
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
        let desired_customer_scope_hash = customer_scope_hash(state.customer_ref.as_deref());
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
            sort_customer_scope_hash: customer_scope_hash(state.customer_ref.as_deref()),
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
          status_code, duration_ms, customer_ref, classification, confirmation_method,
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
        tx.commit().await?;
        return Ok((interaction, existing));
    };
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
    tx.commit().await?;
    Ok((interaction, report))
}

#[cfg(test)]
mod product_tests {
    #![allow(
        clippy::expect_used,
        reason = "test failures should abort at the assertion site with explicit context"
    )]

    use std::str::FromStr;

    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use crate::models::{ConsentDecisionInput, CurrentUser};

    use super::*;

    fn test_error(error: ApiError) -> anyhow::Error {
        let ApiError { status, message } = error;
        anyhow::anyhow!("{status}: {message}")
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
    async fn recording_one_group_issue_twice_returns_the_existing_link() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let fixture = github_issue_group_fixture(&pool, "Issue idempotency test", 2).await?;

        let result = async {
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

            let (ref_hash, ref_hint): (Vec<u8>, String) =
                sqlx::query_as("SELECT ref_hash, ref_hint FROM sessions_v2 WHERE id = $1")
                    .bind(mcp_session)
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(ref_hash == sha256(canonical_ref));
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
            anyhow::ensure!(malformed.accepted == 2 && malformed.dropped == 0);
            let malformed_rows: Vec<(Uuid, Option<Uuid>, Option<String>)> = sqlx::query_as(
                r"SELECT id, session_id, customer_ref FROM interactions_v2
                WHERE id = ANY($1) ORDER BY id",
            )
            .bind(vec![malformed_session_id, malformed_customer_id])
            .fetch_all(&pool)
            .await?;
            anyhow::ensure!(malformed_rows.len() == 2);
            anyhow::ensure!(malformed_rows.iter().all(|(_, session_id, customer_ref)| {
                session_id.is_none() && customer_ref.is_none()
            }));
            let malformed_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM interactions_v2 WHERE id = ANY($1)")
                    .bind(vec![malformed_session_id, malformed_customer_id])
                    .fetch_one(&pool)
                    .await?;
            anyhow::ensure!(malformed_count == 2);
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
            let coalesced_ref_hash: Vec<u8> = sqlx::query_scalar(
                r"SELECT s.ref_hash FROM sessions_v2 s
                JOIN interactions_v2 i ON i.session_id = s.id
                WHERE i.id = $1",
            )
            .bind(coalesced_id)
            .fetch_one(&pool)
            .await?;
            anyhow::ensure!(coalesced_ref_hash == sha256("workflow:first_valid_proof"));

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
