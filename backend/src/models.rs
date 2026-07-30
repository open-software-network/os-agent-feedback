use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentUser {
    pub id: String,
    pub handle: String,
    pub email: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMembership {
    pub workspace_id: Uuid,
    pub workspace_name: String,
    pub workspace_slug: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub workspace_id: Uuid,
    pub os_user_id: String,
    pub handle: String,
    pub email: Option<String>,
    pub display_name: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitation {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub invited_by_os_user_id: String,
    pub invitee_kind: String,
    pub invitee_value: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTeamInvitationInput {
    pub invitee: Option<String>,
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTeamMemberInput {
    pub role: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyPublic {
    pub id: Uuid,
    pub environment_id: Uuid,
    pub label: String,
    pub prefix: String,
    pub kind: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyInput {
    pub environment_id: Uuid,
    pub label: Option<String>,
    pub kind: Option<String>,
    pub expires_in_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductEnvironment {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProductInput {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateNameInput {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProductInput {
    pub confirmation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyInput {
    pub environment_id: Uuid,
    pub feedback_mode: String,
    pub collect_event_summaries: bool,
    pub retention_days: i32,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductSession {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub environment_id: Uuid,
    pub source: String,
    pub ref_hint: String,
    pub started_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductInteraction {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub environment_id: Uuid,
    pub api_key_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub surface: String,
    pub operation: String,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub customer_ref: Option<String>,
    pub classification: String,
    pub confirmation_method: Option<String>,
    pub runtime_hint: Option<String>,
    pub runtime_hint_source: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductFeedbackReport {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub interaction_id: Uuid,
    pub summary: String,
    pub impact: Option<String>,
    pub confidence: Option<f64>,
    pub findings: Value,
    pub workaround: Option<Value>,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductFeedbackReportWithInteraction {
    pub id: Uuid,
    pub interaction_id: Uuid,
    pub summary: String,
    pub impact: Option<String>,
    pub confidence: Option<f64>,
    pub findings: Value,
    pub workaround: Option<Value>,
    pub source: String,
    pub created_at: DateTime<Utc>,
    pub session_id: Option<Uuid>,
    pub surface: String,
    pub operation: String,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub customer_ref: Option<String>,
    pub classification: String,
    pub confirmation_method: Option<String>,
    pub runtime_hint: Option<String>,
    pub runtime_hint_source: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub workflow_status: String,
    pub assignee_os_user_id: Option<String>,
    pub tags: Vec<String>,
    pub internal_note: Option<String>,
    pub workflow_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateFeedbackWorkflowInput {
    pub product_id: Uuid,
    pub status: String,
    pub assignee_os_user_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub internal_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackListReportsInput {
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
pub struct FeedbackListInteractionsInput {
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
pub struct FeedbackWindow {
    pub since: DateTime<Utc>,
    pub retention_days: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReportItem {
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
pub struct FeedbackReportsPage {
    pub reports: Vec<FeedbackReportItem>,
    pub next_cursor: Option<String>,
    pub window: FeedbackWindow,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInteractionItem {
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
pub struct FeedbackInteractionsPage {
    pub interactions: Vec<FeedbackInteractionItem>,
    pub next_cursor: Option<String>,
    pub window: FeedbackWindow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackOperationSummary {
    pub operation: String,
    pub interactions: i64,
    pub reports: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSurfaceSummary {
    pub surface: String,
    pub interactions: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSummary {
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
pub enum FeedbackReportsResponse {
    Summary(FeedbackSummary),
    Page(FeedbackReportsPage),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryBatchInput {
    pub events: Vec<InteractionTelemetryInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBatchResult {
    pub accepted: usize,
    pub dropped: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionTelemetryInput {
    pub interaction_id: Uuid,
    pub sequence: Option<i64>,
    pub surface: String,
    pub operation: String,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub customer_ref: Option<String>,
    pub classification: Option<String>,
    pub confirmation_method: Option<String>,
    pub runtime_hint: Option<String>,
    pub runtime_hint_source: Option<String>,
    pub session_ref: Option<String>,
    pub session_source: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackFindingInput {
    pub kind: String,
    pub topic: String,
    pub severity: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackWorkaroundInput {
    pub used: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductFeedbackReportInput {
    pub summary: String,
    pub impact: Option<String>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub findings: Vec<FeedbackFindingInput>,
    pub workaround: Option<FeedbackWorkaroundInput>,
    pub consent: Option<FeedbackConsentInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackConsentInput {
    pub user_approved: bool,
    pub approval_source: String,
    pub consent_scope: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    pub window_days: i32,
    pub comparison_days: i32,
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
    pub p50_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub top_operations: Vec<InsightCount>,
    pub surfaces: Vec<InsightCount>,
    pub impacts: Vec<InsightCount>,
    pub finding_kinds: Vec<InsightCount>,
    pub topics: Vec<InsightCount>,
    pub blocking_topics: Vec<InsightCount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardListState {
    pub interactions_total: i64,
    pub reports_total: i64,
    pub sessions_total: i64,
    pub interactions_loaded: usize,
    pub reports_loaded: usize,
    pub sessions_loaded: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSessionDetail {
    pub session: ProductSession,
    pub interactions: Vec<ProductInteraction>,
    pub reports: Vec<ProductFeedbackReportWithInteraction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub user: CurrentUser,
    pub workspace: Workspace,
    pub workspace_memberships: Vec<WorkspaceMembership>,
    pub current_role: String,
    pub team_members: Vec<TeamMember>,
    pub team_invitations: Vec<TeamInvitation>,
    pub products: Vec<Product>,
    pub environments: Vec<ProductEnvironment>,
    pub current_product: Option<Product>,
    pub current_environment: Option<ProductEnvironment>,
    pub api_keys: Vec<ApiKeyPublic>,
    pub interactions: Vec<ProductInteraction>,
    pub reports: Vec<ProductFeedbackReportWithInteraction>,
    pub sessions: Vec<ProductSession>,
    pub insights: Insights,
    pub list_state: DashboardListState,
}

#[derive(Debug, Clone)]
pub struct ProductAuth {
    pub workspace: Workspace,
    pub environment: ProductEnvironment,
    pub api_key_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct DashboardContext {
    pub user: CurrentUser,
    pub workspace: Workspace,
    pub role: String,
    pub workspace_memberships: Vec<WorkspaceMembership>,
}
