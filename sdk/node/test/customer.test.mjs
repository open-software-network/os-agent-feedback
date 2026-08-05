import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/server";
import express from "express";
import Fastify from "fastify";

import { createEpode } from "../dist/customer.js";
import { epode as epodeExpress } from "../dist/customer-express.js";
import { epode as epodeFastify } from "../dist/customer-fastify.js";
import { epode as epodeMcp } from "../dist/customer-mcp.js";

const key = `af_live_0123456789abcdef0123456789abcdef_${"x".repeat(32)}`;
const ids = {
  request: "10000000-0000-4000-8000-000000000001",
  customer: "10000000-0000-4000-8000-000000000002",
  signal: "10000000-0000-4000-8000-000000000003",
  retrieval: "10000000-0000-4000-8000-000000000004",
  decision: "10000000-0000-4000-8000-000000000005",
  outcome: "10000000-0000-4000-8000-000000000006",
};
const consentStageInstruction =
  "Finish the user's product task first. Then ask the exact question once and stop. Wait for the user's next explicit reply; never infer approval from silence, prior use, or the current request. Submit approved only for an unambiguous yes, declined only for an unambiguous no, and submit nothing when the reply is unclear.";
const answerStageInstruction =
  "Finish the user's product task first. Then submit at most one bounded answer using the provided schema. Include only relevant, non-sensitive context allowed by the explicit permission; do not infer identity or sensitive traits.";
const noActionStageInstruction = "No enrichment action is permitted for this request.";
const answerInstruction =
  "Provide only non-sensitive context the user explicitly shared or that is directly relevant to the current task for this product experience by Example Store. Mark only durable preferences as remembered; keep situational context interaction-scoped. Never include prompts, transcripts, names, emails, credentials, or raw customer content.";
const consentBodySchema = { decision: ["approved", "declined"] };
const answerBodySchema = {
  status: ["answered", "declined", "no_relevant_context"],
  items: {
    maximum: 8,
    required: ["key", "type", "value", "provenance", "remember"],
    type: ["intent", "preference", "constraint", "interest"],
    provenance: ["agent_reports_user_statement", "agent_reports_current_task", "agent_inference"],
  },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function customerContextFromHtml(html) {
  const encoded = /<meta name="epode-customer-context" content="([A-Za-z0-9_-]+)">/.exec(html)?.[1];
  assert.ok(encoded, "HTML is missing the Epode customer-context marker");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))._epode.customerContext;
}

async function serve(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function backend({ enforceConsent = false } = {}) {
  const calls = [];
  let currentInteractionId;
  const answeredInteractions = new Set();
  const approvedInteractions = new Set();
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({ path, authorization: init.headers.authorization, body });
    if (path === "/api/v2/enrichment/requests") {
      currentInteractionId = body.interactionId;
      const answered = answeredInteractions.has(body.interactionId);
      return json({
        requestId: ids.request,
        interactionId: body.interactionId,
        state: answered ? "answered" : "consent_required",
        purpose: body.purpose,
        identityLevel: body.anonymousRef
          ? "pseudonymous"
          : body.accountRef || body.userRef || body.customerRef
            ? "verified"
            : "ephemeral",
        stageInstruction: answered ? noActionStageInstruction : consentStageInstruction,
        question: answered ? null : "May Example Store remember these shopping preferences?",
        answerInstruction: null,
        expiresAt: "2026-08-02T15:00:00Z",
        consent: {
          url: "https://app.epode.ai/api/v2/enrichment/consent/decisions",
          method: "POST",
          authorization: "Bearer aqr1_request-1",
          contentType: "application/json",
          bodySchema: consentBodySchema,
        },
        submit: null,
      });
    }
    if (path === "/api/v2/enrichment/requests/inspect") {
      const approved = approvedInteractions.has(currentInteractionId);
      return json({
        requestId: ids.request,
        interactionId: currentInteractionId,
        state: approved ? "answer_ready" : "consent_required",
        purpose: "product_personalization",
        identityLevel: "verified",
        stageInstruction: approved ? answerStageInstruction : consentStageInstruction,
        question: approved ? null : "May Example Store remember these shopping preferences?",
        answerInstruction: approved ? answerInstruction : null,
        expiresAt: "2026-08-02T15:00:00Z",
        consent: {
          url: "https://app.epode.ai/api/v2/enrichment/consent/decisions",
          method: "POST",
          authorization: "Bearer aqr1_request-1",
          contentType: "application/json",
          bodySchema: consentBodySchema,
        },
        submit: approved
          ? {
              url: "https://app.epode.ai/api/v2/enrichment/answers",
              method: "POST",
              authorization: "Bearer aqr1_answer-1",
              contentType: "application/json",
              bodySchema: answerBodySchema,
            }
          : null,
      });
    }
    if (path === "/api/v2/enrichment/consent/decisions") {
      if (body.decision === "approved") approvedInteractions.add(currentInteractionId);
      else approvedInteractions.delete(currentInteractionId);
      return json({
        requestId: ids.request,
        state: body.decision === "approved" ? "answer_ready" : "declined",
        changed: true,
        stageInstruction:
          body.decision === "approved" ? answerStageInstruction : noActionStageInstruction,
        answerInstruction: body.decision === "approved" ? answerInstruction : null,
        submit:
          body.decision === "approved"
            ? {
                url: "https://app.epode.ai/api/v2/enrichment/answers",
                method: "POST",
                authorization: "Bearer aqr1_answer-1",
                contentType: "application/json",
                bodySchema: answerBodySchema,
              }
            : null,
      });
    }
    if (path === "/api/v2/enrichment/answers") {
      if (enforceConsent && !approvedInteractions.has(currentInteractionId)) {
        return json({ error: "customer_context_not_approved" }, 403);
      }
      answeredInteractions.add(currentInteractionId);
      return json({
        accepted: true,
        requestId: ids.request,
        interactionId: currentInteractionId,
        customerId: ids.customer,
        signals: (body.items || []).map((item) => ({
          ...item,
          signalId: ids.signal,
          allowedUses: ["product_personalization"],
          expiresAt: item.expiresAt || null,
          confidence: item.confidence ?? null,
          remembered: item.remember,
        })),
      });
    }
    if (path === "/api/v2/customer-context") {
      const hasCorrelation = Boolean(
        body.accountRef ||
          body.userRef ||
          body.anonymousRef ||
          body.customerRef ||
          body.interactionId,
      );
      return json({
        retrievalId: ids.retrieval,
        identityLevel: body.anonymousRef
          ? "pseudonymous"
          : body.accountRef || body.userRef || body.customerRef
            ? "verified"
            : "ephemeral",
        customerId: body.interactionId ? null : ids.customer,
        interactionId: body.interactionId || null,
        contextVersion: "context-1",
        items: hasCorrelation
          ? [
              {
                signalId: ids.signal,
                key: "budget",
                type: "constraint",
                value: "under_150_usd",
                summary: "Customer explicitly stated a budget under $150.",
                provenance: "agent_reports_user_statement",
                confidence: 1,
                expiresAt: null,
                allowedUses: ["product_personalization"],
                remembered: true,
              },
            ]
          : [],
      });
    }
    if (path === "/api/v2/personalization/decisions") {
      return json({
        decision: {
          id: ids.decision,
          externalDecisionId: body.externalDecisionId,
          purpose: "product_personalization",
          signalIds: body.signalIds,
          variant: body.variant || null,
          createdAt: "2026-08-02T14:00:00Z",
        },
      });
    }
    if (path === "/api/v2/personalization/outcomes") {
      return json({
        outcome: {
          id: ids.outcome,
          ...body,
          occurredAt: body.occurredAt || "2026-08-02T14:05:00Z",
          createdAt: "2026-08-02T14:05:01Z",
        },
      });
    }
    return json({ error: "not_found" }, 404);
  };
  return { calls, fetch };
}

