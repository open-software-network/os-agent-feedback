import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { feedbackFromResponse } from "../dist/agent.js";
import { agentFeedback } from "../dist/fastify.js";

const key = `af_live_1123456789abcdef0123456789abcdef_${"y".repeat(32)}`;

test("Fastify instruments JSON and agent-readable HTML", async () => {
  const telemetry = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/api/*", "/docs"],
    flushIntervalMs: 1,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  app.get("/docs", async (_request, reply) => {
    reply.type("text/html");
    return "<!doctype html><html><head><title>Docs</title></head><body>Useful docs</body></html>";
  });
  await app.ready();

  const json = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().answer, "found");
  assert.equal(json.json()._agentFeedback.v, 1);
  const html = await app.inject({ method: "GET", url: "/docs" });
  assert.match(html.body, /id="agent-feedback"/);
  assert.match(html.body, /submit_product_feedback/i);
  await plugin.shutdown();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].events.length, 2);
  await app.close();
});

test("Fastify preserves a server-owned HTML marker and falls back to the scoped header", async () => {
  const telemetry = [];
  let ownedMarkup = "";
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/html", "/owned", "/cached"],
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/html", async (_request, reply) => {
    reply.header("content-type", "TEXT/HTML; charset=utf-8");
    return "<!doctype html><html><head><title>Docs</title></head><body>Ready</body></html>";
  });
  app.get("/owned", async (_request, reply) => {
    reply.header("content-type", "TEXT/HTML; charset=utf-8");
    return ownedMarkup;
  });
  app.get("/cached", async (_request, reply) => {
    reply.header("content-type", "TEXT/HTML; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    return ownedMarkup;
  });
  await app.ready();

  const injected = await app.inject({ method: "GET", url: "/html" });
  const injectedFeedback = feedbackFromResponse(
    { headers: new Headers(injected.headers) },
    injected.body,
  );
  assert.ok(injectedFeedback);
  assert.match(injected.body, /id="agent-feedback"/i);
  assert.equal(injected.headers["agent-feedback"], undefined);

  ownedMarkup = `<!doctype html><html><head><script id="agent-feedback" type="application/json">${JSON.stringify(
    {
      ...injectedFeedback,
      submit: { ...injectedFeedback.submit, url: "https://stale-template.test/api/v2/reports" },
    },
  )}</script></head><body>Ready</body></html>`;
  const fallback = await app.inject({ method: "GET", url: "/owned" });
  const fallbackFeedback = feedbackFromResponse(
    { headers: new Headers(fallback.headers) },
    fallback.body,
  );
  assert.equal(fallback.body, ownedMarkup);
  assert.equal([...fallback.body.matchAll(/id=["']agent-feedback["']/gi)].length, 1);
  assert.match(fallback.headers["agent-feedback"] || "", /.+/);
  assert.equal(fallback.headers["cache-control"], "private, no-store");
  assert.equal(fallbackFeedback?.submit?.url, "https://feedback.test/api/v2/reports");

  const cached = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(cached.body, ownedMarkup);
  assert.equal(cached.headers["agent-feedback"], undefined);
  assert.equal(cached.headers["cache-control"], "public, max-age=300");

  await plugin.flush();
  assert.deepEqual(
    telemetry
      .flatMap((batch) => batch.events)
      .map((event) => event.surface)
      .sort(),
    ["http_headers", "http_html"],
  );
  await plugin.shutdown();
  await app.close();
});

test("Fastify HTML injection ignores fake head boundaries around the real boundary", async () => {
  const documents = new Map([
    [
      "/before",
      [
        '<!doctype html><html><head data-probe="> </head>">',
        "<!-- decoy </head> -->",
        '<script data-probe="> </head>">window.before = "</head>";</script>',
        "<style data-probe='> </head>'>.before::after { content: \"</head>\"; }</style>",
        "<title>real head</title></head><body>Ready</body></html>",
      ].join(""),
    ],
    [
      "/after",
      [
        "<!doctype html><html><head><title>real head</title></head>",
        '<body data-probe="> </head>"><!-- decoy </head> -->',
        '<script data-probe="> </head>">window.after = "</head>";</script>',
        "<style data-probe='> </head>'>.after::after { content: \"</head>\"; }</style>",
        "Ready</body></html>",
      ].join(""),
    ],
  ]);
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    include: ["/**"],
    fetch: async () => new Response("{}", { status: 202 }),
  });
  await app.register(plugin);
  for (const [path, document] of documents) {
    app.get(path, async (_request, reply) => {
      reply.type("text/html");
      return document;
    });
  }
  const unclosedRawText =
    '<!doctype html><html><head><title>unfinished</title><style>.probe::after { content: "</head>"; }';
  app.get("/unclosed", async (_request, reply) => {
    reply.type("text/html");
    return unclosedRawText;
  });
  await app.ready();

  for (const [path, document] of documents) {
    const response = await app.inject({ method: "GET", url: path });
    const realBoundary = document.indexOf("</head>", document.indexOf("<title>real head</title>"));
    const markerStart = response.body.indexOf('<script id="agent-feedback"');
    const markerEnd = response.body.indexOf("</script>", markerStart) + "</script>".length;
    assert.equal([...response.body.matchAll(/id=["']agent-feedback["']/gi)].length, 1);
    assert.equal(response.body.slice(0, markerStart), document.slice(0, realBoundary));
    assert.equal(response.body.slice(markerEnd), document.slice(realBoundary));
  }
  const unclosedResponse = await app.inject({ method: "GET", url: "/unclosed" });
  const unclosedMarker = unclosedResponse.body.indexOf('<script id="agent-feedback"');
  const originalStyle = unclosedRawText.indexOf("<style>");
  assert.equal([...unclosedResponse.body.matchAll(/id=["']agent-feedback["']/gi)].length, 1);
  assert.equal(
    unclosedResponse.body.slice(0, unclosedMarker),
    unclosedRawText.slice(0, originalStyle),
  );
  assert.ok(unclosedResponse.body.endsWith(unclosedRawText.slice(originalStyle)));

  await plugin.shutdown();
  await app.close();
});

test("Fastify safe mode treats CDN cache controls as shared without resolving identity", async () => {
  const policies = [
    ["/cdn", "CDN-Cache-Control", "public, max-age=600"],
    ["/cloudflare", "Cloudflare-CDN-Cache-Control", "s-maxage=600"],
    ["/surrogate", "Surrogate-Control", "max-age=600, stale-while-revalidate=60"],
  ];
  let identityResolutions = 0;
  let consentLookups = 0;
  let telemetryBatches = 0;
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    include: ["/**"],
    customerRef: () => {
      identityResolutions += 1;
      return "acct_cached";
    },
    logger: { debug() {}, warn() {} },
    fetch: async (url) => {
      if (String(url).endsWith("/api/v2/consent/state")) consentLookups += 1;
      if (String(url).endsWith("/api/v2/telemetry/batches")) telemetryBatches += 1;
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  for (const [path, header, value] of policies) {
    app.get(path, async (_request, reply) => {
      reply.header(header, value);
      return { answer: "cached" };
    });
  }
  await app.ready();

  for (const [path, header, value] of policies) {
    const response = await app.inject({ method: "GET", url: path });
    assert.deepEqual(response.json(), { answer: "cached" });
    assert.equal(response.headers[header.toLowerCase()], value);
    assert.notEqual(response.headers["cache-control"], "private, no-store");
  }
  await plugin.shutdown();
  assert.equal(identityResolutions, 0);
  assert.equal(consentLookups, 0);
  assert.equal(telemetryBatches, 0);
  await app.close();
});

test("Fastify private and request instrumentation remove CDN cache overrides", async () => {
  for (const cacheMode of ["private", "request"]) {
    const app = Fastify();
    const plugin = agentFeedback({
      apiKey: key,
      cacheMode,
      include: ["/search"],
      fetch: async () => new Response("{}", { status: 202 }),
    });
    await app.register(plugin);
    app.get("/search", async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=600");
      reply.header("CDN-Cache-Control", "public, max-age=600");
      reply.header("Cloudflare-CDN-Cache-Control", "s-maxage=600");
      reply.header("Surrogate-Control", "max-age=600");
      return { answer: "cached" };
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/search",
      headers: cacheMode === "request" ? { "Agent-Feedback-Request": "1" } : {},
    });

    assert.equal(response.json()._agentFeedback.v, 1);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["cdn-cache-control"], undefined);
    assert.equal(response.headers["cloudflare-cdn-cache-control"], undefined);
    assert.equal(response.headers["surrogate-control"], undefined);
    await plugin.shutdown();
    await app.close();
  }
});

test("Fastify reads customer context after normal authentication hooks", async () => {
  const telemetry = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    include: ["/api/account"],
    customerRef: (request) => request.user?.accountId,
    flushIntervalMs: 1,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/telemetry/batches")) {
        telemetry.push(JSON.parse(init.body));
      }
      return new Response('{"state":"unknown","revision":0}', {
        status: String(url).endsWith("/api/v2/consent/state") ? 200 : 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await app.register(plugin);
  app.addHook("preHandler", async (request) => {
    request.user = { accountId: "acct_authenticated" };
  });
  app.get("/api/account", async () => ({ account: "ready" }));
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/api/account" });
  assert.equal(response.json()._agentFeedback.mode, "ask_once");
  await plugin.shutdown();
  assert.equal(telemetry[0].events[0].customerRef, "acct_authenticated");
  await app.close();
});

test("Fastify Ask-once never awaits Epode and keeps consent_required through an outage", async () => {
  let rejectLookup;
  let consentLookups = 0;
  const pendingLookup = new Promise((_resolve, reject) => {
    rejectLookup = reject;
  });
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_unavailable",
    include: ["/api/search"],
    flushIntervalMs: 1,
    logger: { debug() {}, warn() {} },
    fetch: async (url) => {
      if (!String(url).endsWith("/api/v2/consent/state")) {
        return new Response("{}", { status: 202 });
      }
      consentLookups += 1;
      if (consentLookups === 1) return pendingLookup;
      throw new Error("Epode unavailable");
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  await app.ready();

  const firstRequest = app.inject({ method: "GET", url: "/api/search" });
  const firstResult = await Promise.race([
    firstRequest,
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 250)),
  ]);
  assert.notEqual(firstResult, "timed_out", "the product response joined the consent lookup");
  assert.equal(firstResult.json()._agentFeedback.state, "consent_required");
  rejectLookup(new Error("Epode unavailable"));
  await new Promise((resolve) => setImmediate(resolve));

  const second = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(second.json()._agentFeedback.state, "consent_required");
  assert.equal(consentLookups, 2);
  await plugin.shutdown();
  await app.close();
});

test("Fastify request cache mode varies ordinary and agent responses", async () => {
  const authorization = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/api/search"],
    cacheMode: "request",
    flushIntervalMs: 60_000,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  await app.register(plugin);
  app.get("/api/search", async (request, reply) => {
    authorization.push(request.headers.authorization);
    reply.header("cache-control", "public, max-age=300");
    reply.header("vary", "Accept-Encoding");
    return { answer: "cached" };
  });
  await app.ready();

  const ordinary = await app.inject({
    method: "GET",
    url: "/api/search?scope=private",
    headers: { authorization: "Bearer customer-secret" },
  });
  assert.equal(ordinary.json()._agentFeedback, undefined);
  assert.match(ordinary.headers.vary, /Accept-Encoding/);
  assert.match(ordinary.headers.vary, /Agent-Feedback-Request/);
  assert.equal(
    ordinary.headers.link,
    '</api/search?scope=private>; rel="agent-feedback"; request-header="Agent-Feedback-Request: 1"',
  );
  const agent = await app.inject({
    method: "GET",
    url: "/api/search?scope=private",
    headers: {
      authorization: "Bearer customer-secret",
      "agent-feedback-request": "1",
    },
  });
  assert.equal(agent.json()._agentFeedback.v, 1);
  assert.equal(agent.headers["cache-control"], "private, no-store");
  assert.match(agent.headers.vary, /Agent-Feedback-Request/);
  assert.equal(agent.headers.link, undefined);
  assert.deepEqual(authorization, ["Bearer customer-secret", "Bearer customer-secret"]);

  const ordinaryHead = await app.inject({ method: "HEAD", url: "/api/search?scope=head" });
  assert.match(ordinaryHead.headers.link, /request-header=/);
  const agentHead = await app.inject({
    method: "HEAD",
    url: "/api/search?scope=head",
    headers: { "agent-feedback-request": "1" },
  });
  assert.match(agentHead.headers["agent-feedback"], /^ey/);
  assert.equal(agentHead.headers["cache-control"], "private, no-store");
  await plugin.flush();
  await app.close();
});

test("Fastify Ask-once does no consent work for ineligible responses", async () => {
  let consentLookups = 0;
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_ineligible",
    include: ["/error", "/shared", "/existing"],
    flushIntervalMs: 1,
    fetch: async (url) => {
      if (String(url).endsWith("/api/v2/consent/state")) consentLookups += 1;
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/error", async (_request, reply) => reply.code(503).send({ error: true }));
  app.get("/shared", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=60");
    return { answer: "cached" };
  });
  app.get("/existing", async () => ({
    answer: "owned",
    _agentFeedback: { state: "owned" },
  }));
  app.get("/excluded", async () => ({ answer: "excluded" }));
  await app.ready();

  for (const url of ["/error", "/shared", "/existing", "/excluded"]) {
    await app.inject({ method: "GET", url });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consentLookups, 0);
  await plugin.shutdown();
  await app.close();
});

test("Fastify Ask-once can use a decision warmed into the local cache", async () => {
  let resolveLookup;
  let consentLookups = 0;
  const pendingLookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_cached",
    include: ["/api/search"],
    flushIntervalMs: 1,
    fetch: async (url) => {
      if (!String(url).endsWith("/api/v2/consent/state")) {
        return new Response("{}", { status: 202 });
      }
      consentLookups += 1;
      return pendingLookup;
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  await app.ready();

  const first = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(first.json()._agentFeedback.state, "consent_required");
  resolveLookup(
    new Response('{"state":"approved","revision":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const second = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(second.json()._agentFeedback.state, "feedback_ready");
  assert.equal(second.json()._agentFeedback.configuredMode, "ask_once");
  assert.equal(consentLookups, 1);
  await plugin.shutdown();
  await app.close();
});

test("Fastify omits feedback and background work when JSON serialization ends as a 500", async () => {
  const requests = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_circular",
    include: ["/api/circular"],
    flushIntervalMs: 1,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body });
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/api/circular", async () => {
    const body = { answer: "found" };
    body.self = body;
    return body;
  });
  app.setErrorHandler((_error, _request, reply) => {
    reply.code(500).send({ error: "serialization failed" });
  });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/api/circular" });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "serialization failed" });
  assert.equal(response.headers["agent-feedback"], undefined);
  await plugin.shutdown();
  assert.deepEqual(requests, []);
  await app.close();
});
