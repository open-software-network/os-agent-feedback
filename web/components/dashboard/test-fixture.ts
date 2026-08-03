import type {
  CustomerDetail,
  CustomerSignal,
  CustomersPage,
  FeatureDetail,
  FeaturesPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";

export function dashboardFixture(overrides: Partial<DashboardData> = {}): DashboardData {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const environmentId = "33333333-3333-4333-8333-333333333333";
  const interactionId = "44444444-4444-4444-8444-444444444444";
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const reportId = "66666666-6666-4666-8666-666666666666";
  const now = "2026-07-30T12:00:00Z";
  return {
    user: {
      id: "owner-user",
      displayName: "Owner User",
      email: "owner@example.com",
      handle: "owner",
    },
    workspace: {
      id: workspaceId,
      osUserId: "owner-user",
      name: "Epode Team",
      slug: "epode-team",
      feedbackMode: "never_ask",
      collectEventSummaries: false,
      retentionDays: 90,
      createdAt: now,
      updatedAt: now,
    },
    workspaceMemberships: [
      {
        workspaceId,
        workspaceName: "Epode Team",
        workspaceSlug: "epode-team",
        role: "owner",
      },
    ],
    currentRole: "owner",
    products: [
      {
        id: productId,
        workspaceId,
        name: "Search API",
        slug: "search-api",
        createdAt: now,
        updatedAt: now,
      },
    ],
    currentProduct: {
      id: productId,
      workspaceId,
      name: "Search API",
      slug: "search-api",
      createdAt: now,
      updatedAt: now,
    },
    environments: [
      {
        id: environmentId,
        workspaceId,
        productId,
        name: "Production",
        slug: "production",
        feedbackMode: "never_ask",
        collectEventSummaries: false,
        retentionDays: 90,
        createdAt: now,
        updatedAt: now,
      },
    ],
    currentEnvironment: {
      id: environmentId,
      workspaceId,
      productId,
      name: "Production",
      slug: "production",
      feedbackMode: "never_ask",
      collectEventSummaries: false,
      retentionDays: 90,
      createdAt: now,
      updatedAt: now,
    },
    activationMilestones: {
      workspaceId,
      productId,
      firstOpportunityAt: now,
      firstConfirmedInteractionAt: now,
      firstReportAt: now,
    },
    apiKeys: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        environmentId,
        kind: "write",
        label: "Product key",
        prefix: "af_live_1234abcd",
        createdAt: now,
        expiresAt: null,
        lastUsedAt: now,
        revokedAt: null,
        interactionCount: 1,
        reportCount: 1,
      },
    ],
    interactions: [
      {
        id: interactionId,
        workspaceId,
        environmentId,
        apiKeyId: "77777777-7777-4777-8777-777777777777",
        sessionId,
        customerId: null,
        operation: "search",
        surface: "http",
        classification: "confirmed",
        confirmationMethod: "receipt",
        customerRef: "account-42",
        durationMs: 125,
        occurredAt: now,
        statusCode: 200,
        runtimeHint: "node",
        runtimeHintSource: "sdk",
        createdAt: now,
        updatedAt: now,
      },
    ],
    reports: [
      {
        id: reportId,
        interactionId,
        sessionId,
        summary: "Search results omitted the newest document",
        source: "agent",
        findings: [
          {
            kind: "bug",
            topic: "freshness",
            detail: "The document was indexed but not returned.",
            severity: "high",
          },
        ],
        impact: "degraded",
        confidence: 0.9,
        workaround: { used: true, detail: "Requested the document directly." },
        workflowStatus: "new",
        assigneeOsUserId: null,
        tags: [],
        internalNote: null,
        workflowUpdatedAt: null,
        codeHints: [],
        operation: "search",
        surface: "http",
        classification: "confirmed",
        confirmationMethod: "receipt",
        customerRef: "account-42",
        durationMs: 125,
        occurredAt: now,
        statusCode: 200,
        runtimeHint: "node",
        runtimeHintSource: "sdk",
        createdAt: now,
      },
    ],
    sessions: [
      {
        id: sessionId,
        workspaceId,
        environmentId,
        refHint: "session-42",
        source: "sdk",
        startedAt: now,
        lastSeenAt: now,
        createdAt: now,
        interactionCount: 1,
        reportCount: 1,
        firstOperation: "search",
        lastOperation: "search",
        customerRef: "account-42",
        strongestImpact: "degraded",
      },
    ],
    insights: {
      windowDays: 30,
      comparisonDays: 30,
      customerContextItems: 3,
      customersWithContext: 2,
      contextRetrievals: 4,
      personalizationReadyCustomers: 2,
      personalizationDecisions: 2,
      personalizationOutcomes: 1,
      reports: 1,
      opportunities: 1,
      confirmedInteractions: 1,
      confirmationRate: 100,
      reviewRate: 0,
      recentReports: 1,
      previousReports: 0,
      recentOpportunities: 1,
      previousOpportunities: 0,
      recentConfirmedInteractions: 1,
      previousConfirmedInteractions: 0,
      reportsWithBlockers: 0,
      reportsWithWorkarounds: 1,
      p50DurationMs: 125,
      p95DurationMs: 125,
      impacts: [{ name: "degraded", count: 1 }],
      findingKinds: [{ name: "bug", count: 1 }],
      topics: [{ name: "freshness", count: 1 }],
      blockingTopics: [],
      surfaces: [{ name: "http", count: 1 }],
      topOperations: [{ name: "search", count: 1 }],
    } as DashboardData["insights"] & {
      customerContextItems: number;
      customersWithContext: number;
      contextRetrievals: number;
      personalizationReadyCustomers: number;
      personalizationDecisions: number;
      personalizationOutcomes: number;
    },
    listState: {
      interactionsLoaded: 1,
      interactionsTotal: 1,
      reportsLoaded: 1,
      reportsTotal: 1,
      sessionsLoaded: 1,
      sessionsTotal: 1,
    },
    teamMembers: [
      {
        osUserId: "owner-user",
        workspaceId,
        displayName: "Owner User",
        email: "owner@example.com",
        handle: "owner",
        role: "owner",
        joinedAt: now,
        updatedAt: now,
      },
      {
        osUserId: "member-user",
        workspaceId,
        displayName: "Member User",
        email: "member@example.com",
        handle: "member",
        role: "member",
        joinedAt: now,
        updatedAt: now,
      },
    ],
    teamInvitations: [],
    ...overrides,
  };
}

