import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

// This credential exists only in the short-lived local fixture below. Neither
// the Next.js app nor the Rust API has a test-auth branch, so it cannot work
// against a deployed environment.
const TEST_COOKIE = "af_oa_access=epode_release_e2e_fixture";
const now = "2026-07-31T12:00:00.000Z";
const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  search: "22222222-2222-4222-8222-222222222222",
  billing: "22222222-2222-4222-8222-222222222223",
  searchEnvironment: "33333333-3333-4333-8333-333333333333",
  billingEnvironment: "33333333-3333-4333-8333-333333333334",
  reportOne: "66666666-6666-4666-8666-666666666666",
  reportTwo: "66666666-6666-4666-8666-666666666667",
  remoteReport: "66666666-6666-4666-8666-666666666668",
  sessionOne: "55555555-5555-4555-8555-555555555555",
  sessionTwo: "55555555-5555-4555-8555-555555555556",
  interactionOne: "44444444-4444-4444-8444-444444444444",
  interactionTwo: "44444444-4444-4444-8444-444444444445",
  customerOne: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  signalOne: "88888888-8888-4888-8888-888888888888",
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = path.resolve(repositoryRoot, "..", ".artifacts", "real-dashboard-screenshots");

function product(id, name) {
  return {
    id,
    workspaceId: ids.workspace,
    name,
    slug: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    createdAt: now,
    updatedAt: now,
  };
}

function environment(productId, id) {
  return {
    id,
    workspaceId: ids.workspace,
    productId,
    name: "Production",
    slug: "production",
    feedbackMode: "never_ask",
    collectEventSummaries: false,
    retentionDays: 90,
    createdAt: now,
    updatedAt: now,
  };
}

