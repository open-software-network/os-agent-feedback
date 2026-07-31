#![allow(
    clippy::print_stdout,
    reason = "this local seed CLI reports its result through standard output"
)]

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    str::FromStr,
    time::Duration as StdDuration,
};

use anyhow::{Context, ensure};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction, postgres::PgConnectOptions, postgres::PgPoolOptions};
use uuid::Uuid;

const SCENARIO_JSON: &str = include_str!("../../seed/dashboard-demo.json");
const SEED_NAMESPACE: Uuid = Uuid::from_u128(0x4c77_81ad_96e8_4ca5_940c_40ae_931f_738d);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    version: String,
    product: ProductSeed,
    members: Vec<MemberSeed>,
    reports: Vec<ReportSeed>,
    supporting_interactions: Vec<InteractionSeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductSeed {
    name: String,
    slug: String,
    environment_name: String,
    environment_slug: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberSeed {
    alias: String,
    os_user_id: String,
    handle: String,
    display_name: String,
    role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportSeed {
    key: String,
    session_key: String,
    session_source: String,
    hours_ago: i64,
    surface: String,
    operation: String,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    customer_ref: Option<String>,
    runtime_hint: Option<String>,
    runtime_hint_source: Option<String>,
    summary: String,
    impact: Option<String>,
    confidence: Option<f64>,
    findings: Vec<FindingSeed>,
    workaround: Option<WorkaroundSeed>,
    workflow: WorkflowSeed,
}

#[derive(Debug, Deserialize, Serialize)]
struct FindingSeed {
    kind: String,
    topic: String,
    severity: Option<String>,
    detail: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkaroundSeed {
    used: bool,
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSeed {
    status: String,
    assignee: Option<String>,
    tags: Vec<String>,
    internal_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractionSeed {
    key: String,
    session_key: Option<String>,
    session_source: Option<String>,
    hours_ago: i64,
    surface: String,
    operation: String,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    customer_ref: Option<String>,
    runtime_hint: Option<String>,
    runtime_hint_source: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct WorkspaceTarget {
    id: Uuid,
    os_user_id: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedSummary {
    action: &'static str,
    workspace_id: Uuid,
    workspace_name: String,
    product_id: Option<Uuid>,
    environment_id: Option<Uuid>,
    members: i64,
    sessions: i64,
    interactions: i64,
    reports: i64,
    workflows: i64,
}

#[derive(Clone, Copy, Debug)]
enum Action {
    Seed,
    Status,
    Reset,
}

#[derive(Debug)]
struct Cli {
    action: Action,
    workspace_id: Option<Uuid>,
}

#[derive(Debug)]
struct InteractionRecord<'a> {
    key: &'a str,
    session_key: Option<&'a str>,
    session_source: Option<&'a str>,
    hours_ago: i64,
    surface: &'a str,
    operation: &'a str,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    customer_ref: Option<&'a str>,
    runtime_hint: Option<&'a str>,
    runtime_hint_source: Option<&'a str>,
    has_report: bool,
}

impl Cli {
    fn parse() -> anyhow::Result<Self> {
        let mut args = env::args().skip(1);
        let mut action = Action::Seed;
        let mut workspace_id = env::var("DASHBOARD_DEMO_WORKSPACE_ID")
            .ok()
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .context("DASHBOARD_DEMO_WORKSPACE_ID must be a UUID")?;

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "seed" => action = Action::Seed,
                "status" => action = Action::Status,
                "reset" => action = Action::Reset,
                "--workspace-id" => {
                    let value = args
                        .next()
                        .context("--workspace-id requires a UUID value")?;
                    workspace_id =
                        Some(Uuid::parse_str(&value).context("--workspace-id must be a UUID")?);
                }
                _ => anyhow::bail!(
                    "unknown argument {argument:?}; expected seed, status, reset, or --workspace-id"
                ),
            }
        }

        Ok(Self {
            action,
            workspace_id,
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let cli = Cli::parse()?;
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    ensure_local_database(&database_url)?;
    let scenario = parse_scenario()?;
    validate_scenario(&scenario)?;

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(StdDuration::from_secs(10))
        .connect(&database_url)
        .await?;
    let workspace = resolve_workspace(&pool, cli.workspace_id).await?;
    let summary = match cli.action {
        Action::Seed => seed_dashboard_demo(&pool, &workspace, &scenario, Utc::now()).await?,
        Action::Status => dashboard_demo_status(&pool, &workspace, &scenario).await?,
        Action::Reset => reset_dashboard_demo(&pool, &workspace, &scenario).await?,
    };
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn ensure_local_database(database_url: &str) -> anyhow::Result<()> {
    ensure!(
        env::var_os("RAILWAY_ENVIRONMENT").is_none()
            && env::var("APP_ENV").as_deref() != Ok("production"),
        "dashboard demo seeding is disabled in production"
    );
    ensure!(
        is_loopback_database_url(database_url),
        "dashboard demo seeding requires a loopback DATABASE_URL"
    );
    Ok(())
}

fn is_loopback_database_url(database_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(database_url) else {
        return false;
    };
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return false;
    }

    let Some(authority_host) = url.host_str() else {
        return false;
    };
    let Ok(options) = PgConnectOptions::from_str(database_url) else {
        return false;
    };

    is_loopback_host(authority_host) && is_loopback_host(options.get_host())
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn parse_scenario() -> anyhow::Result<Scenario> {
    serde_json::from_str(SCENARIO_JSON).context("dashboard demo scenario is invalid JSON")
}

fn validate_scenario(scenario: &Scenario) -> anyhow::Result<()> {
    const IMPACTS: &[&str] = &[
        "helped",
        "helped_with_friction",
        "neutral",
        "hindered",
        "blocked",
        "unknown",
    ];
    const FINDING_KINDS: &[&str] = &[
        "strength",
        "friction",
        "defect",
        "gap",
        "suggestion",
        "uncertainty",
        "other",
    ];
    const SEVERITIES: &[&str] = &["minor", "major", "blocking"];
    const SURFACES: &[&str] = &["mcp", "http_json", "http_html", "http_headers", "unknown"];
    const SESSION_SOURCES: &[&str] = &["customer", "mcp", "continuation"];
    const WORKFLOW_STATUSES: &[&str] = &["new", "investigating", "planned", "resolved", "wont_act"];
    const MEMBER_ROLES: &[&str] = &["admin", "member"];

    ensure!(
        !scenario.version.trim().is_empty(),
        "scenario version is empty"
    );
    ensure!(
        !scenario.product.name.trim().is_empty() && !scenario.product.slug.trim().is_empty(),
        "scenario product name and slug are required"
    );
    ensure!(
        scenario.reports.len() >= 12,
        "scenario should contain enough reports to exercise dashboard filters"
    );

    let mut aliases = BTreeSet::from(["owner".to_owned()]);
    for member in &scenario.members {
        ensure!(
            aliases.insert(member.alias.clone()),
            "duplicate member alias {}",
            member.alias
        );
        ensure!(
            member.os_user_id.starts_with("usr_seed_"),
            "seed member ids must start with usr_seed_"
        );
        ensure!(
            MEMBER_ROLES.contains(&member.role.as_str()),
            "invalid seed member role {}",
            member.role
        );
    }

    let mut keys = BTreeSet::new();
    for report in &scenario.reports {
        ensure!(
            keys.insert(report.key.clone()),
            "duplicate key {}",
            report.key
        );
        ensure!(
            (8..=700).contains(&report.summary.chars().count()),
            "invalid summary length for {}",
            report.key
        );
        validate_interaction(
            &report.key,
            &report.surface,
            &report.operation,
            report.status_code,
            report.duration_ms,
            report.customer_ref.as_deref(),
        )?;
        ensure!(
            SESSION_SOURCES.contains(&report.session_source.as_str()),
            "invalid session source for {}",
            report.key
        );
        ensure!(
            report
                .impact
                .as_deref()
                .is_none_or(|value| IMPACTS.contains(&value)),
            "invalid impact for {}",
            report.key
        );
        ensure!(
            report
                .confidence
                .is_none_or(|value| (0.0..=1.0).contains(&value)),
            "invalid confidence for {}",
            report.key
        );
        ensure!(
            report.findings.len() <= 8,
            "too many findings for {}",
            report.key
        );
        for finding in &report.findings {
            ensure!(
                FINDING_KINDS.contains(&finding.kind.as_str()),
                "invalid finding kind for {}",
                report.key
            );
            ensure!(
                normalized_slug(&finding.topic, 64),
                "invalid finding topic for {}",
                report.key
            );
            ensure!(
                finding
                    .severity
                    .as_deref()
                    .is_none_or(|value| SEVERITIES.contains(&value)),
                "invalid finding severity for {}",
                report.key
            );
            ensure!(
                (3..=350).contains(&finding.detail.chars().count()),
                "invalid finding detail length for {}",
                report.key
            );
        }
        if let Some(workaround) = &report.workaround {
            ensure!(
                !workaround.used
                    || workaround
                        .detail
                        .as_deref()
                        .is_some_and(|detail| (3..=350).contains(&detail.chars().count())),
                "used workaround needs detail for {}",
                report.key
            );
        }
        ensure!(
            WORKFLOW_STATUSES.contains(&report.workflow.status.as_str()),
            "invalid workflow status for {}",
            report.key
        );
        ensure!(
            report.workflow.tags.len() <= 8
                && report
                    .workflow
                    .tags
                    .iter()
                    .all(|tag| normalized_slug(tag, 32)),
            "invalid workflow tags for {}",
            report.key
        );
        ensure!(
            report
                .workflow
                .assignee
                .as_ref()
                .is_none_or(|alias| aliases.contains(alias)),
            "unknown assignee for {}",
            report.key
        );
    }

    for interaction in &scenario.supporting_interactions {
        ensure!(
            keys.insert(interaction.key.clone()),
            "duplicate key {}",
            interaction.key
        );
        validate_interaction(
            &interaction.key,
            &interaction.surface,
            &interaction.operation,
            interaction.status_code,
            interaction.duration_ms,
            interaction.customer_ref.as_deref(),
        )?;
        ensure!(
            match (
                interaction.session_key.as_ref(),
                interaction.session_source.as_ref(),
            ) {
                (None, None) => true,
                (Some(_), Some(source)) => SESSION_SOURCES.contains(&source.as_str()),
                _ => false,
            },
            "session key/source must be provided together for {}",
            interaction.key
        );
    }

    ensure!(
        scenario
            .reports
            .iter()
            .all(|report| SURFACES.contains(&report.surface.as_str())),
        "report contains an invalid surface"
    );
    Ok(())
}

fn validate_interaction(
    key: &str,
    surface: &str,
    operation: &str,
    status_code: Option<i32>,
    duration_ms: Option<i64>,
    customer_ref: Option<&str>,
) -> anyhow::Result<()> {
    ensure!(
        ["mcp", "http_json", "http_html", "http_headers", "unknown"].contains(&surface),
        "invalid surface for {key}"
    );
    ensure!(
        !operation.trim().is_empty() && operation.chars().count() <= 160,
        "invalid operation for {key}"
    );
    ensure!(
        status_code.is_none_or(|value| (100..=599).contains(&value)),
        "invalid status code for {key}"
    );
    ensure!(
        duration_ms.is_none_or(|value| value >= 0),
        "invalid duration for {key}"
    );
    ensure!(
        customer_ref.is_none_or(|value| {
            value.chars().count() <= 160
                && !value.contains('@')
                && !value.chars().any(char::is_whitespace)
        }),
        "invalid customer reference for {key}"
    );
    Ok(())
}

fn normalized_slug(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_length
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '_' | '-'))
        })
}

async fn resolve_workspace(
    pool: &PgPool,
    requested: Option<Uuid>,
) -> anyhow::Result<WorkspaceTarget> {
    if let Some(workspace_id) = requested {
        return sqlx::query_as::<_, WorkspaceTarget>(
            "SELECT id, os_user_id, name FROM workspaces WHERE id = $1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?
        .with_context(|| format!("workspace {workspace_id} does not exist"));
    }

    let workspaces = sqlx::query_as::<_, WorkspaceTarget>(
        "SELECT id, os_user_id, name FROM workspaces ORDER BY created_at LIMIT 2",
    )
    .fetch_all(pool)
    .await?;
    match workspaces.as_slice() {
        [workspace] => Ok(WorkspaceTarget {
            id: workspace.id,
            os_user_id: workspace.os_user_id.clone(),
            name: workspace.name.clone(),
        }),
        [] => anyhow::bail!("no workspace exists; sign in to the local dashboard first"),
        _ => anyhow::bail!(
            "multiple workspaces exist; pass --workspace-id or DASHBOARD_DEMO_WORKSPACE_ID"
        ),
    }
}

fn stable_id(workspace_id: Uuid, version: &str, key: &str) -> Uuid {
    Uuid::new_v5(
        &SEED_NAMESPACE,
        format!("{workspace_id}:{version}:{key}").as_bytes(),
    )
}

async fn seed_dashboard_demo(
    pool: &PgPool,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    now: DateTime<Utc>,
) -> anyhow::Result<SeedSummary> {
    let mut tx = pool.begin().await?;
    lock_and_validate_workspace(&mut tx, workspace).await?;
    let assignees = upsert_seed_members(&mut tx, workspace, scenario).await?;
    let product_id = upsert_product(&mut tx, workspace, scenario, now).await?;
    let environment_id = upsert_environment(&mut tx, workspace, scenario, product_id, now).await?;
    let write_key_id = upsert_demo_keys(&mut tx, workspace, scenario, environment_id, now).await?;

    for interaction in &scenario.supporting_interactions {
        let record = InteractionRecord {
            key: &interaction.key,
            session_key: interaction.session_key.as_deref(),
            session_source: interaction.session_source.as_deref(),
            hours_ago: interaction.hours_ago,
            surface: &interaction.surface,
            operation: &interaction.operation,
            status_code: interaction.status_code,
            duration_ms: interaction.duration_ms,
            customer_ref: interaction.customer_ref.as_deref(),
            runtime_hint: interaction.runtime_hint.as_deref(),
            runtime_hint_source: interaction.runtime_hint_source.as_deref(),
            has_report: false,
        };
        upsert_interaction(
            &mut tx,
            workspace,
            scenario,
            environment_id,
            write_key_id,
            now,
            &record,
        )
        .await?;
    }

    for report in &scenario.reports {
        let record = InteractionRecord {
            key: &report.key,
            session_key: Some(&report.session_key),
            session_source: Some(&report.session_source),
            hours_ago: report.hours_ago,
            surface: &report.surface,
            operation: &report.operation,
            status_code: report.status_code,
            duration_ms: report.duration_ms,
            customer_ref: report.customer_ref.as_deref(),
            runtime_hint: report.runtime_hint.as_deref(),
            runtime_hint_source: report.runtime_hint_source.as_deref(),
            has_report: true,
        };
        let (interaction_id, occurred_at) = upsert_interaction(
            &mut tx,
            workspace,
            scenario,
            environment_id,
            write_key_id,
            now,
            &record,
        )
        .await?;
        let report_id = stable_id(
            workspace.id,
            &scenario.version,
            &format!("report:{}", report.key),
        );
        let created_at = occurred_at + Duration::minutes(2);
        sqlx::query(
            r"INSERT INTO feedback_reports
            (id, workspace_id, interaction_id, summary, impact, confidence, findings,
             workaround, source, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'customer_agent', $9)
            ON CONFLICT (id) DO UPDATE SET
              summary = EXCLUDED.summary,
              impact = EXCLUDED.impact,
              confidence = EXCLUDED.confidence,
              findings = EXCLUDED.findings,
              workaround = EXCLUDED.workaround,
              created_at = EXCLUDED.created_at",
        )
        .bind(report_id)
        .bind(workspace.id)
        .bind(interaction_id)
        .bind(&report.summary)
        .bind(&report.impact)
        .bind(report.confidence)
        .bind(serde_json::to_value(&report.findings)?)
        .bind(
            report
                .workaround
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?,
        )
        .bind(created_at)
        .execute(&mut *tx)
        .await?;

        let assignee = report
            .workflow
            .assignee
            .as_ref()
            .map(|alias| {
                assignees
                    .get(alias)
                    .cloned()
                    .with_context(|| format!("unknown assignee alias {alias}"))
            })
            .transpose()?;
        sqlx::query(
            r"INSERT INTO feedback_report_workflow
            (report_id, workspace_id, status, assignee_os_user_id, tags, internal_note,
             updated_by_os_user_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (report_id) DO NOTHING",
        )
        .bind(report_id)
        .bind(workspace.id)
        .bind(&report.workflow.status)
        .bind(assignee)
        .bind(&report.workflow.tags)
        .bind(&report.workflow.internal_note)
        .bind(&workspace.os_user_id)
        .bind(created_at + Duration::hours(1))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let mut summary = dashboard_demo_status(pool, workspace, scenario).await?;
    summary.action = "seed";
    Ok(summary)
}

async fn lock_and_validate_workspace(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
) -> anyhow::Result<()> {
    let owner_id: String =
        sqlx::query_scalar("SELECT os_user_id FROM workspaces WHERE id = $1 FOR UPDATE")
            .bind(workspace.id)
            .fetch_one(&mut **tx)
            .await?;
    ensure!(
        owner_id == workspace.os_user_id,
        "workspace owner changed while seeding"
    );
    let owner_is_member: bool = sqlx::query_scalar(
        r"SELECT EXISTS(
          SELECT 1 FROM workspace_members
          WHERE workspace_id = $1 AND os_user_id = $2 AND role = 'owner'
        )",
    )
    .bind(workspace.id)
    .bind(&workspace.os_user_id)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(owner_is_member, "workspace owner membership is missing");
    Ok(())
}

async fn upsert_seed_members(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut assignees = BTreeMap::from([("owner".to_owned(), workspace.os_user_id.clone())]);
    for member in &scenario.members {
        sqlx::query(
            r"INSERT INTO workspace_members
            (workspace_id, os_user_id, handle, email, display_name, role)
            VALUES ($1, $2, $3, NULL, $4, $5)
            ON CONFLICT (workspace_id, os_user_id) DO UPDATE SET
              handle = EXCLUDED.handle,
              display_name = EXCLUDED.display_name,
              role = EXCLUDED.role,
              updated_at = NOW()",
        )
        .bind(workspace.id)
        .bind(&member.os_user_id)
        .bind(&member.handle)
        .bind(&member.display_name)
        .bind(&member.role)
        .execute(&mut **tx)
        .await?;
        assignees.insert(member.alias.clone(), member.os_user_id.clone());
    }
    Ok(assignees)
}

async fn upsert_product(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    now: DateTime<Utc>,
) -> anyhow::Result<Uuid> {
    let expected_id = stable_id(workspace.id, &scenario.version, "product");
    let occupied = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM products WHERE workspace_id = $1 AND slug = $2",
    )
    .bind(workspace.id)
    .bind(&scenario.product.slug)
    .fetch_optional(&mut **tx)
    .await?;
    ensure!(
        occupied.is_none_or(|id| id == expected_id),
        "reserved demo product slug is owned by a different product"
    );
    sqlx::query_scalar(
        r"INSERT INTO products (id, workspace_id, name, slug, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
        RETURNING id",
    )
    .bind(expected_id)
    .bind(workspace.id)
    .bind(&scenario.product.name)
    .bind(&scenario.product.slug)
    .bind(now - Duration::days(120))
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn upsert_environment(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    product_id: Uuid,
    now: DateTime<Utc>,
) -> anyhow::Result<Uuid> {
    let expected_id = stable_id(workspace.id, &scenario.version, "environment:production");
    let occupied = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM product_environments WHERE product_id = $1 AND slug = $2",
    )
    .bind(product_id)
    .bind(&scenario.product.environment_slug)
    .fetch_optional(&mut **tx)
    .await?;
    ensure!(
        occupied.is_none_or(|id| id == expected_id),
        "reserved demo environment slug is owned by a different environment"
    );
    sqlx::query_scalar(
        r"INSERT INTO product_environments
        (id, workspace_id, product_id, name, slug, feedback_mode,
         collect_event_summaries, retention_days, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'ask_once', TRUE, 90, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          feedback_mode = EXCLUDED.feedback_mode,
          collect_event_summaries = EXCLUDED.collect_event_summaries,
          retention_days = EXCLUDED.retention_days,
          updated_at = NOW()
        RETURNING id",
    )
    .bind(expected_id)
    .bind(workspace.id)
    .bind(product_id)
    .bind(&scenario.product.environment_name)
    .bind(&scenario.product.environment_slug)
    .bind(now - Duration::days(110))
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn upsert_demo_keys(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    environment_id: Uuid,
    now: DateTime<Utc>,
) -> anyhow::Result<Uuid> {
    let write_id = stable_id(workspace.id, &scenario.version, "api-key:write");
    let read_id = stable_id(workspace.id, &scenario.version, "api-key:read");
    for (id, label, prefix, kind, secret, age_days) in [
        (
            write_id,
            "Production ingestion",
            "af_live_demo_relay",
            "write",
            "dashboard-demo-write",
            90,
        ),
        (
            read_id,
            "Feedback analytics",
            "af_read_demo_relay",
            "read",
            "dashboard-demo-read",
            60,
        ),
    ] {
        let key_hash =
            Sha256::digest(format!("{}:{}:{secret}", scenario.version, workspace.id).as_bytes())
                .to_vec();
        sqlx::query(
            r"INSERT INTO api_keys
            (id, workspace_id, environment_id, label, prefix, key_hash, kind,
             created_at, last_used_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
              label = EXCLUDED.label,
              prefix = EXCLUDED.prefix,
              kind = EXCLUDED.kind,
              revoked_at = NULL,
              expires_at = NULL,
              last_used_at = EXCLUDED.last_used_at",
        )
        .bind(id)
        .bind(workspace.id)
        .bind(environment_id)
        .bind(label)
        .bind(prefix)
        .bind(key_hash)
        .bind(kind)
        .bind(now - Duration::days(age_days))
        .bind(now - Duration::hours(2))
        .execute(&mut **tx)
        .await?;
    }
    Ok(write_id)
}

async fn upsert_interaction(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    environment_id: Uuid,
    api_key_id: Uuid,
    now: DateTime<Utc>,
    record: &InteractionRecord<'_>,
) -> anyhow::Result<(Uuid, DateTime<Utc>)> {
    let occurred_at = now - Duration::hours(record.hours_ago);
    let session_id = match (record.session_key, record.session_source) {
        (Some(session_key), Some(session_source)) => Some(
            upsert_session(
                tx,
                workspace,
                scenario,
                environment_id,
                session_key,
                session_source,
                occurred_at,
            )
            .await?,
        ),
        (None, None) => None,
        _ => anyhow::bail!("session key/source mismatch for {}", record.key),
    };
    let interaction_id = stable_id(
        workspace.id,
        &scenario.version,
        &format!("interaction:{}", record.key),
    );
    let (classification, confirmation_method) = if record.has_report {
        if record.surface == "mcp" {
            ("confirmed", Some("mcp"))
        } else {
            ("confirmed", Some("feedback_report"))
        }
    } else if record.surface == "mcp" {
        ("confirmed", Some("mcp"))
    } else {
        ("unclassified", None)
    };

    sqlx::query(
        r"INSERT INTO interactions_v2
        (id, workspace_id, environment_id, api_key_id, session_id, surface, operation,
         status_code, duration_ms, customer_ref, classification, confirmation_method,
         runtime_hint, runtime_hint_source, occurred_at, created_at, updated_at, client_sequence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $15, 1)
        ON CONFLICT (id) DO UPDATE SET
          api_key_id = EXCLUDED.api_key_id,
          session_id = EXCLUDED.session_id,
          surface = EXCLUDED.surface,
          operation = EXCLUDED.operation,
          status_code = EXCLUDED.status_code,
          duration_ms = EXCLUDED.duration_ms,
          customer_ref = EXCLUDED.customer_ref,
          classification = EXCLUDED.classification,
          confirmation_method = EXCLUDED.confirmation_method,
          runtime_hint = EXCLUDED.runtime_hint,
          runtime_hint_source = EXCLUDED.runtime_hint_source,
          occurred_at = EXCLUDED.occurred_at,
          updated_at = EXCLUDED.updated_at",
    )
    .bind(interaction_id)
    .bind(workspace.id)
    .bind(environment_id)
    .bind(api_key_id)
    .bind(session_id)
    .bind(record.surface)
    .bind(record.operation)
    .bind(record.status_code)
    .bind(record.duration_ms)
    .bind(record.customer_ref)
    .bind(classification)
    .bind(confirmation_method)
    .bind(record.runtime_hint)
    .bind(record.runtime_hint_source)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await?;
    Ok((interaction_id, occurred_at))
}

async fn upsert_session(
    tx: &mut Transaction<'_, Postgres>,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
    environment_id: Uuid,
    session_key: &str,
    source: &str,
    occurred_at: DateTime<Utc>,
) -> anyhow::Result<Uuid> {
    let id = stable_id(
        workspace.id,
        &scenario.version,
        &format!("session:{source}:{session_key}"),
    );
    let ref_hash = Sha256::digest(
        format!(
            "{}:{}:{source}:{session_key}",
            scenario.version, workspace.id
        )
        .as_bytes(),
    )
    .to_vec();
    let ref_hint = format!("session-{}", &id.simple().to_string()[..8]);
    sqlx::query_scalar(
        r"INSERT INTO sessions_v2
        (id, workspace_id, environment_id, source, ref_hash, ref_hint,
         started_at, last_seen_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
        ON CONFLICT (environment_id, source, ref_hash) DO UPDATE SET
          started_at = LEAST(sessions_v2.started_at, EXCLUDED.started_at),
          last_seen_at = GREATEST(sessions_v2.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id",
    )
    .bind(id)
    .bind(workspace.id)
    .bind(environment_id)
    .bind(source)
    .bind(ref_hash)
    .bind(ref_hint)
    .bind(occurred_at)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn dashboard_demo_status(
    pool: &PgPool,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
) -> anyhow::Result<SeedSummary> {
    let product_id = stable_id(workspace.id, &scenario.version, "product");
    let environment_id = stable_id(workspace.id, &scenario.version, "environment:production");
    let product_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id = $1 AND workspace_id = $2)",
    )
    .bind(product_id)
    .bind(workspace.id)
    .fetch_one(pool)
    .await?;
    if !product_exists {
        return Ok(SeedSummary {
            action: "status",
            workspace_id: workspace.id,
            workspace_name: workspace.name.clone(),
            product_id: None,
            environment_id: None,
            members: 0,
            sessions: 0,
            interactions: 0,
            reports: 0,
            workflows: 0,
        });
    }
    let (members, sessions, interactions, reports, workflows) =
        sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
            r"SELECT
              (SELECT COUNT(*) FROM workspace_members
               WHERE workspace_id = $1 AND os_user_id LIKE 'usr_seed_%'),
              (SELECT COUNT(*) FROM sessions_v2 WHERE environment_id = $2),
              (SELECT COUNT(*) FROM interactions_v2 WHERE environment_id = $2),
              (SELECT COUNT(*) FROM feedback_reports r
               JOIN interactions_v2 i ON i.id = r.interaction_id
               WHERE i.environment_id = $2),
              (SELECT COUNT(*) FROM feedback_report_workflow w
               JOIN feedback_reports r ON r.id = w.report_id
               JOIN interactions_v2 i ON i.id = r.interaction_id
               WHERE i.environment_id = $2)",
        )
        .bind(workspace.id)
        .bind(environment_id)
        .fetch_one(pool)
        .await?;
    Ok(SeedSummary {
        action: "status",
        workspace_id: workspace.id,
        workspace_name: workspace.name.clone(),
        product_id: Some(product_id),
        environment_id: Some(environment_id),
        members,
        sessions,
        interactions,
        reports,
        workflows,
    })
}

async fn reset_dashboard_demo(
    pool: &PgPool,
    workspace: &WorkspaceTarget,
    scenario: &Scenario,
) -> anyhow::Result<SeedSummary> {
    let product_id = stable_id(workspace.id, &scenario.version, "product");
    let mut tx = pool.begin().await?;
    let deleted =
        sqlx::query("DELETE FROM products WHERE id = $1 AND workspace_id = $2 AND slug = $3")
            .bind(product_id)
            .bind(workspace.id)
            .bind(&scenario.product.slug)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    ensure!(
        deleted <= 1,
        "reset matched more than one demo product unexpectedly"
    );
    for member in &scenario.members {
        sqlx::query("DELETE FROM workspace_members WHERE workspace_id = $1 AND os_user_id = $2")
            .bind(workspace.id)
            .bind(&member.os_user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(SeedSummary {
        action: "reset",
        workspace_id: workspace.id,
        workspace_name: workspace.name.clone(),
        product_id: None,
        environment_id: None,
        members: 0,
        sessions: 0,
        interactions: 0,
        reports: 0,
        workflows: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_scenario_is_valid_and_covers_the_workflow() -> anyhow::Result<()> {
        let scenario = parse_scenario()?;
        validate_scenario(&scenario)?;
        assert_eq!(scenario.reports.len(), 18);
        assert_eq!(scenario.supporting_interactions.len(), 14);

        let statuses = scenario
            .reports
            .iter()
            .map(|report| report.workflow.status.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            statuses,
            BTreeSet::from(["investigating", "new", "planned", "resolved", "wont_act"])
        );
        assert!(
            scenario
                .reports
                .iter()
                .any(|report| report.findings.is_empty())
        );
        assert!(
            scenario
                .reports
                .iter()
                .any(|report| report.impact.as_deref() == Some("blocked"))
        );
        assert!(
            scenario
                .reports
                .iter()
                .any(|report| report.workaround.is_some())
        );
        Ok(())
    }

    #[test]
    fn seeding_guard_accepts_only_loopback_database_urls() {
        for database_url in [
            "postgres://user:pass@localhost:5432/db",
            "postgresql://localhost/db",
            "postgres://user:pass@127.0.0.1:5432/db",
            "postgres://user:pass@[::1]:5432/db",
        ] {
            assert!(
                is_loopback_database_url(database_url),
                "expected {database_url:?} to be accepted"
            );
        }

        for database_url in [
            "postgres://user:pass@localhost.example.com:5432/db",
            "postgres://user:pass@127.0.0.1.example.com:5432/db",
            "postgres://user:pass@db.internal:5432/path/@localhost",
            "postgres://user:pass@db.internal:5432/db?host=@127.0.0.1",
            "postgres:///db?host=@localhost",
            "postgres://user:pass@localhost:5432/db?host=db.internal",
            "postgres://user:pass@localhost:5432/db?hostaddr=203.0.113.10",
            "https://user:pass@localhost:5432/db",
            "not a database URL @localhost",
        ] {
            assert!(
                !is_loopback_database_url(database_url),
                "expected {database_url:?} to be rejected"
            );
        }
    }

    #[test]
    fn stable_ids_are_workspace_scoped() {
        let first = stable_id(Uuid::nil(), "v1", "report:one");
        let same = stable_id(Uuid::nil(), "v1", "report:one");
        let other_workspace = stable_id(Uuid::from_u128(1), "v1", "report:one");
        assert_eq!(first, same);
        assert_ne!(first, other_workspace);
    }
}
