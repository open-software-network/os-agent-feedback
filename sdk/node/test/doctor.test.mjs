import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function feedbackEnvelope(feedbackOrigin) {
  return {
    v: 1,
    mode: "never_ask",
    state: "feedback_ready",
    requested: true,
    consentRequired: false,
    consentPolicy: "none",
    when: "after_experience_known_before_final_response",
    instruction: "Submit one bounded report after the product experience is known.",
    submit: {
      url: `${feedbackOrigin}/api/v2/reports`,
      method: "POST",
      authorization: "Bearer afr2_test.payload.signature",
      contentType: "application/json",
      reportSchema: { required: ["summary"] },
    },
  };
}

function consentEnvelope(feedbackOrigin) {
  return {
    v: 1,
    mode: "ask_once",
    state: "consent_required",
    requested: true,
    consentRequired: true,
    consentPolicy: "once",
    consentManagedBy: "epode",
    when: "after_experience_known_and_consent_resolved",
    instruction: "Complete the product task, then ask the exact permission question.",
    requiredAction: {
      type: "ask_user",
      question: "May I send one privacy-safe outcome report?",
      submitDecision: {
        url: `${feedbackOrigin}/api/v2/consent/decisions`,
        method: "POST",
        authorization: "Bearer afr2_consent.payload.signature",
        bodySchema: { decision: ["approved", "declined"] },
      },
    },
  };
}

test("doctor accepts --url and verifies capability without creating feedback", async () => {
  let inspections = 0;
  let optedIn = false;
  const feedback = await listen((request, response) => {
    if (request.url !== "/api/v2/capabilities/introspect") {
      response.writeHead(404).end();
      return;
    }
    inspections += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"state":"feedback_ready","configuredMode":"never_ask","consentPolicy":"none","productName":"Doctor test","canonicalQuestion":null,"expiresAt":"2026-08-01T12:00:00Z"}',
    );
  });
  const product = await listen((request, response) => {
    optedIn = request.headers["agent-feedback-request"] === "1";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ answer: "ok", _agentFeedback: feedbackEnvelope(feedback.origin) }),
    );
  });

  try {
    const accepted = await run(
      process.execPath,
      ["dist/doctor.js", "--url", `${product.origin}/search`, "--feedback-origin", feedback.origin],
      { cwd: new URL("..", import.meta.url) },
    );
    assert.match(accepted.stdout, /PASS trusted Epode submission origin/);
    assert.match(accepted.stdout, /PASS scoped capability inspection for Doctor test/);
    assert.match(accepted.stdout, /no feedback report was created/);
    assert.match(accepted.stdout, /NEXT .*prove confirmation and reporting/);
    assert.equal(optedIn, true, "the doctor must opt into request-mode cached handoffs");
    assert.equal(inspections, 1);

    await assert.rejects(
      run(process.execPath, ["dist/doctor.js", `${product.origin}/search`], {
        cwd: new URL("..", import.meta.url),
      }),
      /untrusted feedback origin/,
    );
    assert.equal(
      inspections,
      1,
      "the doctor must reject the origin before inspecting a capability",
    );
  } finally {
    await product.close();
    await feedback.close();
  }
});

test("doctor reads authenticated product headers from the environment only", async () => {
  let productRequests = 0;
  let inspectionAuthorization;
  const feedback = await listen((request, response) => {
    assert.equal(request.url, "/api/v2/capabilities/introspect");
    inspectionAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"state":"feedback_ready","configuredMode":"never_ask","consentPolicy":"none","productName":"Authenticated doctor","canonicalQuestion":null,"expiresAt":"2026-08-01T12:00:00Z"}',
    );
  });
  const product = await listen((request, response) => {
    productRequests += 1;
    if (request.headers.authorization !== "Bearer product-test-token") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ answer: "ok", _agentFeedback: feedbackEnvelope(feedback.origin) }),
    );
  });

  try {
    const accepted = await run(
      process.execPath,
      [
        "dist/doctor.js",
        `${product.origin}/private-search`,
        "--header-env",
        "Authorization=PRODUCT_TEST_AUTHORIZATION",
        "--feedback-origin",
        feedback.origin,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PRODUCT_TEST_AUTHORIZATION: "Bearer product-test-token" },
      },
    );

    assert.match(accepted.stdout, /PASS product route HTTP 200/);
    assert.equal(productRequests, 1);
    assert.equal(inspectionAuthorization, "Bearer afr2_test.payload.signature");
  } finally {
    await product.close();
    await feedback.close();
  }
});

