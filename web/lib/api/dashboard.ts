import { apiRequest } from "@/lib/api/client";
import type { components, operations } from "@/lib/api/types";

export type DashboardData = components["schemas"]["DashboardData"];
export type DashboardQuery = NonNullable<operations["dashboard_handler"]["parameters"]["query"]>;
export type Product = components["schemas"]["Product"];
export type ProductCreatedResponse = components["schemas"]["ProductCreatedResponse"];
export type ProductResponse = components["schemas"]["ProductResponse"];
export type ProductDeletedResponse = components["schemas"]["ProductDeletedResponse"];
export type ProductFeedbackReport = components["schemas"]["ProductFeedbackReportWithInteraction"];
export type ProductInteraction = components["schemas"]["ProductInteraction"];
export type ProductSession = components["schemas"]["ProductSession"];
export type DashboardInteractionResponse = components["schemas"]["DashboardInteractionResponse"];
export type DashboardSessionDetail = components["schemas"]["DashboardSessionDetail"];
export type FeedbackFinding = components["schemas"]["FeedbackFinding"];
export type ApiKey = components["schemas"]["ApiKeyPublic"];
export type ApiKeyCreatedResponse = components["schemas"]["ApiKeyCreatedResponse"];
export type ApiKeyRotatedResponse = components["schemas"]["ApiKeyRotatedResponse"];
export type TeamInvitationCreatedResponse = components["schemas"]["TeamInvitationCreatedResponse"];
export type TeamInvitation = components["schemas"]["TeamInvitation"];
export type TeamMember = components["schemas"]["TeamMember"];
export type TeamMemberResponse = components["schemas"]["TeamMemberResponse"];
export type WorkspaceResponse = components["schemas"]["WorkspaceResponse"];
export type EnvironmentResponse = components["schemas"]["EnvironmentResponse"];
export type UpdatedResponse = components["schemas"]["UpdatedResponse"];
export type RevokedResponse = components["schemas"]["RevokedResponse"];
export type RemovedResponse = components["schemas"]["RemovedResponse"];
export type TransferredResponse = components["schemas"]["TransferredResponse"];
export type DashboardReportResponse = components["schemas"]["DashboardReportResponse"];

export type CreateProductInput = components["schemas"]["CreateProductInput"];
export type UpdateNameInput = components["schemas"]["UpdateNameInput"];
export type DeleteProductInput = components["schemas"]["DeleteProductInput"];
export type UpdateFeedbackWorkflowInput = components["schemas"]["UpdateFeedbackWorkflowInput"];
export type CreateApiKeyInput = components["schemas"]["CreateApiKeyInput"];
export type PolicyInput = components["schemas"]["PolicyInput"];
export type CreateTeamInvitationInput = components["schemas"]["CreateTeamInvitationInput"];
export type UpdateTeamMemberInput = components["schemas"]["UpdateTeamMemberInput"];

export const DASHBOARD_LIMIT_DEFAULTS = {
  interactionLimit: 250,
  reportLimit: 250,
  sessionLimit: 100,
} as const;

export function dashboardQueryPath(query: DashboardQuery): string {
  const params = new URLSearchParams();
  if (query.workspaceId) params.set("workspaceId", query.workspaceId);
  if (query.productId) params.set("productId", query.productId);
  if (query.interactionLimit !== undefined) {
    params.set("interactionLimit", String(query.interactionLimit));
  }
  if (query.reportLimit !== undefined) params.set("reportLimit", String(query.reportLimit));
  if (query.sessionLimit !== undefined) params.set("sessionLimit", String(query.sessionLimit));
  const serialized = params.toString();
  return serialized ? `/api/dashboard?${serialized}` : "/api/dashboard";
}

export function fetchDashboard(query: DashboardQuery): Promise<DashboardData> {
  return apiRequest<DashboardData>(dashboardQueryPath(query));
}
