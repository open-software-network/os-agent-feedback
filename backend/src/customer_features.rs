#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility keeps customer intelligence internal to the API binary"
)]

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    error::ApiError,
    models::{
        CustomerSignal, CustomerSummary, DashboardSessionSummary, DashboardSignalFilters,
        GithubIssueLink, InsightCount,
    },
    store::{dashboard_customer_by_id, dashboard_signals_page},
};

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardFeatureFilters {
    pub query: Option<String>,
    pub signal_types: Option<Vec<String>>,
    pub impacts: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub segments: Option<Vec<String>>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureSummary {
    pub key: String,
    #[schema(required = true, nullable)]
    pub group_key: Option<String>,
    pub title: String,
    pub summary: String,
    pub signal_types: Vec<String>,
    pub affected_customer_count: i64,
    pub evidence_count: i64,
    pub strongest_impact: String,
    #[schema(required = true, nullable)]
    pub trend: Option<i64>,
    pub status: String,
    pub last_observed_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub github_issue: Option<GithubIssueLink>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureRollup {
    pub features: i64,
    pub affected_customers: i64,
    pub evidence: i64,
    pub blocking: i64,
}

#[derive(Debug, Default, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeatureFacets {
    pub signal_type: Vec<InsightCount>,
    pub impact: Vec<InsightCount>,
    pub status: Vec<InsightCount>,
    pub segment: Vec<InsightCount>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardFeaturesPage {
    pub features: Vec<FeatureSummary>,
    pub rollup: FeatureRollup,
    pub facets: FeatureFacets,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardFeatureDetail {
    pub feature: FeatureSummary,
    pub signals: Vec<CustomerSignal>,
    pub customers: Vec<CustomerSummary>,
    pub sessions: Vec<DashboardSessionSummary>,
}

#[derive(Debug, sqlx::FromRow)]
struct FeatureRow {
    key: String,
    group_key: Option<String>,
    summary: String,
    signal_types: Vec<String>,
    affected_customer_count: i64,
    evidence_count: i64,
    strongest_impact: String,
    recent_count: i64,
    previous_count: i64,
    status: String,
    last_observed_at: DateTime<Utc>,
    issue_repo: Option<String>,
    issue_number: Option<i64>,
    issue_url: Option<String>,
    issue_state: Option<String>,
}

impl FeatureRow {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "bounded retained evidence counts are intentionally rounded to a display percentage"
    )]
    fn into_summary(self) -> FeatureSummary {
        let trend = (self.previous_count > 0).then(|| {
            (((self.recent_count - self.previous_count) as f64 / self.previous_count as f64)
                * 100.0)
                .round() as i64
        });
        let github_issue = match (
            self.issue_repo,
            self.issue_number,
            self.issue_url,
            self.issue_state,
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
        FeatureSummary {
            title: title_case_key(&self.key),
            key: self.key,
            group_key: self.group_key,
            summary: self.summary,
            signal_types: self.signal_types,
            affected_customer_count: self.affected_customer_count,
            evidence_count: self.evidence_count,
            strongest_impact: self.strongest_impact,
            trend,
            status: self.status,
            last_observed_at: self.last_observed_at,
            github_issue,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct FeatureCursor {
    last_observed_at: DateTime<Utc>,
    key: String,
}

fn title_case_key(key: &str) -> String {
    key.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_values(
    values: Option<&[String]>,
    allowed: &[&str],
    field: &str,
) -> Result<(), ApiError> {
    if values.is_some_and(|values| {
        values.is_empty()
            || values.len() > 20
            || values
                .iter()
                .any(|value| !allowed.contains(&value.as_str()))
    }) {
        return Err(ApiError::bad_request(format!("Invalid {field} filter")));
    }
    Ok(())
}

fn validate_filters(filters: &DashboardFeatureFilters) -> Result<(), ApiError> {
    validate_values(
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
    validate_values(
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
    validate_values(
        filters.statuses.as_deref(),
        &["new", "investigating", "planned", "resolved", "wont_act"],
        "status",
    )?;
    if filters
        .segments
        .as_ref()
        .is_some_and(|segments| segments.is_empty() || segments.len() > 20)
    {
        return Err(ApiError::bad_request("Invalid segment filter"));
    }
    if filters
        .query
        .as_ref()
        .is_some_and(|query| query.trim().is_empty() || query.len() > 200)
    {
        return Err(ApiError::bad_request("Invalid query filter"));
    }
    if filters
        .since
        .zip(filters.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(ApiError::bad_request("since must not be after until"));
    }
    Ok(())
}

fn encode_cursor(feature: &FeatureSummary) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(&FeatureCursor {
        last_observed_at: feature.last_observed_at,
        key: feature.key.clone(),
    })
    .map_err(ApiError::internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_cursor(value: Option<&str>) -> Result<Option<FeatureCursor>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    if value.len() > 500 {
        return Err(ApiError::bad_request("Invalid feature cursor"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::bad_request("Invalid feature cursor"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ApiError::bad_request("Invalid feature cursor"))
}

async fn retained_since(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
) -> Result<DateTime<Utc>, ApiError> {
    let days = sqlx::query_scalar::<_, i32>(
        r"SELECT retention_days FROM product_environments
        WHERE workspace_id = $1 AND product_id = $2
        ORDER BY created_at, id LIMIT 1",
    )
    .bind(workspace_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Product not found in team"))?;
    Ok(Utc::now() - Duration::days(days.into()))
}

async fn feature_rows(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: &DashboardFeatureFilters,
    retained_since: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<FeatureRow>, ApiError> {
    let since = filters.since.unwrap_or(retained_since).max(retained_since);
    let cursor = decode_cursor(filters.cursor.as_deref())?;
    let search = filters.query.as_deref().map(str::trim).map(|value| {
        format!(
            "%{}%",
            value
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });
    sqlx::query_as::<_, FeatureRow>(
        r"WITH evidence AS (
          SELECT signal.feature_key, signal.signal_type, signal.summary,
            signal.customer_id, signal.collected_at,
            COALESCE(signal.attributes ->> 'impact', 'unknown') AS impact,
            COALESCE(workflow.status, 'new') AS workflow_status,
            signal.feedback_report_id
          FROM customer_signals signal
          LEFT JOIN feedback_report_workflow workflow
            ON workflow.report_id = signal.feedback_report_id
            AND workflow.workspace_id = signal.workspace_id
          WHERE signal.workspace_id = $1 AND signal.product_id = $2
            AND signal.feature_key IS NOT NULL
            AND signal.collected_at >= $3
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
            AND ($4::TIMESTAMPTZ IS NULL OR signal.collected_at <= $4)
            AND ($5::TEXT[] IS NULL OR signal.signal_type = ANY($5))
            AND ($6::TEXT[] IS NULL OR COALESCE(signal.attributes ->> 'impact', 'unknown') = ANY($6))
            AND ($7::TEXT[] IS NULL OR COALESCE(workflow.status, 'new') = ANY($7))
            AND ($8::TEXT[] IS NULL OR EXISTS (
              SELECT 1 FROM customers customer
              WHERE customer.id = signal.customer_id AND customer.workspace_id = signal.workspace_id
                AND customer.segments && $8
            ))
        ), features AS (
          SELECT evidence.feature_key AS key,
            (ARRAY_AGG(evidence.summary ORDER BY evidence.collected_at DESC))[1] AS summary,
            ARRAY_AGG(DISTINCT evidence.signal_type ORDER BY evidence.signal_type) AS signal_types,
            COUNT(DISTINCT evidence.customer_id)::BIGINT AS affected_customer_count,
            COUNT(*)::BIGINT AS evidence_count,
            (ARRAY_AGG(evidence.impact ORDER BY CASE evidence.impact
              WHEN 'blocked' THEN 5 WHEN 'hindered' THEN 4
              WHEN 'helped_with_friction' THEN 3 WHEN 'neutral' THEN 2
              WHEN 'unknown' THEN 1 WHEN 'helped' THEN 0 ELSE -1 END DESC,
              evidence.collected_at DESC))[1] AS strongest_impact,
            COUNT(*) FILTER (WHERE evidence.collected_at >= NOW() - INTERVAL '7 days')::BIGINT AS recent_count,
            COUNT(*) FILTER (WHERE evidence.collected_at >= NOW() - INTERVAL '14 days'
              AND evidence.collected_at < NOW() - INTERVAL '7 days')::BIGINT AS previous_count,
            (ARRAY_AGG(evidence.workflow_status ORDER BY evidence.collected_at DESC))[1] AS status,
            MAX(evidence.collected_at) AS last_observed_at
          FROM evidence GROUP BY evidence.feature_key
        )
        SELECT features.*, issue.group_key,
          issue.repo_full_name AS issue_repo, issue.issue_number,
          issue.url AS issue_url, issue.state AS issue_state
        FROM features
        LEFT JOIN LATERAL (
          SELECT report_group.group_key, linked.repo_full_name, linked.issue_number,
            linked.url, linked.state
          FROM customer_signals signal
          JOIN feedback_reports report ON report.id = signal.feedback_report_id
            AND report.workspace_id = signal.workspace_id
          JOIN report_groups report_group ON report_group.id = report.group_id
            AND report_group.workspace_id = report.workspace_id
          LEFT JOIN group_github_issues linked ON linked.group_key = report_group.group_key
            AND linked.workspace_id = report_group.workspace_id
          WHERE signal.workspace_id = $1 AND signal.product_id = $2
            AND signal.feature_key = features.key
            AND signal.collected_at >= $3
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          ORDER BY (linked.issue_number IS NOT NULL) DESC, signal.collected_at DESC,
            report_group.group_key LIMIT 1
        ) issue ON TRUE
        WHERE ($9::TEXT IS NULL OR features.key ILIKE $9 ESCAPE '\'
          OR features.summary ILIKE $9 ESCAPE '\')
          AND ($10::TIMESTAMPTZ IS NULL OR
            (features.last_observed_at, features.key) < ($10, $11))
        ORDER BY features.last_observed_at DESC, features.key DESC LIMIT $12",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(since)
    .bind(filters.until)
    .bind(&filters.signal_types)
    .bind(&filters.impacts)
    .bind(&filters.statuses)
    .bind(&filters.segments)
    .bind(search)
    .bind(cursor.as_ref().map(|cursor| cursor.last_observed_at))
    .bind(cursor.as_ref().map(|cursor| cursor.key.as_str()))
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub(crate) async fn dashboard_features_page(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    filters: DashboardFeatureFilters,
) -> Result<DashboardFeaturesPage, ApiError> {
    validate_filters(&filters)?;
    let retained_since = retained_since(pool, workspace_id, product_id).await?;
    let limit = filters.limit.unwrap_or(50).clamp(1, 100);
    let mut features = feature_rows(
        pool,
        workspace_id,
        product_id,
        &filters,
        retained_since,
        limit + 1,
    )
    .await?
    .into_iter()
    .map(FeatureRow::into_summary)
    .collect::<Vec<_>>();
    let next_cursor = if features.len() > usize::try_from(limit).map_err(ApiError::internal)? {
        features
            .get(usize::try_from(limit - 1).map_err(ApiError::internal)?)
            .map(encode_cursor)
            .transpose()?
    } else {
        None
    };
    features.truncate(usize::try_from(limit).map_err(ApiError::internal)?);

    let (feature_count, affected_customers, evidence, blocking) =
        sqlx::query_as::<_, (i64, i64, i64, i64)>(
            r"SELECT COUNT(DISTINCT feature_key), COUNT(DISTINCT customer_id), COUNT(*),
              COUNT(DISTINCT feature_key) FILTER (WHERE attributes ->> 'impact' = 'blocked')
            FROM customer_signals WHERE workspace_id = $1 AND product_id = $2
              AND feature_key IS NOT NULL AND collected_at >= $3
              AND (expires_at IS NULL OR expires_at > NOW())",
        )
        .bind(workspace_id)
        .bind(product_id)
        .bind(retained_since)
        .fetch_one(pool)
        .await?;
    let facet_rows = sqlx::query_as::<_, (String, String, i64)>(
        r"WITH values AS (
          SELECT 'signal_type'::TEXT facet, signal_type value, feature_key evidence_key
          FROM customer_signals WHERE workspace_id = $1 AND product_id = $2
            AND feature_key IS NOT NULL AND collected_at >= $3
            AND (expires_at IS NULL OR expires_at > NOW())
          UNION ALL SELECT 'impact', COALESCE(attributes ->> 'impact', 'unknown'), feature_key
          FROM customer_signals WHERE workspace_id = $1 AND product_id = $2
            AND feature_key IS NOT NULL AND collected_at >= $3
            AND (expires_at IS NULL OR expires_at > NOW())
          UNION ALL SELECT 'status', COALESCE(workflow.status, 'new'), signal.feature_key
          FROM customer_signals signal LEFT JOIN feedback_report_workflow workflow
            ON workflow.report_id = signal.feedback_report_id AND workflow.workspace_id = signal.workspace_id
          WHERE signal.workspace_id = $1 AND signal.product_id = $2
            AND signal.feature_key IS NOT NULL AND signal.collected_at >= $3
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          UNION ALL SELECT 'segment', segment, signal.feature_key
          FROM customer_signals signal JOIN customers customer
            ON customer.id = signal.customer_id AND customer.workspace_id = signal.workspace_id
          CROSS JOIN LATERAL UNNEST(customer.segments) segment
          WHERE signal.workspace_id = $1 AND signal.product_id = $2
            AND signal.feature_key IS NOT NULL AND signal.collected_at >= $3
            AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
        ) SELECT facet, value, COUNT(DISTINCT evidence_key)::BIGINT
          FROM values GROUP BY facet, value ORDER BY facet, COUNT(DISTINCT evidence_key) DESC, value",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(retained_since)
    .fetch_all(pool)
    .await?;
    let mut facets = FeatureFacets::default();
    for (facet, name, count) in facet_rows {
        let item = InsightCount { name, count };
        match facet.as_str() {
            "signal_type" => facets.signal_type.push(item),
            "impact" => facets.impact.push(item),
            "status" => facets.status.push(item),
            "segment" => facets.segment.push(item),
            _ => {}
        }
    }
    Ok(DashboardFeaturesPage {
        features,
        rollup: FeatureRollup {
            features: feature_count,
            affected_customers,
            evidence,
            blocking,
        },
        facets,
        limit,
        next_cursor,
    })
}

pub(crate) async fn dashboard_feature_by_key(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    feature_key: &str,
) -> Result<DashboardFeatureDetail, ApiError> {
    if feature_key.is_empty()
        || feature_key.len() > 64
        || !feature_key.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
        })
    {
        return Err(ApiError::bad_request("Invalid feature key"));
    }
    let retained_since = retained_since(pool, workspace_id, product_id).await?;
    let feature = feature_rows(
        pool,
        workspace_id,
        product_id,
        &DashboardFeatureFilters {
            query: Some(feature_key.to_owned()),
            ..DashboardFeatureFilters::default()
        },
        retained_since,
        100,
    )
    .await?
    .into_iter()
    .find(|row| row.key == feature_key)
    .map(FeatureRow::into_summary)
    .ok_or_else(|| ApiError::not_found("Feature not found for product"))?;
    let signals = dashboard_signals_page(
        pool,
        workspace_id,
        product_id,
        DashboardSignalFilters {
            feature_key: Some(feature_key.to_owned()),
            limit: Some(100),
            ..DashboardSignalFilters::default()
        },
    )
    .await?
    .signals;
    let mut customers = Vec::new();
    let customer_ids = signals
        .iter()
        .filter_map(|signal| signal.customer_id)
        .collect::<std::collections::BTreeSet<_>>();
    for customer_id in customer_ids.into_iter().take(50) {
        customers.push(
            dashboard_customer_by_id(pool, workspace_id, product_id, customer_id)
                .await?
                .customer,
        );
    }
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
          WHERE interaction.session_id = session.id AND EXISTS (
            SELECT 1 FROM customer_signals signal
            WHERE signal.interaction_id = interaction.id AND signal.workspace_id = $1
              AND signal.product_id = $2 AND signal.feature_key = $3
              AND signal.collected_at >= $4
              AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
          )) activity
        WHERE session.workspace_id = $1 AND session.environment_id IN (
          SELECT id FROM product_environments WHERE workspace_id = $1 AND product_id = $2)
          AND activity.interaction_count > 0
        ORDER BY session.last_seen_at DESC, session.id DESC LIMIT 50",
    )
    .bind(workspace_id)
    .bind(product_id)
    .bind(feature_key)
    .bind(retained_since)
    .fetch_all(pool)
    .await?;
    Ok(DashboardFeatureDetail {
        feature,
        signals,
        customers,
        sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{PgPool, postgres::PgPoolOptions};

    async fn insert_scope(pool: &PgPool, label: &str) -> anyhow::Result<(Uuid, Uuid, Uuid)> {
        let workspace_id = Uuid::new_v4();
        let product_id = Uuid::new_v4();
        let environment_id = Uuid::new_v4();
        let suffix = workspace_id.simple().to_string();
        sqlx::query(
            r"INSERT INTO workspaces (id, os_user_id, name, slug, retention_days)
            VALUES ($1, $2, $3, $4, 30)",
        )
        .bind(workspace_id)
        .bind(format!("usr_feature_{suffix}"))
        .bind(format!("{label} team"))
        .bind(format!("feature-{suffix}"))
        .execute(pool)
        .await?;
        sqlx::query(
            r"INSERT INTO products (id, workspace_id, name, slug)
            VALUES ($1, $2, $3, $4)",
        )
        .bind(product_id)
        .bind(workspace_id)
        .bind(format!("{label} product"))
        .bind(format!("product-{suffix}"))
        .execute(pool)
        .await?;
        sqlx::query(
            r"INSERT INTO product_environments
              (id, workspace_id, product_id, name, slug, retention_days)
            VALUES ($1, $2, $3, 'Production', 'production', 30)",
        )
        .bind(environment_id)
        .bind(workspace_id)
        .bind(product_id)
        .execute(pool)
        .await?;
        Ok((workspace_id, product_id, environment_id))
    }

    async fn insert_customer(
        pool: &PgPool,
        workspace_id: Uuid,
        product_id: Uuid,
        display_name: &str,
        segments: &[&str],
        observed_at: DateTime<Utc>,
    ) -> anyhow::Result<Uuid> {
        let customer_id = Uuid::new_v4();
        let identifier_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO customers
              (id, workspace_id, kind, identity_level, identity_confidence,
               display_name, segments, first_seen_at, last_seen_at)
            VALUES ($1, $2, 'user', 'verified', 1, $3, $4, $5, $5)",
        )
        .bind(customer_id)
        .bind(workspace_id)
        .bind(display_name)
        .bind(segments)
        .bind(observed_at)
        .execute(pool)
        .await?;
        sqlx::query(
            r"INSERT INTO customer_identifiers
              (id, workspace_id, product_id, customer_id, kind, ref_hash,
               display_hint, identity_level, provenance, verified_at)
            VALUES ($1, $2, $3, $4, 'user_ref', $5, $6,
                    'verified', 'company_authenticated', $7)",
        )
        .bind(identifier_id)
        .bind(workspace_id)
        .bind(product_id)
        .bind(customer_id)
        .bind(Vec::from(*Uuid::new_v4().as_bytes()).repeat(2))
        .bind(display_name)
        .bind(observed_at)
        .execute(pool)
        .await?;
        Ok(customer_id)
    }

    async fn insert_session_interaction(
        pool: &PgPool,
        workspace_id: Uuid,
        environment_id: Uuid,
        customer_id: Option<Uuid>,
        operation: &str,
        occurred_at: DateTime<Utc>,
    ) -> anyhow::Result<(Uuid, Uuid)> {
        let session_id = Uuid::new_v4();
        let interaction_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO sessions_v2
              (id, workspace_id, environment_id, source, ref_hash, ref_hint,
               started_at, last_seen_at)
            VALUES ($1, $2, $3, 'mcp', $4, $5, $6, $6)",
        )
        .bind(session_id)
        .bind(workspace_id)
        .bind(environment_id)
        .bind(Uuid::new_v4().as_bytes().as_slice())
        .bind(operation)
        .bind(occurred_at)
        .execute(pool)
        .await?;
        sqlx::query(
            r"INSERT INTO interactions_v2
              (id, workspace_id, environment_id, session_id, customer_id,
               surface, operation, status_code, classification,
               confirmation_method, occurred_at)
            VALUES ($1, $2, $3, $4, $5, 'mcp', $6, 200,
                    'confirmed', 'mcp', $7)",
        )
        .bind(interaction_id)
        .bind(workspace_id)
        .bind(environment_id)
        .bind(session_id)
        .bind(customer_id)
        .bind(operation)
        .bind(occurred_at)
        .execute(pool)
        .await?;
        Ok((session_id, interaction_id))
    }

    struct SignalSeed<'a> {
        workspace_id: Uuid,
        product_id: Uuid,
        customer_id: Option<Uuid>,
        session_id: Option<Uuid>,
        interaction_id: Uuid,
        feedback_report_id: Option<Uuid>,
        feature_key: &'a str,
        signal_type: &'a str,
        summary: &'a str,
        impact: &'a str,
        collected_at: DateTime<Utc>,
        expires_at: Option<DateTime<Utc>>,
    }

    async fn insert_signal(pool: &PgPool, seed: SignalSeed<'_>) -> anyhow::Result<Uuid> {
        let signal_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO customer_signals
              (id, workspace_id, product_id, customer_id, session_id,
               interaction_id, feedback_report_id, feature_key, source_item_key,
               signal_type, summary, attributes, provenance, confidence,
               collection_basis, collected_at, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                    jsonb_build_object('impact', $12::TEXT),
                    'agent_reports_current_task', 0.9,
                    'provider_feedback_policy', $13, $14)",
        )
        .bind(signal_id)
        .bind(seed.workspace_id)
        .bind(seed.product_id)
        .bind(seed.customer_id)
        .bind(seed.session_id)
        .bind(seed.interaction_id)
        .bind(seed.feedback_report_id)
        .bind(seed.feature_key)
        .bind(format!("feature-test-{signal_id}"))
        .bind(seed.signal_type)
        .bind(seed.summary)
        .bind(seed.impact)
        .bind(seed.collected_at)
        .bind(seed.expires_at)
        .execute(pool)
        .await?;
        Ok(signal_id)
    }

    async fn insert_report(
        pool: &PgPool,
        workspace_id: Uuid,
        interaction_id: Uuid,
        summary: &str,
        impact: &str,
    ) -> anyhow::Result<Uuid> {
        let report_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO feedback_reports
              (id, workspace_id, interaction_id, summary, impact, confidence)
            VALUES ($1, $2, $3, $4, $5, 0.95)",
        )
        .bind(report_id)
        .bind(workspace_id)
        .bind(interaction_id)
        .bind(summary)
        .bind(impact)
        .execute(pool)
        .await?;
        Ok(report_id)
    }

    #[test]
    fn feature_keys_become_readable_titles() {
        assert_eq!(title_case_key("batch_export-limit"), "Batch Export Limit");
    }

    #[test]
    fn feature_cursor_rejects_malformed_input() {
        assert!(decode_cursor(Some("not base64")).is_err());
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn feature_projection_is_filtered_linked_paginated_and_tenant_safe() -> anyhow::Result<()>
    {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        let (workspace_id, product_id, environment_id) = insert_scope(&pool, "Primary").await?;
        let second_product_id = Uuid::new_v4();
        let second_environment_id = Uuid::new_v4();
        sqlx::query(
            r"INSERT INTO products (id, workspace_id, name, slug)
            VALUES ($1, $2, 'Second product', $3)",
        )
        .bind(second_product_id)
        .bind(workspace_id)
        .bind(format!("second-{}", second_product_id.simple()))
        .execute(&pool)
        .await?;
        sqlx::query(
            r"INSERT INTO product_environments
              (id, workspace_id, product_id, name, slug, retention_days)
            VALUES ($1, $2, $3, 'Production', 'production', 30)",
        )
        .bind(second_environment_id)
        .bind(workspace_id)
        .bind(second_product_id)
        .execute(&pool)
        .await?;
        let (other_workspace_id, other_product_id, other_environment_id) =
            insert_scope(&pool, "Other tenant").await?;

        let result = async {
            let now = Utc::now();
            let enterprise_customer = insert_customer(
                &pool,
                workspace_id,
                product_id,
                "Enterprise user",
                &["enterprise", "design-partner"],
                now,
            )
            .await?;
            let small_customer =
                insert_customer(&pool, workspace_id, product_id, "Small user", &["smb"], now)
                    .await?;
            let (enterprise_session, enterprise_interaction) = insert_session_interaction(
                &pool,
                workspace_id,
                environment_id,
                Some(enterprise_customer),
                "search",
                now - Duration::minutes(1),
            )
            .await?;
            let (small_session, small_interaction) = insert_session_interaction(
                &pool,
                workspace_id,
                environment_id,
                Some(small_customer),
                "search",
                now - Duration::minutes(2),
            )
            .await?;
            let (bulk_session, bulk_interaction) = insert_session_interaction(
                &pool,
                workspace_id,
                environment_id,
                Some(enterprise_customer),
                "export",
                now - Duration::minutes(3),
            )
            .await?;

            let report_id = insert_report(
                &pool,
                workspace_id,
                enterprise_interaction,
                "Fresh results are required for this workflow.",
                "blocked",
            )
            .await?;
            sqlx::query(
                r"INSERT INTO feedback_report_workflow
                  (report_id, workspace_id, status)
                VALUES ($1, $2, 'planned')",
            )
            .bind(report_id)
            .bind(workspace_id)
            .execute(&pool)
            .await?;
            let group_id = Uuid::new_v4();
            let group_key = format!("group-{}", group_id.simple());
            sqlx::query(
                r"INSERT INTO report_groups
                  (id, workspace_id, product_id, group_key, grouper_name,
                   grouper_version, explanation)
                VALUES ($1, $2, $3, $4, 'test', 1, 'Freshness evidence')",
            )
            .bind(group_id)
            .bind(workspace_id)
            .bind(product_id)
            .bind(&group_key)
            .execute(&pool)
            .await?;
            sqlx::query("UPDATE feedback_reports SET group_id = $1 WHERE id = $2")
                .bind(group_id)
                .bind(report_id)
                .execute(&pool)
                .await?;
            sqlx::query(
                r"INSERT INTO group_github_issues
                  (group_key, workspace_id, installation_id, repo_full_name,
                   issue_number, url, state, filing_state, created_by)
                VALUES ($1, $2, 42, 'epode/example', 17,
                        'https://github.com/epode/example/issues/17', 'open',
                        'filed', 'feature-test')",
            )
            .bind(&group_key)
            .bind(workspace_id)
            .execute(&pool)
            .await?;

            let freshness_signal = insert_signal(
                &pool,
                SignalSeed {
                    workspace_id,
                    product_id,
                    customer_id: Some(enterprise_customer),
                    session_id: Some(enterprise_session),
                    interaction_id: enterprise_interaction,
                    feedback_report_id: Some(report_id),
                    feature_key: "freshness_gap",
                    signal_type: "feature_need",
                    summary: "Fresh results are required",
                    impact: "blocked",
                    collected_at: now - Duration::minutes(1),
                    expires_at: None,
                },
            )
            .await?;
            let friction_signal = insert_signal(
                &pool,
                SignalSeed {
                    workspace_id,
                    product_id,
                    customer_id: Some(small_customer),
                    session_id: Some(small_session),
                    interaction_id: small_interaction,
                    feedback_report_id: None,
                    feature_key: "freshness_gap",
                    signal_type: "friction",
                    summary: "Cached results slowed the task",
                    impact: "hindered",
                    collected_at: now - Duration::minutes(2),
                    expires_at: None,
                },
            )
            .await?;
            insert_signal(
                &pool,
                SignalSeed {
                    workspace_id,
                    product_id,
                    customer_id: Some(enterprise_customer),
                    session_id: Some(bulk_session),
                    interaction_id: bulk_interaction,
                    feedback_report_id: None,
                    feature_key: "bulk_export",
                    signal_type: "feature_need",
                    summary: "Export all results in one request",
                    impact: "helped",
                    collected_at: now - Duration::minutes(1),
                    expires_at: None,
                },
            )
            .await?;

            let (expired_session, expired_interaction) = insert_session_interaction(
                &pool,
                workspace_id,
                environment_id,
                Some(enterprise_customer),
                "expired",
                now - Duration::days(2),
            )
            .await?;
            let expired_report = insert_report(
                &pool,
                workspace_id,
                expired_interaction,
                "Expired evidence must not remain visible.",
                "blocked",
            )
            .await?;
            let expired_group_id = Uuid::new_v4();
            let expired_group_key = format!("group-{}", expired_group_id.simple());
            sqlx::query(
                r"INSERT INTO report_groups
                  (id, workspace_id, product_id, group_key, grouper_name,
                   grouper_version, explanation)
                VALUES ($1, $2, $3, $4, 'test', 1, 'Expired evidence')",
            )
            .bind(expired_group_id)
            .bind(workspace_id)
            .bind(product_id)
            .bind(&expired_group_key)
            .execute(&pool)
            .await?;
            sqlx::query("UPDATE feedback_reports SET group_id = $1 WHERE id = $2")
                .bind(expired_group_id)
                .bind(expired_report)
                .execute(&pool)
                .await?;
            sqlx::query(
                r"INSERT INTO group_github_issues
                  (group_key, workspace_id, installation_id, repo_full_name,
                   issue_number, url, state, filing_state, created_by)
                VALUES ($1, $2, 43, 'epode/example', 18,
                        'https://github.com/epode/example/issues/18', 'open',
                        'filed', 'feature-test')",
            )
            .bind(&expired_group_key)
            .bind(workspace_id)
            .execute(&pool)
            .await?;
            insert_signal(
                &pool,
                SignalSeed {
                    workspace_id,
                    product_id,
                    customer_id: Some(enterprise_customer),
                    session_id: Some(expired_session),
                    interaction_id: expired_interaction,
                    feedback_report_id: Some(expired_report),
                    feature_key: "expired_feature",
                    signal_type: "feature_need",
                    summary: "This evidence has expired",
                    impact: "blocked",
                    collected_at: now - Duration::days(2),
                    expires_at: Some(now - Duration::days(1)),
                },
            )
            .await?;

            let (_, old_interaction) = insert_session_interaction(
                &pool,
                workspace_id,
                environment_id,
                None,
                "old",
                now - Duration::days(40),
            )
            .await?;
            insert_signal(
                &pool,
                SignalSeed {
                    workspace_id,
                    product_id,
                    customer_id: None,
                    session_id: None,
                    interaction_id: old_interaction,
                    feedback_report_id: None,
                    feature_key: "outside_retention",
                    signal_type: "feature_need",
                    summary: "Outside retention",
                    impact: "blocked",
                    collected_at: now - Duration::days(40),
                    expires_at: None,
                },
            )
            .await?;

            for (scope_workspace, scope_product, scope_environment, summary) in [
                (
                    workspace_id,
                    second_product_id,
                    second_environment_id,
                    "Same-team product evidence",
                ),
                (
                    other_workspace_id,
                    other_product_id,
                    other_environment_id,
                    "Other-team evidence",
                ),
            ] {
                let (_, interaction_id) = insert_session_interaction(
                    &pool,
                    scope_workspace,
                    scope_environment,
                    None,
                    "isolated",
                    now,
                )
                .await?;
                insert_signal(
                    &pool,
                    SignalSeed {
                        workspace_id: scope_workspace,
                        product_id: scope_product,
                        customer_id: None,
                        session_id: None,
                        interaction_id,
                        feedback_report_id: None,
                        feature_key: "freshness_gap",
                        signal_type: "feature_need",
                        summary,
                        impact: "blocked",
                        collected_at: now,
                        expires_at: None,
                    },
                )
                .await?;
            }

            let page = dashboard_features_page(
                &pool,
                workspace_id,
                product_id,
                DashboardFeatureFilters::default(),
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(
                page.features
                    .iter()
                    .map(|feature| feature.key.as_str())
                    .collect::<Vec<_>>()
                    == ["freshness_gap", "bulk_export"]
            );
            anyhow::ensure!(page.rollup.features == 2);
            anyhow::ensure!(page.rollup.affected_customers == 2);
            anyhow::ensure!(page.rollup.evidence == 3);
            anyhow::ensure!(page.rollup.blocking == 1);
            anyhow::ensure!(
                page.facets
                    .impact
                    .iter()
                    .find(|facet| facet.name == "blocked")
                    .is_some_and(|facet| facet.count == 1)
            );
            let freshness = &page.features[0];
            anyhow::ensure!(freshness.evidence_count == 2);
            anyhow::ensure!(freshness.affected_customer_count == 2);
            anyhow::ensure!(freshness.strongest_impact == "blocked");
            anyhow::ensure!(freshness.status == "planned");
            anyhow::ensure!(freshness.group_key.as_deref() == Some(group_key.as_str()));
            anyhow::ensure!(
                freshness
                    .github_issue
                    .as_ref()
                    .is_some_and(|issue| issue.issue_number == 17)
            );

            let planned = dashboard_features_page(
                &pool,
                workspace_id,
                product_id,
                DashboardFeatureFilters {
                    query: Some("Fresh results".into()),
                    signal_types: Some(vec!["feature_need".into()]),
                    impacts: Some(vec!["blocked".into()]),
                    statuses: Some(vec!["planned".into()]),
                    segments: Some(vec!["enterprise".into()]),
                    since: Some(now - Duration::hours(1)),
                    until: Some(now),
                    ..DashboardFeatureFilters::default()
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(planned.features.len() == 1);
            anyhow::ensure!(planned.features[0].key == "freshness_gap");
            anyhow::ensure!(planned.features[0].evidence_count == 1);

            let first = dashboard_features_page(
                &pool,
                workspace_id,
                product_id,
                DashboardFeatureFilters {
                    limit: Some(1),
                    ..DashboardFeatureFilters::default()
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(first.features.len() == 1);
            anyhow::ensure!(first.features[0].key == "freshness_gap");
            let cursor = first
                .next_cursor
                .ok_or_else(|| anyhow::anyhow!("missing feature cursor"))?;
            let second = dashboard_features_page(
                &pool,
                workspace_id,
                product_id,
                DashboardFeatureFilters {
                    limit: Some(1),
                    cursor: Some(cursor),
                    ..DashboardFeatureFilters::default()
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(second.features.len() == 1);
            anyhow::ensure!(second.features[0].key == "bulk_export");
            anyhow::ensure!(second.next_cursor.is_none());

            let detail = dashboard_feature_by_key(&pool, workspace_id, product_id, "freshness_gap")
                .await
                .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(detail.signals.len() == 2);
            anyhow::ensure!(
                detail
                    .signals
                    .iter()
                    .map(|signal| signal.id)
                    .collect::<std::collections::BTreeSet<_>>()
                    == [freshness_signal, friction_signal].into_iter().collect()
            );
            anyhow::ensure!(
                detail
                    .customers
                    .iter()
                    .map(|customer| customer.id)
                    .collect::<std::collections::BTreeSet<_>>()
                    == [enterprise_customer, small_customer].into_iter().collect()
            );
            anyhow::ensure!(
                detail
                    .sessions
                    .iter()
                    .map(|session| session.id)
                    .collect::<std::collections::BTreeSet<_>>()
                    == [enterprise_session, small_session].into_iter().collect()
            );
            anyhow::ensure!(
                detail
                    .signals
                    .iter()
                    .find(|signal| signal.id == freshness_signal)
                    .and_then(|signal| signal.feedback_report_id)
                    == Some(report_id)
            );

            anyhow::ensure!(
                dashboard_feature_by_key(&pool, workspace_id, product_id, "expired_feature",)
                    .await
                    .is_err()
            );
            let second_product =
                dashboard_feature_by_key(&pool, workspace_id, second_product_id, "freshness_gap")
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(second_product.feature.summary == "Same-team product evidence");
            let other_tenant = dashboard_feature_by_key(
                &pool,
                other_workspace_id,
                other_product_id,
                "freshness_gap",
            )
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
            anyhow::ensure!(other_tenant.feature.summary == "Other-team evidence");
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
            .bind([workspace_id, other_workspace_id])
            .execute(&pool)
            .await?;
        result
    }
}
