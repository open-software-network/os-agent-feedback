#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

//! Data destinations: continuous piping of workspace data into the customer's
//! own data system.
//!
//! Companies aggregate their user data in one place — a warehouse, lake,
//! transactional database, or collector endpoint. A data destination is a
//! workspace-scoped pipe that continuously exports Epode's feedback reports
//! and interaction telemetry into that system.
//!
//! Two transports ship today:
//!
//! - `postgres`: upsert into a PostgreSQL-compatible database, which covers
//!   direct SQL database destinations.
//! - `http_ndjson`: POST newline-delimited JSON batches to a collector URL,
//!   which covers lake and object-store ingestion endpoints without Epode
//!   holding cloud credentials.
//!
//! Warehouse-specific kinds plug into the same claim/cursor/export pipeline
//! as they land.
//!
//! Delivery is at-least-once: the per-stream keyset cursor only advances
//! after a batch is durably delivered, so a crash re-delivers and every
//! write is an idempotent upsert keyed by `(stream, id)`.

use std::{collections::BTreeMap, net::IpAddr, str::FromStr, time::Duration as StdDuration};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use chrono::{DateTime, Utc};
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::error::ApiError;

pub(crate) const KIND_POSTGRES: &str = "postgres";
pub(crate) const KIND_HTTP_NDJSON: &str = "http_ndjson";
pub(crate) const ENABLED_KINDS: [&str; 2] = [KIND_POSTGRES, KIND_HTTP_NDJSON];

pub(crate) const STREAM_INTERACTIONS: &str = "interactions";
pub(crate) const STREAM_FEEDBACK_REPORTS: &str = "feedback_reports";
const STREAMS: [&str; 2] = [STREAM_INTERACTIONS, STREAM_FEEDBACK_REPORTS];

/// Rows fetched per stream per delivery attempt.
const EXPORT_BATCH_SIZE: i64 = 500;
/// Total rows one run may export before yielding to the next run.
const EXPORT_RUN_ROW_CAP: i64 = 10_000;
/// Whole-run ceiling; the stale-claim age must comfortably exceed this.
const EXPORT_RUN_TIMEOUT: StdDuration = StdDuration::from_mins(8);
/// Claims older than this belong to a dead worker and are reclaimable.
pub(crate) const DESTINATION_STALE_CLAIM_AGE: chrono::Duration = chrono::Duration::minutes(10);
/// Failed runs retry on this cadence instead of the configured interval.
const FAILURE_RETRY_DELAY: chrono::Duration = chrono::Duration::minutes(5);

const SEAL_CONTEXT: &[u8] = b"epode-data-destination-credentials-v1";
const MAX_CREDENTIAL_VALUE_LENGTH: usize = 4096;

