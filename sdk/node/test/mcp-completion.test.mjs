import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMcpInstrumentation } from "../dist/mcp.js";

const key = `af_live_2123456789abcdef0123456789abcdef_${"z".repeat(32)}`;
const conformanceDocument = JSON.parse(
  await readFile(new URL("../../../protocol/v1/conformance.json", import.meta.url), "utf8"),
);
const conformance = conformanceDocument.mcpCompletion;

function harness(options = {}) {
  const tools = new Map();
  const requests = [];
  const instrumentation = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackTools: [],
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return new Response(JSON.stringify({ accepted: payload.events.length, dropped: 0 }), {
        status: 202,
      });
    },
    ...options,
  });
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
    },
  };
  instrumentation.instrument(server);
  return {
    instrumentation,
    requests,
    register(name, handler) {
      server.registerTool(name, { inputSchema: {} }, handler);
    },
    call(name, arguments_ = {}, context = {}) {
      return tools.get(name).handler(arguments_, context);
    },
  };
}

function projection(event) {
  const projected = { ...event };
  for (const field of conformance.expectedEventComparison.omit) delete projected[field];
  delete projected.durationMs;
  return projected;
}

test("createMcpInstrumentation executes the canonical completion vectors", async (t) => {
  for (const vector of conformance.vectors) {
    await t.test(vector.name, async () => {
      if (vector.name === "invalid_outcome") {
        assert.equal(vector.expectedErrorKind, "invalid_outcome");
        assert.equal(
          vector.expectedEvent,
          null,
          "outcome is structurally unrepresentable: the adapter derives it from isError/throw",
        );
        return;
      }
      const input = vector.input;
      let feedbackPredicateCalls = 0;
      const runtime = harness({
        feedbackTools: vector.expectedEvent === null ? undefined : [],
        shouldRequestFeedback: () => {
          feedbackPredicateCalls += 1;
          return true;
        },
        accountRef: () => input.accountRef,
        userRef: () => input.userRef,
        anonymousRef: () => input.anonymousRef,
        customerRef: () => input.customerRef,
        sessionRef: (_arguments, _context, result) =>
          vector.name === "success_result_derived_session" && !result
            ? undefined
            : input.sessionRef,
        runtimeHint: () => input.runtimeHint,
      });
      const productResult = {
        content: [{ type: "text", text: "private product output" }],
        ...(input.outcome === "error" ? { isError: true } : {}),
      };
      runtime.register(input.operation, async () => productResult);
      assert.equal(await runtime.call(input.operation), productResult);
      await runtime.instrumentation.shutdown();

      if (vector.expectedEvent === null) {
        assert.deepEqual(runtime.requests, []);
        assert.equal(feedbackPredicateCalls, 0);
        assert.doesNotMatch(JSON.stringify(productResult), /_agentFeedback/);
        return;
      }
      const event = runtime.requests[0].events[0];
      assert.deepEqual(projection(event), vector.expectedEvent);
      assert.match(
        event.interactionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.ok(Number.isInteger(event.sequence) && event.sequence > 0);
      assert.equal(new Date(event.occurredAt).toISOString(), event.occurredAt);
      assert.match(event.occurredAt, /Z$/);
      assert.ok(Number.isInteger(event.durationMs) && event.durationMs >= 0);
      assert.doesNotMatch(JSON.stringify(event), /private product output/);
    });
  }
});

test("isError and thrown completions use the same sanitized extraction path", async () => {
  const marker = new Error("exact product error");
  const runtime = harness({
    accountRef: () => " account_42 ",
    customerRef: () => "different_account",
    sessionRef: () => " summary:42 ",
    runtimeHint: () => `${"x".repeat(199)}🚀`,
  });
  runtime.register("returned_error", async () => ({ isError: true, content: [] }));
  runtime.register("thrown_error", async () => {
    throw marker;
  });
  assert.equal((await runtime.call("returned_error")).isError, true);
  await assert.rejects(runtime.call("thrown_error"), (error) => error === marker);
  await runtime.instrumentation.shutdown();
  const events = runtime.requests.flatMap((request) => request.events);
  assert.deepEqual(
    events.map(({ statusCode, accountRef, customerRef, sessionRef, runtimeHint }) => ({
      statusCode,
      accountRef,
      customerRef,
      sessionRef,
      runtimeHint,
    })),
    [
      {
        statusCode: 500,
        accountRef: "account_42",
        customerRef: undefined,
        sessionRef: "summary:42",
        runtimeHint: `${"x".repeat(199)}🚀`,
      },
      {
        statusCode: 500,
        accountRef: "account_42",
        customerRef: undefined,
        sessionRef: "summary:42",
        runtimeHint: `${"x".repeat(199)}🚀`,
      },
    ],
  );
});

test("product-owned journey fixture links only server-proven canonical sessions", async () => {
  const registry = new Map([
    ["A", "verified_account"],
    ["B", "verified_account"],
    ["OTHER", "other_account"],
  ]);
  const verifiedContext = {
    http: { authInfo: { extra: { accountId: "verified_account" } } },
  };
  const runtime = harness({
    accountRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId,
    sessionRef: (arguments_, context, result) => {
      const account = context.http?.authInfo?.extra?.accountId;
      const candidate = result?.structuredContent?.canonical ?? arguments_.candidate;
      return typeof candidate === "string" && registry.get(candidate) === account
        ? `journey:${candidate}`
        : undefined;
    },
  });
  const productSecret = "PRODUCT-CONTENT-MUST-NOT-LEAK";
  const calls = [
    ["create_a", {}, { canonical: "A", value: productSecret }],
    ["follow_a", { candidate: "A" }, { value: productSecret }],
    ["cache_a", {}, { canonical: "A", cached: true }],
    ["create_b", {}, { canonical: "B" }],
    ["follow_b", { candidate: "B" }, { value: "B" }],
    ["missing", {}, { value: "none" }],
    ["malformed", { candidate: "not valid" }, { value: "none" }],
    ["unknown", { candidate: "UNKNOWN" }, { value: "none" }],
    ["wrong_account", { candidate: "OTHER" }, { value: "none" }],
    ["proven_error", { candidate: "A" }, { isError: true }],
    ["failed_create", {}, { isError: true }],
  ];
  for (const [name, arguments_, productResult] of calls) {
    runtime.register(name, async () =>
      productResult.isError ? productResult : { structuredContent: productResult },
    );
    await runtime.call(name, arguments_, verifiedContext);
  }
  const marker = new Error("original thrown object");
  runtime.register("thrown", async () => {
    throw marker;
  });
  await assert.rejects(
    runtime.call("thrown", { candidate: "B" }, verifiedContext),
    (error) => error === marker,
  );
  await runtime.instrumentation.shutdown();

  const events = runtime.requests.flatMap((request) => request.events);
  assert.deepEqual(
    events.map((event) => event.operation),
    [...calls.map(([name]) => name), "thrown"],
  );
  assert.deepEqual(
    events.map((event) => event.sessionRef),
    [
      "journey:A",
      "journey:A",
      "journey:A",
      "journey:B",
      "journey:B",
      undefined,
      undefined,
      undefined,
      undefined,
      "journey:A",
      undefined,
      "journey:B",
    ],
  );
  assert.equal(new Set(events.map((event) => event.interactionId)).size, events.length);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.doesNotMatch(JSON.stringify(events), new RegExp(productSecret));
});

test("shared linked journey fixture preserves cross-SDK semantics", async () => {
  const fixture = conformanceDocument.mcpLinkedJourney;
  const runtime = harness({
    accountRef: () => fixture.identity.accountRef,
    userRef: () => fixture.identity.userRef,
    anonymousRef: () => fixture.identity.anonymousRef,
    sessionRef: (_arguments, _context, result) => result?.structuredContent?.resolvedSessionRef,
    runtimeHint: () => fixture.runtimeHint,
  });
  const expected = [];
  for (const run of fixture.runs) {
    for (const completion of run.completions) {
      const tool = completion.operation;
      const result = {
        structuredContent: {
          resolvedSessionRef: run.sessionRef,
          privateContent: fixture.privateContentSentinel,
        },
      };
      runtime.register(tool, async () => result);
      await runtime.call(tool, { privateContent: fixture.privateContentSentinel });
      expected.push({ ...completion, sessionRef: run.sessionRef });
    }
  }
  for (const completion of fixture.unlinked) {
    const tool = completion.operation;
    const result = {
      structuredContent: { privateContent: fixture.privateContentSentinel },
      ...(completion.outcome === "error" ? { isError: true } : {}),
    };
    runtime.register(tool, async () => result);
    await runtime.call(tool, {
      candidateSessionRef: completion.candidateSessionRef,
      privateContent: fixture.privateContentSentinel,
    });
    expected.push({ ...completion, sessionRef: undefined });
  }
  await runtime.instrumentation.shutdown();

  const events = runtime.requests.flatMap((request) => request.events);
  assert.deepEqual(
    events.map(({ operation, statusCode, sessionRef }) => ({ operation, statusCode, sessionRef })),
    expected.map(({ operation, outcome, sessionRef }) => ({
      operation,
      statusCode: outcome === "success" ? 200 : 500,
      sessionRef,
    })),
  );
  for (const event of events) {
    assert.equal(event.surface, "mcp");
    assert.equal(event.classification, "confirmed");
    assert.equal(event.confirmationMethod, "mcp");
    assert.equal(event.accountRef, fixture.identity.accountRef);
    assert.equal(event.userRef, fixture.identity.userRef);
    assert.equal(event.anonymousRef, fixture.identity.anonymousRef);
    assert.equal(event.runtimeHint, fixture.runtimeHint);
    assert.equal(event.runtimeHintSource, "mcp");
    assert.equal(event.sessionSource, event.sessionRef ? "mcp" : undefined);
    assert.match(
      event.interactionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
  assert.equal(new Set(events.map((event) => event.interactionId)).size, events.length);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.doesNotMatch(JSON.stringify(events), new RegExp(fixture.privateContentSentinel));
});

test("retryable telemetry reuses the exact event and payload", async () => {
  const bodies = [];
  let attempt = 0;
  const runtime = harness({
    maxTelemetryAttempts: 2,
    fetch: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      bodies.push(init.body);
      attempt += 1;
      return new Response(attempt === 1 ? "{}" : '{"accepted":1,"dropped":0}', {
        status: attempt === 1 ? 503 : 202,
      });
    },
  });
  runtime.register("create_item", async () => ({ content: [] }));
  await runtime.call("create_item");
  await runtime.instrumentation.shutdown();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
});

test("a retry keeps its batch atomic while a new event is queued", async () => {
  const bodies = [];
  let releaseFirstAttempt;
  let releaseSecondBatch;
  let markSecondBatchStarted;
  const firstAttemptBlocked = new Promise((resolve) => {
    releaseFirstAttempt = resolve;
  });
  const secondBatchBlocked = new Promise((resolve) => {
    releaseSecondBatch = resolve;
  });
  const secondBatchStarted = new Promise((resolve) => {
    markSecondBatchStarted = resolve;
  });
  const runtime = harness({
    maxTelemetryAttempts: 2,
    logger: { debug() {}, warn() {} },
    fetch: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) {
        await firstAttemptBlocked;
        return new Response("{}", { status: 503 });
      }
      const payload = JSON.parse(init.body);
      if (bodies.length === 3) {
        markSecondBatchStarted();
        await secondBatchBlocked;
      }
      return new Response(JSON.stringify({ accepted: payload.events.length, dropped: 0 }), {
        status: 202,
      });
    },
  });
  runtime.register("first", async () => ({ content: [] }));
  runtime.register("second", async () => ({ content: [] }));
  await runtime.call("first");
  const activeFlush = runtime.instrumentation.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.call("second");
  let successorSettled = false;
  const successorFlush = runtime.instrumentation.flush().then(() => {
    successorSettled = true;
  });
  let queuedSettled = false;
  const queuedFlush = runtime.instrumentation.flush();
  void queuedFlush.then(() => {
    queuedSettled = true;
  });
  releaseFirstAttempt();
  let flushDeadline;
  try {
    await Promise.race([
      secondBatchStarted,
      new Promise((_, reject) => {
        flushDeadline = setTimeout(
          () => reject(new Error("telemetry retry did not settle")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(flushDeadline);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successorSettled, false);
  assert.equal(queuedSettled, false);
  releaseSecondBatch();
  await Promise.all([successorFlush, queuedFlush]);

  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[0]);
  assert.deepEqual(
    bodies.map((body) => JSON.parse(body).events.map((event) => event.operation)),
    [["first"], ["first"], ["second"]],
  );
  await activeFlush;
  await runtime.instrumentation.shutdown();
});

test("terminal telemetry statuses and receipts are not retried", async (t) => {
  const cases = [
    ["wrong status", 200, '{"accepted":1,"dropped":0}'],
    ["empty receipt", 202, ""],
    ["malformed receipt", 202, "{"],
    ["partial receipt", 202, '{"accepted":0,"dropped":1}'],
    ["terminal client error", 400, "{}"],
  ];
  for (const [name, status, body] of cases) {
    await t.test(name, async () => {
      let attempts = 0;
      const warnings = [];
      const runtime = harness({
        maxTelemetryAttempts: 3,
        logger: {
          debug() {},
          warn(message) {
            warnings.push(message);
          },
        },
        fetch: async () => {
          attempts += 1;
          return new Response(body, { status });
        },
      });
      const productResult = { content: [{ type: "text", text: "unchanged" }] };
      runtime.register("create_item", async () => productResult);
      assert.equal(await runtime.call("create_item"), productResult);
      await runtime.instrumentation.shutdown();
      assert.equal(attempts, 1);
      assert.equal(warnings.length, 1);
    });
  }
});

test("only transport failures, 408, 429, and 5xx statuses are retried", async (t) => {
  for (const status of [408, 429, 503]) {
    await t.test(String(status), async () => {
      const bodies = [];
      const runtime = harness({
        maxTelemetryAttempts: 2,
        logger: { debug() {}, warn() {} },
        fetch: async (_url, init) => {
          bodies.push(init.body);
          return new Response(bodies.length === 1 ? "{}" : '{"accepted":1,"dropped":0}', {
            status: bodies.length === 1 ? status : 202,
          });
        },
      });
      runtime.register("create_item", async () => ({ content: [] }));
      await runtime.call("create_item");
      await runtime.instrumentation.shutdown();
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1], bodies[0]);
    });
  }
  await t.test("transport failure", async () => {
    let attempts = 0;
    const runtime = harness({
      maxTelemetryAttempts: 2,
      logger: { debug() {}, warn() {} },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      },
    });
    runtime.register("create_item", async () => ({ content: [] }));
    await runtime.call("create_item");
    await runtime.instrumentation.shutdown();
    assert.equal(attempts, 2);
  });
  await t.test("response body transport failure", async () => {
    const bodies = [];
    const runtime = harness({
      maxTelemetryAttempts: 2,
      logger: { debug() {}, warn() {} },
      fetch: async (_url, init) => {
        bodies.push(init.body);
        if (bodies.length === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("body stream failed"));
              },
            }),
            { status: 202 },
          );
        }
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      },
    });
    runtime.register("create_item", async () => ({ content: [] }));
    await runtime.call("create_item");
    await runtime.instrumentation.shutdown();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0]);
  });
});

