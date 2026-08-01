import assert from "node:assert/strict";
import test from "node:test";

import { createStaticDocsProxy } from "../dist/edge.js";

const key = `af_live_4123456789abcdef0123456789abcdef_${"e".repeat(32)}`;
const html = "<!doctype html><html><body>Hosted documentation</body></html>";

function executionContext({ throws = false } = {}) {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      if (throws) throw new Error("lifecycle unavailable");
      promises.push(promise);
    },
  };
}

function response(body = html, options = {}) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "public, max-age=300",
    vary: "Accept-Encoding",
    ...options.headers,
  });
  return new Response(body, { status: options.status || 200, headers });
}

test("static docs proxy preserves public caching and same-URL discovery", async () => {
  const upstream = [];
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs", "/docs/**"],
    fetch: async (input) => {
      upstream.push(input);
      return response();
    },
  });
  const context = executionContext();
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/platform/auth?q=cache", {
      headers: { authorization: "Bearer customer-session" },
    }),
    context,
  );

  assert.equal(await result.text(), html);
  assert.equal(result.headers.get("cache-control"), "public, max-age=300");
  assert.equal(result.headers.get("agent-feedback"), null);
  assert.doesNotMatch(JSON.stringify([...result.headers]), /afr2_|af_live_/);
  assert.match(result.headers.get("vary") || "", /Accept-Encoding/);
  assert.match(result.headers.get("vary") || "", /Agent-Feedback-Request/);
  assert.match(
    result.headers.get("link") || "",
    /^<\/docs\/platform\/auth\?q=cache>; rel="agent-feedback"; request-header=/,
  );
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, "https://docs-origin.test/docs/platform/auth?q=cache");
  assert.equal(upstream[0].redirect, "manual");
  assert.equal(upstream[0].headers.get("authorization"), "Bearer customer-session");
  assert.equal(upstream[0].headers.get("agent-feedback-request"), null);
  assert.equal(context.promises.length, 0);
  await proxy.shutdown();
});

test("paths outside the dedicated proxy scope fail closed before upstream", async () => {
  const upstream = [];
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs", "/docs/**"],
    exclude: ["/docs/admin/**"],
    fetch: async (input) => {
      upstream.push(input);
      return response();
    },
  });

  for (const url of [
    "https://docs.example.test/admin/users",
    "https://docs.example.test/docs/admin/secrets",
  ]) {
    const result = await proxy.fetch(
      new Request(url, { headers: { "agent-feedback-request": "1" } }),
      executionContext(),
    );
    assert.equal(result.status, 404, url);
    assert.equal(result.headers.get("cache-control"), "private, no-store", url);
    assert.equal(result.headers.get("agent-feedback"), null, url);
    assert.equal(await result.text(), "", url);
  }

  assert.equal(upstream.length, 0);
  await proxy.shutdown();
});

test("unsafe methods fail closed before upstream", async () => {
  let upstreamCalls = 0;
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async () => {
      upstreamCalls += 1;
      return response();
    },
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const result = await proxy.fetch(
      new Request("https://docs.example.test/docs/admin", {
        method,
        headers: { "agent-feedback-request": "1" },
      }),
      executionContext(),
    );
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.get("allow"), "GET, HEAD", method);
    assert.equal(result.headers.get("cache-control"), "private, no-store", method);
    assert.equal(result.headers.get("agent-feedback"), null, method);
  }

  assert.equal(upstreamCalls, 0);
  await proxy.shutdown();
});

test("eligible HEAD requests preserve routing and discovery behavior", async () => {
  const upstream = [];
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async (input) => {
      upstream.push(input);
      return new Response(null, {
        status: 200,
        headers: new Headers({
          "content-type": "text/html; charset=utf-8",
          "content-length": "123",
          "cache-control": "public, max-age=300",
          vary: "Accept-Encoding",
        }),
      });
    },
  });
  const context = executionContext();
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start?lang=en", { method: "HEAD" }),
    context,
  );

  assert.equal(result.status, 200);
  assert.equal(await result.text(), "");
  assert.match(result.headers.get("vary") || "", /Agent-Feedback-Request/);
  assert.match(result.headers.get("link") || "", /^<\/docs\/start\?lang=en>/);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].method, "HEAD");
  assert.equal(context.promises.length, 0);
  await proxy.shutdown();
});

test("common CDN HTML without Content-Length remains supported byte-for-byte", async () => {
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("https://feedback.test")) return new Response("{}", { status: 202 });
      return response(html, {
        headers: { "content-length": "", "content-encoding": "br" },
      });
    },
  });
  const context = executionContext();
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/cdn", {
      headers: { "agent-feedback-request": "1" },
    }),
    context,
  );

  assert.equal(await result.text(), html);
  assert.equal(result.headers.get("content-encoding"), "br");
  assert.equal(result.headers.get("content-length"), "");
  assert.match(result.headers.get("agent-feedback") || "", /.+/);
  await Promise.all(context.promises);
  await proxy.shutdown();
});

test("opted-in docs receive only a private capability and background telemetry", async () => {
  const upstreamRequests = [];
  const telemetry = [];
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://feedback.test/api/v2/telemetry/batches") {
        telemetry.push({ authorization: init.headers.authorization, body: JSON.parse(init.body) });
        return new Response("{}", { status: 202 });
      }
      upstreamRequests.push(input);
      return response();
    },
  });
  const context = executionContext();
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start", {
      headers: { "agent-feedback-request": "1" },
    }),
    context,
  );
  const body = await result.text();
  const envelope = JSON.parse(
    Buffer.from(result.headers.get("agent-feedback"), "base64url").toString("utf8"),
  );

  assert.equal(body, html);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(envelope.v, 1);
  assert.equal(envelope.state, "feedback_ready");
  assert.match(envelope.submit.authorization, /^Bearer afr2_/);
  assert.doesNotMatch(JSON.stringify(envelope), /af_live_/);
  assert.equal(upstreamRequests[0].headers.get("agent-feedback-request"), null);
  assert.doesNotMatch(JSON.stringify([...upstreamRequests[0].headers]), /af_live_/);
  assert.equal(context.promises.length, 1);
  await Promise.all(context.promises);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].authorization, `Bearer ${key}`);
  assert.equal(telemetry[0].body.events[0].operation, "/docs/start");
  assert.equal(telemetry[0].body.events[0].surface, "http_headers");
  await proxy.shutdown();
});

test("ineligible edge responses are relayed without feedback or telemetry", async () => {
  const cases = [
    [
      "https://docs.example.test/docs/app.js",
      response("script", {
        headers: { "content-type": "application/javascript", "content-length": "6" },
      }),
    ],
    ["https://docs.example.test/docs/missing", response("missing", { status: 404 })],
    [
      "https://docs.example.test/docs/stream",
      response(html, { headers: { "transfer-encoding": "chunked", "content-length": "" } }),
    ],
    [
      "https://docs.example.test/docs/large",
      response(html, { headers: { "content-length": "2000000" } }),
    ],
    [
      "https://docs.example.test/docs/download",
      response(html, { headers: { "content-disposition": "attachment; filename=docs.html" } }),
    ],
    [
      "https://docs.example.test/docs/owned",
      response(html, { headers: { "agent-feedback": "owned-upstream-contract" } }),
    ],
  ];
  let index = 0;
  let epodeCalls = 0;
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    maxTelemetryAttempts: 1,
    fetch: async (input) => {
      if (
        String(typeof input === "string" ? input : input.url).startsWith("https://feedback.test")
      ) {
        epodeCalls += 1;
      }
      return cases[index++][1];
    },
  });

  for (const [url, expected] of cases) {
    const expectedBody = await expected.clone().text();
    const result = await proxy.fetch(
      new Request(url, { headers: { "agent-feedback-request": "1" } }),
      executionContext(),
    );
    assert.equal(result.status, expected.status);
    assert.equal(await result.text(), expectedBody);
    assert.equal(result.headers.get("agent-feedback"), expected.headers.get("agent-feedback"), url);
  }
  assert.equal(epodeCalls, 0);
  await proxy.shutdown();
});

test("proxy rewrites same-upstream redirects, preserves trusted external redirects, and follows neither", async () => {
  let observed;
  let external = false;
  const proxy = createStaticDocsProxy({
    apiKey: key,
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async (input) => {
      observed = input;
      return new Response(null, {
        status: 302,
        headers: {
          location: external
            ? "https://login.example.test/start"
            : "https://docs-origin.test/docs/start/?from=redirect",
        },
      });
    },
  });
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start"),
    executionContext(),
  );
  assert.equal(observed.redirect, "manual");
  assert.equal(
    result.headers.get("location"),
    "https://docs.example.test/docs/start/?from=redirect",
  );
  assert.equal(result.headers.get("agent-feedback"), null);
  external = true;
  const externalResult = await proxy.fetch(
    new Request("https://docs.example.test/docs/private"),
    executionContext(),
  );
  assert.equal(externalResult.headers.get("location"), "https://login.example.test/start");
  assert.equal(externalResult.headers.get("agent-feedback"), null);
  await proxy.shutdown();
});

test("Epode outage and lifecycle failure never change the docs response", async () => {
  const warnings = [];
  const proxy = createStaticDocsProxy({
    apiKey: key,
    endpoint: "https://feedback.test",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    maxTelemetryAttempts: 1,
    shutdownTimeoutMs: 1,
    logger: {
      debug() {},
      warn(value) {
        warnings.push(value);
      },
    },
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("https://feedback.test")) throw new Error("Epode unavailable");
      return response();
    },
  });
  const context = executionContext({ throws: true });
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start", {
      headers: { "agent-feedback-request": "1" },
    }),
    context,
  );

  assert.equal(result.status, 200);
  assert.equal(await result.text(), html);
  assert.match(result.headers.get("agent-feedback") || "", /.+/);
  assert.ok(warnings.some((value) => /lifecycle scheduling failed/i.test(value)));
  await proxy.shutdown();
});

test("proxy rejects unsafe origins, empty scope, and recursive routing", async () => {
  assert.throws(
    () =>
      createStaticDocsProxy({
        apiKey: key,
        upstreamOrigin: "http://docs-origin.test",
        include: ["/docs/**"],
      }),
    /exact HTTPS origin/,
  );
  assert.throws(
    () =>
      createStaticDocsProxy({
        apiKey: key,
        upstreamOrigin: "https://docs-origin.test",
        include: [],
      }),
    /include must contain/,
  );
  let fetched = false;
  const proxy = createStaticDocsProxy({
    apiKey: key,
    upstreamOrigin: "https://docs.example.test",
    include: ["/docs/**"],
    fetch: async () => {
      fetched = true;
      return response();
    },
  });
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start"),
    executionContext(),
  );
  assert.equal(result.status, 502);
  assert.equal(fetched, false);
  assert.doesNotMatch(await result.text(), /af_live_/);
  await proxy.shutdown();
});

test("off mode leaves even opted-in HTML completely uninstrumented", async () => {
  let epodeCalls = 0;
  const proxy = createStaticDocsProxy({
    apiKey: key,
    feedbackMode: "off",
    upstreamOrigin: "https://docs-origin.test",
    include: ["/docs/**"],
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("https://app.epode.ai")) epodeCalls += 1;
      return response();
    },
  });
  const result = await proxy.fetch(
    new Request("https://docs.example.test/docs/start", {
      headers: { "agent-feedback-request": "1" },
    }),
    executionContext(),
  );

  assert.equal(await result.text(), html);
  assert.equal(result.headers.get("agent-feedback"), null);
  assert.equal(result.headers.get("link"), null);
  assert.equal(result.headers.get("vary"), "Accept-Encoding");
  assert.equal(epodeCalls, 0);
  await proxy.shutdown();
});
