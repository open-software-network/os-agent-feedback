use std::env;

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
    summary: String,
    impact: Option<String>,
    findings: serde_json::Value,
    workaround: Option<serde_json::Value>,
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
        .max_connections(2)
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
                r#"SELECT i.id, i.surface, i.operation, i.classification, i.confirmation_method,
                r.summary, r.impact, r.findings, r.workaround
                FROM interactions_v2 i JOIN feedback_reports r ON r.interaction_id = i.id
                WHERE i.workspace_id = $1 ORDER BY r.summary"#,
            )
            .bind(workspace_id)
            .fetch_all(&pool)
            .await?;
            let output: Vec<_> = rows.into_iter().map(|row| json!({
                "id": row.id, "surface": row.surface, "operation": row.operation,
                "classification": row.classification, "confirmationMethod": row.confirmation_method,
                "summary": row.summary, "impact": row.impact,
                "findings": row.findings, "workaround": row.workaround,
            })).collect();
            println!("{}", serde_json::to_string(&output)?);
        }
        "delete" => {
            sqlx::query("DELETE FROM workspaces WHERE id = $1")
                .bind(workspace_id)
                .execute(&pool)
                .await?;
            println!("deleted");
        }
        _ => anyhow::bail!("unknown action"),
    }
    Ok(())
}
