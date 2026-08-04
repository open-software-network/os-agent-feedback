import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import test from "node:test";

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

  const first = await (await fetch(`${server.url}/api/recommendations`)).json();
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
          type: "constraint",
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
  const response = await app.inject({ method: "GET", url: "/api/feed" });
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
  assert.equal(result.structuredContent._epode.customerContext.permissionMode, "mcp_elicitation");
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