export function signalFixture(overrides: Partial<CustomerSignal> = {}): CustomerSignal {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "55555555-5555-4555-8555-555555555555",
    interactionId: "44444444-4444-4444-8444-444444444444",
    feedbackReportId: "66666666-6666-4666-8666-666666666666",
    featureKey: "freshness-gap",
    signalKey: null,
    value: null,
    type: "feature_need",
    summary: "Results need to include newly indexed documents",
    detail: "The current search path omitted a document needed for the task.",
    provenance: "agent_reports_current_task",
    confidence: 0.9,
    collectedAt: "2026-07-30T12:00:00Z",
    expiresAt: null,
    consentScope: "share_outcome",
    consentState: "approved",
    allowedUses: [],
    ...overrides,
  };
}

export function customersPageFixture(): CustomersPage {
  return {
    customers: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "account",
        parentCustomerId: null,
        memberCount: 1,
        displayName: "Acme workspace",
        identityLevel: "verified",
        identityConfidence: 1,
        accountRefHint: "acct…0042",
        userRefHint: null,
        segments: ["Enterprise"],
        lastActivityAt: "2026-07-30T12:00:00Z",
        outcomeHealth: "blocked",
        signalCount: 4,
        sessionCount: 2,
        activeNeedCount: 1,
        consentState: "approved",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        kind: "anonymous",
        parentCustomerId: null,
        memberCount: 0,
        displayName: "Anonymous actor B7D2",
        identityLevel: "pseudonymous",
        identityConfidence: null,
        accountRefHint: null,
        userRefHint: null,
        segments: [],
        lastActivityAt: "2026-07-29T12:00:00Z",
        outcomeHealth: "helped",
        signalCount: 1,
        sessionCount: 1,
        activeNeedCount: 0,
        consentState: "unknown",
      },
    ],
    rollup: {
      customers: 2,
      verified: 1,
      pseudonymous: 1,
      ephemeral: 0,
      unclassified: 0,
      active: 2,
      atRisk: 1,
    },
    facets: {
      identityLevel: [
        { name: "verified", count: 1 },
        { name: "pseudonymous", count: 1 },
      ],
      outcomeHealth: [
        { name: "blocked", count: 1 },
        { name: "helped", count: 1 },
      ],
      signalType: [{ name: "feature_need", count: 1 }],
      consentState: [{ name: "approved", count: 1 }],
      segment: [{ name: "Enterprise", count: 1 }],
    },
    limit: 50,
    nextCursor: null,
  };
}