// ---------------------------------------------------------------------------
// API models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DataDestinationConfigInput {
    /// `postgres`: connection URL without an embedded password, e.g.
    /// `postgres://user@host:5432/dbname?sslmode=require`.
    pub connection_url: Option<String>,
    /// `postgres`: schema that receives the export tables; defaults to `public`.
    pub schema: Option<String>,
    /// `http_ndjson`: collector URL that accepts NDJSON POST batches.
    pub url: Option<String>,
    /// `http_ndjson`: extra request headers. Non-sensitive only: values are
    /// stored in plaintext configuration, not in the sealed credential store.
    pub headers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DataDestinationCredentialsInput {
    /// `postgres`: database password (the URL never carries one).
    pub password: Option<String>,
    /// `http_ndjson`: sent as `Authorization: Bearer <token>`.
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateDataDestinationInput {
    pub name: String,
    pub kind: String,
    pub config: DataDestinationConfigInput,
    pub credentials: Option<DataDestinationCredentialsInput>,
    pub sync_interval_seconds: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TestDataDestinationInput {
    pub kind: String,
    pub config: DataDestinationConfigInput,
    pub credentials: Option<DataDestinationCredentialsInput>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateDataDestinationInput {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub sync_interval_seconds: Option<i32>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationSyncRun {
    pub id: Uuid,
    pub destination_id: Uuid,
    /// 'scheduled' | 'manual'
    pub trigger: String,
    /// 'running' | 'succeeded' | 'failed'
    pub status: String,
    pub records_exported: i64,
    #[schema(required = true, nullable)]
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestination {
    pub id: Uuid,
    pub name: String,
    /// `postgres` | `http_ndjson`
    pub kind: String,
    /// Normalized non-secret configuration. Credentials are never returned.
    pub config: Value,
    pub enabled: bool,
    pub sync_interval_seconds: i32,
    pub next_sync_at: DateTime<Utc>,
    /// True while a worker holds the sync claim.
    pub syncing: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub last_run: Option<DataDestinationSyncRun>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationsResponse {
    pub destinations: Vec<DataDestination>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationResponse {
    pub destination: DataDestination,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationRunsResponse {
    pub runs: Vec<DataDestinationSyncRun>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationTestResponse {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDestinationSyncTriggeredResponse {
    pub triggered: bool,
    pub run_id: Uuid,
}

// ---------------------------------------------------------------------------
// Storage rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct DataDestinationRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub kind: String,
    pub config: Value,
    pub credentials_sealed: Option<Vec<u8>>,
    pub enabled: bool,
    pub sync_interval_seconds: i32,
    pub next_sync_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SyncRunRow {
    id: Uuid,
    destination_id: Uuid,
    trigger: String,
    status: String,
    records_exported: i64,
    error: Option<String>,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

impl SyncRunRow {
    fn into_response(self) -> DataDestinationSyncRun {
        DataDestinationSyncRun {
            id: self.id,
            destination_id: self.destination_id,
            trigger: self.trigger,
            status: self.status,
            records_exported: self.records_exported,
            error: self.error,
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
}

impl DataDestinationRow {
    fn into_response(self, last_run: Option<DataDestinationSyncRun>) -> DataDestination {
        DataDestination {
            id: self.id,
            name: self.name,
            kind: self.kind,
            config: self.config,
            enabled: self.enabled,
            sync_interval_seconds: self.sync_interval_seconds,
            next_sync_at: self.next_sync_at,
            syncing: self.claimed_at.is_some(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_run,
        }
    }
}

// ---------------------------------------------------------------------------
// Credential sealing (AES-256-GCM under a key derived from the deployment's
// identity HMAC secret; the secret never appears in the sealed bytes).
// ---------------------------------------------------------------------------

fn seal_key(identity_hmac_secret: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(SEAL_CONTEXT);
    hasher.update(identity_hmac_secret);
    hasher.finalize().into()
}

pub(crate) fn seal_credentials(
    identity_hmac_secret: &[u8],
    credentials: &Value,
) -> Result<Vec<u8>, ApiError> {
    let plaintext = serde_json::to_vec(credentials).map_err(ApiError::internal)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&seal_key(
        identity_hmac_secret,
    )));
    let mut nonce_bytes = [0_u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_slice())
        .map_err(|_| ApiError::internal("Credential sealing failed"))?;
    let mut sealed = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    sealed.extend_from_slice(&nonce_bytes);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

fn unseal_credentials(
    identity_hmac_secret: &[u8],
    sealed: &[u8],
) -> Result<Value, DataDestinationError> {
    if sealed.len() < 12 + 16 {
        return Err(DataDestinationError::new(
            "stored credentials are malformed; re-create the destination",
        ));
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&seal_key(
        identity_hmac_secret,
    )));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| {
            DataDestinationError::new(
                "stored credentials could not be unsealed; re-create the destination",
            )
        })?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| DataDestinationError::new("stored credentials are not valid JSON"))
}

// ---------------------------------------------------------------------------
// Validation and normalization
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct NormalizedDestination {
    config: Value,
    credentials: Option<Value>,
}

fn validate_name(name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(
            "Destination name must be 1-120 characters without control characters",
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_kind(kind: &str) -> Result<&'static str, ApiError> {
    ENABLED_KINDS
        .iter()
        .find(|enabled| **enabled == kind)
        .copied()
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "Destination kind must be one of: {}",
                ENABLED_KINDS.join(", ")
            ))
        })
}

fn validate_sync_interval(seconds: Option<i32>) -> Result<i32, ApiError> {
    let value = seconds.unwrap_or(300);
    if !(5..=86_400).contains(&value) {
        return Err(ApiError::bad_request(
            "Sync interval must be between 5 and 86400 seconds",
        ));
    }
    Ok(value)
}

fn validate_schema_name(schema: &str) -> Result<String, ApiError> {
    let trimmed = schema.trim();
    let valid = !trimmed.is_empty()
        && trimmed.chars().count() <= 63
        && trimmed
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_');
    if !valid {
        return Err(ApiError::bad_request(
            "Schema must start with a letter or underscore and contain only letters, digits, and underscores",
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_postgres_url(raw: &str) -> Result<String, ApiError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| ApiError::bad_request("Connection URL is not a valid URL"))?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(ApiError::bad_request(
            "Connection URL must use the postgres:// scheme",
        ));
    }
    if url.host_str().is_none() {
        return Err(ApiError::bad_request("Connection URL must include a host"));
    }
    if url.password().is_some() {
        return Err(ApiError::bad_request(
            "Connection URL must not embed a password; pass it as the credentials password",
        ));
    }
    Ok(url.to_string())
}

fn validate_http_url(raw: &str) -> Result<String, ApiError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| ApiError::bad_request("Collector URL is not a valid URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| ApiError::bad_request("Collector URL must include a host"))?;
    let loopback =
        host == "localhost" || IpAddr::from_str(host).is_ok_and(|address| address.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(ApiError::bad_request(
            "Collector URL must use HTTPS (HTTP is allowed only for loopback development)",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::bad_request(
            "Collector URL must not embed credentials; pass a token as the credentials token",
        ));
    }
    Ok(url.to_string())
}

fn validate_headers(headers: &BTreeMap<String, String>) -> Result<(), ApiError> {
    const RESERVED: [&str; 4] = ["authorization", "content-type", "content-length", "host"];
    for (name, value) in headers {
        if name.len() > 128
            || name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err(ApiError::bad_request(format!(
                "Header name {name:?} is not a valid HTTP header name"
            )));
        }
        if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(ApiError::bad_request(format!(
                "Header {name:?} is managed by the destination transport"
            )));
        }
        if value.len() > 1024 || value.chars().any(char::is_control) {
            return Err(ApiError::bad_request(format!(
                "Header {name:?} has an invalid value"
            )));
        }
    }
    Ok(())
}

fn validate_credential_value(value: &str, field: &str) -> Result<String, ApiError> {
    if value.is_empty()
        || value.len() > MAX_CREDENTIAL_VALUE_LENGTH
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(format!(
            "Credential {field} must be 1-{MAX_CREDENTIAL_VALUE_LENGTH} characters without control characters"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_destination(
    kind: &str,
    config: &DataDestinationConfigInput,
    credentials: Option<&DataDestinationCredentialsInput>,
) -> Result<NormalizedDestination, ApiError> {
    match kind {
        KIND_POSTGRES => {
            if config.url.is_some() || config.headers.is_some() {
                return Err(ApiError::bad_request(
                    "postgres destinations accept only connectionUrl and schema",
                ));
            }
            if credentials.is_some_and(|value| value.token.is_some()) {
                return Err(ApiError::bad_request(
                    "postgres destinations accept only a credentials password",
                ));
            }
            let connection_url = validate_postgres_url(
                config
                    .connection_url
                    .as_deref()
                    .ok_or_else(|| ApiError::bad_request("connectionUrl is required"))?,
            )?;
            let schema = validate_schema_name(config.schema.as_deref().unwrap_or("public"))?;
            let password = credentials
                .and_then(|value| value.password.as_deref())
                .map(|value| validate_credential_value(value, "password"))
                .transpose()?;
            Ok(NormalizedDestination {
                config: json!({ "connectionUrl": connection_url, "schema": schema }),
                credentials: password.map(|value| json!({ "password": value })),
            })
        }
        KIND_HTTP_NDJSON => {
            if config.connection_url.is_some() || config.schema.is_some() {
                return Err(ApiError::bad_request(
                    "http_ndjson destinations accept only url and headers",
                ));
            }
            if credentials.is_some_and(|value| value.password.is_some()) {
                return Err(ApiError::bad_request(
                    "http_ndjson destinations accept only a credentials token",
                ));
            }
            let url = validate_http_url(
                config
                    .url
                    .as_deref()
                    .ok_or_else(|| ApiError::bad_request("url is required"))?,
            )?;
            let headers = config.headers.clone().unwrap_or_default();
            validate_headers(&headers)?;
            let token = credentials
                .and_then(|value| value.token.as_deref())
                .map(|value| validate_credential_value(value, "token"))
                .transpose()?;
            Ok(NormalizedDestination {
                config: json!({ "url": url, "headers": headers }),
                credentials: token.map(|value| json!({ "token": value })),
            })
        }
        other => Err(ApiError::bad_request(format!(
            "Destination kind {other:?} is not supported"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Store: CRUD
// ---------------------------------------------------------------------------

const DESTINATION_COLUMNS: &str = "id, workspace_id, name, kind, config, credentials_sealed, \
     enabled, sync_interval_seconds, next_sync_at, claimed_at, created_at, \
     updated_at";

pub(crate) async fn list_data_destinations(
    pool: &PgPool,
    workspace_id: Uuid,
) -> Result<Vec<DataDestination>, ApiError> {
    let rows = sqlx::query_as::<_, DataDestinationRow>(&format!(
        "SELECT {DESTINATION_COLUMNS} FROM data_destinations
        WHERE workspace_id = $1 ORDER BY created_at, id"
    ))
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;
    let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let last_runs = sqlx::query_as::<_, SyncRunRow>(
        r"SELECT DISTINCT ON (destination_id)
          id, destination_id, trigger, status, records_exported, error, started_at, finished_at
        FROM data_destination_sync_runs
        WHERE destination_id = ANY($1)
        ORDER BY destination_id, started_at DESC",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let mut last_run_by_destination = BTreeMap::new();
    for run in last_runs {
        last_run_by_destination.insert(run.destination_id, run.into_response());
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let last_run = last_run_by_destination.remove(&row.id);
            row.into_response(last_run)
        })
        .collect())
}

pub(crate) async fn create_data_destination(
    pool: &PgPool,
    identity_hmac_secret: &[u8],
    workspace_id: Uuid,
    input: &CreateDataDestinationInput,
) -> Result<DataDestination, ApiError> {
    let name = validate_name(&input.name)?;
    let kind = validate_kind(&input.kind)?;
    let sync_interval_seconds = validate_sync_interval(input.sync_interval_seconds)?;
    let normalized = normalize_destination(kind, &input.config, input.credentials.as_ref())?;
    let sealed = normalized
        .credentials
        .as_ref()
        .map(|credentials| seal_credentials(identity_hmac_secret, credentials))
        .transpose()?;

    let row = sqlx::query_as::<_, DataDestinationRow>(&format!(
        "INSERT INTO data_destinations
        (id, workspace_id, name, kind, config, credentials_sealed, sync_interval_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING {DESTINATION_COLUMNS}"
    ))
    .bind(Uuid::new_v4())
    .bind(workspace_id)
    .bind(&name)
    .bind(kind)
    .bind(&normalized.config)
    .bind(sealed)
    .bind(sync_interval_seconds)
    .fetch_one(pool)
    .await
    .map_err(|error| {
        if let sqlx::Error::Database(database) = &error
            && database.is_unique_violation()
        {
            return ApiError::bad_request(
                "A data destination with this name already exists for this team",
            );
        }
        ApiError::from(error)
    })?;
    Ok(row.into_response(None))
}

pub(crate) async fn update_data_destination(
    pool: &PgPool,
    workspace_id: Uuid,
    destination_id: Uuid,
    input: &UpdateDataDestinationInput,
) -> Result<DataDestination, ApiError> {
    let name = input.name.as_deref().map(validate_name).transpose()?;
    let sync_interval_seconds = input
        .sync_interval_seconds
        .map(|seconds| validate_sync_interval(Some(seconds)))
        .transpose()?;
    let row = sqlx::query_as::<_, DataDestinationRow>(&format!(
        "UPDATE data_destinations SET
          name = COALESCE($3, name),
          enabled = COALESCE($4, enabled),
          sync_interval_seconds = COALESCE($5, sync_interval_seconds),
          -- Resuming (or retuning) a destination should not wait for the old
          -- schedule: make it due on the next worker pass.
          next_sync_at = CASE
            WHEN $4 IS TRUE OR $5 IS NOT NULL THEN NOW()
            ELSE next_sync_at
          END,
          updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING {DESTINATION_COLUMNS}"
    ))
    .bind(destination_id)
    .bind(workspace_id)
    .bind(name)
    .bind(input.enabled)
    .bind(sync_interval_seconds)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::not_found("Data destination not found for this team"))?;
    Ok(row.into_response(None))
}

pub(crate) async fn delete_data_destination(
    pool: &PgPool,
    workspace_id: Uuid,
    destination_id: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query("DELETE FROM data_destinations WHERE id = $1 AND workspace_id = $2")
        .bind(destination_id)
        .bind(workspace_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn list_data_destination_runs(
    pool: &PgPool,
    workspace_id: Uuid,
    destination_id: Uuid,
    limit: i64,
) -> Result<Vec<DataDestinationSyncRun>, ApiError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM data_destinations WHERE id = $1 AND workspace_id = $2)",
    )
    .bind(destination_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;
    if !exists {
        return Err(ApiError::not_found(
            "Data destination not found for this team",
        ));
    }
    let rows = sqlx::query_as::<_, SyncRunRow>(
        r"SELECT id, destination_id, trigger, status, records_exported, error, started_at,
          finished_at
        FROM data_destination_sync_runs
        WHERE destination_id = $1 AND workspace_id = $2
        ORDER BY started_at DESC
        LIMIT $3",
    )
    .bind(destination_id)
    .bind(workspace_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(SyncRunRow::into_response).collect())
}

// ---------------------------------------------------------------------------
// Store: claiming and run lifecycle
// ---------------------------------------------------------------------------

/// A destination claimed for one export run. The claim token proves ownership:
/// finishing a run requires it, so a stale-claim reset cannot be clobbered by
/// the worker that lost its lease.
#[derive(Debug)]
pub(crate) struct DataDestinationJob {
    pub destination: DataDestinationRow,
    pub claim_token: Uuid,
    pub run_id: Uuid,
}

async fn release_stale_claims(pool: &PgPool, stale_before: DateTime<Utc>) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE data_destinations SET claimed_at = NULL, claim_token = NULL
        WHERE claimed_at IS NOT NULL AND claimed_at < $1",
    )
    .bind(stale_before)
    .execute(&mut *tx)
    .await?;
    // A run left 'running' past the stale window belongs to a worker that
    // died mid-export. Mark it failed so the dashboard never shows a
    // permanently spinning run.
    sqlx::query(
        "UPDATE data_destination_sync_runs
        SET status = 'failed',
          error = 'Sync worker restarted before the run finished',
          finished_at = NOW()
        WHERE status = 'running' AND started_at < $1",
    )
    .bind(stale_before)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn claim_due_data_destination(
    pool: &PgPool,
    stale_before: DateTime<Utc>,
) -> Result<Option<DataDestinationJob>, ApiError> {
    release_stale_claims(pool, stale_before).await?;
    let claim_token = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, DataDestinationRow>(
        "WITH claimable AS (
          SELECT id FROM data_destinations
          WHERE enabled AND claimed_at IS NULL AND next_sync_at <= NOW()
          ORDER BY next_sync_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE data_destinations destination
        SET claimed_at = NOW(), claim_token = $1, updated_at = NOW()
        FROM claimable
        WHERE destination.id = claimable.id
        RETURNING destination.id, destination.workspace_id, destination.name, destination.kind,
          destination.config, destination.credentials_sealed, destination.enabled,
          destination.sync_interval_seconds, destination.next_sync_at, destination.claimed_at,
          destination.created_at, destination.updated_at",
    )
    .bind(claim_token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(destination) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO data_destination_sync_runs
        (id, destination_id, workspace_id, trigger, status)
        VALUES ($1, $2, $3, 'scheduled', 'running')",
    )
    .bind(run_id)
    .bind(destination.id)
    .bind(destination.workspace_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(DataDestinationJob {
        destination,
        claim_token,
        run_id,
    }))
}

/// Manual "sync now": claims the destination only when no worker holds it, so
/// a manual run can never double-export alongside a scheduled one.
pub(crate) async fn claim_data_destination_now(
    pool: &PgPool,
    workspace_id: Uuid,
    destination_id: Uuid,
    stale_before: DateTime<Utc>,
) -> Result<DataDestinationJob, ApiError> {
    release_stale_claims(pool, stale_before).await?;
    let claim_token = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, DataDestinationRow>(&format!(
        "UPDATE data_destinations
        SET claimed_at = NOW(), claim_token = $3, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2 AND claimed_at IS NULL
        RETURNING {DESTINATION_COLUMNS}"
    ))
    .bind(destination_id)
    .bind(workspace_id)
    .bind(claim_token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(destination) = row else {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM data_destinations WHERE id = $1 AND workspace_id = $2)",
        )
        .bind(destination_id)
        .bind(workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        return if exists {
            Err(ApiError::conflict(
                "A sync is already in progress for this destination",
            ))
        } else {
            Err(ApiError::not_found(
                "Data destination not found for this team",
            ))
        };
    };
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO data_destination_sync_runs
        (id, destination_id, workspace_id, trigger, status)
        VALUES ($1, $2, $3, 'manual', 'running')",
    )
    .bind(run_id)
    .bind(destination.id)
    .bind(destination.workspace_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DataDestinationJob {
        destination,
        claim_token,
        run_id,
    })
}

#[derive(Debug)]
pub(crate) enum DataDestinationRunOutcome {
    Succeeded { records_exported: i64 },
    Failed { error: String },
}

pub(crate) async fn finish_data_destination_run(
    pool: &PgPool,
    job: &DataDestinationJob,
    outcome: DataDestinationRunOutcome,
) -> Result<(), ApiError> {
    let (status, records, error, next_sync_at) = match &outcome {
        DataDestinationRunOutcome::Succeeded { records_exported } => (
            "succeeded",
            *records_exported,
            None,
            Utc::now()
                + chrono::Duration::seconds(i64::from(job.destination.sync_interval_seconds)),
        ),
        DataDestinationRunOutcome::Failed { error } => (
            "failed",
            0,
            Some(error.chars().take(500).collect::<String>()),
            Utc::now() + FAILURE_RETRY_DELAY,
        ),
    };
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE data_destination_sync_runs
        SET status = $3, records_exported = $4, error = $5, finished_at = NOW()
        WHERE id = $1 AND destination_id = $2 AND status = 'running'",
    )
    .bind(job.run_id)
    .bind(job.destination.id)
    .bind(status)
    .bind(records)
    .bind(error)
    .execute(&mut *tx)
    .await?;
    // The claim token guard makes this a no-op for a worker whose claim was
    // already reclaimed as stale.
    sqlx::query(
        "UPDATE data_destinations
        SET claimed_at = NULL, claim_token = NULL, next_sync_at = $3, updated_at = NOW()
        WHERE id = $1 AND claim_token = $2",
    )
    .bind(job.destination.id)
    .bind(job.claim_token)
    .bind(next_sync_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Store: export reads and cursors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct StreamCursor {
    record_at: DateTime<Utc>,
    record_id: Uuid,
}

async fn read_cursor(
    pool: &PgPool,
    destination_id: Uuid,
    stream: &str,
) -> Result<StreamCursor, ApiError> {
    let row: Option<(DateTime<Utc>, Uuid)> = sqlx::query_as(
        "SELECT last_record_at, last_record_id FROM data_destination_cursors
        WHERE destination_id = $1 AND stream = $2",
    )
    .bind(destination_id)
    .bind(stream)
    .fetch_optional(pool)
    .await?;
    Ok(row.map_or(
        StreamCursor {
            record_at: DateTime::UNIX_EPOCH,
            record_id: Uuid::nil(),
        },
        |(record_at, record_id)| StreamCursor {
            record_at,
            record_id,
        },
    ))
}

/// The cursor only moves forward after a batch is durably delivered; callers
/// must deliver first, then advance. A crash between the two re-delivers the
/// batch, which is safe because every transport writes idempotent upserts.
async fn advance_cursor(
    pool: &PgPool,
    destination_id: Uuid,
    stream: &str,
    cursor: StreamCursor,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO data_destination_cursors
        (destination_id, stream, last_record_at, last_record_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (destination_id, stream) DO UPDATE SET
          last_record_at = EXCLUDED.last_record_at,
          last_record_id = EXCLUDED.last_record_id,
          updated_at = NOW()",
    )
    .bind(destination_id)
    .bind(stream)
    .bind(cursor.record_at)
    .bind(cursor.record_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// One exportable record: the stream envelope plus the record payload.
#[derive(Debug, Clone)]
struct ExportRecord {
    id: Uuid,
    /// Cursor timestamp for this record (`updated_at` for interactions,
    /// `created_at` for append-only reports).
    cursor_at: DateTime<Utc>,
    record: Value,
}

#[derive(Debug, sqlx::FromRow)]
struct InteractionExportRow {
    id: Uuid,
    product_id: Option<Uuid>,
    product_slug: Option<String>,
    environment_slug: Option<String>,
    session_id: Option<Uuid>,
    surface: String,
    operation: String,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    classification: String,
    confirmation_method: Option<String>,
    runtime_hint: Option<String>,
    runtime_hint_source: Option<String>,
    client_sequence: Option<i64>,
    occurred_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl InteractionExportRow {
    fn into_record(self) -> ExportRecord {
        ExportRecord {
            id: self.id,
            cursor_at: self.updated_at,
            record: json!({
                "id": self.id,
                "productId": self.product_id,
                "productSlug": self.product_slug,
                "environmentSlug": self.environment_slug,
                "sessionId": self.session_id,
                "surface": self.surface,
                "operation": self.operation,
                "statusCode": self.status_code,
                "durationMs": self.duration_ms,
                "classification": self.classification,
                "confirmationMethod": self.confirmation_method,
                "runtimeHint": self.runtime_hint,
                "runtimeHintSource": self.runtime_hint_source,
                "clientSequence": self.client_sequence,
                "occurredAt": self.occurred_at,
                "createdAt": self.created_at,
                "updatedAt": self.updated_at,
            }),
        }
    }
}

#[derive(Debug, sqlx::FromRow)]
struct FeedbackReportExportRow {
    id: Uuid,
    product_id: Option<Uuid>,
    product_slug: Option<String>,
    environment_slug: Option<String>,
    interaction_id: Uuid,
    summary: String,
    impact: Option<String>,
    confidence: Option<f64>,
    findings: Value,
    workaround: Option<Value>,
    source: String,
    created_at: DateTime<Utc>,
}

impl FeedbackReportExportRow {
    fn into_record(self) -> ExportRecord {
        ExportRecord {
            id: self.id,
            cursor_at: self.created_at,
            record: json!({
                "id": self.id,
                "productId": self.product_id,
                "productSlug": self.product_slug,
                "environmentSlug": self.environment_slug,
                "interactionId": self.interaction_id,
                "summary": self.summary,
                "impact": self.impact,
                "confidence": self.confidence,
                "findings": self.findings,
                "workaround": self.workaround,
                "source": self.source,
                "createdAt": self.created_at,
            }),
        }
    }
}

/// Keyset-paginated export read. Interactions are keyed on `updated_at` so a
/// later classification change re-exports the row as an upsert; reports are
/// append-only and key on `created_at`.
async fn fetch_export_batch(
    pool: &PgPool,
    workspace_id: Uuid,
    stream: &str,
    cursor: StreamCursor,
    limit: i64,
) -> Result<Vec<ExportRecord>, ApiError> {
    match stream {
        STREAM_INTERACTIONS => {
            let rows = sqlx::query_as::<_, InteractionExportRow>(
                r"SELECT
                  interaction.id,
                  product.id AS product_id,
                  product.slug AS product_slug,
                  environment.slug AS environment_slug,
                  interaction.session_id,
                  interaction.surface,
                  interaction.operation,
                  interaction.status_code,
                  interaction.duration_ms,
                  interaction.classification,
                  interaction.confirmation_method,
                  interaction.runtime_hint,
                  interaction.runtime_hint_source,
                  interaction.client_sequence,
                  interaction.occurred_at,
                  interaction.created_at,
                  interaction.updated_at
                FROM interactions_v2 interaction
                LEFT JOIN product_environments environment
                  ON environment.id = interaction.environment_id
                LEFT JOIN products product ON product.id = environment.product_id
                WHERE interaction.workspace_id = $1
                  AND (interaction.updated_at, interaction.id) > ($2, $3)
                ORDER BY interaction.updated_at, interaction.id
                LIMIT $4",
            )
            .bind(workspace_id)
            .bind(cursor.record_at)
            .bind(cursor.record_id)
            .bind(limit)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(InteractionExportRow::into_record)
                .collect())
        }
        STREAM_FEEDBACK_REPORTS => {
            let rows = sqlx::query_as::<_, FeedbackReportExportRow>(
                r"SELECT
                  report.id,
                  product.id AS product_id,
                  product.slug AS product_slug,
                  environment.slug AS environment_slug,
                  report.interaction_id,
                  report.summary,
                  report.impact,
                  report.confidence,
                  report.findings,
                  report.workaround,
                  report.source,
                  report.created_at
                FROM feedback_reports report
                LEFT JOIN interactions_v2 interaction ON interaction.id = report.interaction_id
                LEFT JOIN product_environments environment
                  ON environment.id = interaction.environment_id
                LEFT JOIN products product ON product.id = environment.product_id
                WHERE report.workspace_id = $1
                  AND (report.created_at, report.id) > ($2, $3)
                ORDER BY report.created_at, report.id
                LIMIT $4",
            )
            .bind(workspace_id)
            .bind(cursor.record_at)
            .bind(cursor.record_id)
            .bind(limit)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(FeedbackReportExportRow::into_record)
                .collect())
        }
        other => Err(ApiError::internal(format!("unknown export stream {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/// A recoverable export failure. These become failed runs with the message
/// surfaced on the dashboard, and the run retries on the failure cadence.
#[derive(Debug)]
pub(crate) struct DataDestinationError(String);

impl DataDestinationError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for DataDestinationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DataDestinationError {}

fn export_envelope(stream: &str, record: &ExportRecord, exported_at: DateTime<Utc>) -> Value {
    json!({
        "stream": stream,
        "id": record.id,
        "exportedAt": exported_at,
        "record": record.record,
    })
}

fn postgres_connect_options(config: &Value, credentials: Option<&Value>) -> String {
    let mut url = config
        .get("connectionUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Some(password) = credentials
        .and_then(|value| value.get("password"))
        .and_then(Value::as_str)
    {
        // Insert the password into the authority rather than logging it: the
        // URL only ever lives in memory here, never in an error message.
        if let Ok(mut parsed) = reqwest::Url::parse(&url)
            && parsed.set_password(Some(password)).is_ok()
        {
            url = parsed.to_string();
        }
    }
    url
}

async fn deliver_postgres_batch(
    config: &Value,
    credentials: Option<&Value>,
    stream: &str,
    batch: &[ExportRecord],
) -> Result<(), DataDestinationError> {
    let url = postgres_connect_options(config, credentials);
    let schema = config
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or("public");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(StdDuration::from_secs(15))
        .connect(&url)
        .await
        .map_err(|error| DataDestinationError::new(format!("connection failed: {error}")))?;
    let result = deliver_postgres_batch_inner(&pool, schema, stream, batch).await;
    pool.close().await;
    result
}

async fn deliver_postgres_batch_inner(
    pool: &PgPool,
    schema: &str,
    stream: &str,
    batch: &[ExportRecord],
) -> Result<(), DataDestinationError> {
    // `schema` passed destination validation, so it is a bare identifier and
    // safe to interpolate (sqlx cannot bind identifiers).
    let table = format!("\"{schema}\".epode_data_exports");
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| DataDestinationError::new(format!("transaction failed: {error}")))?;
    sqlx::query(&format!(
        "CREATE TABLE IF NOT EXISTS {table} (
          stream TEXT NOT NULL,
          id UUID NOT NULL,
          record JSONB NOT NULL,
          exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (stream, id)
        )"
    ))
    .execute(&mut *tx)
    .await
    .map_err(|error| DataDestinationError::new(format!("table setup failed: {error}")))?;
    let exported_at = Utc::now();
    for record in batch {
        sqlx::query(&format!(
            "INSERT INTO {table} (stream, id, record, exported_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (stream, id) DO UPDATE SET
              record = EXCLUDED.record,
              exported_at = EXCLUDED.exported_at"
        ))
        .bind(stream)
        .bind(record.id)
        .bind(&record.record)
        .bind(exported_at)
        .execute(&mut *tx)
        .await
        .map_err(|error| DataDestinationError::new(format!("upsert failed: {error}")))?;
    }
    tx.commit()
        .await
        .map_err(|error| DataDestinationError::new(format!("commit failed: {error}")))?;
    Ok(())
}

fn http_client() -> Result<reqwest::Client, DataDestinationError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(StdDuration::from_secs(30))
        .user_agent("epode-data-destination/1")
        .build()
        .map_err(|error| DataDestinationError::new(format!("HTTP client failed: {error}")))
}

fn http_request(
    client: &reqwest::Client,
    config: &Value,
    credentials: Option<&Value>,
) -> Result<reqwest::RequestBuilder, DataDestinationError> {
    let url = config
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| DataDestinationError::new("destination config is missing url"))?;
    let mut request = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/x-ndjson");
    if let Some(token) = credentials
        .and_then(|value| value.get("token"))
        .and_then(Value::as_str)
    {
        request = request.bearer_auth(token);
    }
    if let Some(headers) = config.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            let Some(value) = value.as_str() else {
                continue;
            };
            request = request.header(name.as_str(), value);
        }
    }
    Ok(request)
}

async fn deliver_http_batch(
    config: &Value,
    credentials: Option<&Value>,
    stream: &str,
    batch: &[ExportRecord],
) -> Result<(), DataDestinationError> {
    let client = http_client()?;
    let exported_at = Utc::now();
    let body = batch
        .iter()
        .map(|record| serde_json::to_string(&export_envelope(stream, record, exported_at)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DataDestinationError::new(format!("serialization failed: {error}")))?
        .join("\n");
    let response = http_request(&client, config, credentials)?
        .body(body)
        .send()
        .await
        .map_err(|error| DataDestinationError::new(format!("delivery failed: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(DataDestinationError::new(format!(
            "collector responded with HTTP {status}"
        )));
    }
    Ok(())
}

async fn deliver_batch(
    destination: &DataDestinationRow,
    credentials: Option<&Value>,
    stream: &str,
    batch: &[ExportRecord],
) -> Result<(), DataDestinationError> {
    match destination.kind.as_str() {
        KIND_POSTGRES => {
            deliver_postgres_batch(&destination.config, credentials, stream, batch).await
        }
        KIND_HTTP_NDJSON => {
            deliver_http_batch(&destination.config, credentials, stream, batch).await
        }
        other => Err(DataDestinationError::new(format!(
            "destination kind {other:?} has no transport"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Export engine
// ---------------------------------------------------------------------------

async fn export_destination(
    pool: &PgPool,
    identity_hmac_secret: &[u8],
    job: &DataDestinationJob,
) -> Result<i64, DataDestinationError> {
    let credentials = job
        .destination
        .credentials_sealed
        .as_deref()
        .map(|sealed| unseal_credentials(identity_hmac_secret, sealed))
        .transpose()?;
    let mut total: i64 = 0;
    for stream in STREAMS {
        loop {
            let cursor = read_cursor(pool, job.destination.id, stream)
                .await
                .map_err(|error| DataDestinationError::new(error.message))?;
            let remaining = EXPORT_RUN_ROW_CAP - total;
            if remaining <= 0 {
                return Ok(total);
            }
            let batch = fetch_export_batch(
                pool,
                job.destination.workspace_id,
                stream,
                cursor,
                EXPORT_BATCH_SIZE.min(remaining),
            )
            .await
            .map_err(|error| DataDestinationError::new(error.message))?;
            if batch.is_empty() {
                break;
            }
            let last = batch.last().map_or(cursor, |record| StreamCursor {
                record_at: record.cursor_at,
                record_id: record.id,
            });
            let batch_len = i64::try_from(batch.len()).unwrap_or(i64::MAX);
            deliver_batch(&job.destination, credentials.as_ref(), stream, &batch).await?;
            // Only advance after durable delivery; a crash before this line
            // re-delivers the batch as idempotent upserts.
            advance_cursor(pool, job.destination.id, stream, last)
                .await
                .map_err(|error| DataDestinationError::new(error.message))?;
            total += batch_len;
            if batch_len < EXPORT_BATCH_SIZE {
                break;
            }
        }
    }
    Ok(total)
}

/// Runs one claimed destination to completion and records the outcome. Never
/// fails the caller: the outcome lands in the run row either way.
pub(crate) async fn drain_data_destination(
    pool: PgPool,
    identity_hmac_secret: Vec<u8>,
    job: DataDestinationJob,
) {
    let destination_id = job.destination.id;
    let export = export_destination(&pool, &identity_hmac_secret, &job);
    let outcome = match tokio::time::timeout(EXPORT_RUN_TIMEOUT, export).await {
        Ok(Ok(records_exported)) => {
            tracing::info!(%destination_id, records_exported, "data destination sync succeeded");
            DataDestinationRunOutcome::Succeeded { records_exported }
        }
        Ok(Err(error)) => {
            tracing::warn!(%destination_id, error = %error, "data destination sync failed");
            DataDestinationRunOutcome::Failed {
                error: error.to_string(),
            }
        }
        Err(_) => {
            tracing::warn!(%destination_id, "data destination sync timed out");
            DataDestinationRunOutcome::Failed {
                error: format!(
                    "Sync exceeded the {} second run limit",
                    EXPORT_RUN_TIMEOUT.as_secs()
                ),
            }
        }
    };
    if let Err(error) = finish_data_destination_run(&pool, &job, outcome).await {
        tracing::warn!(
            %destination_id,
            error = %error.message,
            "data destination run could not be recorded"
        );
    }
}

// ---------------------------------------------------------------------------
// Connection testing
// ---------------------------------------------------------------------------

pub(crate) async fn test_data_destination(
    input: &TestDataDestinationInput,
) -> Result<DataDestinationTestResponse, ApiError> {
    let kind = validate_kind(&input.kind)?;
    let normalized = normalize_destination(kind, &input.config, input.credentials.as_ref())?;
    let detail = match kind {
        KIND_POSTGRES => {
            let url = postgres_connect_options(&normalized.config, normalized.credentials.as_ref());
            let pool = PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(StdDuration::from_secs(10))
                .connect(&url)
                .await
                .map_err(|error| ApiError::bad_request(format!("Connection failed: {error}")))?;
            let check = sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&pool)
                .await;
            pool.close().await;
            check.map_err(|error| ApiError::bad_request(format!("Connection failed: {error}")))?;
            "Connected and authenticated.".to_owned()
        }
        KIND_HTTP_NDJSON => {
            let client = http_client().map_err(|error| ApiError::bad_request(error.0))?;
            // An empty batch exercises reachability and auth without writing
            // a test record into the customer's data system.
            let response =
                http_request(&client, &normalized.config, normalized.credentials.as_ref())
                    .map_err(|error| ApiError::bad_request(error.0))?
                    .body(String::new())
                    .send()
                    .await
                    .map_err(|error| ApiError::bad_request(format!("Delivery failed: {error}")))?;
            let status = response.status();
            if !status.is_success() {
                return Err(ApiError::bad_request(format!(
                    "Collector responded with HTTP {status}"
                )));
            }
            format!("Collector responded with HTTP {status}.")
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "Destination kind {other:?} is not supported"
            )));
        }
    };
    Ok(DataDestinationTestResponse { ok: true, detail })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "test failures should abort at the assertion site with explicit context"
    )]

    use super::*;

    const TEST_SECRET: &[u8] = b"epode-test-destination-secret-32-bytes!";

    fn test_error(error: ApiError) -> anyhow::Error {
        let ApiError { status, message } = error;
        anyhow::anyhow!("{status}: {message}")
    }

    fn postgres_config(url: &str) -> DataDestinationConfigInput {
        DataDestinationConfigInput {
            connection_url: Some(url.to_owned()),
            schema: None,
            url: None,
            headers: None,
        }
    }

    fn http_config(url: &str) -> DataDestinationConfigInput {
        DataDestinationConfigInput {
            connection_url: None,
            schema: None,
            url: Some(url.to_owned()),
            headers: None,
        }
    }

    #[test]
    fn sealed_credentials_round_trip_and_depend_on_the_secret() {
        let credentials = json!({ "password": "hunter2" });
        let sealed = seal_credentials(TEST_SECRET, &credentials).expect("seal succeeds");
        let unsealed = unseal_credentials(TEST_SECRET, &sealed).expect("unseal succeeds");
        assert_eq!(unsealed, credentials);

        let other_secret = b"epode-test-destination-secret-32-bytes?";
        assert!(unseal_credentials(other_secret, &sealed).is_err());
    }

    #[test]
    fn sealed_credentials_do_not_embed_the_plaintext() {
        let credentials = json!({ "token": "af_secret_token_value" });
        let sealed = seal_credentials(TEST_SECRET, &credentials).expect("seal succeeds");
        let sealed_text = String::from_utf8_lossy(&sealed);
        assert!(!sealed_text.contains("af_secret_token_value"));
    }

    #[test]
    fn postgres_urls_must_not_embed_passwords() {
        let error = normalize_destination(
            KIND_POSTGRES,
            &postgres_config("postgres://user:secret@db.internal:5432/warehouse"),
            None,
        )
        .expect_err("embedded passwords are rejected");
        assert!(error.message.contains("must not embed a password"));
    }

    #[test]
    fn postgres_normalization_defaults_the_schema() {
        let normalized = normalize_destination(
            KIND_POSTGRES,
            &postgres_config("postgres://loader@db.internal:5432/warehouse?sslmode=require"),
            None,
        )
        .expect("valid postgres destination");
        assert_eq!(normalized.config["schema"], json!("public"));
        assert_eq!(
            normalized.config["connectionUrl"],
            json!("postgres://loader@db.internal:5432/warehouse?sslmode=require")
        );
    }

    #[test]
    fn http_urls_require_https_outside_loopback() {
        assert!(
            normalize_destination(
                KIND_HTTP_NDJSON,
                &http_config("http://collector.acme.io/in"),
                None
            )
            .is_err()
        );
        assert!(
            normalize_destination(
                KIND_HTTP_NDJSON,
                &http_config("http://127.0.0.1:4310/in"),
                None,
            )
            .is_ok()
        );
        assert!(
            normalize_destination(
                KIND_HTTP_NDJSON,
                &http_config("https://collector.acme.io/in"),
                None,
            )
            .is_ok()
        );
    }

    #[tokio::test]
    async fn http_delivery_rejects_redirects_without_forwarding_records() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        use axum::{Router, http::StatusCode, routing::post};

        let sink_hits = Arc::new(AtomicUsize::new(0));
        let sink_hits_for_route = Arc::clone(&sink_hits);
        let app = Router::new()
            .route(
                "/collector",
                post(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(reqwest::header::LOCATION, "/sink")],
                    )
                }),
            )
            .route(
                "/sink",
                post(move || {
                    let sink_hits = Arc::clone(&sink_hits_for_route);
                    async move {
                        sink_hits.fetch_add(1, Ordering::SeqCst);
                        StatusCode::ACCEPTED
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("redirect test listener should bind");
        let address = listener
            .local_addr()
            .expect("redirect test listener should have an address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("redirect test server should run");
        });
        let config = json!({ "url": format!("http://{address}/collector") });
        let batch = [ExportRecord {
            id: Uuid::new_v4(),
            cursor_at: Utc::now(),
            record: json!({ "value": "private" }),
        }];

        let error = deliver_http_batch(&config, None, STREAM_INTERACTIONS, &batch)
            .await
            .expect_err("redirect should be rejected");
        assert!(error.to_string().contains("HTTP 307"));
        assert_eq!(sink_hits.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[test]
    fn http_headers_reject_reserved_names() {
        let mut config = http_config("https://collector.acme.io/in");
        config.headers = Some(BTreeMap::from([(
            "Authorization".to_owned(),
            "Bearer injected".to_owned(),
        )]));
        let error = normalize_destination(KIND_HTTP_NDJSON, &config, None)
            .expect_err("authorization is transport-managed");
        assert!(
            error
                .message
                .contains("managed by the destination transport")
        );
    }

    #[test]
    fn irrelevant_fields_are_rejected_per_kind() {
        let mut config = postgres_config("postgres://loader@db.internal/warehouse");
        config.url = Some("https://collector.acme.io/in".to_owned());
        assert!(normalize_destination(KIND_POSTGRES, &config, None).is_err());
    }

    #[test]
    fn schema_names_are_bare_identifiers() {
        let mut config = postgres_config("postgres://loader@db.internal/warehouse");
        config.schema = Some("analytics\"; DROP TABLE users; --".to_owned());
        assert!(normalize_destination(KIND_POSTGRES, &config, None).is_err());
        config.schema = Some("analytics_v2".to_owned());
        assert!(normalize_destination(KIND_POSTGRES, &config, None).is_ok());
    }

    #[test]
    fn credential_values_have_bounds() {
        let credentials = DataDestinationCredentialsInput {
            password: None,
            token: Some("x".repeat(MAX_CREDENTIAL_VALUE_LENGTH + 1)),
        };
        assert!(
            normalize_destination(
                KIND_HTTP_NDJSON,
                &http_config("https://collector.acme.io/in"),
                Some(&credentials),
            )
            .is_err()
        );
    }

    #[test]
    fn connect_options_insert_the_password_without_logging_it() {
        let config = json!({
            "connectionUrl": "postgres://loader@db.internal:5432/warehouse",
            "schema": "public",
        });
        let credentials = json!({ "password": "s3cret" });
        let url = postgres_connect_options(&config, Some(&credentials));
        assert!(url.contains("s3cret"));
        let without = postgres_connect_options(&config, None);
        assert!(!without.contains("s3cret"));
    }

    /// End-to-end store coverage: real rows are exported into a real Postgres
    /// destination, the cursor advances, reruns are idempotent, and deletes
    /// cascade. Run with `DATABASE_URL` set:
    /// `cargo test -- --ignored destinations::tests::postgres_export`
    #[tokio::test]
    #[ignore = "requires DATABASE_URL"]
    async fn postgres_export_lifecycle_is_durable_and_idempotent() -> anyhow::Result<()> {
        let database_url = std::env::var("DATABASE_URL")?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        // The ignored suite shares its scratch database; clear destination
        // state so claim assertions are independent of test order.
        sqlx::query("DELETE FROM data_destinations")
            .execute(&pool)
            .await?;

        let workspace_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, os_user_id, name, slug) VALUES ($1, $2, $3, $4)")
            .bind(workspace_id)
            .bind(format!("usr_destination_{}", workspace_id.simple()))
            .bind("Destination export test")
            .bind(format!(
                "destination-{}",
                &workspace_id.simple().to_string()[..12]
            ))
            .execute(&pool)
            .await?;
        let product_id = Uuid::new_v4();
        sqlx::query("INSERT INTO products (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)")
            .bind(product_id)
            .bind(workspace_id)
            .bind("Warehouse product")
            .bind(format!(
                "warehouse-product-{}",
                &product_id.simple().to_string()[..8]
            ))
            .execute(&pool)
            .await?;
        let environment_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO product_environments (id, workspace_id, product_id, name, slug)
            VALUES ($1, $2, $3, 'Production', 'production')",
        )
        .bind(environment_id)
        .bind(workspace_id)
        .bind(product_id)
        .execute(&pool)
        .await?;
        let interaction_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO interactions_v2
            (id, workspace_id, environment_id, surface, operation, classification,
             confirmation_method, occurred_at)
            VALUES ($1, $2, $3, 'mcp', 'submit_feedback', 'confirmed', 'mcp', NOW())",
        )
        .bind(interaction_id)
        .bind(workspace_id)
        .bind(environment_id)
        .execute(&pool)
        .await?;
        let report_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO feedback_reports (id, workspace_id, interaction_id, summary)
            VALUES ($1, $2, $3, 'The export destination lifecycle is under test.')",
        )
        .bind(report_id)
        .bind(workspace_id)
        .bind(interaction_id)
        .execute(&pool)
        .await?;

        // The destination database is a second database in the same scratch
        // instance, so the test needs no extra infrastructure.
        let sink_database = format!(
            "epode_destination_{}",
            &workspace_id.simple().to_string()[..12]
        );
        sqlx::query(&format!("CREATE DATABASE \"{sink_database}\""))
            .execute(&pool)
            .await?;
        // Reuse the scratch instance's authority (user, host, port) and swap
        // only the database name. The destination config keeps the password
        // in sealed credentials, exactly like the UI flow.
        let mut sink_authority = reqwest::Url::parse(&database_url)?;
        sink_authority
            .set_password(None)
            .map_err(|()| anyhow::anyhow!("DATABASE_URL authority could not be re-based"))?;
        sink_authority.set_path(&sink_database);
        sink_authority.set_query(None);
        let sink_password = reqwest::Url::parse(&database_url)?
            .password()
            .map(str::to_owned);

        let destination = create_data_destination(
            &pool,
            TEST_SECRET,
            workspace_id,
            &CreateDataDestinationInput {
                name: "Scratch warehouse".to_owned(),
                kind: KIND_POSTGRES.to_owned(),
                config: DataDestinationConfigInput {
                    connection_url: Some(sink_authority.to_string()),
                    schema: None,
                    url: None,
                    headers: None,
                },
                credentials: sink_password.map(|password| DataDestinationCredentialsInput {
                    password: Some(password),
                    token: None,
                }),
                sync_interval_seconds: Some(60),
            },
        )
        .await
        .map_err(test_error)?;
        assert!(destination.enabled);
        assert!(destination.last_run.is_none());
        assert_eq!(destination.config["schema"], json!("public"));
        // The sealed column never holds plaintext.
        let stored: (Option<Vec<u8>>,) =
            sqlx::query_as("SELECT credentials_sealed FROM data_destinations WHERE id = $1")
                .bind(destination.id)
                .fetch_one(&pool)
                .await?;
        if let Some(sealed) = stored.0 {
            assert!(!String::from_utf8_lossy(&sealed).contains("postgres"));
        }

        // First sync: both streams export.
        let job = claim_data_destination_now(
            &pool,
            workspace_id,
            destination.id,
            Utc::now() - DESTINATION_STALE_CLAIM_AGE,
        )
        .await
        .map_err(test_error)?;
        // A second claim while the first is in flight must conflict.
        assert!(
            claim_data_destination_now(
                &pool,
                workspace_id,
                destination.id,
                Utc::now() - DESTINATION_STALE_CLAIM_AGE,
            )
            .await
            .is_err()
        );
        drain_data_destination(pool.clone(), TEST_SECRET.to_vec(), job).await;

        let sink_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&{
                let mut url = reqwest::Url::parse(&database_url)?;
                url.set_path(&sink_database);
                url.set_query(None);
                url.to_string()
            })
            .await?;
        let exported: Vec<(String, Uuid)> =
            sqlx::query_as("SELECT stream, id FROM epode_data_exports ORDER BY stream")
                .fetch_all(&sink_pool)
                .await?;
        assert_eq!(
            exported,
            vec![
                (STREAM_FEEDBACK_REPORTS.to_owned(), report_id),
                (STREAM_INTERACTIONS.to_owned(), interaction_id),
            ]
        );
        // The exported record carries product context and the report payload.
        let record: (Value,) =
            sqlx::query_as("SELECT record FROM epode_data_exports WHERE stream = $1")
                .bind(STREAM_FEEDBACK_REPORTS)
                .fetch_one(&sink_pool)
                .await?;
        assert_eq!(record.0["productId"], json!(product_id));
        assert_eq!(
            record.0["productSlug"],
            json!(format!(
                "warehouse-product-{}",
                &product_id.simple().to_string()[..8]
            ))
        );
        assert_eq!(
            record.0["summary"],
            json!("The export destination lifecycle is under test.")
        );

        let destination = list_data_destinations(&pool, workspace_id)
            .await
            .map_err(test_error)?;
        let destination = destination.first().expect("destination listed");
        let last_run = destination.last_run.clone().expect("run recorded");
        assert_eq!(last_run.status, "succeeded");
        assert_eq!(last_run.records_exported, 2);
        assert_eq!(last_run.trigger, "manual");

        // Second sync with no new rows: zero records, cursors stable.
        let job = claim_data_destination_now(
            &pool,
            workspace_id,
            destination.id,
            Utc::now() - DESTINATION_STALE_CLAIM_AGE,
        )
        .await
        .map_err(test_error)?;
        drain_data_destination(pool.clone(), TEST_SECRET.to_vec(), job).await;
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM epode_data_exports")
            .fetch_one(&sink_pool)
            .await?;
        assert_eq!(count.0, 2);
        let runs = list_data_destination_runs(&pool, workspace_id, destination.id, 10)
            .await
            .map_err(test_error)?;
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].records_exported, 0);

        // A new report is picked up by the next sync from the cursor.
        let second_interaction_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO interactions_v2
            (id, workspace_id, environment_id, surface, operation, classification,
             confirmation_method, occurred_at)
            VALUES ($1, $2, $3, 'http_json', 'load_dashboard', 'confirmed',
              'feedback_report', NOW())",
        )
        .bind(second_interaction_id)
        .bind(workspace_id)
        .bind(environment_id)
        .execute(&pool)
        .await?;
        let second_report_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO feedback_reports (id, workspace_id, interaction_id, summary)
            VALUES ($1, $2, $3, 'A follow-up report lands after the first sync.')",
        )
        .bind(second_report_id)
        .bind(workspace_id)
        .bind(second_interaction_id)
        .execute(&pool)
        .await?;
        let job = claim_data_destination_now(
            &pool,
            workspace_id,
            destination.id,
            Utc::now() - DESTINATION_STALE_CLAIM_AGE,
        )
        .await
        .map_err(test_error)?;
        drain_data_destination(pool.clone(), TEST_SECRET.to_vec(), job).await;
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM epode_data_exports")
            .fetch_one(&sink_pool)
            .await?;
        assert_eq!(count.0, 4);

        // Deleting the destination cascades cursors and runs.
        assert!(
            delete_data_destination(&pool, workspace_id, destination.id)
                .await
                .map_err(test_error)?
        );
        let leftovers: (i64,) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM data_destination_cursors)
            + (SELECT COUNT(*) FROM data_destination_sync_runs)",
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(leftovers.0, 0);

        sink_pool.close().await;
        sqlx::query(&format!("DROP DATABASE \"{sink_database}\""))
            .execute(&pool)
            .await?;
        // The ignored suite shares its scratch database: remove this test's
        // workspace so global scans in other tests (backfills, rollups) are
        // unaffected by the rows this pipe exported.
        sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