function mcpMatrixBackend() {
  const calls = [];
  const records = new Map();
  const rememberedIdentities = new Set();
  const inspectionFailures = new Map();
  const operationStates = new Map();
  let sequence = 0;

  const identityKey = (input) =>
    input.accountRef || input.userRef || input.customerRef || input.anonymousRef || "ephemeral";
  const action = (authorization, bodySchema) => ({
    url: "https://app.epode.ai/api/v2/enrichment/answers",
    method: "POST",
    authorization: `Bearer ${authorization}`,
    contentType: "application/json",
    bodySchema,
  });
  const responseFor = (record) => ({
    requestId: record.requestId,
    interactionId: record.interactionId,
    state: record.state,
    purpose: "product_personalization",
    identityLevel: record.identityKey === "ephemeral" ? "ephemeral" : "verified",
    stageInstruction:
      record.state === "consent_required"
        ? consentStageInstruction
        : record.state === "answer_ready"
          ? answerStageInstruction
          : noActionStageInstruction,
    question:
      record.state === "consent_required"
        ? "May Example Store use relevant context to personalize your experience?"
        : null,
    answerInstruction: record.state === "answer_ready" ? answerInstruction : null,
    expiresAt: record.expiresAt || "2026-08-05T15:00:00Z",
    consent:
      record.state === "consent_required"
        ? {
            ...action(record.requestHandle, consentBodySchema),
            url: "https://app.epode.ai/api/v2/enrichment/consent/decisions",
          }
        : null,
    submit: record.state === "answer_ready" ? action(record.answerHandle, answerBodySchema) : null,
  });
  const createRecord = (input = {}, state) => {
    sequence += 1;
    const key = identityKey(input);
    const record = {
      requestId: `request-${sequence}`,
      interactionId: input.interactionId || `interaction-${sequence}`,
      identityKey: key,
      operation: input.operation || "seeded",
      sessionRef: input.sessionRef,
      requestHandle: `aqr1_request_${sequence}`,
      answerHandle: `aqr1_answer_${sequence}`,
      state:
        state ||
        operationStates.get(input.operation) ||
        (rememberedIdentities.has(key) ? "answer_ready" : "consent_required"),
      answerCount: 0,
      consentCount: 0,
    };
    records.set(record.requestHandle, record);
    records.set(record.answerHandle, record);
    return record;
  };
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization") || "";
    const capability = authorization.replace(/^Bearer\s+/, "");
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({ path, authorization, body });
    if (path === "/api/v2/enrichment/requests") {
      return json(responseFor(createRecord(body)));
    }
    if (path === "/api/v2/enrichment/requests/inspect") {
      const failure = inspectionFailures.get(capability);
      if (failure) return json(failure.body, failure.status);
      const record = records.get(capability);
      return record ? json(responseFor(record)) : json({ error: "invalid_handle" }, 401);
    }
    if (path === "/api/v2/enrichment/consent/decisions") {
      const record = records.get(capability);
      if (!record) return json({ error: "invalid_handle" }, 401);
      if (record.state !== "consent_required") {
        return json({ error: "request_already_decided" }, 409);
      }
      record.consentCount += 1;
      if (body.decision === "declined") {
        record.state = "declined";
        return json({
          requestId: record.requestId,
          state: "declined",
          changed: true,
          stageInstruction: noActionStageInstruction,
          answerInstruction: null,
          submit: null,
        });
      }
      record.state = "answer_ready";
      if (body.remember === true) rememberedIdentities.add(record.identityKey);
      return json({
        requestId: record.requestId,
        state: "answer_ready",
        changed: true,
        stageInstruction: answerStageInstruction,
        answerInstruction,
        submit: action(record.answerHandle, answerBodySchema),
      });
    }
    if (path === "/api/v2/enrichment/answers") {
      const record = records.get(capability);
      if (!record) return json({ error: "invalid_handle" }, 401);
      if (capability !== record.answerHandle || record.state !== "answer_ready") {
        return json({ error: "request_not_answer_ready" }, 409);
      }
      record.answerCount += 1;
      record.state = body.status;
      return json({
        accepted: true,
        requestId: record.requestId,
        interactionId: record.interactionId,
        customerId: ids.customer,
        signals: body.items || [],
      });
    }
    return json({ error: "not_found" }, 404);
  };
  return {
    calls,
    fetch,
    records,
    rememberedIdentities,
    operationStates,
    inspectionFailures,
    seed(state = "consent_required", input = {}) {
      const record = createRecord(input, state);
      return {
        record,
        requestHandle: state === "answer_ready" ? record.answerHandle : record.requestHandle,
      };
    },
  };
}

function mcpTestServer(service, options = {}) {
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  const customer = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["search_*"],
    ...options,
  });
  customer.instrument(server);
  return { customer, server, tools };
}

function customerAnswer(requestHandle, remember = true) {
  return {
    requestHandle,
    status: "answered",
    items: [
      {
        key: "shopping.priority",
        type: "preference",
        value: "outdoor_travel",
        summary: "Customer prefers outdoor travel.",
        provenance: "agent_reports_user_statement",
        confidence: 1,
        remember,
      },
    ],
  };
}

let customerMcpRequestId = 0;

function realCustomerMcpContext(extra = {}) {
  return {
    mcpReq: {
      id: ++customerMcpRequestId,
      method: "tools/call",
      requestState: () => undefined,
      signal: new AbortController().signal,
      envelope: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
      },
      ...extra,
    },
  };
}

function callRealCustomerMcpTool(server, name, arguments_, context = realCustomerMcpContext()) {
  const handler = server.server._requestHandlers.get("tools/call");
  assert.equal(typeof handler, "function");
  return handler(
    {
      method: "tools/call",
      params: {
        name,
        arguments: arguments_ || {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "matrix-client", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
        },
      },
    },
    context,
  );
}