export function customerDetailFixture(): CustomerDetail {
  const dashboard = dashboardFixture();
  const customer = customersPageFixture().customers[0];
  return {
    customer,
    identifiers: [
      {
        id: "identifier-1",
        kind: "account_ref",
        displayHint: "acct…0042",
        identityLevel: "verified",
        provenance: "company_assertion",
        verifiedAt: "2026-07-30T12:00:00Z",
      },
    ],
    signals: [
      signalFixture({
        id: "signal-intent",
        signalKey: "search.goal",
        value: "newest_policy",
        type: "intent",
        summary: "Find the newest indexed policy",
        consentScope: "share_preferences",
        allowedUses: ["product_personalization"],
      }),
      signalFixture(),
      signalFixture({
        id: "signal-inference",
        type: "preference",
        summary: "May prefer shorter answers",
        provenance: "agent_inference",
        confidence: 0.55,
        consentScope: "share_preferences",
        consentState: "approved",
        allowedUses: ["product_personalization"],
      }),
    ],
    sessions: dashboard.sessions,
    consent: [
      {
        scope: "share_outcome",
        enrichmentPurpose: null,
        state: "approved",
        basis: "user_decision",
        decidedAt: "2026-07-30T12:00:00Z",
        expiresAt: null,
        revokedAt: null,
        revision: 1,
      },
      {
        scope: "share_preferences",
        enrichmentPurpose: null,
        state: "expired",
        basis: "user_decision",
        decidedAt: "2026-07-01T12:00:00Z",
        expiresAt: "2026-07-15T12:00:00Z",
        revokedAt: null,
        revision: 2,
      },
      {
        scope: "personalize",
        enrichmentPurpose: "targeted_advertising",
        state: "declined",
        basis: "user_decision",
        decidedAt: "2026-07-30T12:05:00Z",
        expiresAt: null,
        revokedAt: null,
        revision: 1,
      },
    ],
    consentHistory: [
      {
        id: "consent-event-1",
        scope: "share_outcome",
        enrichmentPurpose: null,
        priorState: null,
        state: "approved",
        basis: "user_consent",
        revision: 1,
        source: "feedback_consent",
        decidedAt: "2026-07-30T12:00:00Z",
        createdAt: "2026-07-30T12:00:01Z",
      },
      {
        id: "consent-event-2",
        scope: "personalize",
        enrichmentPurpose: "targeted_advertising",
        priorState: null,
        state: "declined",
        basis: "user_decision",
        revision: 1,
        source: "enrichment",
        decidedAt: "2026-07-30T12:05:00Z",
        createdAt: "2026-07-30T12:05:01Z",
      },
    ],
    counts: { signals: 3, sessions: 1, features: 1 },
  };
}

export function featuresPageFixture(): FeaturesPage {
  return {
    features: [
      {
        key: "freshness-gap",
        groupKey: "report-group-freshness",
        title: "Fresh results after indexing",
        summary: "Customers need newly indexed documents to appear immediately.",
        signalTypes: ["feature_need", "friction"],
        affectedCustomerCount: 2,
        evidenceCount: 4,
        strongestImpact: "blocked",
        trend: 25,
        status: "new",
        lastObservedAt: "2026-07-30T12:00:00Z",
        githubIssue: null,
      },
    ],
    rollup: { features: 1, affectedCustomers: 2, evidence: 4, blocking: 1 },
    facets: {
      signalType: [{ name: "feature_need", count: 4 }],
      impact: [{ name: "blocked", count: 4 }],
      status: [{ name: "new", count: 1 }],
      segment: [{ name: "Enterprise", count: 2 }],
    },
    limit: 50,
    nextCursor: null,
  };
}

export function featureDetailFixture(): FeatureDetail {
  const dashboard = dashboardFixture();
  return {
    feature: featuresPageFixture().features[0],
    signals: [signalFixture()],
    customers: customersPageFixture().customers,
    sessions: dashboard.sessions,
    reports: dashboard.reports,
  };
}
