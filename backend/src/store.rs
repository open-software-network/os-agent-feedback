use std::collections::HashMap;

use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::ApiError,
    models::*,
    os_accounts::OsUser,
    security::{bearer_token, parse_capability, random_token, sha256, verify_capability},
};

#[derive(sqlx::FromRow)]
struct FeedbackReceiptRow {
    workspace_id: Uuid,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
}

pub fn clean(value: &str, max: usize) -> String {
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
        .and_then(|db| db.code())
        .as_deref()
        == Some("23505")
    {
        ApiError::conflict(message)
    } else {
        ApiError::internal(error)
    }
}

pub async fn get_or_create_workspace(
    pool: &PgPool,
    os_user: &OsUser,
) -> Result<Workspace, ApiError> {
    if let Some(workspace) =
        sqlx::query_as::<_, Workspace>("SELECT * FROM workspaces WHERE os_user_id = $1")
            .bind(&os_user.id)
            .fetch_optional(pool)
            .await?
    {
        return Ok(workspace);
    }
    let display = os_user.display_name.as_deref().unwrap_or(&os_user.handle);
    let name = format!("{} workspace", clean(display, 70));
    sqlx::query_as::<_, Workspace>(
        r#"INSERT INTO workspaces (id, os_user_id, name, slug)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (os_user_id) DO UPDATE SET updated_at = workspaces.updated_at
        RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(&os_user.id)
    .bind(name)
    .bind(slug(display))
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn agent_workspace(pool: &PgPool, headers: &HeaderMap) -> Result<Workspace, ApiError> {
    Ok(agent_product_auth(pool, headers).await?.workspace)
}

pub async fn agent_product_auth(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<ProductAuth, ApiError> {
    let token = bearer_token(headers)
        .filter(|token| token.starts_with("af_live_"))
        .ok_or_else(ApiError::unauthorized)?;
    let key_hash = sha256(&token);
    let key = sqlx::query_as::<_, (Uuid, Uuid, Uuid)>(
        r#"SELECT k.id, k.workspace_id, k.environment_id FROM api_keys k
        WHERE k.key_hash = $1
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())"#,
    )
    .bind(&key_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
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
        .bind(&key_hash)
        .execute(pool)
        .await?;
    Ok(ProductAuth {
        workspace,
        environment,
        api_key_id: key.0,
    })
}

pub async fn create_product(
    pool: &PgPool,
    workspace_id: Uuid,
    input: CreateProductInput,
) -> Result<(Product, ProductEnvironment), ApiError> {
    let name = clean(&input.name, 80);
    let environment_name = clean(input.environment.as_deref().unwrap_or("Production"), 40);
    if name.len() < 2 || environment_name.len() < 2 {
        return Err(ApiError::bad_request(
            "Product and environment names must contain at least 2 characters",
        ));
    }
    let product_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(pool)
            .await?;
    if product_count >= 25 {
        return Err(ApiError::conflict("This workspace already has 25 products"));
    }
    let mut tx = pool.begin().await?;
    let product = sqlx::query_as::<_, Product>(
        r#"INSERT INTO products (id, workspace_id, name, slug)
        VALUES ($1, $2, $3, $4) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(&name)
    .bind(slug(&name))
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "A product with this name already exists"))?;
    let environment = sqlx::query_as::<_, ProductEnvironment>(
        r#"INSERT INTO product_environments
        (id, workspace_id, product_id, name, slug)
        VALUES ($1, $2, $3, $4, $5) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product.id)
    .bind(&environment_name)
    .bind(slug(&environment_name))
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "This environment already exists"))?;
    tx.commit().await?;
    Ok((product, environment))
}

pub async fn create_product_environment(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    input: CreateEnvironmentInput,
) -> Result<ProductEnvironment, ApiError> {
    let name = clean(&input.name, 40);
    if name.len() < 2 {
        return Err(ApiError::bad_request(
            "Environment name must contain at least 2 characters",
        ));
    }
    let product_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND workspace_id = $2)",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    if !product_exists {
        return Err(ApiError::not_found("Product not found"));
    }
    let environment_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM product_environments WHERE product_id = $1")
            .bind(product_id)
            .fetch_one(pool)
            .await?;
    if environment_count >= 10 {
        return Err(ApiError::conflict(
            "This product already has 10 environments",
        ));
    }
    sqlx::query_as::<_, ProductEnvironment>(
        r#"INSERT INTO product_environments
        (id, workspace_id, product_id, name, slug)
        VALUES ($1, $2, $3, $4, $5) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(product_id)
    .bind(&name)
    .bind(slug(&name))
    .fetch_one(pool)
    .await
    .map_err(|error| database_conflict(error, "This environment already exists"))
}

