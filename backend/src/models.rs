use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
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
    pub invitee: String,
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
#[serde(rename_all = "camelCase")]
pub struct PolicyInput {
    pub environment_id: Uuid,
    pub feedback_mode: String,
    pub collect_event_summaries: bool,
    pub retention_days: i32,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub external_id: Option<String>,
    pub customer_ref: Option<String>,
    pub agent_name: String,
    pub agent_version: Option<String>,
    pub agent_identity_source: String,
    pub task: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionInput {
    pub external_id: Option<String>,
    pub customer_ref: Option<String>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub sequence: i32,
    pub event_type: String,
    pub name: String,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEventInput {
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub worked: bool,
    pub summary: String,
    pub confidence: Option<f64>,
    pub would_use_again: Option<bool>,
    pub friction: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteSessionInput {
    pub worked: Option<bool>,
    pub summary: Option<String>,
    pub confidence: Option<f64>,
    pub would_use_again: Option<bool>,
    pub friction: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAgentFeedbackInput {
    pub worked: bool,
    pub summary: String,
    pub confidence: Option<f64>,
    pub would_use_again: Option<bool>,
    pub friction: Option<String>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
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
pub struct ProductOutcome {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub interaction_id: Uuid,
    pub outcome: String,
    pub note: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductOutcomeWithInteraction {
    pub id: Uuid,
    pub interaction_id: Uuid,
    pub outcome: String,
    pub note: String,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryBatchInput {
    pub events: Vec<InteractionTelemetryInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionTelemetryInput {
    pub interaction_id: Uuid,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductOutcomeInput {
    pub outcome: String,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct IssuedFeedbackReceipt {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackWithSession {
    pub id: Uuid,
    pub session_id: Uuid,
    pub worked: bool,
    pub summary: String,
    pub confidence: Option<f64>,
    pub would_use_again: Option<bool>,
    pub friction: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
    pub task: String,
    pub customer_ref: Option<String>,
    pub agent_name: String,
    pub agent_version: Option<String>,
    pub agent_identity_source: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
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
    pub opportunities: usize,
    pub confirmed_interactions: usize,
    pub reviews: usize,
    pub confirmation_rate: i64,
    pub review_rate: i64,
    pub outcome_success_rate: i64,
    pub top_operations: Vec<InsightCount>,
    pub surfaces: Vec<InsightCount>,
    pub outcomes: Vec<InsightCount>,
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
    pub outcomes: Vec<ProductOutcomeWithInteraction>,
    pub sessions: Vec<ProductSession>,
    pub legacy_sessions: Vec<AgentSession>,
    pub legacy_feedback: Vec<FeedbackWithSession>,
    pub legacy_events: Vec<AgentEvent>,
    pub insights: Insights,
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
