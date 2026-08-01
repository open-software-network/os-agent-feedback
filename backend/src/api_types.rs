#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use crate::models::{
    ApiKeyPublic, Product, ProductEnvironment, ProductFeedbackReportWithInteraction,
    ProductInteraction, TeamInvitation, TeamMember, Workspace,
};

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AuthenticationStateResponse {
    pub authenticated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DashboardReportResponse {
    pub report: ProductFeedbackReportWithInteraction,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DashboardInteractionResponse {
    pub interaction: ProductInteraction,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct UpdatedResponse {
    pub updated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductCreatedResponse {
    pub product: Product,
    pub environment: ProductEnvironment,
    pub api_key: ApiKeyPublic,
    pub secret: String,
    pub shown_once: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ProductResponse {
    pub product: Product,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct WorkspaceResponse {
    pub workspace: Workspace,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ProductDeletedResponse {
    pub deleted: bool,
    pub product: Product,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiKeyCreatedResponse {
    pub api_key: ApiKeyPublic,
    pub secret: String,
    pub shown_once: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiKeyRotatedResponse {
    pub api_key: ApiKeyPublic,
    pub secret: String,
    pub shown_once: bool,
    pub predecessor_expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct EnvironmentResponse {
    pub environment: ProductEnvironment,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamInvitationCreatedResponse {
    pub invitation: TeamInvitation,
    pub join_path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct TeamMemberResponse {
    pub member: TeamMember,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RemovedResponse {
    pub removed: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct TransferredResponse {
    pub transferred: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RevokedResponse {
    pub revoked: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubInstallationResponse {
    /// Internal identifier for the stored installation record.
    pub id: uuid::Uuid,
    /// GitHub's numeric installation identifier.
    pub installation_id: i64,
    /// Login of the GitHub user or organization that owns the installation.
    pub account_login: String,
    /// GitHub account kind, either `User` or `Organization`.
    pub account_type: String,
    /// Time when the installation was first connected to the workspace.
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubRepositoryResponse {
    /// Repository name in `owner/name` form.
    pub full_name: String,
    /// Repository's default branch.
    pub default_branch: String,
    /// Whether GitHub marks the repository as private.
    pub private: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubInstallationsResponse {
    /// Whether the server has complete GitHub App configuration.
    pub configured: bool,
    /// Active GitHub App installations connected to the workspace.
    pub installations: Vec<GithubInstallationResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubRepositoriesResponse {
    /// GitHub installation whose repositories were listed.
    pub installation_id: i64,
    /// Repositories currently accessible to the installation.
    pub repositories: Vec<GithubRepositoryResponse>,
    /// True when the pagination cap cut the listing short, so `repositories` is
    /// a partial view of the installation rather than the complete set.
    pub truncated: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct McpInfoResponse {
    pub name: String,
    pub transport: String,
    pub endpoint: String,
    pub authentication: String,
    pub privacy: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentDecisionResponse {
    pub state: String,
    /// When the standing decision was made. Matches the request time when this
    /// call recorded the decision, and the original decision time when a prior
    /// decision stands.
    pub decided_at: chrono::DateTime<chrono::Utc>,
    /// True when this call recorded the standing decision; false when a prior
    /// decision already stood and was returned unchanged.
    pub changed: bool,
    #[schema(required = true, nullable)]
    pub feedback: Option<serde_json::Value>,
}

/// An opaque JSON object whose exact fields depend on the JSON-RPC method.
pub(crate) struct OpaqueJsonObject;

impl utoipa::PartialSchema for OpaqueJsonObject {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::schema::Object::builder()
            .description(Some(
                "Opaque JSON object whose fields depend on the MCP JSON-RPC method.",
            ))
            .build()
            .into()
    }
}

impl ToSchema for OpaqueJsonObject {}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "test fixtures use known-valid timestamps and JSON objects"
    )]

    use std::collections::BTreeSet;

    use chrono::{DateTime, Utc};
    use serde::Serialize;
    use serde_json::Value;
    use uuid::Uuid;

    use super::*;
    use crate::models::{
        ProductActivationMilestones, ProductFeedbackReportWithInteraction, ProductInteraction,
    };

    fn timestamp() -> DateTime<Utc> {
        DateTime::from_timestamp(1_700_000_000, 0).expect("fixture timestamp is valid")
    }

    fn product() -> Product {
        Product {
            id: Uuid::nil(),
            workspace_id: Uuid::nil(),
            name: "Product".to_owned(),
            slug: "product".to_owned(),
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn environment() -> ProductEnvironment {
        ProductEnvironment {
            id: Uuid::nil(),
            workspace_id: Uuid::nil(),
            product_id: Uuid::nil(),
            name: "Default".to_owned(),
            slug: "default".to_owned(),
            feedback_mode: "ask_once".to_owned(),
            collect_event_summaries: false,
            retention_days: 30,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn api_key() -> ApiKeyPublic {
        ApiKeyPublic {
            id: Uuid::nil(),
            environment_id: Uuid::nil(),
            label: "Production".to_owned(),
            prefix: "af_live_example".to_owned(),
            kind: "write".to_owned(),
            created_at: timestamp(),
            last_used_at: None,
            revoked_at: None,
            expires_at: None,
            interaction_count: 0,
            report_count: 0,
        }
    }

    fn workspace() -> Workspace {
        Workspace {
            id: Uuid::nil(),
            os_user_id: "usr_example".to_owned(),
            name: "Team".to_owned(),
            slug: "team".to_owned(),
            feedback_mode: "ask_once".to_owned(),
            collect_event_summaries: false,
            retention_days: 30,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn interaction() -> ProductInteraction {
        ProductInteraction {
            id: Uuid::nil(),
            workspace_id: Uuid::nil(),
            environment_id: Uuid::nil(),
            api_key_id: None,
            session_id: None,
            surface: "http".to_owned(),
            operation: "request".to_owned(),
            status_code: None,
            duration_ms: None,
            customer_ref: None,
            classification: "unclassified".to_owned(),
            confirmation_method: None,
            runtime_hint: None,
            runtime_hint_source: None,
            occurred_at: timestamp(),
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn report() -> ProductFeedbackReportWithInteraction {
        ProductFeedbackReportWithInteraction {
            id: Uuid::nil(),
            interaction_id: Uuid::nil(),
            summary: "Useful feedback".to_owned(),
            impact: None,
            confidence: None,
            findings: serde_json::json!([]),
            workaround: None,
            source: "http".to_owned(),
            created_at: timestamp(),
            session_id: None,
            surface: "http".to_owned(),
            operation: "request".to_owned(),
            status_code: None,
            duration_ms: None,
            customer_ref: None,
            classification: "reviewed".to_owned(),
            confirmation_method: None,
            runtime_hint: None,
            runtime_hint_source: None,
            occurred_at: timestamp(),
            workflow_status: "new".to_owned(),
            assignee_os_user_id: None,
            tags: Vec::new(),
            internal_note: None,
            workflow_updated_at: None,
        }
    }

    fn invitation() -> TeamInvitation {
        TeamInvitation {
            id: Uuid::nil(),
            workspace_id: Uuid::nil(),
            invited_by_os_user_id: "usr_owner".to_owned(),
            invitee_kind: "email".to_owned(),
            invitee_value: "member@example.com".to_owned(),
            role: "member".to_owned(),
            created_at: timestamp(),
            expires_at: timestamp(),
        }
    }

    fn member() -> TeamMember {
        TeamMember {
            workspace_id: Uuid::nil(),
            os_user_id: "usr_member".to_owned(),
            handle: "member".to_owned(),
            email: None,
            display_name: "Member".to_owned(),
            role: "member".to_owned(),
            joined_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn assert_value_keys(value: &Value, expected: &[&str]) {
        let object = value
            .as_object()
            .expect("response is an object")
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected = expected
            .iter()
            .map(|key| (*key).to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(object, expected);
    }

    fn assert_keys(value: impl Serialize, expected: &[&str]) -> Value {
        let value = serde_json::to_value(value).expect("response serializes");
        assert_value_keys(&value, expected);
        value
    }

    fn assert_nested_keys(value: &Value, field: &str, expected: &[&str]) {
        assert_value_keys(
            value.get(field).expect("nested response field is present"),
            expected,
        );
    }

    #[test]
    fn fixed_response_envelopes_preserve_wire_keys() {
        assert_keys(
            AuthenticationStateResponse {
                authenticated: false,
            },
            &["authenticated"],
        );
        let dashboard_report =
            assert_keys(DashboardReportResponse { report: report() }, &["report"]);
        assert_nested_keys(
            &dashboard_report,
            "report",
            &[
                "id",
                "interactionId",
                "summary",
                "impact",
                "confidence",
                "findings",
                "workaround",
                "source",
                "createdAt",
                "sessionId",
                "surface",
                "operation",
                "statusCode",
                "durationMs",
                "customerRef",
                "classification",
                "confirmationMethod",
                "runtimeHint",
                "runtimeHintSource",
                "occurredAt",
                "workflowStatus",
                "assigneeOsUserId",
                "tags",
                "internalNote",
                "workflowUpdatedAt",
            ],
        );
        let dashboard_interaction = assert_keys(
            DashboardInteractionResponse {
                interaction: interaction(),
            },
            &["interaction"],
        );
        assert_nested_keys(
            &dashboard_interaction,
            "interaction",
            &[
                "id",
                "workspaceId",
                "environmentId",
                "apiKeyId",
                "sessionId",
                "surface",
                "operation",
                "statusCode",
                "durationMs",
                "customerRef",
                "classification",
                "confirmationMethod",
                "runtimeHint",
                "runtimeHintSource",
                "occurredAt",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_keys(UpdatedResponse { updated: true }, &["updated"]);
        let product_created = assert_keys(
            ProductCreatedResponse {
                product: product(),
                environment: environment(),
                api_key: api_key(),
                secret: "secret".to_owned(),
                shown_once: true,
            },
            &["product", "environment", "apiKey", "secret", "shownOnce"],
        );
        assert_nested_keys(
            &product_created,
            "product",
            &[
                "id",
                "workspaceId",
                "name",
                "slug",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_nested_keys(
            &product_created,
            "environment",
            &[
                "id",
                "workspaceId",
                "productId",
                "name",
                "slug",
                "feedbackMode",
                "collectEventSummaries",
                "retentionDays",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_nested_keys(
            &product_created,
            "apiKey",
            &[
                "id",
                "environmentId",
                "label",
                "prefix",
                "kind",
                "createdAt",
                "lastUsedAt",
                "revokedAt",
                "expiresAt",
                "interactionCount",
                "reportCount",
            ],
        );
        let product_response = assert_keys(ProductResponse { product: product() }, &["product"]);
        assert_nested_keys(
            &product_response,
            "product",
            &[
                "id",
                "workspaceId",
                "name",
                "slug",
                "createdAt",
                "updatedAt",
            ],
        );
        let workspace_response = assert_keys(
            WorkspaceResponse {
                workspace: workspace(),
            },
            &["workspace"],
        );
        assert_nested_keys(
            &workspace_response,
            "workspace",
            &[
                "id",
                "osUserId",
                "name",
                "slug",
                "feedbackMode",
                "collectEventSummaries",
                "retentionDays",
                "createdAt",
                "updatedAt",
            ],
        );
        let product_deleted = assert_keys(
            ProductDeletedResponse {
                deleted: true,
                product: product(),
            },
            &["deleted", "product"],
        );
        assert_nested_keys(
            &product_deleted,
            "product",
            &[
                "id",
                "workspaceId",
                "name",
                "slug",
                "createdAt",
                "updatedAt",
            ],
        );
        let api_key_created = assert_keys(
            ApiKeyCreatedResponse {
                api_key: api_key(),
                secret: "secret".to_owned(),
                shown_once: true,
            },
            &["apiKey", "secret", "shownOnce"],
        );
        assert_nested_keys(
            &api_key_created,
            "apiKey",
            &[
                "id",
                "environmentId",
                "label",
                "prefix",
                "kind",
                "createdAt",
                "lastUsedAt",
                "revokedAt",
                "expiresAt",
                "interactionCount",
                "reportCount",
            ],
        );
        let api_key_rotated = assert_keys(
            ApiKeyRotatedResponse {
                api_key: api_key(),
                secret: "secret".to_owned(),
                shown_once: true,
                predecessor_expires_at: timestamp(),
            },
            &["apiKey", "secret", "shownOnce", "predecessorExpiresAt"],
        );
        assert_nested_keys(
            &api_key_rotated,
            "apiKey",
            &[
                "id",
                "environmentId",
                "label",
                "prefix",
                "kind",
                "createdAt",
                "lastUsedAt",
                "revokedAt",
                "expiresAt",
                "interactionCount",
                "reportCount",
            ],
        );
        let environment_response = assert_keys(
            EnvironmentResponse {
                environment: environment(),
            },
            &["environment"],
        );
        assert_nested_keys(
            &environment_response,
            "environment",
            &[
                "id",
                "workspaceId",
                "productId",
                "name",
                "slug",
                "feedbackMode",
                "collectEventSummaries",
                "retentionDays",
                "createdAt",
                "updatedAt",
            ],
        );
        let invitation_created = assert_keys(
            TeamInvitationCreatedResponse {
                invitation: invitation(),
                join_path: "/join/example".to_owned(),
            },
            &["invitation", "joinPath"],
        );
        assert_nested_keys(
            &invitation_created,
            "invitation",
            &[
                "id",
                "workspaceId",
                "invitedByOsUserId",
                "inviteeKind",
                "inviteeValue",
                "role",
                "createdAt",
                "expiresAt",
            ],
        );
        let member_response = assert_keys(TeamMemberResponse { member: member() }, &["member"]);
        assert_nested_keys(
            &member_response,
            "member",
            &[
                "workspaceId",
                "osUserId",
                "handle",
                "email",
                "displayName",
                "role",
                "joinedAt",
                "updatedAt",
            ],
        );
        assert_keys(RemovedResponse { removed: true }, &["removed"]);
        assert_keys(TransferredResponse { transferred: true }, &["transferred"]);
        assert_keys(RevokedResponse { revoked: true }, &["revoked"]);
        assert_keys(
            McpInfoResponse {
                name: "Agent Feedback".to_owned(),
                transport: "MCP".to_owned(),
                endpoint: "/mcp".to_owned(),
                authentication: "Bearer".to_owned(),
                privacy: "Metadata-only".to_owned(),
            },
            &["name", "transport", "endpoint", "authentication", "privacy"],
        );
    }

    #[test]
    fn nullable_dashboard_fields_remain_present_as_null() {
        let activation = serde_json::to_value(ProductActivationMilestones {
            workspace_id: Uuid::nil(),
            product_id: Uuid::nil(),
            first_opportunity_at: None,
            first_confirmed_interaction_at: None,
            first_report_at: None,
        })
        .expect("activation milestones serialize");
        for key in [
            "firstOpportunityAt",
            "firstConfirmedInteractionAt",
            "firstReportAt",
        ] {
            assert_eq!(activation.get(key), Some(&Value::Null), "{key}");
        }

        let interaction = serde_json::to_value(interaction()).expect("interaction serializes");
        for key in [
            "apiKeyId",
            "sessionId",
            "statusCode",
            "durationMs",
            "customerRef",
            "confirmationMethod",
            "runtimeHint",
            "runtimeHintSource",
        ] {
            assert_eq!(interaction.get(key), Some(&Value::Null), "{key}");
        }

        let report = serde_json::to_value(report()).expect("report serializes");
        for key in [
            "impact",
            "confidence",
            "workaround",
            "sessionId",
            "statusCode",
            "durationMs",
            "customerRef",
            "confirmationMethod",
            "runtimeHint",
            "runtimeHintSource",
            "assigneeOsUserId",
            "internalNote",
            "workflowUpdatedAt",
        ] {
            assert_eq!(report.get(key), Some(&Value::Null), "{key}");
        }
    }
}