function interaction({ id, sessionId, operation, customerRef, occurredAt = now }) {
  return {
    id,
    workspaceId: ids.workspace,
    environmentId: ids.searchEnvironment,
    apiKeyId: "77777777-7777-4777-8777-777777777777",
    sessionId,
    operation,
    surface: "http",
    classification: "confirmed",
    confirmationMethod: "receipt",
    customerRef,
    durationMs: 125,
    occurredAt,
    statusCode: 200,
    runtimeHint: "node",
    runtimeHintSource: "sdk",
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function report({ id, interactionId, sessionId, summary, status, impact, operation, customerRef }) {
  return {
    id,
    interactionId,
    sessionId,
    summary,
    source: "agent",
    findings: [
      {
        kind: "bug",
        topic: "freshness",
        detail: "The returned result did not include the newest record.",
        severity: "high",
      },
    ],
    impact,
    confidence: 0.9,
    workaround: { used: true, detail: "The agent retried with an exact identifier." },
    workflowStatus: status,
    assigneeOsUserId: null,
    tags: ["release-e2e"],
    internalNote: null,
    workflowUpdatedAt: null,
    codeHints: [],
    operation,
    surface: "http",
    classification: "confirmed",
    confirmationMethod: "receipt",
    customerRef,
    durationMs: 125,
    occurredAt: now,
    statusCode: 200,
    runtimeHint: "node",
    runtimeHintSource: "sdk",
    createdAt: now,
    updatedAt: now,
  };
}

function session({ id, refHint, operation, interactionCount, reportCount, customerRef }) {
  return {
    id,
    workspaceId: ids.workspace,
    environmentId: ids.searchEnvironment,
    refHint,
    source: "sdk",
    startedAt: "2026-07-31T11:50:00.000Z",
    lastSeenAt: now,
    createdAt: now,
    interactionCount,
    reportCount,
    firstOperation: operation,
    lastOperation: operation,
    customerRef,
    customerId: ids.customerOne,
    customerDisplayName: "Acme workspace",
    identityLevel: "verified",
    strongestImpact: "blocked",
  };
}

const firstInteraction = interaction({
  id: ids.interactionOne,
  sessionId: ids.sessionOne,
  operation: "search",
  customerRef: "account-42",
});
const secondInteraction = interaction({
  id: ids.interactionTwo,
  sessionId: ids.sessionTwo,
  operation: "checkout",
  customerRef: "account-99",
});
const firstReport = report({
  id: ids.reportOne,
  interactionId: ids.interactionOne,
  sessionId: ids.sessionOne,
  summary: "Search results omitted the newest document",
  status: "new",
  impact: "blocked",
  operation: "search",
  customerRef: "account-42",
});
const secondReport = report({
  id: ids.reportTwo,
  interactionId: ids.interactionTwo,
  sessionId: ids.sessionTwo,
  summary: "Checkout retry hid the confirmation receipt",
  status: "investigating",
  impact: "hindered",
  operation: "checkout",
  customerRef: "account-99",
});
const remoteReport = report({
  id: ids.remoteReport,
  interactionId: ids.interactionTwo,
  sessionId: ids.sessionTwo,
  summary: "Remote feedback detail reached through the BFF",
  status: "planned",
  impact: "helped_with_friction",
  operation: "checkout",
  customerRef: "account-99",
});
const firstSession = session({
  id: ids.sessionOne,
  refHint: "session-42",
  operation: "search",
  interactionCount: 1,
  reportCount: 1,
  customerRef: "account-42",
});
const secondSession = session({
  id: ids.sessionTwo,
  refHint: "session-99",
  operation: "checkout",
  interactionCount: 2,
  reportCount: 1,
  customerRef: "account-99",
});
const firstCustomer = {
  id: ids.customerOne,
  displayName: "Acme workspace",
  identityLevel: "verified",
  identityConfidence: 1,
  accountRefHint: "acco…t-42",
  userRefHint: "user…r-42",
  segments: ["Enterprise"],
  lastActivityAt: now,
  outcomeHealth: "blocked",
  signalCount: 1,
  sessionCount: 1,
  activeNeedCount: 1,
  consentState: "approved",
  contextSummary: "Find the newest indexed policy",
  contextCount: 1,
  personalizationReady: true,
};
const firstSignal = {
  id: ids.signalOne,
  customerId: ids.customerOne,
  sessionId: ids.sessionOne,
  interactionId: ids.interactionOne,
  feedbackReportId: ids.reportOne,
  featureKey: null,
  signalKey: "b2b.primary_goal",
  value: "improve_operations",
  type: "intent",
  summary: "Find the newest indexed policy",
  detail: "The customer needs current policy information before making a decision.",
  provenance: "agent_reports_user_statement",
  confidence: 0.9,
  collectedAt: now,
  expiresAt: null,
  consentScope: "share_preferences",
  consentState: "approved",
  allowedUses: ["product_personalization"],
};
const firstResponse = {
  id: "89898989-8989-4898-8898-898989898989",
  question: "What does the user need from search right now?",
  operation: "search_catalog",
  status: "answered",
  purpose: "product_personalization",
  surface: "http_json",
  customerId: ids.customerOne,
  customerName: "Acme workspace",
  sessionId: ids.sessionOne,
  sessionRef: "session-42",
  askedAt: now,
  answeredAt: now,
  answers: [
    {
      key: "b2b.primary_goal",
      type: "intent",
      value: "Find the newest indexed policy",
      summary: "The user needs the newest indexed policy",
      remembered: true,
    },
  ],
};
const firstFeature = {
  key: "freshness-gap",
  groupKey: "report-group-freshness",
  title: "Fresh results after indexing",
  summary: "Customers need newly indexed documents to appear immediately.",
  signalTypes: ["feature_need", "friction"],
  affectedCustomerCount: 1,
  evidenceCount: 1,
  strongestImpact: "blocked",
  trend: 25,
  status: "new",
  lastObservedAt: now,
  githubIssue: null,
};

function createFixture() {
  const state = {
    authStarts: 0,
    createdProducts: [],
    feedbackMode: "never_ask",
    retentionDays: 90,
    invitations: [],
    requests: [],
  };

  function activeProducts() {
    return [
      product(ids.search, "Search API"),
      product(ids.billing, "Billing API"),
      ...state.createdProducts,
    ];
  }

  function activeProduct(productId) {
    return activeProducts().find((item) => item.id === productId) ?? activeProducts()[0];
  }

  function productEnvironment(item) {
    const id =
      item.id === ids.search
        ? ids.searchEnvironment
        : item.id === ids.billing
          ? ids.billingEnvironment
          : item.environmentId;
    return {
      ...environment(item.id, id),
      feedbackMode: state.feedbackMode,
      retentionDays: state.retentionDays,
    };
  }

  function dashboard(productId) {
    const currentProduct = activeProduct(productId);
    const selectedSearchProduct = currentProduct.id === ids.search;
    const reports = selectedSearchProduct ? [firstReport] : [];
    const sessions = selectedSearchProduct ? [firstSession] : [];
    const interactions = selectedSearchProduct ? [firstInteraction] : [];
    const currentEnvironment = productEnvironment(currentProduct);
    const allEnvironments = activeProducts().map(productEnvironment);
    return {
      user: {
        id: "owner-user",
        displayName: "Owner User",
        email: "owner@example.com",
        handle: "owner",
      },
      workspace: {
        id: ids.workspace,
        osUserId: "owner-user",
        name: "Release E2E Team",
        slug: "release-e2e-team",
        feedbackMode: state.feedbackMode,
        collectEventSummaries: false,
        retentionDays: 90,
        createdAt: now,
        updatedAt: now,
      },
      workspaceMemberships: [
        {
          workspaceId: ids.workspace,
          workspaceName: "Release E2E Team",
          workspaceSlug: "release-e2e-team",
          role: "owner",
        },
      ],
      currentRole: "owner",
      products: activeProducts(),
      currentProduct,
      environments: allEnvironments,
      currentEnvironment,
      activationMilestones: selectedSearchProduct
        ? {
            workspaceId: ids.workspace,
            productId: currentProduct.id,
            firstOpportunityAt: now,
            firstConfirmedInteractionAt: now,
            firstReportAt: now,
          }
        : null,
      apiKeys: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          environmentId: currentEnvironment.id,
          kind: "write",
          label: "Product key",
          prefix: "af_live_1234abcd",
          createdAt: now,
          expiresAt: null,
          lastUsedAt: now,
          revokedAt: null,
        },
      ],
      interactions,
      reports,
      sessions,
      insights: {
        windowDays: 30,
        comparisonDays: 30,
        customerContextItems: selectedSearchProduct ? 1 : 0,
        customersWithContext: selectedSearchProduct ? 1 : 0,
        contextRetrievals: selectedSearchProduct ? 2 : 0,
        personalizationReadyCustomers: selectedSearchProduct ? 1 : 0,
        personalizationDecisions: selectedSearchProduct ? 1 : 0,
        personalizationOutcomes: selectedSearchProduct ? 1 : 0,
        reports: reports.length,
        opportunities: selectedSearchProduct ? 3 : 0,
        confirmedInteractions: selectedSearchProduct ? 2 : 0,
        confirmationRate: selectedSearchProduct ? 100 : 0,
        reviewRate: selectedSearchProduct ? 50 : 0,
        recentReports: reports.length,
        previousReports: 0,
        recentOpportunities: selectedSearchProduct ? 3 : 0,
        previousOpportunities: 0,
        recentConfirmedInteractions: selectedSearchProduct ? 2 : 0,
        previousConfirmedInteractions: 0,
        reportsWithBlockers: reports.length,
        reportsWithWorkarounds: reports.length,
        p50DurationMs: 125,
        p95DurationMs: 125,
        impacts: reports.length ? [{ name: "blocked", count: 1 }] : [],
        findingKinds: reports.length ? [{ name: "bug", count: 1 }] : [],
        topics: reports.length ? [{ name: "freshness", count: 1 }] : [],
        blockingTopics: reports.length ? [{ name: "freshness", count: 1 }] : [],
        surfaces: selectedSearchProduct ? [{ name: "http", count: 2 }] : [],
        topOperations: selectedSearchProduct ? [{ name: "search", count: 2 }] : [],
      },
      listState: {
        interactionsLoaded: interactions.length,
        interactionsTotal: selectedSearchProduct ? 2 : 0,
        reportsLoaded: reports.length,
        reportsTotal: selectedSearchProduct ? 2 : 0,
        sessionsLoaded: sessions.length,
        sessionsTotal: selectedSearchProduct ? 2 : 0,
      },
      teamMembers: [
        {
          osUserId: "owner-user",
          workspaceId: ids.workspace,
          displayName: "Owner User",
          email: "owner@example.com",
          handle: "owner",
          role: "owner",
          joinedAt: now,
          updatedAt: now,
        },
        {
          osUserId: "member-user",
          workspaceId: ids.workspace,
          displayName: "Member User",
          email: "member@example.com",
          handle: "member",
          role: "member",
          joinedAt: now,
          updatedAt: now,
        },
      ],
      teamInvitations: state.invitations,
    };
  }

  function requireFixtureSession(request, response) {
    if ((request.headers.cookie ?? "").includes(TEST_COOKIE)) return true;
    json(response, 401, { error: "fixture session required" });
    return false;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const body = await readBody(request);
    state.requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
    });

    if (url.pathname === "/auth/start") {
      state.authStarts += 1;
      if (state.authStarts === 1) {
        redirect(response, "/?auth=failed");
      } else {
        response.setHeader("set-cookie", `${TEST_COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
        redirect(response, "/");
      }
      return;
    }

    if (url.pathname === "/api/auth/logout") {
      json(response, 200, { authenticated: false });
      return;
    }

    if (!requireFixtureSession(request, response)) return;

    if (url.pathname === "/api/dashboard") {
      json(response, 200, dashboard(url.searchParams.get("productId") ?? undefined));
      return;
    }

    if (url.pathname === "/api/dashboard/customers") {
      const selectedSearchProduct = url.searchParams.get("productId") === ids.search;
      json(response, 200, {
        customers: selectedSearchProduct ? [firstCustomer] : [],
        rollup: {
          customers: selectedSearchProduct ? 1 : 0,
          verified: selectedSearchProduct ? 1 : 0,
          pseudonymous: 0,
          ephemeral: 0,
          unclassified: 0,
          active: selectedSearchProduct ? 1 : 0,
          atRisk: selectedSearchProduct ? 1 : 0,
        },
        facets: {
          identityLevel: selectedSearchProduct ? [{ name: "verified", count: 1 }] : [],
          outcomeHealth: selectedSearchProduct ? [{ name: "blocked", count: 1 }] : [],
          signalType: selectedSearchProduct ? [{ name: "feature_need", count: 1 }] : [],
          consentState: selectedSearchProduct ? [{ name: "approved", count: 1 }] : [],
          segment: selectedSearchProduct ? [{ name: "Enterprise", count: 1 }] : [],
        },
        limit: Number(url.searchParams.get("limit") ?? 50),
        nextCursor: null,
      });
      return;
    }

    if (url.pathname === `/api/dashboard/customers/${ids.customerOne}`) {
      json(response, 200, {
        customer: firstCustomer,
        identifiers: [
          {
            id: "identifier-1",
            kind: "account_ref",
            displayHint: "acco…t-42",
            identityLevel: "verified",
            provenance: "company_assertion",
            verifiedAt: now,
          },
        ],
        requestObservations: [
          {
            id: "request-observation-1",
            interactionId: firstSignal.interactionId,
            clientIp: "203.0.113.42",
            method: "GET",
            userAgent: "Release-E2E-Browser/1.0",
            acceptLanguage: "en-US",
            referrerOrigin: "https://customer.example.test",
            secChUa: null,
            secChUaPlatform: '"macOS"',
            secChUaMobile: "?0",
            observedAt: now,
          },
        ],
        signals: [firstSignal],
        contextReturns: [
          {
            retrievalId: "context-retrieval-release-e2e",
            interactionId: ids.interactionOne,
            sessionId: ids.sessionOne,
            purpose: "product_personalization",
            identityLevel: "verified",
            contextVersion: "ctx1_release_e2e",
            retrievedAt: now,
            items: [
              {
                signalId: firstSignal.id,
                key: firstSignal.signalKey,
                type: firstSignal.type,
                value: firstSignal.value,
                summary: firstSignal.summary,
                provenance: firstSignal.provenance,
                confidence: firstSignal.confidence,
                expiresAt: firstSignal.expiresAt,
              },
            ],
            decisions: [
              {
                id: "context-decision-release-e2e",
                externalDecisionId: "release-e2e-freshness-first",
                variant: "freshness_first",
                signalIds: [firstSignal.id],
                createdAt: now,
                outcomes: [
                  {
                    id: "context-outcome-release-e2e",
                    externalOutcomeId: "release-e2e-complete",
                    decisionId: "context-decision-release-e2e",
                    outcome: "completion",
                    occurredAt: now,
                  },
                ],
              },
            ],
          },
        ],
        sessions: [firstSession],
        consent: [
          {
            scope: "share_preferences",
            enrichmentPurpose: "product_personalization",
            state: "approved",
            basis: "user_decision",
            decidedAt: now,
            expiresAt: null,
            revokedAt: null,
            revision: 1,
          },
        ],
        consentHistory: [],
        counts: { signals: 1, sessions: 1, features: 1, requestObservations: 1 },
      });
      return;
    }

    if (url.pathname === "/api/dashboard/signals") {
      const selectedSearchProduct = url.searchParams.get("productId") === ids.search;
      json(response, 200, {
        signals: selectedSearchProduct ? [firstSignal] : [],
        total: selectedSearchProduct ? 1 : 0,
        limit: Number(url.searchParams.get("limit") ?? 100),
        nextCursor: null,
      });
      return;
    }

    if (url.pathname === "/api/dashboard/responses") {
      const selectedSearchProduct = url.searchParams.get("productId") === ids.search;
      json(response, 200, {
        responses: selectedSearchProduct ? [firstResponse] : [],
        rollup: {
          questions: selectedSearchProduct ? 1 : 0,
          answered: selectedSearchProduct ? 1 : 0,
          awaitingAnswer: 0,
          declined: 0,
        },
        limit: Number(url.searchParams.get("limit") ?? 50),
        nextCursor: null,
      });
      return;
    }

    if (url.pathname === "/api/dashboard/features") {
      const selectedSearchProduct = url.searchParams.get("productId") === ids.search;
      json(response, 200, {
        features: selectedSearchProduct ? [firstFeature] : [],
        rollup: {
          features: selectedSearchProduct ? 1 : 0,
          affectedCustomers: selectedSearchProduct ? 1 : 0,
          evidence: selectedSearchProduct ? 1 : 0,
          blocking: selectedSearchProduct ? 1 : 0,
        },
        facets: {
          signalType: selectedSearchProduct ? [{ name: "feature_need", count: 1 }] : [],
          impact: selectedSearchProduct ? [{ name: "blocked", count: 1 }] : [],
          status: selectedSearchProduct ? [{ name: "new", count: 1 }] : [],
          segment: selectedSearchProduct ? [{ name: "Enterprise", count: 1 }] : [],
        },
        limit: Number(url.searchParams.get("limit") ?? 50),
        nextCursor: null,
      });
      return;
    }

    if (url.pathname === "/api/dashboard/features/freshness-gap") {
      json(response, 200, {
        feature: firstFeature,
        signals: [firstSignal],
        customers: [firstCustomer],
        sessions: [firstSession],
        reports: [firstReport],
      });
      return;
    }

    if (url.pathname === "/api/dashboard/feedback") {
      const filtered =
        url.searchParams.get("status") === "investigating" ||
        url.searchParams.get("q")?.includes("checkout")
          ? [secondReport]
          : url.searchParams.get("cursor") === "feedback-page-2"
            ? [secondReport]
            : [firstReport];
      json(response, 200, {
        reports: filtered,
        total: url.searchParams.get("status") === "investigating" ? 1 : 2,
        limit: Number(url.searchParams.get("limit") ?? 50),
        nextCursor:
          filtered[0]?.id === firstReport.id && !url.searchParams.get("status")
            ? "feedback-page-2"
            : null,
      });
      return;
    }

    if (url.pathname === "/api/dashboard/sessions") {
      const filtered =
        ["multi", "response"].includes(url.searchParams.get("kind")) ||
        url.searchParams.get("q")?.includes("checkout")
          ? [secondSession]
          : url.searchParams.get("cursor") === "session-page-2"
            ? [secondSession]
            : [firstSession];
      json(response, 200, {
        sessions: filtered,
        rollup: {
          sessions: url.searchParams.get("kind") === "multi" ? 1 : 2,
          interactions: 3,
          multiStepSessions: 1,
          averageInteractions: 1.5,
        },
        limit: Number(url.searchParams.get("limit") ?? 50),
        nextCursor:
          filtered[0]?.id === firstSession.id && !url.searchParams.get("kind")
            ? "session-page-2"
            : null,
      });
      return;
    }

    if (url.pathname.startsWith("/api/dashboard/reports/")) {
      const reportId = url.pathname.split("/").at(-1);
      const matching = [firstReport, secondReport, remoteReport].find(
        (item) => item.id === reportId,
      );
      json(
        response,
        matching ? 200 : 404,
        matching ? { report: matching } : { error: "missing report" },
      );
      return;
    }

    if (url.pathname.startsWith("/api/dashboard/sessions/")) {
      const sessionId = url.pathname.split("/").at(-1);
      const selected = sessionId === ids.sessionTwo ? secondSession : firstSession;
      const selectedInteraction =
        selected.id === ids.sessionTwo ? secondInteraction : firstInteraction;
      const selectedReport = selected.id === ids.sessionTwo ? secondReport : firstReport;
      json(response, 200, {
        session: selected,
        interactions: [selectedInteraction],
        reports: [selectedReport],
        responses: selected.id === ids.sessionTwo ? [] : [firstResponse],
      });
      return;
    }

    if (url.pathname === "/api/products" && request.method === "POST") {
      const input = JSON.parse(body || "{}");
      const newProduct = {
        ...product("22222222-2222-4222-8222-222222222229", input.name || "Untitled product"),
        environmentId: "33333333-3333-4333-8333-333333333339",
      };
      state.createdProducts.push(newProduct);
      json(response, 201, {
        product: newProduct,
        environment: productEnvironment(newProduct),
        secret: "af_live_release_e2e_secret",
      });
      return;
    }

    if (url.pathname === "/api/settings/policy" && request.method === "POST") {
      const input = JSON.parse(body || "{}");
      state.feedbackMode = input.feedbackMode ?? "never_ask";
      state.retentionDays = input.retentionDays ?? state.retentionDays;
      json(response, 200, { environment: dashboard().currentEnvironment });
      return;
    }

    if (url.pathname === "/api/team/invitations" && request.method === "POST") {
      const input = JSON.parse(body || "{}");
      const invitation = {
        id: `88888888-8888-4888-8888-${String(state.invitations.length + 1).padStart(12, "0")}`,
        workspaceId: ids.workspace,
        inviteeKind: input.invitee ? "email" : "link",
        inviteeValue: input.invitee ?? null,
        role: input.role ?? "member",
        createdAt: now,
        expiresAt: "2026-08-07T12:00:00.000Z",
      };
      state.invitations.push(invitation);
      json(response, 201, { invitation, joinPath: `/join/${invitation.id}` });
      return;
    }

    json(response, 404, { error: `fixture has no route for ${request.method} ${url.pathname}` });
  });

  return { server, state };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function executablePath() {
  const candidates = [
    process.env.EPODE_E2E_BROWSER,
    puppeteer.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional browser location.
    }
  }
  throw new Error(
    "Chrome or Chromium was not found. Set EPODE_E2E_BROWSER to the browser binary used by CI.",
  );
}

function startNext({ port, apiUrl }) {
  const output = [];
  const child = spawn(
    "pnpm",
    ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        API_URL: apiUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  return { child, output };
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js stopped before it became ready:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${url}/auth/signin`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Next.js:\n${output.join("")}`);
}

async function clickText(page, text) {
  await page.waitForFunction(
    (target) =>
      [
        ...document.querySelectorAll(
          "button, a, [role=tab], [role=menuitem], [role=menuitemradio]",
        ),
      ].some(
        (element) => element.textContent?.trim() === target && !element.hasAttribute("disabled"),
      ),
    { timeout: 15_000 },
    text,
  );
  await page.evaluate((target) => {
    const element = [
      ...document.querySelectorAll("button, a, [role=tab], [role=menuitem], [role=menuitemradio]"),
    ].find((item) => item.textContent?.trim() === target && !item.hasAttribute("disabled"));
    if (!(element instanceof HTMLElement)) throw new Error(`Could not click ${target}`);
    element.click();
  }, text);
}

async function textVisible(page, text) {
  await page.waitForFunction(
    (target) => document.body.innerText.includes(target),
    { timeout: 15_000 },
    text,
  );
}

async function metricVisible(page, label, value) {
  await page.waitForFunction(
    ({ targetLabel, targetValue }) =>
      [...document.querySelectorAll("dt")].some(
        (term) =>
          term.textContent?.trim() === targetLabel &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === targetValue,
      ),
    { timeout: 15_000 },
    { targetLabel: label, targetValue: value },
  );
}

async function fixtureRequest(state, predicate, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = state.requests.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected BFF fixture request: ${description}`);
}

function requestPath(pathname) {
  return (request) => request.path.startsWith(pathname);
}

async function runBrowserChecks({ page, baseUrl, state, upstreamHost }) {
  await mkdir(artifactDirectory, { recursive: true });
  const initialResponse = await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  assert.match(
    initialResponse?.headers()["content-security-policy"] ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal(initialResponse?.headers()["x-frame-options"], "DENY");
  assert.match(page.url(), /\/auth\/signin/);
  await textVisible(page, "Sign in to Epode");

  await clickText(page, "Continue");
  await textVisible(page, "Sign in to Epode");
  assert.equal(
    state.authStarts,
    1,
    "first OS Accounts handoff should fail in the disposable fixture",
  );

  await clickText(page, "Continue");
  await textVisible(page, "Epode is the agent experience and analytics layer for your product.");
  assert.equal(new URL(page.url()).pathname, "/", "the dashboard must live at the root, not /app");
  assert.equal(state.authStarts, 2, "retry should reach the same OS Accounts handoff route");
  await fixtureRequest(state, requestPath("/api/dashboard"), "initial dashboard data");
  await page.screenshot({ path: path.join(artifactDirectory, "01-home.png"), fullPage: true });

  await page.click("button[aria-label*='open product menu']");
  await clickText(page, "Billing API");
  await textVisible(page, "Epode is the agent experience and analytics layer for your product.");
  await page.click("button[aria-label*='open product menu']");
  await clickText(page, "Search API");
  await textVisible(page, "Epode is the agent experience and analytics layer for your product.");

  await clickText(page, "Responses");
  const responses = await fixtureRequest(
    state,
    (request) =>
      request.path.startsWith("/api/dashboard/responses?") &&
      request.path.includes(`productId=${ids.search}`),
    "question and answer list for Responses",
  );
  assert.equal(responses.headers["x-workspace-id"], ids.workspace);
  assert.equal(
    responses.headers.host,
    upstreamHost,
    "the browser must reach responses only through the root-host BFF",
  );
  assert.ok(
    String(responses.headers.cookie).includes(TEST_COOKIE),
    "the responses BFF must forward the real browser session cookie",
  );
  await textVisible(page, "Tool called");
  await textVisible(page, "search_catalog");
  await textVisible(page, "Find the newest indexed policy");
  await textVisible(page, "Acme workspace");
  await textVisible(page, "session-42");
  await page.screenshot({ path: path.join(artifactDirectory, "05-responses.png"), fullPage: true });

  await clickText(page, "Customers");
  await page.waitForSelector('input[aria-label="Search customers"]', { visible: true });
  await metricVisible(page, "Customers", "1");
  await metricVisible(page, "Known", "1");
  await clickText(page, "Acme workspace");
  await textVisible(page, "What we know");
  await textVisible(page, "Context returned to product");
  await textVisible(page, "Freshness First");
  await textVisible(page, "Request facts");
  await textVisible(page, "IP 203.0.113.42");
  await textVisible(page, "MAC addresses are not exposed by routed HTTP");
  await textVisible(page, "Journeys");
  await page.screenshot({ path: path.join(artifactDirectory, "02-customers.png"), fullPage: true });
  const customerDetail = await fixtureRequest(
    state,
    requestPath(`/api/dashboard/customers/${ids.customerOne}`),
    "customer detail BFF route",
  );
  assert.equal(customerDetail.headers["x-workspace-id"], ids.workspace);
  assert.equal(
    customerDetail.headers.host,
    upstreamHost,
    "the browser must reach customer detail only through the root-host BFF",
  );
  assert.ok(
    String(customerDetail.headers.cookie).includes(TEST_COOKIE),
    "BFF must forward the real browser session cookie to its API origin",
  );

  await clickText(page, "Journeys");
  await textVisible(page, "Proven journeys");
  await page.screenshot({ path: path.join(artifactDirectory, "03-journeys.png"), fullPage: true });
  await clickText(page, "Filters");
  await textVisible(page, "Has response");
  await textVisible(page, "No response");
  await clickText(page, "Has response");
  await clickText(page, "Apply");
  const responseFilteredSessions = await fixtureRequest(
    state,
    (request) =>
      request.path.startsWith("/api/dashboard/sessions?") && request.path.includes("kind=response"),
    "response-filtered session list",
  );
  assert.equal(responseFilteredSessions.headers["x-workspace-id"], ids.workspace);

  await clickText(page, "Home");
  await textVisible(page, "Connect Search API");
  await textVisible(page, "Install Epode once to serve an agent experience graph and optional permissioned context.");
  await textVisible(page, "Agent experience graph");
  await metricVisible(page, "Product key", "Ready");
  await metricVisible(page, "SDK connected", "Complete");
  await metricVisible(page, "Answers stored", "1");
  await metricVisible(page, "Customers with context", "1");
  await metricVisible(page, "Ready customers", "1");
  await metricVisible(page, "Answer retrievals", "2");
  await page.screenshot({ path: path.join(artifactDirectory, "04-setup.png"), fullPage: true });
  await textVisible(page, "1. Install Epode");
  await textVisible(page, "2. Identify customers when possible");
  await textVisible(page, "3. Use answers to personalize");
  await clickText(page, "4. Verify the complete loop");
  await textVisible(
    page,
    "Answer activation loop complete; linked Sessions still require the manual checks below.",
  );
  await textVisible(page, "Verify linked Sessions manually · not yet verified");

  await clickText(page, "Connectors");
  await textVisible(page, "Destinations");
  await textVisible(page, "Apps");
  await textVisible(page, "Code");

  await clickText(page, "Configurations");
  await clickText(page, "Data controls");
  await textVisible(page, "Allowed customer information");
  await textVisible(page, "Product personalization");
  await textVisible(page, "Targeted advertising");
  await textVisible(page, "Data retention");
  await clickText(page, "30 days");
  await page.click("summary");
  await page.select("#feedback-mode", "ask_once");
  await clickText(page, "Save retention and outcome settings");
  await textVisible(
    page,
    "Retention saved. Legacy outcome feedback is ask_once; customer enrichment permission is unchanged.",
  );
  const policySave = await fixtureRequest(
    state,
    (request) =>
      request.method === "POST" &&
      request.path === "/api/settings/policy" &&
      request.body.includes('"feedbackMode":"ask_once"') &&
      request.body.includes('"retentionDays":30'),
    "collection policy save",
  );
  assert.equal(policySave.headers["x-workspace-id"], ids.workspace);
  assert.equal(state.feedbackMode, "ask_once");
  assert.equal(state.retentionDays, 30);
}

async function writeFailureArtifacts(page, error, state, nextOutput) {
  await mkdir(artifactDirectory, { recursive: true });
  const trace = {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    requests: state?.requests ?? [],
    nextOutput: nextOutput?.join("") ?? "",
  };
  await writeFile(
    path.join(artifactDirectory, "dashboard-release-e2e-trace.json"),
    JSON.stringify(trace, null, 2),
  );
  if (page) {
    await page.screenshot({
      path: path.join(artifactDirectory, "dashboard-release-e2e-failure.png"),
      fullPage: true,
    });
  }
}

async function main() {
  const fixture = createFixture();
  const apiUrl = await listen(fixture.server);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const next = startNext({ port, apiUrl });
  let browser;
  let page;
  try {
    await waitForServer(baseUrl, next.child, next.output);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: await executablePath(),
      args: os.platform() === "linux" ? ["--no-sandbox"] : [],
      defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    });
    page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await runBrowserChecks({
      page,
      baseUrl,
      state: fixture.state,
      upstreamHost: new URL(apiUrl).host,
    });
    process.stdout.write("Dashboard release browser check passed.\n");
  } catch (error) {
    await writeFailureArtifacts(page, error, fixture.state, next.output);
    throw error;
  } finally {
    await browser?.close();
    next.child.kill("SIGTERM");
    await close(fixture.server);
  }
}

await main();
