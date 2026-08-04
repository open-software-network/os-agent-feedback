#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct HealthResponse {
    pub status: String,
    pub service: String,
    pub database: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FeedbackModesDiscovery {
    pub never_ask: String,
    pub ask_once: String,
    pub ask_always: String,
    pub off: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct TelemetryDiscovery {
    pub url: String,
    pub authentication: String,
    pub delivery: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FeedbackRequiredFieldsDiscovery {
    pub summary: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackFindingShapeDiscovery {
    pub required: Vec<String>,
    pub optional: Vec<String>,
    pub topic_format: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FeedbackWorkaroundShapeDiscovery {
    pub required: Vec<String>,
    pub optional: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackConsentDiscovery {
    pub prompt: String,
    pub ask_once_prompt: String,
    pub ask_always_prompt: String,
    pub ask_once_scope: String,
    pub ask_always_scope: String,
    pub on_refusal_or_no_response: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackSubmissionDiscovery {
    pub url: String,
    pub authentication: String,
    pub capability_inspection_url: String,
    pub consent_state_url: String,
    pub consent_decision_url: String,
    pub consent_owner: String,
    pub required_fields: FeedbackRequiredFieldsDiscovery,
    pub optional_fields: Vec<String>,
    pub finding_kinds: Vec<String>,
    pub finding_severities: Vec<String>,
    pub confidence_range: [u8; 2],
    pub finding_shape: FeedbackFindingShapeDiscovery,
    pub workaround_shape: FeedbackWorkaroundShapeDiscovery,
    pub consent: FeedbackConsentDiscovery,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ClassificationDiscovery {
    pub http: String,
    pub mcp: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpDiscovery {
    pub protocol_version: String,
    pub transport: String,
    pub discovery_method: String,
    pub required_headers: Vec<String>,
    pub transport_sessions: bool,
    pub legacy_compatibility: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct IntegrationsDiscovery {
    pub node: String,
    pub python: String,
    pub go: String,
    pub rust: String,
    pub protocol: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ReliabilityDiscovery {
    pub http: String,
    pub mcp: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackDiscoveryResponse {
    pub name: String,
    pub version: u8,
    pub purpose: String,
    pub feedback_modes: FeedbackModesDiscovery,
    pub telemetry: TelemetryDiscovery,
    pub feedback_submission: FeedbackSubmissionDiscovery,
    pub classification: ClassificationDiscovery,
    pub mcp: McpDiscovery,
    pub integrations: IntegrationsDiscovery,
    pub integrity_manifest: String,
    pub reliability: ReliabilityDiscovery,
    pub identity: String,
    pub privacy: String,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    pub id: Uuid,
    pub os_user_id: String,
    pub name: String,
    pub slug: String,
    pub feedback_mode: String,
    pub collect_event_summaries: bool,
    pub retention_days: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CurrentUser {
    pub id: String,
    pub handle: String,
    #[schema(required = true, nullable)]
    pub email: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMembership {
    pub workspace_id: Uuid,
    pub workspace_name: String,
    pub workspace_slug: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMember {
    pub workspace_id: Uuid,
    pub os_user_id: String,
    pub handle: String,
    #[schema(required = true, nullable)]
    pub email: Option<String>,
    pub display_name: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamInvitation {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub invited_by_os_user_id: String,
    pub invitee_kind: String,
    pub invitee_value: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateTeamInvitationInput {
    pub invitee: Option<String>,
    pub role: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateTeamMemberInput {
    pub role: String,
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiKeyPublic {
    pub id: Uuid,
    pub environment_id: Uuid,
    pub label: String,
    pub prefix: String,
    pub kind: String,
    pub created_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub last_used_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub revoked_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub expires_at: Option<DateTime<Utc>>,
    pub interaction_count: i64,
    pub report_count: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateApiKeyInput {
    pub environment_id: Uuid,
    pub label: Option<String>,
    pub kind: Option<String>,
    pub expires_in_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Product {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductGithubRepoInput {
    pub installation_id: i64,
    pub repo_full_name: String,
    pub default_branch: String,
    pub path_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductGithubRepo {
    pub product_id: Uuid,
    pub installation_id: i64,
    pub repo_full_name: String,
    pub default_branch: String,
    #[schema(required = true, nullable)]
    pub path_prefix: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubIssueLink {
    pub repo_full_name: String,
    pub issue_number: i64,
    pub url: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductReportGroup {
    pub group_key: String,
    pub explanation: String,
    pub report_count: i64,
    #[schema(required = true, nullable)]
    pub latest_occurred_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub github_issue: Option<GithubIssueLink>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductGroupsResponse {
    pub groups: Vec<ProductReportGroup>,
    pub limit: i64,
    pub offset: i64,
    pub has_more: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MergeReportGroupsInput {
    pub into_group_key: String,
}

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeReportGroupsResponse {
    pub reports_moved: i64,
    pub target_group_key: String,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductEnvironment {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub product_id: Uuid,
    pub name: String,
    pub slug: String,
    pub feedback_mode: String,
    pub collect_event_summaries: bool,
    pub retention_days: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateProductInput {
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateNameInput {
    pub name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteProductInput {
    pub confirmation: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyInput {
    pub environment_id: Uuid,
    pub feedback_mode: String,
    pub collect_event_summaries: bool,
    pub retention_days: i32,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductSession {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub environment_id: Uuid,
    pub source: String,
    pub ref_hint: String,
    pub started_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// A session row enriched with complete server-side rollups for the dashboard.
///
/// Dashboard interaction and report windows are independently paginated. Keeping
/// these counts on the session summary prevents an older session from appearing
/// empty merely because its interactions are outside the currently loaded window.
#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSessionSummary {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub environment_id: Uuid,
    pub source: String,
    pub ref_hint: String,
    pub started_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub interaction_count: i64,
    pub report_count: i64,
    #[schema(required = true, nullable)]
    pub first_operation: Option<String>,
    #[schema(required = true, nullable)]
    pub last_operation: Option<String>,
    #[schema(required = true, nullable)]
    pub customer_ref: Option<String>,
    #[schema(required = true, nullable)]
    pub strongest_impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductInteraction {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub environment_id: Uuid,
    #[schema(required = true, nullable)]
    pub api_key_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub session_id: Option<Uuid>,
    pub surface: String,
    pub operation: String,
    #[schema(required = true, nullable)]
    pub status_code: Option<i32>,
    #[schema(required = true, nullable)]
    pub duration_ms: Option<i64>,
    #[schema(required = true, nullable)]
    pub customer_ref: Option<String>,
    #[sqlx(default)]
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    pub classification: String,
    #[schema(required = true, nullable)]
    pub confirmation_method: Option<String>,
    #[schema(required = true, nullable)]
    pub runtime_hint: Option<String>,
    #[schema(required = true, nullable)]
    pub runtime_hint_source: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductFeedbackReport {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub interaction_id: Uuid,
    pub summary: String,
    #[schema(required = true, nullable)]
    pub impact: Option<String>,
    #[schema(required = true, nullable)]
    pub confidence: Option<f64>,
    #[schema(value_type = Vec<FeedbackFinding>)]
    pub findings: Value,
    #[schema(
        value_type = Option<FeedbackWorkaround>,
        required = true,
        nullable
    )]
    pub workaround: Option<Value>,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

/// Schema-only view of legacy JSONB findings. Known fields are optional and
/// additional properties remain allowed because stored output is passed through.
#[derive(Debug, ToSchema)]
#[allow(
    dead_code,
    reason = "this type exists only to describe permissive legacy JSONB output in OpenAPI"
)]
pub(crate) struct FeedbackFinding {
    pub kind: Option<String>,
    pub topic: Option<String>,
    pub severity: Option<String>,
    pub detail: Option<String>,
}

/// Schema-only view of legacy JSONB workarounds. Known fields are optional and
/// additional properties remain allowed because stored output is passed through.
#[derive(Debug, ToSchema)]
#[allow(
    dead_code,
    reason = "this type exists only to describe permissive legacy JSONB output in OpenAPI"
)]
pub(crate) struct FeedbackWorkaround {
    pub used: Option<bool>,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductFeedbackAcceptedResponse {
    pub accepted: bool,
    pub interaction_id: Uuid,
    pub report: ProductFeedbackReport,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductFeedbackReportWithInteraction {
    pub id: Uuid,
    pub interaction_id: Uuid,
    pub summary: String,
    #[schema(required = true, nullable)]
    pub impact: Option<String>,
    #[schema(required = true, nullable)]
    pub confidence: Option<f64>,
    #[schema(value_type = Vec<FeedbackFinding>)]
    pub findings: Value,
    #[schema(
        value_type = Option<FeedbackWorkaround>,
        required = true,
        nullable
    )]
    pub workaround: Option<Value>,
    pub source: String,
    pub created_at: DateTime<Utc>,
    #[schema(value_type = Vec<crate::api_types::CodeHintResponse>)]
    pub code_hints: Value,
    #[schema(required = true, nullable)]
    pub session_id: Option<Uuid>,
    pub surface: String,
    pub operation: String,
    #[schema(required = true, nullable)]
    pub status_code: Option<i32>,
    #[schema(required = true, nullable)]
    pub duration_ms: Option<i64>,
    #[schema(required = true, nullable)]
    pub customer_ref: Option<String>,
    pub classification: String,
    #[schema(required = true, nullable)]
    pub confirmation_method: Option<String>,
    #[schema(required = true, nullable)]
    pub runtime_hint: Option<String>,
    #[schema(required = true, nullable)]
    pub runtime_hint_source: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub workflow_status: String,
    #[schema(required = true, nullable)]
    pub assignee_os_user_id: Option<String>,
    pub tags: Vec<String>,
    #[schema(required = true, nullable)]
    pub internal_note: Option<String>,
    #[schema(required = true, nullable)]
    pub workflow_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateFeedbackWorkflowInput {
    pub product_id: Uuid,
    pub status: String,
    pub assignee_os_user_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub internal_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackListReportsInput {
    pub summary: Option<bool>,
    pub since: Option<DateTime<Utc>>,
    pub impact: Option<Vec<String>>,
    pub finding_kind: Option<Vec<String>>,
    pub severity: Option<Vec<String>>,
    pub topic: Option<String>,
    pub operation: Option<String>,
    pub customer_ref: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackListInteractionsInput {
    pub since: Option<DateTime<Utc>>,
    pub reviewed: Option<bool>,
    pub operation: Option<String>,
    pub customer_ref: Option<String>,
    pub surface: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackWindow {
    pub since: DateTime<Utc>,
    pub retention_days: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackReportItem {
    pub id: Uuid,
    pub summary: String,
    pub impact: Option<String>,
    pub confidence: Option<f64>,
    pub findings: Value,
    pub workaround: Option<Value>,
    pub operation: String,
    pub customer_ref: Option<String>,
    pub surface: String,
    pub duration_ms: Option<i64>,
    pub status_code: Option<i32>,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub interaction_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackReportsPage {
    pub reports: Vec<FeedbackReportItem>,
    pub next_cursor: Option<String>,
    pub window: FeedbackWindow,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackInteractionItem {
    pub id: Uuid,
    pub operation: String,
    pub customer_ref: Option<String>,
    pub surface: String,
    pub classification: String,
    pub duration_ms: Option<i64>,
    pub status_code: Option<i32>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackInteractionsPage {
    pub interactions: Vec<FeedbackInteractionItem>,
    pub next_cursor: Option<String>,
    pub window: FeedbackWindow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackOperationSummary {
    pub operation: String,
    pub interactions: i64,
    pub reports: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackSurfaceSummary {
    pub surface: String,
    pub interactions: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeedbackSummary {
    pub product: String,
    pub window: FeedbackWindow,
    pub interactions: i64,
    pub reviewed: i64,
    pub review_rate: f64,
    pub confirmation_rate: f64,
    pub impacts: BTreeMap<String, i64>,
    pub finding_kinds: BTreeMap<String, i64>,
    pub severities: BTreeMap<String, i64>,
    pub workaround_rate: f64,
    pub top_operations: Vec<FeedbackOperationSummary>,
    pub surfaces: Vec<FeedbackSurfaceSummary>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum FeedbackReportsResponse {
    Summary(FeedbackSummary),
    Page(FeedbackReportsPage),
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TelemetryBatchInput {
    pub events: Vec<InteractionTelemetryInput>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelemetryBatchResult {
    pub accepted: usize,
    pub dropped: usize,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InteractionTelemetryInput {
    pub interaction_id: Uuid,
    pub sequence: Option<i64>,
    pub surface: String,
    pub operation: String,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub customer_ref: Option<String>,
    pub account_ref: Option<String>,
    pub user_ref: Option<String>,
    pub anonymous_ref: Option<String>,
    pub classification: Option<String>,
    pub confirmation_method: Option<String>,
    pub runtime_hint: Option<String>,
    pub runtime_hint_source: Option<String>,
    pub session_ref: Option<String>,
    pub session_source: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnrichmentRequestInput {
    pub interaction_id: Uuid,
    pub operation: String,
    #[serde(default = "default_enrichment_surface")]
    #[schema(default = "http_json")]
    pub surface: String,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub session_ref: Option<String>,
    pub runtime_hint: Option<String>,
    pub purpose: String,
    pub remember: bool,
    pub customer_ref: Option<String>,
    pub account_ref: Option<String>,
    pub user_ref: Option<String>,
    pub anonymous_ref: Option<String>,
}

fn default_enrichment_surface() -> String {
    "http_json".to_owned()
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentConsentBodySchema {
    pub decision: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentAnswerItemsSchema {
    pub maximum: u8,
    pub required: Vec<String>,
    #[serde(rename = "type")]
    pub signal_types: Vec<String>,
    pub provenance: Vec<String>,
    pub catalog_version: String,
    pub catalog: Vec<EnrichmentCatalogEntry>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentCatalogEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub signal_type: String,
    pub allowed_values: Vec<String>,
    pub targeted_advertising_safe: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentAnswerBodySchema {
    pub status: Vec<String>,
    pub items: EnrichmentAnswerItemsSchema,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentConsentAction {
    pub url: String,
    pub method: String,
    pub authorization: String,
    pub content_type: String,
    pub body_schema: EnrichmentConsentBodySchema,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentAnswerAction {
    pub url: String,
    pub method: String,
    pub authorization: String,
    pub content_type: String,
    pub body_schema: EnrichmentAnswerBodySchema,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentRequestResponse {
    pub request_id: Uuid,
    pub interaction_id: Uuid,
    pub state: String,
    pub purpose: String,
    pub surface: String,
    pub identity_level: String,
    pub stage_instruction: String,
    #[schema(required = true, nullable)]
    pub question: Option<String>,
    #[schema(required = true, nullable)]
    pub answer_instruction: Option<String>,
    pub expires_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub consent: Option<EnrichmentConsentAction>,
    #[schema(required = true, nullable)]
    pub submit: Option<EnrichmentAnswerAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnrichmentConsentDecisionInput {
    pub decision: String,
    #[serde(default)]
    pub remember: Option<bool>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentConsentDecisionResponse {
    pub request_id: Uuid,
    pub state: String,
    pub changed: bool,
    pub stage_instruction: String,
    #[schema(required = true, nullable)]
    pub answer_instruction: Option<String>,
    #[schema(required = true, nullable)]
    pub submit: Option<EnrichmentAnswerAction>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnrichmentAnswerItemInput {
    pub key: String,
    #[serde(rename = "type")]
    pub signal_type: String,
    pub value: String,
    #[serde(default, skip_serializing, rename = "summary")]
    #[schema(ignore)]
    pub _summary: Option<String>,
    pub provenance: String,
    pub confidence: Option<f64>,
    pub remember: bool,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnrichmentAnswerInput {
    pub status: String,
    #[serde(default)]
    pub items: Vec<EnrichmentAnswerItemInput>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerContextItem {
    pub signal_id: Uuid,
    pub key: String,
    #[serde(rename = "type")]
    pub signal_type: String,
    pub value: Value,
    pub summary: String,
    pub provenance: String,
    #[schema(required = true, nullable)]
    pub confidence: Option<f64>,
    #[schema(required = true, nullable)]
    pub expires_at: Option<DateTime<Utc>>,
    pub allowed_uses: Vec<String>,
    pub remembered: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichmentAnswerResponse {
    pub accepted: bool,
    pub request_id: Uuid,
    pub interaction_id: Uuid,
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    pub signals: Vec<CustomerContextItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CustomerContextInput {
    pub customer_ref: Option<String>,
    pub account_ref: Option<String>,
    pub user_ref: Option<String>,
    pub anonymous_ref: Option<String>,
    pub interaction_id: Option<Uuid>,
    pub purpose: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerContextResponse {
    pub retrieval_id: Uuid,
    pub identity_level: String,
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub interaction_id: Option<Uuid>,
    pub context_version: String,
    pub items: Vec<CustomerContextItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersonalizationDecisionInput {
    pub external_decision_id: String,
    pub context_retrieval_id: Uuid,
    pub signal_ids: Vec<Uuid>,
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalizationDecision {
    pub id: Uuid,
    pub external_decision_id: String,
    pub purpose: String,
    pub signal_ids: Vec<Uuid>,
    #[schema(required = true, nullable)]
    pub variant: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct PersonalizationDecisionResponse {
    pub decision: PersonalizationDecision,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersonalizationOutcomeInput {
    pub external_outcome_id: String,
    pub decision_id: Uuid,
    pub outcome: String,
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalizationOutcome {
    pub id: Uuid,
    pub external_outcome_id: String,
    pub decision_id: Uuid,
    pub outcome: String,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct PersonalizationOutcomeResponse {
    pub outcome: PersonalizationOutcome,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerIdentifier {
    pub id: Uuid,
    pub kind: String,
    pub display_hint: String,
    pub identity_level: String,
    pub provenance: String,
    #[schema(required = true, nullable)]
    pub verified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentGrant {
    pub id: Uuid,
    pub scope: String,
    #[schema(required = true, nullable)]
    pub enrichment_purpose: Option<String>,
    pub state: String,
    pub basis: String,
    pub decided_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub expires_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub revoked_at: Option<DateTime<Utc>>,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentEventSummary {
    pub id: Uuid,
    pub scope: String,
    #[schema(required = true, nullable)]
    pub enrichment_purpose: Option<String>,
    #[schema(required = true, nullable)]
    pub prior_state: Option<String>,
    pub state: String,
    pub basis: String,
    pub revision: i64,
    pub source: String,
    pub decided_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerSignal {
    pub id: Uuid,
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub session_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub interaction_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub feedback_report_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub feature_key: Option<String>,
    #[sqlx(default)]
    #[schema(required = true, nullable)]
    pub signal_key: Option<String>,
    #[sqlx(default)]
    #[schema(required = true, nullable)]
    pub value: Option<Value>,
    #[serde(rename = "type")]
    pub signal_type: String,
    pub summary: String,
    #[schema(required = true, nullable)]
    pub detail: Option<String>,
    pub provenance: String,
    #[schema(required = true, nullable)]
    pub confidence: Option<f64>,
    pub collected_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub expires_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub consent_scope: Option<String>,
    #[schema(required = true, nullable)]
    pub consent_state: Option<String>,
    #[sqlx(default)]
    pub allowed_uses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerSummary {
    pub id: Uuid,
    pub kind: String,
    #[schema(required = true, nullable)]
    pub parent_customer_id: Option<Uuid>,
    pub member_count: i64,
    pub display_name: String,
    pub identity_level: String,
    #[schema(required = true, nullable)]
    pub identity_confidence: Option<f64>,
    #[schema(required = true, nullable)]
    pub account_ref_hint: Option<String>,
    #[schema(required = true, nullable)]
    pub user_ref_hint: Option<String>,
    pub segments: Vec<String>,
    pub last_activity_at: DateTime<Utc>,
    pub outcome_health: String,
    pub signal_count: i64,
    pub session_count: i64,
    pub active_need_count: i64,
    pub consent_state: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardCustomerFilters {
    pub query: Option<String>,
    pub identity_levels: Option<Vec<String>>,
    pub outcome_health: Option<Vec<String>>,
    pub signal_types: Option<Vec<String>>,
    pub consent_states: Option<Vec<String>>,
    pub segments: Option<Vec<String>>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerRollup {
    pub customers: i64,
    pub verified: i64,
    pub pseudonymous: i64,
    pub ephemeral: i64,
    pub unclassified: i64,
    pub active: i64,
    pub at_risk: i64,
}

#[derive(Debug, Default, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerFacets {
    pub identity_level: Vec<InsightCount>,
    pub outcome_health: Vec<InsightCount>,
    pub signal_type: Vec<InsightCount>,
    pub consent_state: Vec<InsightCount>,
    pub segment: Vec<InsightCount>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardCustomersPage {
    pub customers: Vec<CustomerSummary>,
    pub rollup: CustomerRollup,
    pub facets: CustomerFacets,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomerDetailCounts {
    pub signals: i64,
    pub sessions: i64,
    pub features: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardContextReturnedItem {
    pub signal_id: Uuid,
    pub key: String,
    #[serde(rename = "type")]
    pub signal_type: String,
    pub value: Value,
    pub summary: String,
    pub provenance: String,
    #[schema(required = true, nullable)]
    pub confidence: Option<f64>,
    #[schema(required = true, nullable)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardPersonalizationOutcome {
    pub id: Uuid,
    pub external_outcome_id: String,
    pub decision_id: Uuid,
    pub outcome: String,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardPersonalizationDecision {
    pub id: Uuid,
    pub external_decision_id: String,
    #[schema(required = true, nullable)]
    pub variant: Option<String>,
    pub signal_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
    pub outcomes: Vec<DashboardPersonalizationOutcome>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardCustomerContextReturn {
    pub retrieval_id: Uuid,
    #[schema(required = true, nullable)]
    pub interaction_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub session_id: Option<Uuid>,
    pub purpose: String,
    pub identity_level: String,
    pub context_version: String,
    pub retrieved_at: DateTime<Utc>,
    pub items: Vec<DashboardContextReturnedItem>,
    pub decisions: Vec<DashboardPersonalizationDecision>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardCustomerDetail {
    pub customer: CustomerSummary,
    pub identifiers: Vec<CustomerIdentifier>,
    pub signals: Vec<CustomerSignal>,
    pub context_returns: Vec<DashboardCustomerContextReturn>,
    pub sessions: Vec<DashboardSessionSummary>,
    pub consent: Vec<ConsentGrant>,
    pub consent_history: Vec<ConsentEventSummary>,
    pub counts: CustomerDetailCounts,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardSignalFilters {
    pub query: Option<String>,
    pub customer_id: Option<Uuid>,
    pub feature_key: Option<String>,
    pub session_id: Option<Uuid>,
    pub signal_types: Option<Vec<String>>,
    pub provenances: Option<Vec<String>>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSignalsPage {
    pub signals: Vec<CustomerSignal>,
    pub total: i64,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardResponseFilters {
    pub query: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardResponseAnswer {
    pub key: String,
    #[serde(rename = "type")]
    pub answer_type: String,
    pub value: String,
    pub summary: String,
    pub remembered: bool,
}

/// A canonical Epode enrichment question associated with one session interaction.
///
/// This read model contains only the bounded, normalized answer items accepted by
/// Epode. It deliberately does not expose an agent prompt, tool input, or query.
#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSessionResponse {
    pub id: Uuid,
    pub interaction_id: Uuid,
    pub question: String,
    pub status: String,
    pub purpose: String,
    pub surface: String,
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub customer_name: Option<String>,
    pub asked_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub answered_at: Option<DateTime<Utc>>,
    #[sqlx(skip)]
    pub answers: Vec<DashboardResponseAnswer>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardResponseSummary {
    pub id: Uuid,
    pub question: String,
    pub status: String,
    pub purpose: String,
    pub surface: String,
    #[schema(required = true, nullable)]
    pub customer_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub customer_name: Option<String>,
    #[schema(required = true, nullable)]
    pub session_id: Option<Uuid>,
    #[schema(required = true, nullable)]
    pub session_ref: Option<String>,
    pub asked_at: DateTime<Utc>,
    #[schema(required = true, nullable)]
    pub answered_at: Option<DateTime<Utc>>,
    #[sqlx(skip)]
    pub answers: Vec<DashboardResponseAnswer>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardResponseRollup {
    pub questions: i64,
    pub answered: i64,
    pub awaiting_answer: i64,
    pub declined: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardResponsesPage {
    pub responses: Vec<DashboardResponseSummary>,
    pub rollup: DashboardResponseRollup,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackFindingInput {
    pub kind: String,
    pub topic: String,
    pub severity: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FeedbackWorkaroundInput {
    pub used: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductFeedbackReportInput {
    pub summary: String,
    pub impact: Option<String>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub findings: Vec<FeedbackFindingInput>,
    pub workaround: Option<FeedbackWorkaroundInput>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsentStateInput {
    pub subject: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ConsentStateResponse {
    pub state: String,
    pub revision: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityInspectionResponse {
    pub state: String,
    pub configured_mode: String,
    pub consent_policy: String,
    pub product_name: String,
    #[schema(required = true, nullable)]
    pub canonical_question: Option<String>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsentDecisionInput {
    pub decision: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InsightCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Insights {
    pub window_days: i32,
    pub comparison_days: i32,
    pub customer_context_items: i64,
    pub customers_with_context: i64,
    pub context_retrievals: i64,
    pub personalization_ready_customers: i64,
    pub personalization_decisions: i64,
    pub personalization_outcomes: i64,
    pub opportunities: i64,
    pub confirmed_interactions: i64,
    pub reports: i64,
    pub recent_opportunities: i64,
    pub recent_confirmed_interactions: i64,
    pub recent_reports: i64,
    pub previous_opportunities: i64,
    pub previous_confirmed_interactions: i64,
    pub previous_reports: i64,
    pub confirmation_rate: i64,
    pub review_rate: i64,
    pub reports_with_blockers: i64,
    pub reports_with_workarounds: i64,
    #[schema(required = true, nullable)]
    pub p50_duration_ms: Option<i64>,
    #[schema(required = true, nullable)]
    pub p95_duration_ms: Option<i64>,
    pub top_operations: Vec<InsightCount>,
    pub surfaces: Vec<InsightCount>,
    pub impacts: Vec<InsightCount>,
    pub finding_kinds: Vec<InsightCount>,
    pub topics: Vec<InsightCount>,
    pub blocking_topics: Vec<InsightCount>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardListState {
    pub interactions_total: i64,
    pub reports_total: i64,
    pub sessions_total: i64,
    pub interactions_loaded: usize,
    pub reports_loaded: usize,
    pub sessions_loaded: usize,
}

/// A bounded, server-filtered page of feedback reports.
///
/// `total` is computed from the complete retained product dataset with the
/// active filters, not from the returned page.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardFeedbackPage {
    pub reports: Vec<ProductFeedbackReportWithInteraction>,
    pub total: i64,
    pub facets: DashboardFeedbackFacets,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

/// Facet counts across the complete retained search/time window.
///
/// Counts use disjunctive faceting: each facet honors every active filter
/// except its own selection, so alternative values remain discoverable within
/// the filtered context. Pagination is never applied to these aggregates.
#[derive(Debug, Default, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardFeedbackFacets {
    pub status: Vec<InsightCount>,
    pub impact: Vec<InsightCount>,
    pub surface: Vec<InsightCount>,
    pub topic: Vec<InsightCount>,
    pub finding_kind: Vec<InsightCount>,
    pub severity: Vec<InsightCount>,
    pub tag: Vec<InsightCount>,
    pub assignee: Vec<InsightCount>,
    pub workaround: Vec<InsightCount>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSessionRollup {
    pub sessions: i64,
    pub interactions: i64,
    pub multi_step_sessions: i64,
    #[schema(value_type = f64)]
    pub average_interactions: f64,
}

/// A bounded, server-filtered page of proven sessions.
///
/// The rollup is computed across every retained session matching the active
/// filters, independently of the current page.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSessionsPage {
    pub sessions: Vec<DashboardSessionSummary>,
    pub rollup: DashboardSessionRollup,
    pub limit: i64,
    #[schema(required = true, nullable)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardFeedbackFilters {
    pub query: Option<String>,
    pub group_key: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub impacts: Option<Vec<String>>,
    pub surfaces: Option<Vec<String>>,
    pub topics: Option<Vec<String>>,
    pub finding_kinds: Option<Vec<String>>,
    pub severities: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
    pub include_unassigned: bool,
    pub workarounds: Option<Vec<String>>,
    pub operation: Option<String>,
    pub customer_ref: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DashboardSessionFilters {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub impacts: Option<Vec<String>>,
    pub operation: Option<String>,
    pub customer_ref: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardSessionDetail {
    pub session: ProductSession,
    pub interactions: Vec<ProductInteraction>,
    pub reports: Vec<ProductFeedbackReportWithInteraction>,
    pub responses: Vec<DashboardSessionResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductActivationMilestones {
    pub workspace_id: Uuid,
    pub product_id: Uuid,
    #[schema(required = true, nullable)]
    pub first_opportunity_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub first_confirmed_interaction_at: Option<DateTime<Utc>>,
    #[schema(required = true, nullable)]
    pub first_report_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardData {
    pub user: CurrentUser,
    pub workspace: Workspace,
    pub workspace_memberships: Vec<WorkspaceMembership>,
    pub current_role: String,
    pub team_members: Vec<TeamMember>,
    pub team_invitations: Vec<TeamInvitation>,
    pub products: Vec<Product>,
    pub environments: Vec<ProductEnvironment>,
    #[schema(required = true, nullable)]
    pub current_product: Option<Product>,
    #[schema(required = true, nullable)]
    pub current_environment: Option<ProductEnvironment>,
    #[schema(required = true, nullable)]
    pub activation_milestones: Option<ProductActivationMilestones>,
    pub api_keys: Vec<ApiKeyPublic>,
    pub interactions: Vec<ProductInteraction>,
    pub reports: Vec<ProductFeedbackReportWithInteraction>,
    pub sessions: Vec<DashboardSessionSummary>,
    pub insights: Insights,
    pub list_state: DashboardListState,
}

#[derive(Debug, Clone)]
pub(crate) struct ProductAuth {
    pub workspace: Workspace,
    pub environment: ProductEnvironment,
    pub api_key_id: Uuid,
}

#[derive(Debug, Clone)]
pub(crate) struct DashboardContext {
    pub user: CurrentUser,
    pub workspace: Workspace,
    pub role: String,
    pub workspace_memberships: Vec<WorkspaceMembership>,
}
