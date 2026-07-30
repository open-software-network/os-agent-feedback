use std::collections::HashMap;

use axum::http::HeaderMap;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::ApiError,
    models::*,
    os_accounts::OsUser,
    security::{bearer_token, parse_capability, random_token, sha256, verify_capability},
};

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

fn validated_name(value: &str, entity: &str) -> Result<String, ApiError> {
    let name = clean(value, 80);
    if name.chars().count() < 2 {
        return Err(ApiError::bad_request(format!(
            "{entity} name must contain at least 2 characters"
        )));
    }
    Ok(name)
}

pub async fn get_or_create_workspace(
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
        r#"INSERT INTO workspace_members
        (workspace_id, os_user_id, handle, email, display_name, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, os_user_id) DO UPDATE SET
          handle = EXCLUDED.handle,
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          updated_at = NOW()"#,
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
        r#"INSERT INTO workspace_members
        (workspace_id, os_user_id, handle, email, display_name, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, os_user_id) DO UPDATE SET
          handle = EXCLUDED.handle,
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          role = CASE WHEN workspace_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END,
          updated_at = NOW()"#,
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
    sqlx::query(
        r#"UPDATE workspace_invitations
        SET accepted_at = NOW(), accepted_by_os_user_id = $1
        WHERE id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()"#,
    )
    .bind(&os_user.id)
    .bind(invitation.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(invitation.workspace_id)
}

pub async fn accept_team_invitation(
    pool: &PgPool,
    os_user: &OsUser,
    invitation_id: Uuid,
) -> Result<Uuid, ApiError> {
    let invitation = sqlx::query_as::<_, TeamInvitation>(
        r#"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()"#,
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
        r#"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
          AND ((invitee_kind = 'handle' AND invitee_value = $1)
            OR (invitee_kind = 'email' AND invitee_value = $2))"#,
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

pub async fn resolve_workspace_access(
    pool: &PgPool,
    os_user: &OsUser,
    requested_workspace_id: Option<Uuid>,
) -> Result<(Workspace, String, Vec<WorkspaceMembership>), ApiError> {
    let personal_workspace = get_or_create_workspace(pool, os_user).await?;
    accept_matching_invitations(pool, os_user).await?;
    sqlx::query(
        r#"UPDATE workspace_members SET handle = $1, email = $2, display_name = $3,
        updated_at = NOW() WHERE os_user_id = $4"#,
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
        r#"SELECT w.id AS workspace_id, w.name AS workspace_name,
        w.slug AS workspace_slug, m.role
        FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.os_user_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        m.joined_at, w.name"#,
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

pub async fn create_team_invitation(
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
    let invitation_id = Uuid::new_v4();
    let (invitee_kind, invitee_value) = match input.invitee {
        Some(value) => ("email", normalize_invitee_email(&value)?),
        None => ("link", invitation_id.to_string()),
    };
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
        r#"UPDATE workspace_invitations SET revoked_at = NOW()
        WHERE workspace_id = $1 AND invitee_kind = $2 AND invitee_value = $3
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()"#,
    )
    .bind(context.workspace.id)
    .bind(invitee_kind)
    .bind(&invitee_value)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, TeamInvitation>(
        r#"INSERT INTO workspace_invitations
        (id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value, role, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')
        RETURNING id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at"#,
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

pub async fn update_team_member_role(
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
        r#"UPDATE workspace_members SET role = $1, updated_at = NOW()
        WHERE workspace_id = $2 AND os_user_id = $3 RETURNING *"#,
    )
    .bind(role)
    .bind(context.workspace.id)
    .bind(os_user_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn remove_team_member(
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

pub async fn revoke_team_invitation(
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
        r#"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
        role, created_at, expires_at FROM workspace_invitations
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL"#,
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

pub async fn agent_product_auth(
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<ProductAuth, ApiError> {
    let token = bearer_token(headers)
        .filter(|token| token.starts_with("af_live_"))
        .ok_or_else(invalid_api_key)?;
    let key_hash = sha256(&token);
    product_auth_for_key(pool, &key_hash, None).await
}

pub async fn read_product_auth(
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
        r#"SELECT k.id, k.workspace_id, k.environment_id, k.expires_at FROM api_keys k
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL
          AND ($2::TEXT IS NULL OR k.kind = $2)"#,
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

pub async fn create_product(
    pool: &PgPool,
    workspace_id: Uuid,
    input: CreateProductInput,
) -> Result<(Product, ProductEnvironment), ApiError> {
    let name = validated_name(&input.name, "Product")?;
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
    .bind("Default")
    .bind("default")
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| database_conflict(error, "This product already exists"))?;
    tx.commit().await?;
    Ok((product, environment))
}

pub async fn rename_workspace(
    pool: &PgPool,
    workspace_id: Uuid,
    input: UpdateNameInput,
) -> Result<Workspace, ApiError> {
    let name = validated_name(&input.name, "Team")?;
    let updated = sqlx::query_as::<_, Workspace>(
        r#"UPDATE workspaces SET name = $1, slug = $2, updated_at = NOW()
        WHERE id = $3 RETURNING *"#,
    )
    .bind(&name)
    .bind(slug(&name))
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_conflict(error, "A team with this name already exists"))?;
    updated.ok_or_else(|| ApiError::not_found("Team not found"))
}

pub async fn rename_product(
    pool: &PgPool,
    workspace_id: Uuid,
    product_id: Uuid,
    input: UpdateNameInput,
) -> Result<Product, ApiError> {
    let name = validated_name(&input.name, "Product")?;
    let updated = sqlx::query_as::<_, Product>(
        r#"UPDATE products SET name = $1, slug = $2, updated_at = NOW()
        WHERE id = $3 AND workspace_id = $4 RETURNING *"#,
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

pub async fn delete_product(
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
    let deleted = sqlx::query_as::<_, Product>(
        "DELETE FROM products WHERE id = $1 AND workspace_id = $2 RETURNING *",
    )
    .bind(product_id)
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(deleted)
}

pub async fn create_api_key(
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
        "SELECT COUNT(*) FROM api_keys WHERE environment_id = $1 AND kind = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(environment_id)
    .bind(&kind)
    .fetch_one(pool)
    .await?;
    if active_keys >= 10 {
        return Err(ApiError::conflict(
            "Revoke an existing API key before creating another",
        ));
    }
    let key_id = Uuid::new_v4();
    let secret = format!("{key_prefix}{}_{}", key_id.simple(), random_token(""));
    let prefix = secret.chars().take(16).collect::<String>();
    let row = sqlx::query_as::<_, ApiKeyPublic>(
        r#"INSERT INTO api_keys
        (id, workspace_id, environment_id, label, prefix, kind, key_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, environment_id, label, prefix, kind, created_at, last_used_at, revoked_at, expires_at"#,
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(environment_id)
    .bind(clean(label.as_deref().unwrap_or("Production"), 60))
    .bind(prefix)
    .bind(kind)
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
        r#"SELECT COUNT(i.id), COUNT(r.id),
        COUNT(i.id) FILTER (WHERE i.classification = 'confirmed'),
        COUNT(r.id) FILTER (WHERE r.workaround ->> 'used' = 'true'),
        COUNT(r.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.findings) finding
          WHERE finding ->> 'severity' = 'blocking'
        ))
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2"#,
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_one(pool)
    .await?;
    let operation_counts = sqlx::query_as::<_, (String, i64, i64)>(
        r#"SELECT i.operation, COUNT(i.id), COUNT(r.id)
        FROM interactions_v2 i
        LEFT JOIN feedback_reports r ON r.interaction_id = i.id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY i.operation
        ORDER BY COUNT(i.id) DESC, i.operation"#,
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
        r#"SELECT surface, COUNT(*) FROM interactions_v2
        WHERE environment_id = $1 AND occurred_at >= $2
        GROUP BY surface ORDER BY COUNT(*) DESC, surface"#,
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
        r#"SELECT COALESCE(r.impact, 'unspecified'), COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY COALESCE(r.impact, 'unspecified')"#,
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let finding_kinds = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT finding ->> 'kind', COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
        LATERAL jsonb_array_elements(r.findings) finding
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
        GROUP BY finding ->> 'kind'"#,
    )
    .bind(auth.environment.id)
    .bind(window.since)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let severities = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT finding ->> 'severity', COUNT(*)
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id,
        LATERAL jsonb_array_elements(r.findings) finding
        WHERE i.environment_id = $1 AND i.occurred_at >= $2
          AND finding ? 'severity'
        GROUP BY finding ->> 'severity'"#,
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
        review_rate: rounded_rate(counts.1, counts.0),
        confirmation_rate: rounded_rate(counts.2, counts.0),
        impacts,
        finding_kinds,
        severities,
        workaround_rate: rounded_rate(counts.3, counts.1),
        top_operations,
        surfaces,
    })
}

pub async fn feedback_list_reports(
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
    let (window, retained_since) = feedback_window(auth.environment.retention_days, input.since);
    let cursor = decode_feedback_cursor(input.cursor.as_deref(), retained_since)?;
    let cursor_occurred_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let mut reports = sqlx::query_as::<_, FeedbackReportItem>(
        r#"SELECT r.id, r.summary, r.impact, r.confidence, r.findings, r.workaround,
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
        LIMIT $11"#,
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
    let next_cursor = if reports.len() > limit as usize {
        let last = &reports[limit as usize - 1];
        Some(encode_feedback_cursor(
            last.occurred_at,
            last.interaction_id,
        )?)
    } else {
        None
    };
    reports.truncate(limit as usize);
    Ok(FeedbackReportsResponse::Page(FeedbackReportsPage {
        reports,
        next_cursor,
        window,
    }))
}

pub async fn feedback_list_interactions(
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
    let (window, retained_since) = feedback_window(auth.environment.retention_days, input.since);
    let cursor = decode_feedback_cursor(input.cursor.as_deref(), retained_since)?;
    let cursor_occurred_at = cursor.as_ref().map(|cursor| cursor.occurred_at);
    let cursor_id = cursor.as_ref().map(|cursor| cursor.id);
    let mut interactions = sqlx::query_as::<_, FeedbackInteractionItem>(
        r#"SELECT i.id, i.operation, i.customer_ref, i.surface, i.classification,
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
        LIMIT $9"#,
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
    let next_cursor = if interactions.len() > limit as usize {
        let last = &interactions[limit as usize - 1];
        Some(encode_feedback_cursor(last.occurred_at, last.id)?)
    } else {
        None
    };
    interactions.truncate(limit as usize);
    Ok(FeedbackInteractionsPage {
        interactions,
        next_cursor,
        window,
    })
}

pub async fn update_policy(
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
    selected_product_id: Option<Uuid>,
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
    let retention_days = current_environment
        .as_ref()
        .map(|environment| environment.retention_days)
        .unwrap_or(context.workspace.retention_days);
    let cutoff = Utc::now() - Duration::days(retention_days.into());
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
        r#"SELECT id, environment_id, label, prefix, kind, created_at, last_used_at, revoked_at, expires_at
        FROM api_keys
        WHERE environment_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC"#,
    )
    .bind(environment_id)
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
    let reports = sqlx::query_as::<_, ProductFeedbackReportWithInteraction>(
        r#"SELECT r.id, r.interaction_id, r.summary, r.impact, r.confidence,
        r.findings, r.workaround, r.source, r.created_at,
        i.session_id, i.surface, i.operation, i.status_code, i.duration_ms,
        i.customer_ref, i.classification, i.confirmation_method, i.runtime_hint,
        i.runtime_hint_source, i.occurred_at
        FROM feedback_reports r JOIN interactions_v2 i ON i.id = r.interaction_id
        WHERE i.environment_id = $1 ORDER BY r.created_at DESC LIMIT 250"#,
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
    let reports_with_blockers = reports
        .iter()
        .filter(|report| {
            report.findings.as_array().is_some_and(|findings| {
                findings.iter().any(|finding| {
                    finding.get("severity").and_then(Value::as_str) == Some("blocking")
                })
            })
        })
        .count();
    let reports_with_workarounds = reports
        .iter()
        .filter(|report| {
            report
                .workaround
                .as_ref()
                .and_then(|workaround| workaround.get("used"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .count();
    let mut operation_counts: HashMap<String, i64> = HashMap::new();
    let mut surface_counts: HashMap<String, i64> = HashMap::new();
    let mut impact_counts: HashMap<String, i64> = HashMap::new();
    let mut finding_kind_counts: HashMap<String, i64> = HashMap::new();
    let mut topic_counts: HashMap<String, i64> = HashMap::new();
    for interaction in &interactions {
        *operation_counts
            .entry(interaction.operation.clone())
            .or_default() += 1;
        *surface_counts
            .entry(interaction.surface.clone())
            .or_default() += 1;
    }
    for report in &reports {
        *impact_counts
            .entry(
                report
                    .impact
                    .clone()
                    .unwrap_or_else(|| "unspecified".into()),
            )
            .or_default() += 1;
        if let Some(findings) = report.findings.as_array() {
            for finding in findings {
                if let Some(kind) = finding.get("kind").and_then(Value::as_str) {
                    *finding_kind_counts.entry(kind.into()).or_default() += 1;
                }
                if let Some(topic) = finding.get("topic").and_then(Value::as_str) {
                    *topic_counts.entry(topic.into()).or_default() += 1;
                }
            }
        }
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
        reports: reports.len(),
        confirmation_rate: if interactions.is_empty() {
            0
        } else {
            (confirmed as f64 / interactions.len() as f64 * 100.0).round() as i64
        },
        review_rate: if confirmed == 0 {
            0
        } else {
            (reports.len() as f64 / confirmed as f64 * 100.0).round() as i64
        },
        reports_with_blockers,
        reports_with_workarounds,
        top_operations: counts(operation_counts),
        surfaces: counts(surface_counts),
        impacts: counts(impact_counts),
        finding_kinds: counts(finding_kind_counts),
        topics: counts(topic_counts),
    };
    let team_members = sqlx::query_as::<_, TeamMember>(
        r#"SELECT workspace_id, os_user_id, handle, email, display_name, role,
        joined_at, updated_at FROM workspace_members
        WHERE workspace_id = $1
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        LOWER(display_name), joined_at"#,
    )
    .bind(context.workspace.id)
    .fetch_all(pool)
    .await?;
    let team_invitations = if context.role == "owner" || context.role == "admin" {
        sqlx::query_as::<_, TeamInvitation>(
            r#"SELECT id, workspace_id, invited_by_os_user_id, invitee_kind, invitee_value,
            role, created_at, expires_at FROM workspace_invitations
            WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
              AND expires_at > NOW()
            ORDER BY created_at DESC"#,
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
        api_keys,
        interactions,
        reports,
        sessions,
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
        SET started_at = LEAST(sessions_v2.started_at, EXCLUDED.started_at),
            last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
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

fn contains_sensitive_report_text(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "bearer ",
        "af_live_",
        "api key",
        "password",
        "transcript:",
        "prompt:",
        "raw input:",
        "raw output:",
    ]
    .iter()
    .any(|pattern| value.contains(pattern))
}

pub async fn submit_product_feedback(
    pool: &PgPool,
    capability: &str,
    input: ProductFeedbackReportInput,
) -> Result<(ProductInteraction, ProductFeedbackReport), ApiError> {
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
    let findings = serde_json::to_value(findings).map_err(ApiError::internal)?;
    let workaround = workaround
        .map(serde_json::to_value)
        .transpose()
        .map_err(ApiError::internal)?;

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
          'feedback_report', $5, TO_TIMESTAMP($6))
        ON CONFLICT (id) DO UPDATE SET
          classification = 'confirmed',
          confirmation_method = COALESCE(interactions_v2.confirmation_method, 'feedback_report'),
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

    if let Some(existing) = sqlx::query_as::<_, ProductFeedbackReport>(
        "SELECT * FROM feedback_reports WHERE interaction_id = $1",
    )
    .bind(claims.i)
    .fetch_optional(&mut *tx)
    .await?
    {
        tx.commit().await?;
        return Ok((interaction, existing));
    }
    let report = sqlx::query_as::<_, ProductFeedbackReport>(
        r#"INSERT INTO feedback_reports
        (id, workspace_id, interaction_id, summary, impact, confidence, findings, workaround)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(key.0)
    .bind(claims.i)
    .bind(summary)
    .bind(input.impact)
    .bind(input.confidence)
    .bind(findings)
    .bind(workaround)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((interaction, report))
}

#[cfg(test)]
mod product_tests {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use sqlx::postgres::PgPoolOptions;

    use super::*;

    fn test_error(error: ApiError) -> anyhow::Error {
        anyhow::anyhow!("{}: {}", error.status, error.message)
    }

    fn api_key_headers(secret: &str) -> anyhow::Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {secret}"))?,
        );
        Ok(headers)
    }

    #[test]
    fn feedback_cursor_is_opaque_and_retention_bounded() -> anyhow::Result<()> {
        let occurred_at = Utc::now() - Duration::hours(1);
        let id = Uuid::new_v4();
        let encoded = encode_feedback_cursor(occurred_at, id).map_err(test_error)?;
        anyhow::ensure!(!encoded.contains(&id.to_string()));
        let decoded = decode_feedback_cursor(Some(&encoded), Utc::now() - Duration::days(1))
            .map_err(test_error)?
            .unwrap();
        anyhow::ensure!(decoded.id == id);
        anyhow::ensure!(decoded.occurred_at == occurred_at);
        let expired = decode_feedback_cursor(Some(&encoded), Utc::now()).unwrap_err();
        anyhow::ensure!(expired.status == StatusCode::GONE);
        anyhow::ensure!(
            decode_feedback_cursor(Some("not-a-cursor"), Utc::now() - Duration::days(1))
                .unwrap_err()
                .status
                == StatusCode::BAD_REQUEST
        );
        Ok(())
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
    async fn read_key_auth_kind_caps_and_expiration() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;

        let workspace_id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO workspaces (id, os_user_id, name, slug)
            VALUES ($1, $2, 'Read key acceptance', $3)"#,
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
            let read_on_write = agent_product_auth(&pool, &read_headers).await.unwrap_err();
            anyhow::ensure!(read_on_write.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(read_on_write.message == "Invalid API key");
            let write_on_read = read_product_auth(&pool, &write_headers).await.unwrap_err();
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
                    r#"INSERT INTO interactions_v2
                    (id, workspace_id, environment_id, api_key_id, surface, operation,
                     customer_ref, classification, confirmation_method, occurred_at)
                    VALUES ($1, $2, $3, $4, 'mcp', $5, 'acct_1',
                            'confirmed', 'mcp', $6)"#,
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
            anyhow::ensure!(summary.review_rate == 0.5);
            anyhow::ensure!(summary.confirmation_rate == 1.0);
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
            .unwrap_err();
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
            .unwrap_err();
            anyhow::ensure!(write_cap.status == StatusCode::CONFLICT);

            sqlx::query(
                "UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
            )
            .bind(read_key.id)
            .execute(&pool)
            .await?;
            let expired = read_product_auth(&pool, &read_headers).await.unwrap_err();
            anyhow::ensure!(expired.status == StatusCode::UNAUTHORIZED);
            anyhow::ensure!(expired.message == "API key expired");
            let invalid_headers = api_key_headers("af_read_missing")?;
            let invalid = read_product_auth(&pool, &invalid_headers)
                .await
                .unwrap_err();
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
            let current_product = search_dashboard.current_product.unwrap();
            anyhow::ensure!(current_product.id == search.id);
            anyhow::ensure!(current_product.name == "Search v2");
            anyhow::ensure!(search_dashboard.interactions.len() == 1);
            anyhow::ensure!(search_dashboard.api_keys.len() == 1);

            let docs_dashboard = dashboard(&pool, context(), Some(docs.id), None)
                .await
                .map_err(test_error)?;
            anyhow::ensure!(docs_dashboard.current_product.unwrap().id == docs.id);
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
            anyhow::ensure!(remaining.current_product.unwrap().id == docs.id);

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
                    display_name: owner.display_name.clone().unwrap(),
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
            anyhow::ensure!(
                accept_team_invitation(&pool, &guest, link_invitation.id)
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
