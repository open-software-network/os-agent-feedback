import { apiRequest } from "@/lib/api/client";
import type {
  DashboardSessionSummary,
  GithubIssueLink,
  ProductFeedbackReport,
} from "@/lib/api/dashboard";

export type IntelligenceCount = { name: string; count: number };

export type IdentityLevel = "verified" | "pseudonymous" | "ephemeral" | "unclassified";

export type SignalType =
  | "outcome"
  | "intent"
  | "friction"
  | "preference"
  | "constraint"
  | "feature_need"
  | "alternative_considered"
  | "workaround"
  | "satisfaction"
  | "likelihood_to_reuse";

export type SignalProvenance =
  | "agent_reports_user_statement"
  | "agent_reports_current_task"
  | "agent_inference"
  | "product_activity"
  | "company_assertion";

export type CustomerSummary = {
  id: string;
  kind: string;
  parentCustomerId: string | null;
  memberCount: number;
  displayName: string;
  identityLevel: IdentityLevel | string;
  identityConfidence: number | null;
  accountRefHint: string | null;
  userRefHint: string | null;
  segments: string[];
  lastActivityAt: string;
  outcomeHealth: string;
  signalCount: number;
  sessionCount: number;
  activeNeedCount: number;
  consentState: string;
};

export type CustomerIdentifier = {
  id: string;
  kind: string;
  displayHint: string;
  identityLevel: IdentityLevel | string;
  provenance: SignalProvenance | string;
  verifiedAt: string | null;
};

export type ConsentGrant = {
  scope: string;
  state: string;
  basis: string;
  decidedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revision: number;
};

export type ConsentEvent = {
  id: string;
  scope: string;
  priorState: string | null;
  state: string;
  basis: string;
  revision: number;
  source: string;
  decidedAt: string;
  createdAt: string;
};

export type CustomerSignal = {
  id: string;
  customerId: string | null;
  sessionId: string | null;
  interactionId: string | null;
  feedbackReportId: string | null;
  featureKey: string | null;
  type: SignalType | string;
  summary: string;
  detail: string | null;
  provenance: SignalProvenance | string;
  confidence: number | null;
  collectedAt: string;
  expiresAt: string | null;
  consentScope: string | null;
  consentState: string | null;
};

export type CustomerRollup = {
  customers: number;
  verified: number;
  pseudonymous: number;
  ephemeral: number;
  unclassified: number;
  active: number;
  atRisk: number;
};

export type CustomerFacets = {
  identityLevel: IntelligenceCount[];
  outcomeHealth: IntelligenceCount[];
  signalType: IntelligenceCount[];
  consentState: IntelligenceCount[];
  segment: IntelligenceCount[];
};

export type CustomersPage = {
  customers: CustomerSummary[];
  rollup: CustomerRollup;
  facets: CustomerFacets;
  limit: number;
  nextCursor: string | null;
};

export type CustomerDetail = {
  customer: CustomerSummary;
  identifiers: CustomerIdentifier[];
  signals: CustomerSignal[];
  sessions: DashboardSessionSummary[];
  consent: ConsentGrant[];
  consentHistory: ConsentEvent[];
  counts: { signals: number; sessions: number; features: number };
};

export type FeatureSummary = {
  key: string;
  groupKey: string | null;
  title: string;
  summary: string;
  signalTypes: string[];
  affectedCustomerCount: number;
  evidenceCount: number;
  strongestImpact: string;
  trend: number | null;
  status: string;
  lastObservedAt: string;
  githubIssue: GithubIssueLink | null;
};

export type FeatureRollup = {
  features: number;
  affectedCustomers: number;
  evidence: number;
  blocking: number;
};

export type FeatureFacets = {
  signalType: IntelligenceCount[];
  impact: IntelligenceCount[];
  status: IntelligenceCount[];
  segment: IntelligenceCount[];
};

export type FeaturesPage = {
  features: FeatureSummary[];
  rollup: FeatureRollup;
  facets: FeatureFacets;
  limit: number;
  nextCursor: string | null;
};

export type FeatureDetail = {
  feature: FeatureSummary;
  signals: CustomerSignal[];
  customers: CustomerSummary[];
  sessions: DashboardSessionSummary[];
  reports?: ProductFeedbackReport[];
};

export type SignalsPage = {
  signals: CustomerSignal[];
  total: number;
  limit: number;
  nextCursor: string | null;
};

type PageQuery = {
  productId: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
};

export type CustomersQuery = PageQuery & {
  identityLevel?: string[];
  outcomeHealth?: string[];
  signalType?: string[];
  consentState?: string[];
  segment?: string[];
};

export type FeaturesQuery = PageQuery & {
  signalType?: string[];
  impact?: string[];
  status?: string[];
  segment?: string[];
};

export type SignalsQuery = PageQuery & {
  customerId?: string;
  featureKey?: string;
  sessionId?: string;
  type?: string[];
  provenance?: string[];
};

function appendPageQuery(params: URLSearchParams, query: PageQuery) {
  if (query.q) params.set("q", query.q);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
}

function appendList(params: URLSearchParams, key: string, values?: string[]) {
  if (values?.length) params.set(key, values.join(","));
}

export function customersPath(query: CustomersQuery): string {
  const params = new URLSearchParams({ productId: query.productId });
  appendPageQuery(params, query);
  appendList(params, "identityLevel", query.identityLevel);
  appendList(params, "outcomeHealth", query.outcomeHealth);
  appendList(params, "signalType", query.signalType);
  appendList(params, "consentState", query.consentState);
  appendList(params, "segment", query.segment);
  return `/api/dashboard/customers?${params}`;
}

export function featuresPath(query: FeaturesQuery): string {
  const params = new URLSearchParams({ productId: query.productId });
  appendPageQuery(params, query);
  appendList(params, "signalType", query.signalType);
  appendList(params, "impact", query.impact);
  appendList(params, "status", query.status);
  appendList(params, "segment", query.segment);
  return `/api/dashboard/features?${params}`;
}

export function signalsPath(query: SignalsQuery): string {
  const params = new URLSearchParams({ productId: query.productId });
  appendPageQuery(params, query);
  if (query.customerId) params.set("customerId", query.customerId);
  if (query.featureKey) params.set("featureKey", query.featureKey);
  if (query.sessionId) params.set("sessionId", query.sessionId);
  appendList(params, "type", query.type);
  appendList(params, "provenance", query.provenance);
  return `/api/dashboard/signals?${params}`;
}

export function fetchCustomersPage(workspaceId: string, query: CustomersQuery) {
  return apiRequest<CustomersPage>(customersPath(query), { workspaceId });
}

export function fetchCustomerDetail(workspaceId: string, productId: string, customerId: string) {
  const params = new URLSearchParams({ productId });
  return apiRequest<CustomerDetail>(
    `/api/dashboard/customers/${encodeURIComponent(customerId)}?${params}`,
    { workspaceId },
  );
}

export function fetchFeaturesPage(workspaceId: string, query: FeaturesQuery) {
  return apiRequest<FeaturesPage>(featuresPath(query), { workspaceId });
}

export function fetchFeatureDetail(workspaceId: string, productId: string, featureKey: string) {
  const params = new URLSearchParams({ productId });
  return apiRequest<FeatureDetail>(
    `/api/dashboard/features/${encodeURIComponent(featureKey)}?${params}`,
    { workspaceId },
  );
}

export function fetchSignalsPage(workspaceId: string, query: SignalsQuery) {
  return apiRequest<SignalsPage>(signalsPath(query), { workspaceId });
}