test("company-side Express completes learn, retrieve, personalize, and measure", async () => {
  const service = backend();
  const epode = epodeExpress({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    include: ["/api/recommendations"],
    identify: (request) => ({ anonymousRef: request.visitorId }),
    sessionRef: (request) => `shopping_${request.visitorId}`,
    runtimeHint: () => "retail-api/v1",
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.visitorId = "anon_retail_42";
    next();
  });
  app.use(epode);
  app.get("/api/recommendations", (_request, response) =>
    response.json({ products: [{ id: "gift-1", price: 129 }] }),
  );
  const server = await serve(app);

  const first = await (
    await fetch(`${server.url}/api/recommendations`, {
      headers: {
        "user-agent": "Customer-Test-Browser/1.0",
        "accept-language": "en-CA,en;q=0.8",
        referer: "https://shop.example.test/private/path?discard=true",
        "sec-ch-ua": '"Customer Test";v="1"',
        "sec-ch-ua-platform": '"macOS"',
        "sec-ch-ua-mobile": "?0",
      },
    })
  ).json();
  assert.deepEqual(first.products, [{ id: "gift-1", price: 129 }]);
  assert.equal(first._epode.customerContext.state, "consent_required");
  assert.equal(first._epode.customerContext.consent.url, "/_epode/v1/enrichment/consent");
  assert.deepEqual(first._epode.customerContext.consent.bodySchema, consentBodySchema);
  assert.equal(first._epode.customerContext.stageInstruction, consentStageInstruction);
  assert.equal(JSON.stringify(first).includes("https://app.epode.ai"), false);
  assert.equal(service.calls[0].authorization, `Bearer ${key}`);
  assert.equal(service.calls[0].body.anonymousRef, "anon_retail_42");
  assert.equal(service.calls[0].body.operation, "/api/recommendations");
  assert.equal(service.calls[0].body.surface, "http_json");
  assert.equal(service.calls[0].body.statusCode, 200);
  assert.ok(Number.isSafeInteger(service.calls[0].body.durationMs));
  assert.ok(service.calls[0].body.durationMs >= 0);
  assert.equal(service.calls[0].body.sessionRef, "shopping_anon_retail_42");
  assert.equal(service.calls[0].body.runtimeHint, "retail-api/v1");
  assert.match(service.calls[0].body.requestObservation.clientIp, /^(?:\d{1,3}\.){3}\d{1,3}$|:/);
  assert.deepEqual(service.calls[0].body.requestObservation, {
    ...service.calls[0].body.requestObservation,
    method: "GET",
    userAgent: "Customer-Test-Browser/1.0",
    acceptLanguage: "en-CA,en;q=0.8",
    referrerOrigin: "https://shop.example.test",
    secChUa: '"Customer Test";v="1"',
    secChUaPlatform: '"macOS"',
    secChUaMobile: "?0",
  });
  assert.doesNotMatch(JSON.stringify(service.calls[0].body.requestObservation), /discard=true/);

  const consent = await fetch(`${server.url}/_epode/v1/enrichment/consent`, {
    method: "POST",
    headers: {
      authorization: first._epode.customerContext.consent.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(consent.status, 200);
  const consentBody = await consent.json();
  assert.equal(consentBody.submit.url, "/_epode/v1/enrichment/answers");
  assert.deepEqual(consentBody.submit.bodySchema, answerBodySchema);
  assert.equal(consentBody.stageInstruction, answerStageInstruction);
  assert.equal(consentBody.answerInstruction, answerInstruction);
  assert.equal(JSON.stringify(consentBody).includes("https://app.epode.ai"), false);
  assert.equal(service.calls[1].authorization, "Bearer aqr1_request-1");
  assert.equal(service.calls[1].body.decision, "approved");

  const answer = await fetch(`${server.url}/_epode/v1/enrichment/answers`, {
    method: "POST",
    headers: {
      authorization: consentBody.submit.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "answered",
      items: [
        {
          key: "budget",
          type: "customer_goal",
          value: "under_150_usd",
          summary: "Customer explicitly stated a budget under $150.",
          provenance: "agent_reports_user_statement",
          confidence: 1,
          remember: true,
        },
      ],
    }),
  });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).accepted, true);

  const context = await epode.context.get({
    anonymousRef: "anon_retail_42",
    purpose: "product_personalization",
  });
  assert.equal(context.available, true);
  assert.equal(context.items[0].key, "budget");
  const decision = await epode.personalization.decide({
    externalDecisionId: "recommendation-42",
    contextRetrievalId: context.retrievalId,
    signalIds: context.items.map((item) => item.signalId),
    variant: "sustainable-gifts-under-150",
  });
  assert.equal(decision.recorded, true);
  const outcome = await epode.outcomes.track({
    externalOutcomeId: "order-42",
    decisionId: decision.decision.id,
    outcome: "conversion",
  });
  assert.equal(outcome.recorded, true);
  assert.deepEqual(
    service.calls.slice(-3).map((call) => call.path),
    [
      "/api/v2/customer-context",
      "/api/v2/personalization/decisions",
      "/api/v2/personalization/outcomes",
    ],
  );
  await server.close();
});

test("same-origin relay rejects unknown customer fields without contacting Epode", async () => {
  const service = backend();
  const client = createEpode({ apiKey: key, endpoint: "https://epode.test", fetch: service.fetch });
  const result = await client.relay({
    path: "/_epode/v1/enrichment/answers",
    authorization: "Bearer aqr1_safe",
    body: {
      status: "answered",
      items: [],
      transcript: "must never leave the company",
    },
  });
  assert.equal(result.status, 400);
  assert.equal(service.calls.length, 0);

  const sensitive = await client.relay({
    path: "/_epode/v1/enrichment/answers",
    authorization: "Bearer aqr1_safe",
    body: {
      status: "answered",
      items: [
        {
          key: "contact",
          type: "preference",
          value: "person@example.com",
          summary: "Customer supplied an email address.",
          provenance: "agent_reports_user_statement",
          remember: true,
        },
      ],
    },
  });
  assert.equal(sensitive.status, 400);
  assert.equal(service.calls.length, 0);

  const noContext = await client.relay({
    path: "/_epode/v1/enrichment/answers",
    authorization: "Bearer aqr1_safe",
    body: { status: "no_relevant_context" },
  });
  assert.equal(noContext.status, 200);
  assert.equal(service.calls.length, 1);
  assert.deepEqual(service.calls[0].body, { status: "no_relevant_context" });
});