pub async fn create_api_key(
    pool: &PgPool,
    workspace_id: Uuid,
    environment_id: Uuid,
    label: Option<String>,
    expires_in_seconds: Option<i64>,
) -> Result<(ApiKeyPublic, String), ApiError> {
    let expires_in_seconds = expires_in_seconds.unwrap_or(90 * 24 * 60 * 60);
    if !(60..=365 * 24 * 60 * 60).contains(&expires_in_seconds) {
        return Err(ApiError::bad_request(
            "expiresInSeconds must be between 60 seconds and 365 days",
        ));
    }
    let expires_at = Utc::now() + chrono::Duration::seconds(expires_in_seconds);
    let environment_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM product_environments WHERE id = $1 AND workspace_id = $2)",
    )
    .bind(environment_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    if !environment_exists {
        return Err(ApiError::not_found("Product environment not found"));
    }
    let active_keys: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM api_keys WHERE environment_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(environment_id)
    .fetch_one(pool)
    .await?;
    if active_keys >= 10 {
        return Err(ApiError::conflict(
            "Revoke an existing API key before creating another",
        ));
    }
    let key_id = Uuid::new_v4();
    let secret = format!("af_live_{}_{}", key_id.simple(), random_token(""));
    let prefix = secret.chars().take(16).collect::<String>();
    let row = sqlx::query_as::<_, ApiKeyPublic>(
        r#"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, key_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, environment_id, label, prefix, created_at, last_used_at, revoked_at, expires_at"#,
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(clean(label.as_deref().unwrap_or("Production"), 60))
    .bind(prefix)
    .bind(sha256(&secret))
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok((row, secret))
}

pub async fn revoke_api_key(
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

pub async fn update_policy(
    pool: &PgPool,
    workspace_id: Uuid,
    input: PolicyInput,
) -> Result<ProductEnvironment, ApiError> {
    if !["auto", "ask", "off"].contains(&input.feedback_mode.as_str())
        || !(1..=365).contains(&input.retention_days)
    {
        return Err(ApiError::bad_request(
            "Invalid feedback mode or retention period",
        ));
    }
    let updated = sqlx::query_as::<_, ProductEnvironment>(
        r#"UPDATE product_environments SET feedback_mode = $1,
        collect_event_summaries = $2, retention_days = $3, updated_at = NOW()
        WHERE id = $4 AND workspace_id = $5 RETURNING *"#,
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

pub async fn dashboard(
    pool: &PgPool,
    context: DashboardContext,
    selected_environment_id: Option<Uuid>,
) -> Result<DashboardData, ApiError> {
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
    let current_environment = selected_environment_id
        .and_then(|id| environments.iter().find(|environment| environment.id == id))
        .or_else(|| environments.first())
        .cloned();
    let current_product = current_environment.as_ref().and_then(|environment| {
        products
            .iter()
            .find(|product| product.id == environment.product_id)
            .cloned()
    });
    let environment_id = current_environment
        .as_ref()
        .map(|environment| environment.id);
    let retention_days = current_environment
        .as_ref()
        .map(|environment| environment.retention_days)
        .unwrap_or(context.workspace.retention_days);
    let cutoff = Utc::now() - Duration::days(retention_days.into());
    let legacy_cutoff = Utc::now() - Duration::days(context.workspace.retention_days.into());
    sqlx::query("DELETE FROM agent_sessions WHERE workspace_id = $1 AND created_at < $2")
        .bind(context.workspace.id)
        .bind(legacy_cutoff)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM interactions_v2 WHERE environment_id = $1 AND occurred_at < $2")
        .bind(environment_id)
        .bind(cutoff)
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM sessions_v2 s WHERE workspace_id = $1 AND NOT EXISTS (SELECT 1 FROM interactions_v2 i WHERE i.session_id = s.id)",
    )
    .bind(context.workspace.id)
    .execute(pool)
    .await?;
    let api_keys = sqlx::query_as::<_, ApiKeyPublic>(
        r#"SELECT id, environment_id, label, prefix, created_at, last_used_at, revoked_at, expires_at
        FROM api_keys
        WHERE environment_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC"#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await?;
    let legacy_sessions = sqlx::query_as::<_, AgentSession>(
        "SELECT * FROM agent_sessions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let legacy_feedback = sqlx::query_as::<_, FeedbackWithSession>(
        r#"SELECT f.id, f.session_id, f.worked, f.summary,
        f.confidence, f.would_use_again, f.friction, f.source, f.created_at,
        s.task, s.customer_ref, s.agent_name, s.agent_version,
        s.agent_identity_source, s.started_at, s.completed_at
        FROM feedback f JOIN agent_sessions s ON s.id = f.session_id
        WHERE f.workspace_id = $1 ORDER BY f.created_at DESC LIMIT 100"#,
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let legacy_events = sqlx::query_as::<_, AgentEvent>(
        "SELECT * FROM agent_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1000",
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;

    let interactions = sqlx::query_as::<_, ProductInteraction>(
        r#"SELECT id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
        status_code, duration_ms, customer_ref, classification, confirmation_method,
        runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at
        FROM interactions_v2 WHERE environment_id = $1 ORDER BY occurred_at DESC LIMIT 250"#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await?;
    let outcomes = sqlx::query_as::<_, ProductOutcomeWithInteraction>(
        r#"SELECT o.id, o.interaction_id, o.outcome, o.note, o.source, o.created_at,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at
        FROM outcomes_v2 o JOIN interactions_v2 i ON i.id = o.interaction_id
        WHERE i.environment_id = $1 ORDER BY o.created_at DESC LIMIT 250"#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await?;
    let sessions = sqlx::query_as::<_, ProductSession>(
        r#"SELECT id, workspace_id, environment_id, source, ref_hint, started_at, last_seen_at, created_at
        FROM sessions_v2 WHERE environment_id = $1 ORDER BY last_seen_at DESC LIMIT 100"#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await?;

    let confirmed = interactions
        .iter()
        .filter(|interaction| interaction.classification == "confirmed")
        .count();
    let successful = outcomes
        .iter()
        .filter(|outcome| outcome.outcome == "success")
        .count();
    let mut operation_counts: HashMap<String, i64> = HashMap::new();
    let mut surface_counts: HashMap<String, i64> = HashMap::new();
    let mut outcome_counts: HashMap<String, i64> = HashMap::new();
    for interaction in &interactions {
        *operation_counts
            .entry(interaction.operation.clone())
            .or_default() += 1;
        *surface_counts
            .entry(interaction.surface.clone())
            .or_default() += 1;
    }
    for outcome in &outcomes {
        *outcome_counts.entry(outcome.outcome.clone()).or_default() += 1;
    }
    let counts = |map: HashMap<String, i64>| {
        let mut values = map
            .into_iter()
            .map(|(name, count)| InsightCount { name, count })
            .collect::<Vec<_>>();
        values.sort_by_key(|value| std::cmp::Reverse(value.count));
        values.truncate(8);
        values
    };
    let insights = Insights {
        opportunities: interactions.len(),
        confirmed_interactions: confirmed,
        reviews: outcomes.len(),
        confirmation_rate: if interactions.is_empty() {
            0
        } else {
            (confirmed as f64 / interactions.len() as f64 * 100.0).round() as i64
        },
        review_rate: if confirmed == 0 {
            0
        } else {
            (outcomes.len() as f64 / confirmed as f64 * 100.0).round() as i64
        },
        outcome_success_rate: if outcomes.is_empty() {
            0
        } else {
            (successful as f64 / outcomes.len() as f64 * 100.0).round() as i64
        },
        top_operations: counts(operation_counts),
        surfaces: counts(surface_counts),
        outcomes: counts(outcome_counts),
    };
    Ok(DashboardData {
        user: context.user,
        workspace: context.workspace,
        products,
        environments,
        current_product,
        current_environment,
        api_keys,
        interactions,
        outcomes,
        sessions,
        legacy_sessions,
        legacy_feedback,
        legacy_events,
        insights,
    })
}

fn opaque_ref(value: Option<String>, field: &str) -> Result<Option<String>, ApiError> {
    let value = value
        .map(|value| clean(&value, 160))
        .filter(|value| !value.is_empty());
    if value.as_ref().is_some_and(|value| {
        value.contains('@')
            || value.chars().any(char::is_whitespace)
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
    }) {
        return Err(ApiError::bad_request(format!(
            "{field} must be an opaque identifier, not a name or email"
        )));
    }
    Ok(value)
}

async fn resolve_v2_session(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    environment_id: Uuid,
    session_ref: Option<String>,
    session_source: Option<String>,
    occurred_at: DateTime<Utc>,
) -> Result<Option<Uuid>, ApiError> {
    let Some(session_ref) = opaque_ref(session_ref, "sessionRef")? else {
        return Ok(None);
    };
    let source = session_source.unwrap_or_else(|| "customer".into());
    if !["customer", "mcp", "continuation"].contains(&source.as_str()) {
        return Err(ApiError::bad_request("Invalid sessionSource"));
    }
    let ref_hint = session_ref.chars().take(12).collect::<String>();
    let session_id = Uuid::new_v4();
    let resolved = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO sessions_v2
        (id, workspace_id, environment_id, source, ref_hash, ref_hint, started_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        ON CONFLICT (environment_id, source, ref_hash) DO UPDATE
        SET last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id"#,
    )
    .bind(session_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(source)
    .bind(sha256(&session_ref))
    .bind(ref_hint)
    .bind(occurred_at)
    .fetch_one(&mut **tx)
    .await?;
    Ok(Some(resolved))
}

fn validate_telemetry(input: &InteractionTelemetryInput) -> Result<(), ApiError> {
    if !["http_json", "http_html", "http_headers", "mcp"].contains(&input.surface.as_str()) {
        return Err(ApiError::bad_request("Invalid interaction surface"));
    }
    if input.operation.trim().is_empty() || input.operation.len() > 160 {
        return Err(ApiError::bad_request(
            "operation is required and must be at most 160 characters",
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
    let classification = input.classification.as_deref().unwrap_or("unclassified");
    if !["unclassified", "confirmed"].contains(&classification) {
        return Err(ApiError::bad_request("Invalid classification"));
    }
    if input.confirmation_method.is_some() && input.confirmation_method.as_deref() != Some("mcp") {
        return Err(ApiError::bad_request("Invalid confirmationMethod"));
    }
    if input.surface == "mcp" && classification != "confirmed" {
        return Err(ApiError::bad_request("MCP interactions must be confirmed"));
    }
    Ok(())
}

pub async fn ingest_telemetry_batch(
    pool: &PgPool,
    auth: &ProductAuth,
    input: TelemetryBatchInput,
) -> Result<usize, ApiError> {
    let event_count = input.events.len();
    if event_count == 0 || event_count > 100 {
        return Err(ApiError::bad_request(
            "events must contain between 1 and 100 interactions",
        ));
    }
    let mut tx = pool.begin().await?;
    for event in input.events {
        validate_telemetry(&event)?;
        let occurred_at = event.occurred_at.unwrap_or_else(Utc::now);
        if occurred_at > Utc::now() + Duration::minutes(5)
            || occurred_at < Utc::now() - Duration::days(7)
        {
            return Err(ApiError::bad_request(
                "occurredAt is outside the accepted window",
            ));
        }
        let customer_ref = opaque_ref(event.customer_ref, "customerRef")?;
        let session_id = resolve_v2_session(
            &mut tx,
            auth.workspace.id,
            auth.environment.id,
            event.session_ref,
            event.session_source,
            occurred_at,
        )
        .await?;
        let classification = if event.surface == "mcp" {
            "confirmed".to_string()
        } else {
            event
                .classification
                .unwrap_or_else(|| "unclassified".into())
        };
        let confirmation_method = if event.surface == "mcp" {
            Some("mcp".to_string())
        } else {
            event.confirmation_method
        };
        let row = sqlx::query_as::<_, ProductInteraction>(
            r#"INSERT INTO interactions_v2
            (id, workspace_id, environment_id, api_key_id, session_id, surface, operation, status_code,
             duration_ms, customer_ref, classification, confirmation_method, runtime_hint,
             runtime_hint_source, occurred_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (id) DO UPDATE SET
              api_key_id = COALESCE(interactions_v2.api_key_id, EXCLUDED.api_key_id),
              session_id = COALESCE(interactions_v2.session_id, EXCLUDED.session_id),
              surface = CASE WHEN interactions_v2.surface = 'unknown' THEN EXCLUDED.surface ELSE interactions_v2.surface END,
              operation = CASE WHEN interactions_v2.operation = 'pending' THEN EXCLUDED.operation ELSE interactions_v2.operation END,
              status_code = COALESCE(interactions_v2.status_code, EXCLUDED.status_code),
              duration_ms = COALESCE(interactions_v2.duration_ms, EXCLUDED.duration_ms),
              customer_ref = COALESCE(interactions_v2.customer_ref, EXCLUDED.customer_ref),
              classification = CASE WHEN interactions_v2.classification = 'confirmed' THEN 'confirmed' ELSE EXCLUDED.classification END,
              confirmation_method = CASE
                WHEN EXCLUDED.confirmation_method = 'mcp' THEN 'mcp'
                ELSE COALESCE(interactions_v2.confirmation_method, EXCLUDED.confirmation_method)
              END,
              runtime_hint = COALESCE(interactions_v2.runtime_hint, EXCLUDED.runtime_hint),
              runtime_hint_source = COALESCE(interactions_v2.runtime_hint_source, EXCLUDED.runtime_hint_source),
              occurred_at = LEAST(interactions_v2.occurred_at, EXCLUDED.occurred_at),
              updated_at = NOW()
            WHERE interactions_v2.environment_id = EXCLUDED.environment_id
            RETURNING id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
              status_code, duration_ms, customer_ref, classification, confirmation_method,
              runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at"#,
        )
        .bind(event.interaction_id)
        .bind(auth.workspace.id)
        .bind(auth.environment.id)
        .bind(auth.api_key_id)
        .bind(session_id)
        .bind(event.surface)
        .bind(clean(&event.operation, 160))
        .bind(event.status_code)
        .bind(event.duration_ms)
        .bind(customer_ref)
        .bind(classification)
        .bind(confirmation_method)
        .bind(event.runtime_hint.map(|value| clean(&value, 120)))
        .bind(event.runtime_hint_source.map(|value| clean(&value, 60)))
        .bind(occurred_at)
        .fetch_optional(&mut *tx)
        .await?;
        if row.is_none() {
            return Err(ApiError::conflict(
                "interactionId belongs to another workspace",
            ));
        }
    }
    tx.commit().await?;
    Ok(event_count)
}

pub async fn submit_product_outcome(
    pool: &PgPool,
    capability: &str,
    input: ProductOutcomeInput,
) -> Result<(ProductInteraction, ProductOutcome), ApiError> {
    if !["success", "partial", "failure"].contains(&input.outcome.as_str()) {
        return Err(ApiError::bad_request(
            "outcome must be success, partial, or failure",
        ));
    }
    let note = clean(&input.note, 500);
    if note.len() < 8 {
        return Err(ApiError::bad_request(
            "note must contain at least 8 characters",
        ));
    }
    let lower_note = note.to_ascii_lowercase();
    if [
        "bearer ",
        "af_live_",
        "api key",
        "password",
        "transcript:",
        "prompt:",
    ]
    .iter()
    .any(|pattern| lower_note.contains(pattern))
    {
        return Err(ApiError::bad_request(
            "The outcome note appears to contain sensitive data",
        ));
    }

    let parsed = parse_capability(capability)?;
    let key = sqlx::query_as::<_, (Uuid, Vec<u8>, String, Uuid)>(
        r#"SELECT k.workspace_id, k.key_hash, e.feedback_mode, k.environment_id
        FROM api_keys k
        JOIN product_environments e ON e.id = k.environment_id
        WHERE k.id = $1 AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > NOW())"#,
    )
    .bind(parsed.key_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let claims = verify_capability(parsed.clone(), &key.1, Utc::now())?;
    if key.2 == "off" {
        return Err(ApiError::gone("Feedback collection is disabled"));
    }

    let mut tx = pool.begin().await?;
    let interaction = sqlx::query_as::<_, ProductInteraction>(
        r#"INSERT INTO interactions_v2
        (id, workspace_id, environment_id, api_key_id, surface, operation, classification,
         confirmation_method, capability_nonce_hash, occurred_at)
        VALUES ($1, $2, $3, $4, 'unknown', 'pending', 'confirmed',
          'outcome_submission', $5, TO_TIMESTAMP($6))
        ON CONFLICT (id) DO UPDATE SET
          classification = 'confirmed',
          confirmation_method = COALESCE(interactions_v2.confirmation_method, 'outcome_submission'),
          capability_nonce_hash = COALESCE(interactions_v2.capability_nonce_hash, EXCLUDED.capability_nonce_hash),
          updated_at = NOW()
        WHERE interactions_v2.environment_id = EXCLUDED.environment_id
        RETURNING id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
          status_code, duration_ms, customer_ref, classification, confirmation_method,
          runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at"#,
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

    if let Some(existing) =
        sqlx::query_as::<_, ProductOutcome>("SELECT * FROM outcomes_v2 WHERE interaction_id = $1")
            .bind(claims.i)
            .fetch_optional(&mut *tx)
            .await?
    {
        tx.commit().await?;
        return Ok((interaction, existing));
    }
    let outcome = sqlx::query_as::<_, ProductOutcome>(
        r#"INSERT INTO outcomes_v2
        (id, workspace_id, interaction_id, outcome, note)
        VALUES ($1, $2, $3, $4, $5) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(key.0)
    .bind(claims.i)
    .bind(input.outcome)
    .bind(note)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((interaction, outcome))
}

pub async fn start_session(
    pool: &PgPool,
    workspace: &Workspace,
    input: StartSessionInput,
) -> Result<AgentSession, ApiError> {
    let task = clean(&input.task, 500);
    if task.len() < 3 {
        return Err(ApiError::bad_request("task is required"));
    }
    let external_id = input
        .external_id
        .map(|value| clean(&value, 160))
        .filter(|value| !value.is_empty());
    let customer_ref = input
        .customer_ref
        .map(|value| clean(&value, 120))
        .filter(|value| !value.is_empty());
    let agent_name = input
        .agent_name
        .map(|value| clean(&value, 100))
        .filter(|value| !value.is_empty());
    let agent_version = input
        .agent_version
        .map(|value| clean(&value, 60))
        .filter(|value| !value.is_empty());
    let agent_identity_source = if agent_name.is_some() || agent_version.is_some() {
        "company_observed"
    } else {
        "unknown"
    };
    if let Some(ref external_id) = external_id
        && let Some(existing) = sqlx::query_as::<_, AgentSession>(
            "SELECT * FROM agent_sessions WHERE workspace_id = $1 AND external_id = $2",
        )
        .bind(workspace.id)
        .bind(external_id)
        .fetch_optional(pool)
        .await?
    {
        return Ok(existing);
    }
    let session = sqlx::query_as::<_, AgentSession>(
        r#"INSERT INTO agent_sessions
        (id, workspace_id, external_id, customer_ref, agent_name, agent_version,
         agent_identity_source, task)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace.id)
    .bind(external_id)
    .bind(customer_ref)
    .bind(agent_name.unwrap_or_else(|| "anonymous-customer-agent".into()))
    .bind(agent_version)
    .bind(agent_identity_source)
    .bind(task)
    .fetch_one(pool)
    .await
    .map_err(|error| database_conflict(error, "externalId already exists"))?;
    Ok(session)
}

pub async fn start_interaction(
    pool: &PgPool,
    workspace: &Workspace,
    input: StartSessionInput,
) -> Result<(AgentSession, Option<IssuedFeedbackReceipt>), ApiError> {
    let session = start_session(pool, workspace, input).await?;
    if workspace.feedback_mode == "off" {
        return Ok((session, None));
    }

    let token = random_token("afr_");
    let expires_at = Utc::now() + Duration::hours(24);
    sqlx::query(
        r#"INSERT INTO feedback_receipts
        (id, workspace_id, session_id, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace.id)
    .bind(session.id)
    .bind(sha256(&token))
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok((session, Some(IssuedFeedbackReceipt { token, expires_at })))
}

async fn lock_session<'a>(
    tx: &mut Transaction<'a, Postgres>,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<AgentSession, ApiError> {
    sqlx::query_as::<_, AgentSession>(
        "SELECT * FROM agent_sessions WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(session_id)
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::not_found("Session not found"))
}

pub async fn record_event(
    pool: &PgPool,
    workspace: &Workspace,
    session_id: Uuid,
    input: RecordEventInput,
) -> Result<AgentEvent, ApiError> {
    let name = clean(&input.name, 120);
    if name.is_empty() {
        return Err(ApiError::bad_request("event name is required"));
    }
    let status = input.status.unwrap_or_else(|| "info".into());
    if !["started", "succeeded", "failed", "info"].contains(&status.as_str()) {
        return Err(ApiError::bad_request("Invalid event status"));
    }
    let mut tx = pool.begin().await?;
    let session = lock_session(&mut tx, workspace.id, session_id).await?;
    if session.status == "completed" {
        return Err(ApiError::conflict("Session is already completed"));
    }
    let sequence: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_events WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await?;
    let summary = if workspace.collect_event_summaries {
        input
            .summary
            .map(|value| clean(&value, 500))
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let event = sqlx::query_as::<_, AgentEvent>(r#"INSERT INTO agent_events
        (id, workspace_id, session_id, sequence, event_type, name, status, duration_ms, summary, error_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *"#)
        .bind(Uuid::new_v4()).bind(workspace.id).bind(session_id).bind(sequence)
        .bind(clean(input.event_type.as_deref().unwrap_or("event"), 40)).bind(name).bind(status)
        .bind(input.duration_ms.map(|value| value.max(0))).bind(summary)
        .bind(input.error_code.map(|value| clean(&value, 80)).filter(|value| !value.is_empty()))
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(event)
}

pub async fn complete_session(
    pool: &PgPool,
    workspace: &Workspace,
    session_id: Uuid,
    input: CompleteSessionInput,
) -> Result<(AgentSession, Option<Feedback>), ApiError> {
    let summary = input
        .summary
        .as_deref()
        .map(|value| clean(value, 700))
        .filter(|value| !value.is_empty());
    if workspace.feedback_mode == "auto"
        && (input.worked.is_none() || summary.as_deref().is_none_or(|value| value.len() < 8))
    {
        return Err(ApiError::bad_request(
            "worked and a feedback summary are required while automatic feedback is enabled",
        ));
    }
    if input
        .confidence
        .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err(ApiError::bad_request("confidence must be between 0 and 1"));
    }
    let mut tx = pool.begin().await?;
    let locked_session = lock_session(&mut tx, workspace.id, session_id).await?;
    if locked_session.status == "completed" {
        let feedback = sqlx::query_as::<_, Feedback>(
            "SELECT * FROM feedback WHERE workspace_id = $1 AND session_id = $2",
        )
        .bind(workspace.id)
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok((locked_session, feedback));
    }
    let session = sqlx::query_as::<_, AgentSession>("UPDATE agent_sessions SET status = 'completed', completed_at = NOW() WHERE id = $1 RETURNING *")
        .bind(session_id).fetch_one(&mut *tx).await?;
    let feedback = if workspace.feedback_mode != "off"
        && let (Some(worked), Some(summary)) = (input.worked, summary)
    {
        Some(sqlx::query_as::<_, Feedback>(r#"INSERT INTO feedback
            (id, workspace_id, session_id, worked, summary, confidence, would_use_again, friction, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'agent')
            ON CONFLICT (session_id) DO UPDATE SET worked = EXCLUDED.worked, summary = EXCLUDED.summary,
              confidence = EXCLUDED.confidence, would_use_again = EXCLUDED.would_use_again,
              friction = EXCLUDED.friction, source = EXCLUDED.source, created_at = NOW()
            RETURNING *"#)
            .bind(Uuid::new_v4()).bind(workspace.id).bind(session_id).bind(worked).bind(summary)
            .bind(input.confidence).bind(input.would_use_again)
            .bind(clean(input.friction.as_deref().unwrap_or("none"), 80))
            .fetch_one(&mut *tx).await?)
    } else {
        None
    };
    tx.commit().await?;
    Ok((session, feedback))
}

pub async fn submit_customer_agent_feedback(
    pool: &PgPool,
    receipt_token: &str,
    input: CustomerAgentFeedbackInput,
) -> Result<(AgentSession, Feedback), ApiError> {
    if !receipt_token.starts_with("afr_") {
        return Err(ApiError::unauthorized());
    }
    let summary = clean(&input.summary, 700);
    if summary.len() < 8 {
        return Err(ApiError::bad_request(
            "A feedback summary of at least 8 characters is required",
        ));
    }
    if input
        .confidence
        .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err(ApiError::bad_request("confidence must be between 0 and 1"));
    }

    let mut tx = pool.begin().await?;
    let receipt = sqlx::query_as::<_, FeedbackReceiptRow>(
        r#"SELECT workspace_id, session_id, expires_at
        FROM feedback_receipts WHERE token_hash = $1 FOR UPDATE"#,
    )
    .bind(sha256(receipt_token))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    if receipt.expires_at <= Utc::now() {
        return Err(ApiError::gone("This feedback receipt has expired"));
    }

    let feedback_mode: String =
        sqlx::query_scalar("SELECT feedback_mode FROM workspaces WHERE id = $1")
            .bind(receipt.workspace_id)
            .fetch_one(&mut *tx)
            .await?;
    if feedback_mode == "off" {
        return Err(ApiError::gone("Feedback collection is disabled"));
    }

    let session = lock_session(&mut tx, receipt.workspace_id, receipt.session_id).await?;
    if let Some(existing) = sqlx::query_as::<_, Feedback>(
        "SELECT * FROM feedback WHERE workspace_id = $1 AND session_id = $2",
    )
    .bind(receipt.workspace_id)
    .bind(receipt.session_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        sqlx::query(
            "UPDATE feedback_receipts SET submitted_at = COALESCE(submitted_at, NOW()) WHERE session_id = $1",
        )
        .bind(receipt.session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok((session, existing));
    }

    let reported_agent_name = input
        .agent_name
        .map(|value| clean(&value, 100))
        .filter(|value| !value.is_empty());
    let reported_agent_version = input
        .agent_version
        .map(|value| clean(&value, 60))
        .filter(|value| !value.is_empty());
    let has_reported_identity = reported_agent_name.is_some() || reported_agent_version.is_some();
    let session = sqlx::query_as::<_, AgentSession>(
        r#"UPDATE agent_sessions SET
          status = 'completed', completed_at = NOW(),
          agent_name = CASE
            WHEN agent_identity_source = 'unknown' AND $2 IS NOT NULL THEN $2
            ELSE agent_name END,
          agent_version = CASE
            WHEN agent_identity_source = 'unknown' AND $3 IS NOT NULL THEN $3
            ELSE agent_version END,
          agent_identity_source = CASE
            WHEN agent_identity_source = 'unknown' AND $4 THEN 'agent_reported'
            ELSE agent_identity_source END
        WHERE id = $1 RETURNING *"#,
    )
    .bind(receipt.session_id)
    .bind(reported_agent_name)
    .bind(reported_agent_version)
    .bind(has_reported_identity)
    .fetch_one(&mut *tx)
    .await?;
    let feedback = sqlx::query_as::<_, Feedback>(
        r#"INSERT INTO feedback
        (id, workspace_id, session_id, worked, summary, confidence, would_use_again, friction, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'customer_agent')
        RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(receipt.workspace_id)
    .bind(receipt.session_id)
    .bind(input.worked)
    .bind(summary)
    .bind(input.confidence)
    .bind(input.would_use_again)
    .bind(clean(input.friction.as_deref().unwrap_or("none"), 80))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE feedback_receipts SET submitted_at = NOW() WHERE session_id = $1")
        .bind(receipt.session_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((session, feedback))
}

#[cfg(test)]
mod product_environment_tests {
    use sqlx::postgres::PgPoolOptions;

    use super::*;

    fn test_error(error: ApiError) -> anyhow::Error {
        anyhow::anyhow!("{}: {}", error.status, error.message)
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn product_environment_scope_isolated_end_to_end() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        let workspace_id = Uuid::new_v4();
        let workspace = sqlx::query_as::<_, Workspace>(
            r#"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Hierarchy acceptance', $3) RETURNING *"#,
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
            let (search, production) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Search".into(),
                    environment: Some("Production".into()),
                },
            )
            .await
            .map_err(test_error)?;
            let staging = create_product_environment(
                &pool,
                workspace_id,
                search.id,
                CreateEnvironmentInput {
                    name: "Staging".into(),
                },
            )
            .await
            .map_err(test_error)?;
            let (_docs, _docs_production) = create_product(
                &pool,
                workspace_id,
                CreateProductInput {
                    name: "Documentation".into(),
                    environment: Some("Production".into()),
                },
            )
            .await
            .map_err(test_error)?;
            let (key, _) = create_api_key(
                &pool,
                workspace_id,
                production.id,
                Some("Express".into()),
                None,
            )
            .await
            .map_err(test_error)?;
            let interaction_id = Uuid::new_v4();
            ingest_telemetry_batch(
                &pool,
                &ProductAuth {
                    workspace: workspace.clone(),
                    environment: production.clone(),
                    api_key_id: key.id,
                },
                TelemetryBatchInput {
                    events: vec![InteractionTelemetryInput {
                        interaction_id,
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

            let context = || DashboardContext {
                user: CurrentUser {
                    id: "usr_test".into(),
                    handle: "test".into(),
                    email: None,
                    display_name: "Test".into(),
                },
                workspace: workspace.clone(),
            };
            let production_dashboard = dashboard(&pool, context(), Some(production.id))
                .await
                .map_err(test_error)?;
            anyhow::ensure!(production_dashboard.products.len() == 2);
            anyhow::ensure!(production_dashboard.environments.len() == 3);
            anyhow::ensure!(production_dashboard.interactions.len() == 1);
            anyhow::ensure!(production_dashboard.api_keys.len() == 1);

            let staging_dashboard = dashboard(&pool, context(), Some(staging.id))
                .await
                .map_err(test_error)?;
            anyhow::ensure!(staging_dashboard.current_product.unwrap().id == search.id);
            anyhow::ensure!(staging_dashboard.interactions.is_empty());
            anyhow::ensure!(staging_dashboard.api_keys.is_empty());

            let updated = update_policy(
                &pool,
                workspace_id,
                PolicyInput {
                    environment_id: staging.id,
                    feedback_mode: "ask".into(),
                    collect_event_summaries: false,
                    retention_days: 7,
                },
            )
            .await
            .map_err(test_error)?;
            anyhow::ensure!(updated.feedback_mode == "ask");
            anyhow::ensure!(production.feedback_mode == "auto");
            Ok::<(), anyhow::Error>(())
        }
        .await;

        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        result
    }
}