test("doctor refuses to send an Epode company key as product authentication", async () => {
  let productRequests = 0;
  const product = await listen((_request, response) => {
    productRequests += 1;
    response.writeHead(200).end();
  });

  try {
    await assert.rejects(
      run(
        process.execPath,
        [
          "dist/doctor.js",
          `${product.origin}/search`,
          "--header-env",
          "Authorization=PRODUCT_TEST_AUTHORIZATION",
        ],
        {
          cwd: new URL("..", import.meta.url),
          env: {
            ...process.env,
            PRODUCT_TEST_AUTHORIZATION: "Bearer af_live_company_secret",
          },
        },
      ),
      /Refusing to send an Epode product or read key/,
    );
    assert.equal(productRequests, 0);
  } finally {
    await product.close();
  }
});

test("doctor never follows a product redirect with authentication", async () => {
  let redirectedRequests = 0;
  const destination = await listen((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200).end();
  });
  const product = await listen((_request, response) => {
    response.writeHead(302, { location: `${destination.origin}/unexpected` }).end();
  });

  try {
    await assert.rejects(
      run(
        process.execPath,
        [
          "dist/doctor.js",
          `${product.origin}/search`,
          "--header-env",
          "Authorization=PRODUCT_TEST_AUTHORIZATION",
        ],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, PRODUCT_TEST_AUTHORIZATION: "Bearer product-test-token" },
        },
      ),
      /final HTTPS product route directly/,
    );
    assert.equal(redirectedRequests, 0);
  } finally {
    await product.close();
    await destination.close();
  }
});

test("doctor explains how to recover when an included handoff is absent", async () => {
  const product = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"answer":"ok"}');
  });

  try {
    await assert.rejects(
      run(process.execPath, ["dist/doctor.js", `${product.origin}/search`], {
        cwd: new URL("..", import.meta.url),
      }),
      /exact route matches include.*current write key.*Agent-Feedback-Request: 1/s,
    );
  } finally {
    await product.close();
  }
});

test("doctor proves only the opportunity milestone when real permission is still required", async () => {
  let decisionRequests = 0;
  const feedback = await listen((_request, response) => {
    decisionRequests += 1;
    response.writeHead(500).end();
  });
  const product = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ answer: "ok", _agentFeedback: consentEnvelope(feedback.origin) }),
    );
  });

  try {
    const checked = await run(
      process.execPath,
      ["dist/doctor.js", `${product.origin}/search`, "--feedback-origin", feedback.origin],
      { cwd: new URL("..", import.meta.url) },
    );
    assert.match(checked.stdout, /PASS synthetic decision skipped/);
    assert.match(checked.stdout, /PASS first opportunity handoff/);
    assert.match(checked.stdout, /NEXT .*prove confirmation and reporting/);
    assert.equal(decisionRequests, 0, "a diagnostic must never fabricate a consent decision");
  } finally {
    await product.close();
    await feedback.close();
  }
});

test("doctor fails loudly when Ask once lost authenticated customer identity", async () => {
  let decisionRequests = 0;
  const feedback = await listen((_request, response) => {
    decisionRequests += 1;
    response.writeHead(500).end();
  });
  const product = await listen((_request, response) => {
    const envelope = consentEnvelope(feedback.origin);
    envelope.mode = "ask_always";
    envelope.configuredMode = "ask_once";
    envelope.consentPolicy = "always";
    envelope.when = "after_experience_known_and_explicit_user_approval";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answer: "ok", _agentFeedback: envelope }));
  });

  try {
    await assert.rejects(
      run(
        process.execPath,
        ["dist/doctor.js", `${product.origin}/search`, "--feedback-origin", feedback.origin],
        { cwd: new URL("..", import.meta.url) },
      ),
      /Ask once could not resolve customerRef.*authentication.*before Agent Feedback/s,
    );
    assert.equal(decisionRequests, 0);
  } finally {
    await product.close();
    await feedback.close();
  }
});

test("doctor rejects an unexpected action path before sending feedback", async () => {
  let requests = 0;
  const feedback = await listen((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"accepted":true}');
  });
  const product = await listen((_request, response) => {
    const envelope = feedbackEnvelope(feedback.origin);
    envelope.submit.url = `${feedback.origin}/collect-anything`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answer: "ok", _agentFeedback: envelope }));
  });

  try {
    await assert.rejects(
      run(
        process.execPath,
        ["dist/doctor.js", `${product.origin}/search`, "--feedback-origin", feedback.origin],
        { cwd: new URL("..", import.meta.url) },
      ),
      /must use \/api\/v2\/reports/,
    );
    assert.equal(requests, 0);
  } finally {
    await product.close();
    await feedback.close();
  }
});