test("Fastify mounts the same-origin relay and preserves the business shape", async () => {
  const service = backend();
  const customer = epodeFastify({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    include: ["/api/feed"],
    identify: (request) => ({ userRef: request.subscriber?.id }),
    sessionRef: (request) => `feed_${request.subscriber?.id}`,
    runtimeHint: () => "fastify-feed/v1",
  });
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.subscriber = { id: "subscriber_7" };
  });
  await app.register(customer);
  app.get("/api/feed", async () => ({ titles: ["documentary-1"] }));
  const response = await app.inject({
    method: "GET",
    url: "/api/feed",
    remoteAddress: "198.51.100.17",
    headers: {
      "user-agent": "Fastify-Customer-Test/1.0",
      "accept-language": "fr-CA",
      referer: "https://media.example.test/watch/123",
    },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.deepEqual(payload.titles, ["documentary-1"]);
  assert.equal(payload._epode.customerContext.consent.url, "/_epode/v1/enrichment/consent");
  assert.equal(service.calls[0].body.userRef, "subscriber_7");
  assert.equal(service.calls[0].body.surface, "http_json");
  assert.equal(service.calls[0].body.statusCode, 200);
  assert.ok(service.calls[0].body.durationMs >= 0);
  assert.equal(service.calls[0].body.sessionRef, "feed_subscriber_7");
  assert.equal(service.calls[0].body.runtimeHint, "fastify-feed/v1");
  assert.deepEqual(service.calls[0].body.requestObservation, {
    clientIp: "198.51.100.17",
    method: "GET",
    userAgent: "Fastify-Customer-Test/1.0",
    acceptLanguage: "fr-CA",
    referrerOrigin: "https://media.example.test",
  });

  const consent = await app.inject({
    method: "POST",
    url: "/_epode/v1/enrichment/consent",
    headers: { authorization: "Bearer aqr1_request-1" },
    payload: { decision: "declined" },
  });
  assert.equal(consent.statusCode, 200);
  assert.equal(service.calls[1].path, "/api/v2/enrichment/consent/decisions");
  await app.close();
});

test("recommended Express authentication cannot intercept relays and bounded HTML is instrumented", async () => {
  const service = backend();
  let authenticationCalls = 0;
  const customer = epodeExpress({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    include: ["/customer-page"],
    authenticate: (request, response, next) => {
      authenticationCalls += 1;
      if (request.get("x-product-auth") !== "allowed") {
        response.status(401).json({ error: "product_auth_required" });
        return;
      }
      request.customer = { id: "customer_7" };
      next();
    },
    identify: (request) => ({ userRef: request.customer?.id }),
  });
  const app = express();
  app.use(express.json());
  app.use(customer);
  app.get("/customer-page", (_request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'");
    response.setHeader("ETag", '"stale-html"');
    response.setHeader("Content-MD5", "stale");
    response
      .type("html")
      .send(
        "<!doctype html><html><head><title>Account</title></head><body>Original page</body></html>",
      );
  });
  const server = await serve(app);

  const relay = await fetch(`${server.url}/_epode/v1/enrichment/consent`, {
    method: "POST",
    headers: { authorization: "Bearer aqr1_relay", "content-type": "application/json" },
    body: JSON.stringify({ decision: "declined" }),
  });
  assert.equal(relay.status, 200);
  assert.equal(authenticationCalls, 0);

  assert.equal((await fetch(`${server.url}/customer-page`)).status, 401);
  const page = await fetch(`${server.url}/customer-page`, {
    headers: { "x-product-auth": "allowed" },
  });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Original page/);
  assert.equal(customerContextFromHtml(html).state, "consent_required");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.notEqual(page.headers.get("etag"), '"stale-html"');
  assert.equal(page.headers.get("content-md5"), null);
  assert.equal(
    page.headers.get("content-security-policy"),
    "default-src 'self'; script-src 'none'",
  );
  assert.equal(authenticationCalls, 2);
  assert.equal(
    service.calls.find((call) => call.path === "/api/v2/enrichment/requests").body.surface,
    "html",
  );
  await server.close();
});

