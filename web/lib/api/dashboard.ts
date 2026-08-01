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
export type DashboardSessionSummary = components["schemas"]["DashboardSessionSummary"];
export type DashboardFeedbackPage = components["schemas"]["DashboardFeedbackPage"];
export type DashboardFeedbackFacets = components["schemas"]["DashboardFeedbackFacets"];
export type DashboardSessionsPage = components["schemas"]["DashboardSessionsPage"];
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
export type GithubInstallationsResponse = components["schemas"]["GithubInstallationsResponse"];
export type GithubRepositoriesResponse = components["schemas"]["GithubRepositoriesResponse"];
export type GithubIssueLink = components["schemas"]["GithubIssueLink"];
export type ProductGithubRepo = components["schemas"]["ProductGithubRepo"];
export type ProductGithubRepoInput = components["schemas"]["ProductGithubRepoInput"];
export type ProductGroupsResponse = components["schemas"]["ProductGroupsResponse"];
export type ProductReportGroup = components["schemas"]["ProductReportGroup"];

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

export type DashboardFeedbackListQuery = {
  productId: string;
  q?: string;
  status?: string[];
  impact?: string[];
  surface?: string[];
  topic?: string[];
  findingKind?: string[];
  severity?: string[];
  tag?: string[];
  assignee?: string[];
  workaround?: string[];
  operation?: string;
  customerRef?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
};

export type DashboardSessionsListQuery = {
  productId: string;
  q?: string;
  kind?: string;
  impact?: string[];
  operation?: string;
  customerRef?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
};

function appendListQuery(params: URLSearchParams, key: string, values?: string[]) {
  if (values?.length) params.set(key, values.join(","));
}

export function feedbackListPath(query: DashboardFeedbackListQuery): string {
  const params = new URLSearchParams({ productId: query.productId });
  if (query.q) params.set("q", query.q);
  appendListQuery(params, "status", query.status);
  appendListQuery(params, "impact", query.impact);
  appendListQuery(params, "surface", query.surface);
  appendListQuery(params, "topic", query.topic);
  appendListQuery(params, "findingKind", query.findingKind);
  appendListQuery(params, "severity", query.severity);
  appendListQuery(params, "tag", query.tag);
  appendListQuery(params, "assignee", query.assignee);
  appendListQuery(params, "workaround", query.workaround);
  if (query.operation) params.set("operation", query.operation);
  if (query.customerRef) params.set("customerRef", query.customerRef);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return `/api/dashboard/feedback?${params}`;
}

export function fetchDashboardFeedbackPage(
  workspaceId: string,
  query: DashboardFeedbackListQuery,
): Promise<DashboardFeedbackPage> {
  return apiRequest<DashboardFeedbackPage>(feedbackListPath(query), { workspaceId });
}

export function sessionsListPath(query: DashboardSessionsListQuery): string {
  const params = new URLSearchParams({ productId: query.productId });
  if (query.q) params.set("q", query.q);
  if (query.kind && query.kind !== "all") params.set("kind", query.kind);
  appendListQuery(params, "impact", query.impact);
  if (query.operation) params.set("operation", query.operation);
  if (query.customerRef) params.set("customerRef", query.customerRef);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return `/api/dashboard/sessions?${params}`;
}

export function fetchDashboardSessionsPage(
  workspaceId: string,
  query: DashboardSessionsListQuery,
): Promise<DashboardSessionsPage> {
  return apiRequest<DashboardSessionsPage>(sessionsListPath(query), { workspaceId });
}
