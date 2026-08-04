#![allow(
    clippy::print_stdout,
    reason = "this database setup CLI communicates its results through standard output"
)]

use std::{env, time::Duration};

use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct StoredRow {
    id: Uuid,
    surface: String,
    operation: String,
    classification: String,
    confirmation_method: Option<String>,
    customer_ref: Option<String>,
    customer_id: Option<Uuid>,
    identity_level: Option<String>,
    summary: String,
    impact: Option<String>,
    findings: serde_json::Value,
    workaround: Option<serde_json::Value>,
}

#[derive(sqlx::FromRow)]
struct ObservationRow {
    id: Uuid,
    surface: String,
    operation: String,
    status_code: Option<i32>,
    customer_ref: Option<String>,
    customer_id: Option<Uuid>,
    identity_level: Option<String>,
    classification: String,
    confirmation_method: Option<String>,
    session_id: Option<Uuid>,
    session_source: Option<String>,
    session_hint: Option<String>,
    summary: Option<String>,
}

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).map_err(|_| anyhow::anyhow!("{name} is required"))
}

fn uuid(name: &str) -> anyhow::Result<Uuid> {
    Ok(Uuid::parse_str(&required(name)?)?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let action = env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("seed, read, or delete is required"))?;
    let pool: PgPool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&required("DATABASE_URL")?)
        .await?;
    if action == "delete-all-tests" {
        let deleted =
            sqlx::query("DELETE FROM workspaces WHERE os_user_id LIKE 'usr_setup_matrix_%'")
                .execute(&pool)
                .await?
                .rows_affected();
        println!("deleted {deleted}");
        return Ok(());
    }
    let workspace_id = uuid("SETUP_MATRIX_WORKSPACE_ID")?;
    match action.as_str() {
        "seed" => {
            let product_id = uuid("SETUP_MATRIX_PRODUCT_ID")?;
            let environment_id = uuid("SETUP_MATRIX_ENVIRONMENT_ID")?;
            let key_id = uuid("SETUP_MATRIX_KEY_ID")?;
            let api_key = required("SETUP_MATRIX_API_KEY")?;
            let key_hash = Sha256::digest(api_key.as_bytes()).to_vec();
            let prefix: String = api_key.chars().take(16).collect();
            let mut tx = pool.begin().await?;
            sqlx::query(
                "INSERT INTO workspaces (id, os_user_id, name, slug) VALUES ($1, $2, $3, $4)",
            )
            .bind(workspace_id)
            .bind(format!("usr_setup_matrix_{}", workspace_id.simple()))
            .bind("Setup matrix")
            .bind(format!(
                "setup-matrix-{}",
                &workspace_id.simple().to_string()[..8]
            ))
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO products (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)",
            )
            .bind(product_id)
            .bind(workspace_id)
            .bind("Setup matrix product")
            .bind("setup-matrix-product")
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO product_environments (id, workspace_id, product_id, name, slug) VALUES ($1, $2, $3, $4, $5)")
                .bind(environment_id).bind(workspace_id).bind(product_id).bind("Default").bind("default")
                .execute(&mut *tx).await?;
            sqlx::query("INSERT INTO api_keys (id, workspace_id, environment_id, label, prefix, key_hash) VALUES ($1, $2, $3, $4, $5, $6)")
                .bind(key_id).bind(workspace_id).bind(environment_id).bind("Setup matrix key").bind(prefix).bind(key_hash)
                .execute(&mut *tx).await?;
            tx.commit().await?;
            println!("seeded");
        }
        "read" => {
            let rows = sqlx::query_as::<_, StoredRow>(
                r"SELECT i.id, i.surface, i.operation, i.classification, i.confirmation_method,
                i.customer_ref, i.customer_id, customer.identity_level,
                r.summary, r.impact, r.findings, r.workaround
                FROM interactions_v2 i JOIN feedback_reports r ON r.interaction_id = i.id
                LEFT JOIN customers customer
                  ON customer.id = i.customer_id AND customer.workspace_id = i.workspace_id
                WHERE i.workspace_id = $1 ORDER BY r.summary",
            )
            .bind(workspace_id)
            .fetch_all(&pool)
            .await?;
            let output: Vec<_> = rows.into_iter().map(|row| json!({
                "id": row.id, "surface": row.surface, "operation": row.operation,
                "classification": row.classification, "confirmationMethod": row.confirmation_method,
                "customerRef": row.customer_ref, "customerId": row.customer_id,
                "identityLevel": row.identity_level,
                "summary": row.summary, "impact": row.impact,
                "findings": row.findings, "workaround": row.workaround,
            })).collect();
            println!("{}", serde_json::to_string(&output)?);
        }
        "read-observations" => {
            let rows = sqlx::query_as::<_, ObservationRow>(
                r"SELECT i.id, i.surface, i.operation, i.status_code, i.customer_ref,
                i.customer_id, customer.identity_level,
                i.classification, i.confirmation_method, i.session_id,
                s.source AS session_source, s.ref_hint AS session_hint, r.summary
                FROM interactions_v2 i
                LEFT JOIN sessions_v2 s ON s.id = i.session_id
                LEFT JOIN customers customer
                  ON customer.id = i.customer_id AND customer.workspace_id = i.workspace_id
                LEFT JOIN feedback_reports r ON r.interaction_id = i.id
                WHERE i.workspace_id = $1
                ORDER BY i.occurred_at, i.client_sequence NULLS LAST, i.id",
            )
            .bind(workspace_id)
            .fetch_all(&pool)
            .await?;
            let output: Vec<_> = rows
                .into_iter()
                .map(|row| {
                    json!({
                        "id": row.id,
                        "surface": row.surface,
                        "operation": row.operation,
                        "statusCode": row.status_code,
                        "customerRef": row.customer_ref,
                        "customerId": row.customer_id,
                        "identityLevel": row.identity_level,
                        "classification": row.classification,
                        "confirmationMethod": row.confirmation_method,
                        "sessionId": row.session_id,
                        "sessionSource": row.session_source,
                        "sessionHint": row.session_hint,
                        "summary": row.summary,
                    })
                })
                .collect();
            println!("{}", serde_json::to_string(&output)?);
        }
        "read-customer-intelligence" => {
            let product_id = uuid("SETUP_MATRIX_PRODUCT_ID")?;
            let output = sqlx::query_scalar::<_, serde_json::Value>(
                r"SELECT jsonb_build_object(
                  'customers', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', customer.id,
                      'kind', customer.kind,
                      'identityLevel', customer.identity_level,
                      'parentCustomerId', customer.parent_customer_id,
                      'mergedIntoCustomerId', customer.merged_into_customer_id
                    ) ORDER BY customer.created_at, customer.id)
                    FROM customers customer
                    WHERE customer.workspace_id = $1
                  ), '[]'::JSONB),
                  'identifiers', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'customerId', identifier.customer_id,
                      'kind', identifier.kind,
                      'identityLevel', identifier.identity_level,
                      'provenance', identifier.provenance
                    ) ORDER BY identifier.kind, identifier.created_at)
                    FROM customer_identifiers identifier
                    WHERE identifier.workspace_id = $1 AND identifier.product_id = $2
                  ), '[]'::JSONB),
                  'resolutions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'fromCustomerId', resolution.from_customer_id,
                      'toCustomerId', resolution.to_customer_id,
                      'method', resolution.method,
                      'provenance', resolution.provenance,
                      'confidence', resolution.confidence
                    ) ORDER BY resolution.created_at)
                    FROM customer_resolution_events resolution
                    WHERE resolution.workspace_id = $1 AND resolution.product_id = $2
                  ), '[]'::JSONB),
                  'interactions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', interaction.id,
                      'customerId', interaction.customer_id,
                      'sessionId', interaction.session_id,
                      'operation', interaction.operation,
                      'classification', interaction.classification
                    ) ORDER BY interaction.occurred_at, interaction.id)
                    FROM interactions_v2 interaction
                    WHERE interaction.workspace_id = $1 AND interaction.environment_id IN (
                      SELECT id FROM product_environments
                      WHERE workspace_id = $1 AND product_id = $2
                    )
                  ), '[]'::JSONB),
                  'signals', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', signal.id,
                      'customerId', signal.customer_id,
                      'sessionId', signal.session_id,
                      'interactionId', signal.interaction_id,
                      'feedbackReportId', signal.feedback_report_id,
                      'signalType', signal.signal_type,
                      'featureKey', signal.feature_key,
                      'provenance', signal.provenance,
                      'confidence', signal.confidence,
                      'collectionBasis', signal.collection_basis
                    ) ORDER BY signal.collected_at, signal.id)
                    FROM customer_signals signal
                    WHERE signal.workspace_id = $1 AND signal.product_id = $2
                      AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
                  ), '[]'::JSONB),
                  'features', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'featureKey', grouped.feature_key,
                      'signalCount', grouped.signal_count,
                      'customerCount', grouped.customer_count,
                      'sessionCount', grouped.session_count
                    ) ORDER BY grouped.feature_key)
                    FROM (
                      SELECT signal.feature_key, COUNT(*)::BIGINT AS signal_count,
                        COUNT(DISTINCT signal.customer_id)::BIGINT AS customer_count,
                        COUNT(DISTINCT signal.session_id)::BIGINT AS session_count
                      FROM customer_signals signal
                      WHERE signal.workspace_id = $1 AND signal.product_id = $2
                        AND signal.feature_key IS NOT NULL
                        AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
                      GROUP BY signal.feature_key
                    ) grouped
                  ), '[]'::JSONB),
                  'sessions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', session.id,
                      'interactionCount', session.interaction_count,
                      'customerCount', session.customer_count,
                      'signalCount', session.signal_count
                    ) ORDER BY session.id)
                    FROM (
                      SELECT session_row.id,
                        COUNT(DISTINCT interaction.id)::BIGINT AS interaction_count,
                        COUNT(DISTINCT interaction.customer_id)::BIGINT AS customer_count,
                        COUNT(DISTINCT signal.id)::BIGINT AS signal_count
                      FROM sessions_v2 session_row
                      LEFT JOIN interactions_v2 interaction
                        ON interaction.session_id = session_row.id
                        AND interaction.workspace_id = session_row.workspace_id
                      LEFT JOIN customer_signals signal
                        ON signal.interaction_id = interaction.id
                        AND signal.workspace_id = interaction.workspace_id
                        AND (signal.expires_at IS NULL OR signal.expires_at > NOW())
                      WHERE session_row.workspace_id = $1
                        AND session_row.environment_id IN (
                          SELECT id FROM product_environments
                          WHERE workspace_id = $1 AND product_id = $2
                        )
                      GROUP BY session_row.id
                    ) session
                  ), '[]'::JSONB)
                )",
            )
            .bind(workspace_id)
            .bind(product_id)
            .fetch_one(&pool)
            .await?;
            println!("{}", serde_json::to_string(&output)?);
        }
        "read-enrichment" => {
            let product_id = uuid("SETUP_MATRIX_PRODUCT_ID")?;
            let output = sqlx::query_scalar::<_, serde_json::Value>(
                r"SELECT jsonb_build_object(
                  'requests', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', request.id,
                      'interactionId', request.interaction_id,
                      'customerId', request.customer_id,
                      'purpose', request.purpose,
                      'remember', request.remember,
                      'identityLevel', request.identity_level,
                      'state', request.state
                    ) ORDER BY request.created_at, request.id)
                    FROM enrichment_requests request
                    WHERE request.workspace_id = $1 AND request.product_id = $2
                  ), '[]'::JSONB),
                  'requestObservations', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', observation.id,
                      'interactionId', observation.interaction_id,
                      'customerId', observation.customer_id,
                      'clientIp', observation.client_ip,
                      'method', observation.request_method,
                      'userAgent', observation.user_agent,
                      'acceptLanguage', observation.accept_language,
                      'referrerOrigin', observation.referrer_origin,
                      'secChUa', observation.sec_ch_ua,
                      'secChUaPlatform', observation.sec_ch_ua_platform,
                      'secChUaMobile', observation.sec_ch_ua_mobile
                    ) ORDER BY observation.observed_at, observation.id)
                    FROM customer_request_observations observation
                    WHERE observation.workspace_id = $1 AND observation.product_id = $2
                  ), '[]'::JSONB),
                  'interactions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', interaction.id,
                      'surface', interaction.surface,
                      'operation', interaction.operation,
                      'statusCode', interaction.status_code,
                      'durationMs', interaction.duration_ms,
                      'sessionId', interaction.session_id,
                      'runtimeHint', interaction.runtime_hint,
                      'classification', CASE WHEN confirmation.interaction_id IS NOT NULL
                        THEN 'confirmed' ELSE interaction.classification END,
                      'confirmationMethod', COALESCE(
                        confirmation.method, interaction.confirmation_method
                      )
                    ) ORDER BY interaction.occurred_at, interaction.id)
                    FROM interactions_v2 interaction
                    JOIN enrichment_requests request
                      ON request.interaction_id = interaction.id
                      AND request.workspace_id = interaction.workspace_id
                    LEFT JOIN enrichment_interaction_confirmations confirmation
                      ON confirmation.interaction_id = interaction.id
                      AND confirmation.workspace_id = interaction.workspace_id
                    WHERE request.workspace_id = $1 AND request.product_id = $2
                  ), '[]'::JSONB),
                  'sessions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', session.id,
                      'source', session.source,
                      'interactionCount', grouped.interaction_count
                    ) ORDER BY session.started_at, session.id)
                    FROM sessions_v2 session
                    JOIN (
                      SELECT interaction.session_id, COUNT(*)::BIGINT AS interaction_count
                      FROM interactions_v2 interaction
                      JOIN enrichment_requests request
                        ON request.interaction_id = interaction.id
                        AND request.workspace_id = interaction.workspace_id
                      WHERE request.workspace_id = $1 AND request.product_id = $2
                        AND interaction.session_id IS NOT NULL
                      GROUP BY interaction.session_id
                    ) grouped ON grouped.session_id = session.id
                    WHERE session.workspace_id = $1
                  ), '[]'::JSONB),
                  'answers', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', answer.id,
                      'requestId', answer.request_id,
                      'customerId', answer.customer_id,
                      'status', answer.status
                    ) ORDER BY answer.created_at, answer.id)
                    FROM enrichment_answers answer
                    WHERE answer.workspace_id = $1 AND answer.product_id = $2
                  ), '[]'::JSONB),
                  'signals', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', signal.id,
                      'customerId', item.customer_id,
                      'interactionId', item.interaction_id,
                      'key', item.signal_key,
                      'type', signal.signal_type,
                      'value', item.signal_value,
                      'provenance', signal.provenance,
                      'consentScope', signal.consent_scope,
                      'expiresAt', item.expires_at
                    ) ORDER BY signal.collected_at, signal.id)
                    FROM enrichment_signal_items item
                    JOIN customer_signals signal
                      ON signal.id = item.signal_id
                      AND signal.workspace_id = item.workspace_id
                    WHERE item.workspace_id = $1 AND item.product_id = $2
                  ), '[]'::JSONB),
                  'contextRetrievals', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', retrieval.id,
                      'customerId', retrieval.customer_id,
                      'interactionId', retrieval.interaction_id,
                      'purpose', retrieval.purpose,
                      'identityLevel', retrieval.identity_level,
                      'itemCount', retrieval.item_count
                    ) ORDER BY retrieval.created_at, retrieval.id)
                    FROM customer_context_retrievals retrieval
                    WHERE retrieval.workspace_id = $1 AND retrieval.product_id = $2
                  ), '[]'::JSONB),
                  'decisions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', decision.id,
                      'customerId', decision.customer_id,
                      'purpose', decision.purpose,
                      'variant', decision.variant
                    ) ORDER BY decision.created_at, decision.id)
                    FROM personalization_decisions decision
                    WHERE decision.workspace_id = $1 AND decision.product_id = $2
                  ), '[]'::JSONB),
                  'outcomes', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', outcome.id,
                      'decisionId', outcome.decision_id,
                      'outcome', outcome.outcome
                    ) ORDER BY outcome.created_at, outcome.id)
                    FROM personalization_outcomes outcome
                    WHERE outcome.workspace_id = $1 AND outcome.product_id = $2
                  ), '[]'::JSONB),
                  'resolutions', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'fromCustomerId', resolution.from_customer_id,
                      'toCustomerId', resolution.to_customer_id,
                      'method', resolution.method,
                      'provenance', resolution.provenance
                    ) ORDER BY resolution.created_at, resolution.id)
                    FROM customer_resolution_events resolution
                    WHERE resolution.workspace_id = $1 AND resolution.product_id = $2
                  ), '[]'::JSONB)
                )",
            )
            .bind(workspace_id)
            .bind(product_id)
            .fetch_one(&pool)
            .await?;
            println!("{}", serde_json::to_string(&output)?);
        }
        "delete" => {
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(workspace_id)
                .execute(&pool)
                .await?;
            println!("deleted");
        }
        "set-mode" => {
            let environment_id = uuid("SETUP_MATRIX_ENVIRONMENT_ID")?;
            let mode = required("SETUP_MATRIX_FEEDBACK_MODE")?;
            if !matches!(
                mode.as_str(),
                "never_ask" | "ask_once" | "ask_always" | "off"
            ) {
                anyhow::bail!("invalid feedback mode");
            }
            sqlx::query("UPDATE product_environments SET feedback_mode = $1 WHERE id = $2")
                .bind(&mode)
                .bind(environment_id)
                .execute(&pool)
                .await?;
            println!("{mode}");
        }
        _ => anyhow::bail!("unknown action"),
    }
    Ok(())
}