test("recommended Fastify authentication bypasses relays and instruments bounded HTML", async () => {
  const service = backend();
  let authenticationCalls = 0;
  const customer = epodeFastify({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    include: ["/customer-page"],
    authenticate: async (request, reply) => {
      authenticationCalls += 1;
      if (request.headers["x-product-auth"] !== "allowed") {
        await reply.code(401).send({ error: "product_auth_required" });
        return;
      }
      request.customer = { id: "customer_7" };
    },
    identify: (request) => ({ userRef: request.customer?.id }),
  });
  const app = Fastify();
  await app.register(customer);
  app.get("/customer-page", async (_request, reply) => {
    reply.header("content-security-policy", "default-src 'self'; script-src 'none'");
    reply.header("etag", '"stale-html"');
    reply.type("text/html; charset=utf-8");
    return "<!doctype html><html><head><title>Account</title></head><body>Original page</body></html>";
  });

  const relay = await app.inject({
    method: "POST",
    url: "/_epode/v1/enrichment/consent",
    headers: { authorization: "Bearer aqr1_relay" },
    payload: { decision: "declined" },
  });
  assert.equal(relay.statusCode, 200);
  assert.equal(authenticationCalls, 0);
  assert.equal((await app.inject({ method: "GET", url: "/customer-page" })).statusCode, 401);
  const page = await app.inject({
    method: "GET",
    url: "/customer-page",
    headers: { "x-product-auth": "allowed" },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Original page/);
  assert.equal(customerContextFromHtml(page.body).state, "consent_required");
  assert.equal(page.headers["cache-control"], "private, no-store");
  assert.equal(page.headers.etag, undefined);
  assert.equal(page.headers["content-security-policy"], "default-src 'self'; script-src 'none'");
  assert.equal(authenticationCalls, 2);
  assert.equal(
    service.calls.find((call) => call.path === "/api/v2/enrichment/requests").body.surface,
    "html",
  );
  await app.close();
});

test("Epode downtime never fails the company's product response", async () => {
  const epode = epodeExpress({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    logger: { debug() {}, warn() {} },
    timeoutMs: 10,
    include: ["/api/recommendations"],
  });
  const app = express();
  app.use(express.json());
  app.use(epode);
  app.get("/api/recommendations", (_request, response) => response.json({ products: ["default"] }));
  const server = await serve(app);

  const startedAt = Date.now();
  const response = await fetch(`${server.url}/api/recommendations`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { products: ["default"] });
  assert.ok(Date.now() - startedAt < 500, "company response exceeded its fail-open budget");
  assert.deepEqual(
    await epode.context.get({
      interactionId: "00000000-0000-4000-8000-000000000001",
      purpose: "product_personalization",
    }),
    { available: false, identityLevel: "ephemeral", items: [] },
  );
  await server.close();
});

test("Express waits for async enrichment and ignores accidental duplicate json sends", async () => {
  let finishEnrichment;
  let backendCalls = 0;
  const epode = epodeExpress({
    apiKey: key,
    endpoint: "https://epode.test",
    include: ["/api/async"],
    fetch: async (_url, init) => {
      backendCalls += 1;
      const body = JSON.parse(String(init.body));
      return await new Promise((resolve) => {
        finishEnrichment = () =>
          resolve(
            json({
              requestId: "request-async",
              interactionId: body.interactionId,
              state: "consent_required",
              purpose: body.purpose,
              identityLevel: "ephemeral",
              stageInstruction: consentStageInstruction,
              question: "May Example learn context for this task?",
              answerInstruction: null,
              expiresAt: "2026-08-02T15:00:00Z",
              consent: {
                url: "https://app.epode.ai/api/v2/enrichment/consent/decisions",
                method: "POST",
                authorization: "Bearer aqr1_async",
                contentType: "application/json",
                bodySchema: consentBodySchema,
              },
              submit: null,
            }),
          );
      });
    },
  });
  const app = express();
  app.use(epode);
  app.get("/api/async", (_request, response) => {
    response.json({ sequence: "first" });
    response.json({ sequence: "second" });
  });
  const server = await serve(app);

  const pendingResponse = fetch(`${server.url}/api/async`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    await Promise.race([
      pendingResponse.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ]),
    false,
  );
  finishEnrichment();
  const payload = await (await pendingResponse).json();
  assert.equal(payload.sequence, "first");
  assert.equal(payload._epode.customerContext.requestId, "request-async");
  assert.equal(backendCalls, 1);
  await server.close();
});

test("ephemeral context continues only when the agent returns the bounded interaction header", async () => {
  const service = backend();
  const customer = epodeExpress({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    include: ["/api/ephemeral"],
  });
  const app = express();
  app.use(express.json());
  app.use(customer);
  app.get("/api/ephemeral", async (request, response) => {
    const context = await customer.contextFor(request);
    response.json({ learnedItems: context.items.length });
  });
  const server = await serve(app);

  const first = await (await fetch(`${server.url}/api/ephemeral`)).json();
  assert.equal(first.learnedItems, 0);
  assert.equal(first._epode.customerContext.identityLevel, "ephemeral");
  const continuation = first._epode.customerContext.continuation;
  assert.equal(continuation.header, "Epode-Context-Interaction");
  assert.equal(continuation.value, first._epode.customerContext.interactionId);
  assert.match(continuation.instruction, /immediate retry/i);

  const consent = await fetch(`${server.url}${first._epode.customerContext.consent.url}`, {
    method: "POST",
    headers: {
      authorization: first._epode.customerContext.consent.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approved" }),
  });
  const consentBody = await consent.json();
  await fetch(`${server.url}${consentBody.submit.url}`, {
    method: "POST",
    headers: {
      authorization: consentBody.submit.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "answered",
      items: [
        {
          key: "budget",
          type: "constraint",
          value: "under_150_usd",
          summary: "Customer explicitly stated a budget under $150.",
          provenance: "agent_reports_current_task",
          confidence: 1,
          remember: false,
        },
      ],
    }),
  });

  const retry = await fetch(`${server.url}/api/ephemeral`, {
    headers: { [continuation.header]: continuation.value },
  });
  assert.equal(retry.headers.get("vary"), "Epode-Context-Interaction");
  const retried = await retry.json();
  assert.equal(retried.learnedItems, 1);
  assert.equal(retried._epode.customerContext.interactionId, continuation.value);
  const contextCall = service.calls.findLast((call) => call.path === "/api/v2/customer-context");
  assert.equal(contextCall.body.interactionId, continuation.value);
  await server.close();
});

test("company-owned MCP registers context tools and decorates selected results", async () => {
  const service = backend();
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  const epode = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["*"],
    identify: (_arguments, context) => ({ userRef: context.http.authInfo.extra.userId }),
    sessionRef: (context) => context.http.authInfo.extra.journeyId,
    runtimeHint: (context) => context.http.authInfo.extra.runtime,
  });
  epode.instrument(server);
  server.registerTool("search_stays", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "Three hotels found." }],
    structuredContent: { hotels: 3 },
  }));
  server.registerTool("failed_search", { inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: "text", text: "upstream failed" }],
  }));
  server.registerTool("canceled_search", { inputSchema: {} }, async () => ({
    status: "canceled",
    content: [{ type: "text", text: "canceled" }],
  }));
  server.registerTool("incomplete_search", { inputSchema: {} }, async () => ({
    resultType: "incomplete",
    content: [{ type: "text", text: "more work required" }],
  }));
  assert.ok(tools.has("record_customer_context_consent"));
  assert.ok(tools.has("share_customer_context"));
  const result = await tools.get("search_stays").handler(
    { city: "Paris", sessionRef: "model_must_not_control_this" },
    {
      http: {
        authInfo: {
          extra: {
            userId: "traveler_7",
            journeyId: "journey_product_7",
            runtime: "claude-desktop/2",
          },
        },
      },
    },
  );
  assert.equal(result.structuredContent.hotels, 3);
  assert.equal(result.structuredContent._epode.customerContext.state, "consent_required");
  assert.equal(
    result.structuredContent._epode.customerContext.answerTool,
    "share_customer_context",
  );
  assert.equal(
    result.structuredContent._epode.customerContext.permissionMode,
    "best_effort_mcp_elicitation",
  );
  assert.equal(result.structuredContent._epode.customerContext.manageConsent, undefined);
  assert.match(result.content.at(-1).text, /do not ask the user separately in chat/i);
  assert.equal(service.calls[0].body.surface, "mcp");
  assert.equal(service.calls[0].body.statusCode, 200);
  assert.ok(service.calls[0].body.durationMs >= 0);
  assert.equal(service.calls[0].body.sessionRef, "journey_product_7");
  assert.equal(service.calls[0].body.runtimeHint, "claude-desktop/2");
  assert.equal(
    service.calls.filter((call) => call.path === "/api/v2/enrichment/requests").length,
    1,
  );
  const callsAfterSuccess = service.calls.length;
  for (const name of ["failed_search", "canceled_search", "incomplete_search"]) {
    const skipped = await tools.get(name).handler({}, {});
    assert.equal(skipped.structuredContent, undefined);
  }
  assert.equal(service.calls.length, callsAfterSuccess);
});

