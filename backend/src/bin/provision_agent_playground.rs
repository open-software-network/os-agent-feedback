use std::{env, io::Write};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).map_err(|_| anyhow::anyhow!("{name} is required"))
}

fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let action = env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("provision or status action is required"))?;
    let pool: PgPool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&required("DATABASE_URL")?)
        .await?;
    let owner_email = required("PLAYGROUND_OWNER_EMAIL")?;
    let product_name =
        env::var("PLAYGROUND_PRODUCT_NAME").unwrap_or_else(|_| "Epode Agent Playground".into());
    let feedback_mode = env::var("PLAYGROUND_FEEDBACK_MODE").unwrap_or_else(|_| "never_ask".into());
    if !["never_ask", "ask_once", "ask_always", "off"].contains(&feedback_mode.as_str()) {
        anyhow::bail!("PLAYGROUND_FEEDBACK_MODE must be never_ask, ask_once, ask_always, or off");
    }
    let key_label = env::var("PLAYGROUND_KEY_LABEL").unwrap_or_else(|_| "Agent playground".into());

    let workspace_id: Uuid = sqlx::query_scalar(
        r#"SELECT w.id FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id
        WHERE LOWER(m.email) = LOWER($1)
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at
        LIMIT 1"#,
    )
    .bind(&owner_email)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("No Epode team found for {owner_email}"))?;

    let existing_product_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM products WHERE workspace_id = $1 AND name = $2 LIMIT 1",
    )
    .bind(workspace_id)
    .bind(&product_name)
    .fetch_optional(&pool)
    .await?;

    if action == "set-mode" {
        let product_id = existing_product_id
            .ok_or_else(|| anyhow::anyhow!("{product_name} has not been provisioned"))?;
        let environment_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM product_environments WHERE product_id = $1 ORDER BY created_at LIMIT 1",
        )
        .bind(product_id)
        .fetch_one(&pool)
        .await?;
        sqlx::query(
            "UPDATE product_environments SET feedback_mode = $2, updated_at = NOW() WHERE id = $1",
        )
        .bind(environment_id)
        .bind(&feedback_mode)
        .execute(&pool)
        .await?;
        println!(
            "{}",
            serde_json::to_string(&json!({
                "productId": product_id,
                "environmentId": environment_id,
                "feedbackMode": feedback_mode,
            }))?
        );
        return Ok(());
    }

    if action == "status" {
        let product_id = existing_product_id
            .ok_or_else(|| anyhow::anyhow!("{product_name} has not been provisioned"))?;
        let (environment_id, stored_feedback_mode): (Uuid, String) = sqlx::query_as(
            "SELECT id, feedback_mode FROM product_environments WHERE product_id = $1 ORDER BY created_at LIMIT 1",
        )
        .bind(product_id)
        .fetch_one(&pool)
        .await?;
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $1")
                .bind(environment_id)
                .fetch_one(&pool)
                .await?;
        let interactions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM interactions_v2 WHERE environment_id = $1")
                .bind(environment_id)
                .fetch_one(&pool)
                .await?;
        let outcomes: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM outcomes_v2 o
            JOIN interactions_v2 i ON i.id = o.interaction_id
            WHERE i.environment_id = $1"#,
        )
        .bind(environment_id)
        .fetch_one(&pool)
        .await?;
        let latest: serde_json::Value = sqlx::query_scalar(
            r#"SELECT COALESCE(json_agg(row_data ORDER BY occurred_at DESC), '[]'::json)
            FROM (
              SELECT json_build_object(
                'interactionId', i.id,
                'sessionHint', s.ref_hint,
                'operation', i.operation,
                'customerRef', i.customer_ref,
                'classification', i.classification,
                'outcome', o.outcome,
                'note', o.note,
                'occurredAt', i.occurred_at
              ) AS row_data, i.occurred_at
              FROM interactions_v2 i
              LEFT JOIN sessions_v2 s ON s.id = i.session_id
              LEFT JOIN outcomes_v2 o ON o.interaction_id = i.id
              WHERE i.environment_id = $1
              ORDER BY i.occurred_at DESC
              LIMIT 20
            ) recent"#,
        )
        .bind(environment_id)
        .fetch_one(&pool)
        .await?;
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "workspaceId": workspace_id,
                "productId": product_id,
                "environmentId": environment_id,
                "feedbackMode": stored_feedback_mode,
                "sessions": sessions,
                "interactions": interactions,
                "outcomes": outcomes,
                "latest": latest,
            }))?
        );
        return Ok(());
    }
    if action != "provision" {
        anyhow::bail!("action must be provision, status, or set-mode");
    }

    let mut tx = pool.begin().await?;
    let product_id = match existing_product_id {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO products (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)",
            )
            .bind(id)
            .bind(workspace_id)
            .bind(&product_name)
            .bind(format!(
                "agent-playground-{}",
                &id.simple().to_string()[..8]
            ))
            .execute(&mut *tx)
            .await?;
            id
        }
    };

    let environment_id = match sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM product_environments WHERE product_id = $1 ORDER BY created_at LIMIT 1",
    )
    .bind(product_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4();
            sqlx::query(
                r#"INSERT INTO product_environments
                (id, workspace_id, product_id, name, slug, feedback_mode, retention_days)
                VALUES ($1, $2, $3, 'Default', 'default', $4, 365)"#,
            )
            .bind(id)
            .bind(workspace_id)
            .bind(product_id)
            .bind(&feedback_mode)
            .execute(&mut *tx)
            .await?;
            id
        }
    };

    sqlx::query(
        "UPDATE product_environments SET feedback_mode = $2, retention_days = 365, updated_at = NOW() WHERE id = $1",
    )
    .bind(environment_id)
    .bind(&feedback_mode)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE api_keys SET revoked_at = NOW() WHERE environment_id = $1 AND label = $2 AND revoked_at IS NULL",
    )
    .bind(environment_id)
    .bind(&key_label)
    .execute(&mut *tx)
    .await?;

    let key_id = Uuid::new_v4();
    let secret = format!("af_live_{}_{}", key_id.simple(), random_secret());
    let prefix: String = secret.chars().take(16).collect();
    let key_hash = Sha256::digest(secret.as_bytes()).to_vec();
    sqlx::query(
        r#"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, key_hash)
        VALUES ($1, $2, $3, $4, $5, $6)"#,
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(&key_label)
    .bind(prefix)
    .bind(key_hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    eprintln!(
        "Provisioned {product_name} in {feedback_mode} mode (workspace {workspace_id}, product {product_id}, environment {environment_id}, key {key_id}, label {key_label})"
    );
    std::io::stdout().write_all(secret.as_bytes())?;
    Ok(())
}