test("a completion after terminal shutdown is a product-preserving no-op", async () => {
  let release;
  let extractorCalls = 0;
  let feedbackPredicateCalls = 0;
  const blocked = new Promise((resolve) => (release = resolve));
  const runtime = harness({
    feedbackTools: undefined,
    shouldRequestFeedback: () => {
      feedbackPredicateCalls += 1;
      return true;
    },
    sessionRef: () => {
      extractorCalls += 1;
      return "journey:late";
    },
  });
  const result = { content: [{ type: "text", text: "still returned" }] };
  runtime.register("slow_product", async () => {
    await blocked;
    return result;
  });
  const pending = runtime.call("slow_product");
  await runtime.instrumentation.shutdown();
  release();
  assert.equal(await pending, result);
  await runtime.instrumentation.flush();
  assert.deepEqual(runtime.requests, []);
  assert.equal(extractorCalls, 0);
  assert.equal(feedbackPredicateCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /_agentFeedback/);
});

test("shutdown joins an active flush and prevents post-return retry", async () => {
  let rejectFetch;
  let requestCount = 0;
  const blockedFetch = new Promise((_resolve, reject) => {
    rejectFetch = reject;
  });
  const runtime = harness({
    maxTelemetryAttempts: 2,
    shutdownTimeoutMs: 20,
    fetch: async () => {
      requestCount += 1;
      return blockedFetch;
    },
  });
  runtime.register("active_flush", async () => ({ content: [] }));
  await runtime.call("active_flush");
  const activeFlush = runtime.instrumentation.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.instrumentation.shutdown();
  rejectFetch(new Error("late transport failure"));
  await activeFlush;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(requestCount, 1);
});