test("company-owned MCP sends planner-selected context fields and skips empty selections", async () => {
  const service = backend();
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  const warnings = [];
  const epode = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["*"],
    identify: (_arguments, context) => ({ userRef: context.http.authInfo.extra.userId }),
    logger: { debug() {}, warn: (message) => warnings.push(message) },
    fields: async ({ name }) => {
      if (name === "search_stays") return ["travel.stay_style", "travel.location_priority"];
      if (name === "fully_known") return [];
      if (name === "broken_planner") throw new Error("graph unavailable");
      if (name === "invalid_planner") return ["travel.stay_style", 7];
      return undefined;
    },
  });
  epode.instrument(server);
  for (const name of [
    "search_stays",
    "fully_known",
    "broken_planner",
    "invalid_planner",
    "unplanned",
  ]) {
    server.registerTool(name, { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { status: "ok" },
    }));
  }
  const context = { http: { authInfo: { extra: { userId: "traveler_7" } } } };

  const selected = await tools.get("search_stays").handler({}, context);
  assert.equal(selected.structuredContent._epode.customerContext.state, "consent_required");
  const selectedCall = service.calls.find((call) => call.path === "/api/v2/enrichment/requests");
  assert.deepEqual(selectedCall.body.fieldKeys, ["travel.stay_style", "travel.location_priority"]);

  const callsAfterSelection = service.calls.length;
  for (const name of ["fully_known", "broken_planner", "invalid_planner"]) {
    const skipped = await tools.get(name).handler({}, context);
    assert.equal(skipped.structuredContent._epode, undefined);
    assert.equal(skipped.structuredContent.status, "ok");
  }
  assert.equal(service.calls.length, callsAfterSelection);
  assert.ok(warnings.some((message) => /field planner failed/.test(message)));
  assert.ok(warnings.some((message) => /invalid keys/.test(message)));

  const unplanned = await tools.get("unplanned").handler({}, context);
  assert.equal(unplanned.structuredContent._epode.customerContext.state, "consent_required");
  assert.equal(service.calls.at(-1).body.fieldKeys, undefined);
});

test("company-owned MCP accepts a static context field list", async () => {
  const service = backend();
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  const epode = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["search_catalog"],
    fields: ["shopping.priority", "shopping.budget_band"],
    identify: (_arguments, context) => ({ userRef: context.http.authInfo.extra.userId }),
  });
  epode.instrument(server);
  server.registerTool("search_catalog", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { status: "ok" },
  }));
  server.registerTool("checkout", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { status: "ok" },
  }));
  const context = { http: { authInfo: { extra: { userId: "shopper_3" } } } };

  const selected = await tools.get("search_catalog").handler({}, context);
  assert.equal(selected.structuredContent._epode.customerContext.state, "consent_required");
  const selectedCall = service.calls.find((call) => call.path === "/api/v2/enrichment/requests");
  assert.deepEqual(selectedCall.body.fieldKeys, ["shopping.priority", "shopping.budget_band"]);

  const excluded = await tools.get("checkout").handler({}, context);
  assert.equal(excluded.structuredContent._epode, undefined);
  assert.equal(
    service.calls.filter((call) => call.path === "/api/v2/enrichment/requests").length,
    1,
  );
});

test("company-owned MCP elicits and records one session-only choice inside sharing", async () => {
  const service = backend({ enforceConsent: true });
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  const epode = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["search_stays"],
    identify: () => ({ userRef: "traveler_7" }),
  });
  epode.instrument(server);
  server.registerTool("search_stays", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "Three hotels found." }],
    structuredContent: { hotels: 3 },
  }));

  const search = await tools.get("search_stays").handler({}, {});
  const requestHandle = search.structuredContent._epode.customerContext.requestHandle;
  const answer = {
    requestHandle,
    status: "answered",
    items: [
      {
        key: "travel.style",
        type: "preference",
        value: "outdoor_travel",
        summary: "Customer prefers outdoor travel.",
        provenance: "agent_reports_user_statement",
        confidence: 1,
        remember: true,
      },
    ],
  };
  const firstRound = await tools.get("share_customer_context").handler(answer, { mcpReq: {} });
  assert.equal(firstRound.resultType, "input_required");
  const elicitation = firstRound.inputRequests.customer_context_permission.params;
  const shared = await tools.get("share_customer_context").handler(answer, {
    mcpReq: {
      inputResponses: {
        customer_context_permission: {
          action: "accept",
          content: { choice: "this_session_only" },
        },
      },
    },
  });

  assert.equal(shared.isError, false);
  assert.equal(shared.structuredContent.accepted, true);
  assert.match(elicitation.message, /Example Store/);
  assert.deepEqual(
    elicitation.requestedSchema.properties.choice.oneOf.map((option) => option.title),
    ["Always allow", "This session only", "Don't allow"],
  );
  assert.deepEqual(
    service.calls.map((call) => call.path),
    [
      "/api/v2/enrichment/requests",
      "/api/v2/enrichment/requests/inspect",
      "/api/v2/enrichment/requests/inspect",
      "/api/v2/enrichment/consent/decisions",
      "/api/v2/enrichment/answers",
    ],
  );
  assert.deepEqual(service.calls[3].body, { decision: "approved", remember: false });
  assert.equal(service.calls[4].body.items[0].remember, false);
});

test("MCP customer context enforces always and session-only retention choices", async (t) => {
  for (const scenario of [
    { choice: "always_allow", consentRemember: true, answerRemember: true },
    { choice: "this_session_only", consentRemember: false, answerRemember: false },
  ]) {
    await t.test(scenario.choice, async () => {
      const service = mcpMatrixBackend();
      const { tools } = mcpTestServer(service);
      const { requestHandle } = service.seed();
      const answer = customerAnswer(requestHandle, true);

      const first = await tools.get("share_customer_context").handler(answer, { mcpReq: {} });
      assert.equal(first.resultType, "input_required");
      assert.deepEqual(
        first.inputRequests.customer_context_permission.params.requestedSchema.properties.choice
          .oneOf,
        [
          { const: "always_allow", title: "Always allow" },
          { const: "this_session_only", title: "This session only" },
          { const: "dont_allow", title: "Don't allow" },
        ],
      );

      const completed = await tools.get("share_customer_context").handler(answer, {
        mcpReq: {
          inputResponses: {
            customer_context_permission: {
              action: "accept",
              content: { choice: scenario.choice },
            },
          },
        },
      });
      assert.equal(completed.isError, false);
      assert.equal(completed.structuredContent.accepted, true);
      const consent = service.calls.find(
        (call) => call.path === "/api/v2/enrichment/consent/decisions",
      );
      const submitted = service.calls.find((call) => call.path === "/api/v2/enrichment/answers");
      assert.deepEqual(consent.body, {
        decision: "approved",
        remember: scenario.consentRemember,
      });
      assert.equal(submitted.body.items[0].remember, scenario.answerRemember);
    });
  }
});

test("MCP customer context handles denial and dismissal without sharing", async (t) => {
  for (const scenario of [
    {
      name: "explicit don't allow choice",
      response: { action: "accept", content: { choice: "dont_allow" } },
      expectedState: "declined",
      consentCalls: 1,
    },
    {
      name: "client decline action",
      response: { action: "decline" },
      expectedState: "declined",
      consentCalls: 1,
    },
    {
      name: "client cancel action",
      response: { action: "cancel" },
      expectedState: "canceled",
      consentCalls: 0,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const service = mcpMatrixBackend();
      const { tools } = mcpTestServer(service);
      const { requestHandle } = service.seed();
      const result = await tools
        .get("share_customer_context")
        .handler(customerAnswer(requestHandle), {
          mcpReq: {
            inputResponses: { customer_context_permission: scenario.response },
          },
        });
      assert.equal(result.isError, scenario.consentCalls === 0 ? undefined : false);
      assert.equal(result.structuredContent.state, scenario.expectedState);
      assert.equal(
        service.calls.filter((call) => call.path === "/api/v2/enrichment/consent/decisions").length,
        scenario.consentCalls,
      );
      assert.equal(
        service.calls.filter((call) => call.path === "/api/v2/enrichment/answers").length,
        0,
      );
    });
  }
});

test("MCP customer context rejects malformed and unknown resumes without mutation", async (t) => {
  const malformedResponses = [
    "accept",
    { action: "unexpected", content: { choice: "always_allow" } },
    { action: "accept" },
    { action: "accept", content: { choice: "share_everything" } },
  ];
  for (const [index, response] of malformedResponses.entries()) {
    await t.test(`malformed response ${index + 1}`, async () => {
      const service = mcpMatrixBackend();
      const { tools } = mcpTestServer(service);
      const { requestHandle, record } = service.seed();
      const result = await tools
        .get("share_customer_context")
        .handler(customerAnswer(requestHandle), {
          mcpReq: { inputResponses: { customer_context_permission: response } },
        });
      assert.equal(result.isError, true);
      assert.equal(record.state, "consent_required");
      assert.deepEqual(
        service.calls.map((call) => call.path),
        ["/api/v2/enrichment/requests/inspect"],
      );
    });
  }
});

test("MCP customer context is idempotent for replayed and terminal requests", async (t) => {
  await t.test("replayed accepted resume", async () => {
    const service = mcpMatrixBackend();
    const { tools } = mcpTestServer(service);
    const { requestHandle, record } = service.seed();
    const answer = customerAnswer(requestHandle);
    const context = {
      mcpReq: {
        inputResponses: {
          customer_context_permission: {
            action: "accept",
            content: { choice: "always_allow" },
          },
        },
      },
    };
    const first = await tools.get("share_customer_context").handler(answer, context);
    const replay = await tools.get("share_customer_context").handler(answer, context);
    assert.equal(first.structuredContent.accepted, true);
    assert.deepEqual(replay.structuredContent, {
      accepted: true,
      state: "answered",
      alreadyCompleted: true,
    });
    assert.equal(record.consentCount, 1);
    assert.equal(record.answerCount, 1);
  });

  await t.test("already declined request", async () => {
    const service = mcpMatrixBackend();
    const { tools } = mcpTestServer(service);
    const { requestHandle, record } = service.seed("declined");
    const result = await tools
      .get("share_customer_context")
      .handler(customerAnswer(requestHandle), { mcpReq: {} });
    assert.deepEqual(result.structuredContent, { accepted: false, state: "declined" });
    assert.equal(record.consentCount, 0);
    assert.equal(record.answerCount, 0);
  });

  for (const state of ["answered", "no_relevant_context"]) {
    await t.test(`already ${state}`, async () => {
      const service = mcpMatrixBackend();
      const { tools } = mcpTestServer(service);
      const { requestHandle, record } = service.seed(state);
      const result = await tools
        .get("share_customer_context")
        .handler(customerAnswer(requestHandle), { mcpReq: {} });
      assert.deepEqual(result.structuredContent, {
        accepted: true,
        state,
        alreadyCompleted: true,
      });
      assert.equal(record.answerCount, 0);
    });
  }
});

test("MCP customer context submits directly for an already-approved request", async () => {
  const service = mcpMatrixBackend();
  const { tools } = mcpTestServer(service);
  const { requestHandle, record } = service.seed("answer_ready");
  const result = await tools
    .get("share_customer_context")
    .handler(customerAnswer(requestHandle), { mcpReq: {} });
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(record.answerCount, 1);
  assert.deepEqual(
    service.calls.map((call) => call.path),
    ["/api/v2/enrichment/requests/inspect", "/api/v2/enrichment/answers"],
  );
});

test("MCP customer context fails closed on expired, unavailable, and malformed inspection", async (t) => {
  for (const scenario of [
    { name: "expired capability", status: 401, body: { error: "expired_handle" } },
    { name: "removed request", status: 410, body: { error: "request_expired" } },
    { name: "temporary outage", status: 503, body: { error: "temporarily_unavailable" } },
    { name: "malformed success", status: 200, body: [] },
  ]) {
    await t.test(scenario.name, async () => {
      const service = mcpMatrixBackend();
      const { tools } = mcpTestServer(service);
      const { requestHandle, record } = service.seed();
      service.inspectionFailures.set(requestHandle, scenario);
      const result = await tools
        .get("share_customer_context")
        .handler(customerAnswer(requestHandle), { mcpReq: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /could not be verified/i);
      assert.equal(record.state, "consent_required");
      assert.equal(record.consentCount, 0);
      assert.equal(record.answerCount, 0);
    });
  }
});

test("MCP customer context keeps identities and sessions isolated across queries", async () => {
  const service = mcpMatrixBackend();
  const { server, tools } = mcpTestServer(service, {
    identify: (_arguments, context) => ({ userRef: context.authenticatedUser }),
    sessionRef: (context) => context.productSession,
    runtimeHint: (context) => context.harness,
  });
  server.registerTool("search_catalog", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "Results found." }],
    structuredContent: { products: 2 },
  }));
  const search = (authenticatedUser, productSession, harness, arguments_ = {}) =>
    tools.get("search_catalog").handler(arguments_, {
      authenticatedUser,
      productSession,
      harness,
    });
  const resume = (requestHandle, choice) =>
    tools.get("share_customer_context").handler(customerAnswer(requestHandle), {
      mcpReq: {
        inputResponses: {
          customer_context_permission: { action: "accept", content: { choice } },
        },
      },
    });

  const firstA = await search("traveler-a", "session-a1", "claude-desktop");
  assert.equal(firstA.structuredContent._epode.customerContext.state, "consent_required");
  await resume(firstA.structuredContent._epode.customerContext.requestHandle, "always_allow");
  const secondA = await search("traveler-a", "session-a2", "chatgpt-desktop");
  assert.equal(secondA.structuredContent._epode.customerContext.state, "answer_ready");
  await tools
    .get("share_customer_context")
    .handler(customerAnswer(secondA.structuredContent._epode.customerContext.requestHandle), {
      mcpReq: {},
    });

  const firstB = await search("traveler-b", "session-b1", "chatgpt-desktop", {
    userRef: "traveler-a",
    sessionRef: "model-controlled-session",
  });
  assert.equal(firstB.structuredContent._epode.customerContext.state, "consent_required");

  const firstC = await search("traveler-c", "session-c1", "claude-desktop");
  await resume(firstC.structuredContent._epode.customerContext.requestHandle, "this_session_only");
  const secondC = await search("traveler-c", "session-c2", "chatgpt-desktop");
  assert.equal(secondC.structuredContent._epode.customerContext.state, "consent_required");

  const requests = service.calls.filter((call) => call.path === "/api/v2/enrichment/requests");
  assert.deepEqual(
    requests.map(({ body }) => [body.userRef, body.sessionRef, body.runtimeHint]),
    [
      ["traveler-a", "session-a1", "claude-desktop"],
      ["traveler-a", "session-a2", "chatgpt-desktop"],
      ["traveler-b", "session-b1", "chatgpt-desktop"],
      ["traveler-c", "session-c1", "claude-desktop"],
      ["traveler-c", "session-c2", "chatgpt-desktop"],
    ],
  );
  assert.equal(new Set(requests.map(({ body }) => body.interactionId)).size, requests.length);
  assert.equal(service.rememberedIdentities.has("traveler-a"), true);
  assert.equal(service.rememberedIdentities.has("traveler-b"), false);
  assert.equal(service.rememberedIdentities.has("traveler-c"), false);
});