test("shutdown prevents a sleeping retry from starting after its deadline", async () => {
  let requestCount = 0;
  const runtime = harness({
    maxTelemetryAttempts: 2,
    shutdownTimeoutMs: 20,
    fetch: async () => {
      requestCount += 1;
      return new Response("{}", { status: 503 });
    },
  });
  runtime.register("retry_backoff", async () => ({ content: [] }));
  await runtime.call("retry_backoff");
  const activeFlush = runtime.instrumentation.flush();
  while (requestCount === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.instrumentation.shutdown();
  const requestCountAtShutdown = requestCount;
  await new Promise((resolve) => setTimeout(resolve, 550));
  await activeFlush;
  assert.equal(requestCountAtShutdown, 1);
  assert.equal(requestCount, requestCountAtShutdown);
});

test("shutdown bounds a flush it starts when transport ignores cancellation", async () => {
  let requestCount = 0;
  const runtime = harness({
    maxTelemetryAttempts: 2,
    shutdownTimeoutMs: 20,
    fetch: async () => {
      requestCount += 1;
      return new Promise(() => {});
    },
  });
  runtime.register("queued_before_shutdown", async () => ({ content: [] }));
  await runtime.call("queued_before_shutdown");

  const started = performance.now();
  const firstShutdown = runtime.instrumentation.shutdown();
  const secondShutdown = runtime.instrumentation.shutdown();
  assert.equal(secondShutdown, firstShutdown);
  await Promise.race([
    firstShutdown,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("shutdown exceeded its bounded deadline")), 250),
    ),
  ]);
  assert.ok(performance.now() - started < 250);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(requestCount, 1);
});