test("MCP customer instrumentation preserves a business tool's own input_required round", async () => {
  const service = mcpMatrixBackend();
  const { server, tools } = mcpTestServer(service, { identify: () => ({ userRef: "user-1" }) });
  const intermediate = {
    resultType: "input_required",
    requestState: "business-signed-state",
    inputRequests: {
      hotel_dates: {
        method: "elicitation/create",
        params: { mode: "form", message: "Which dates?", requestedSchema: { type: "object" } },
      },
    },
  };
  let round = 0;
  server.registerTool("search_stays", { inputSchema: {} }, async () => {
    round += 1;
    return round === 1
      ? intermediate
      : {
          content: [{ type: "text", text: "Three hotels found." }],
          structuredContent: { hotels: 3 },
        };
  });

  const first = await tools.get("search_stays").handler({}, { mcpReq: {} });
  assert.equal(first, intermediate);
  assert.deepEqual(service.calls, []);
  const second = await tools.get("search_stays").handler({}, { mcpReq: {} });
  assert.equal(second.structuredContent.hotels, 3);
  assert.equal(second.structuredContent._epode.customerContext.state, "consent_required");
  assert.deepEqual(
    service.calls.map((call) => call.path),
    ["/api/v2/enrichment/requests"],
  );
});

test("real stateless MCP 2026 server preserves customer-context MRTR and resumes safely", async () => {
  const service = mcpMatrixBackend();
  const server = new McpServer({ name: "customer-context-matrix", version: "1.0.0" });
  server.server._negotiatedProtocolVersion = "2026-07-28";
  const customer = epodeMcp({
    apiKey: key,
    endpoint: "https://epode.test",
    fetch: service.fetch,
    includeTools: ["search_catalog"],
    identify: () => ({ userRef: "real-mcp-user" }),
  });
  customer.instrument(server);
  server.registerTool("search_catalog", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "Two products found." }],
    structuredContent: { products: 2 },
  }));

  const search = await callRealCustomerMcpTool(server, "search_catalog", {});
  const requestHandle = search.structuredContent._epode.customerContext.requestHandle;
  const answer = customerAnswer(requestHandle);
  const intermediate = await callRealCustomerMcpTool(server, "share_customer_context", answer);
  assert.equal(intermediate.resultType, "input_required");
  assert.equal(intermediate.inputRequests.customer_context_permission.method, "elicitation/create");

  const completed = await callRealCustomerMcpTool(
    server,
    "share_customer_context",
    answer,
    realCustomerMcpContext({
      inputResponses: {
        customer_context_permission: {
          action: "accept",
          content: { choice: "this_session_only" },
        },
      },
    }),
  );
  assert.equal(completed.structuredContent.accepted, true);
  assert.equal(
    service.calls.filter((call) => call.path === "/api/v2/enrichment/answers").length,
    1,
  );
  assert.equal(
    service.calls.find((call) => call.path === "/api/v2/enrichment/answers").body.items[0].remember,
    false,
  );
});

test("real stateless MCP 2026 server shares nothing when the client lacks form elicitation", async (t) => {
  for (const scenario of [
    { name: "no elicitation", capabilities: {} },
    { name: "URL-only elicitation", capabilities: { elicitation: { url: {} } } },
  ]) {
    await t.test(scenario.name, async () => {
      const service = mcpMatrixBackend();
      const server = new McpServer({ name: "customer-context-fallback", version: "1.0.0" });
      server.server._negotiatedProtocolVersion = "2026-07-28";
      const customer = epodeMcp({
        apiKey: key,
        endpoint: "https://epode.test",
        fetch: service.fetch,
        includeTools: ["search_catalog"],
        identify: () => ({ userRef: "fallback-user" }),
      });
      customer.instrument(server);
      server.registerTool("search_catalog", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "Two products found." }],
        structuredContent: { products: 2 },
      }));
      const context = realCustomerMcpContext({
        envelope: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": scenario.capabilities,
        },
      });
      const search = await callRealCustomerMcpTool(server, "search_catalog", {}, context);
      const requestHandle = search.structuredContent._epode.customerContext.requestHandle;
      const result = await callRealCustomerMcpTool(
        server,
        "share_customer_context",
        customerAnswer(requestHandle),
        context,
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        accepted: false,
        state: "unsupported",
        reason: "form_elicitation_unavailable",
      });
      assert.equal(JSON.stringify(result).includes("fallbackTool"), false);
      assert.doesNotMatch(result.content[0].text, /\?/);
      assert.doesNotMatch(result.content[0].text, /May Example Store/);
      assert.equal(
        service.calls.filter((call) => call.path === "/api/v2/enrichment/consent/decisions").length,
        0,
      );
      assert.equal(
        service.calls.filter((call) => call.path === "/api/v2/enrichment/answers").length,
        0,
      );
    });
  }
});

test("MCP customer context shares nothing when resumable form elicitation is unavailable", async () => {
  const service = mcpMatrixBackend();
  const { tools } = mcpTestServer(service);
  const { requestHandle, record } = service.seed();
  const result = await tools
    .get("share_customer_context")
    .handler(customerAnswer(requestHandle), {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    accepted: false,
    state: "unsupported",
    reason: "form_elicitation_unavailable",
  });
  assert.equal(JSON.stringify(result).includes("fallbackTool"), false);
  assert.equal(JSON.stringify(result).includes(requestHandle), false);
  assert.doesNotMatch(result.content[0].text, /\?/);
  assert.doesNotMatch(result.content[0].text, /May Example Store/);
  assert.equal(record.consentCount, 0);
  assert.equal(record.answerCount, 0);
});
