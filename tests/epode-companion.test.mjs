import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url).pathname;
const companionRoot = new URL("../companion/", import.meta.url).pathname;
const companionPluginDirectory = new URL("../companion/plugins/epode-companion/", import.meta.url)
  .pathname;
const companionServer = new URL(
  "../companion/plugins/epode-companion/scripts/mcp-server.mjs",
  import.meta.url,
).pathname;
const skillFile = new URL(
  "../companion/plugins/epode-companion/skills/epode-product-feedback/SKILL.md",
  import.meta.url,
).pathname;
const openAiMetadataFile = new URL(
  "../companion/plugins/epode-companion/skills/epode-product-feedback/agents/openai.yaml",
  import.meta.url,
).pathname;
const codexManifestFile = new URL(
  "../companion/plugins/epode-companion/.codex-plugin/plugin.json",
  import.meta.url,
).pathname;
const claudeManifestFile = new URL(
  "../companion/plugins/epode-companion/.claude-plugin/plugin.json",
  import.meta.url,
).pathname;
const claudeMcpFile = new URL("../companion/plugins/epode-companion/.mcp.json", import.meta.url)
  .pathname;
const rootCodexMarketplaceFile = new URL("../.agents/plugins/marketplace.json", import.meta.url)
  .pathname;
const rootClaudeMarketplaceFile = new URL("../.claude-plugin/marketplace.json", import.meta.url)
  .pathname;
const companionCodexMarketplaceFile = new URL(
  "../companion/.agents/plugins/marketplace.json",
  import.meta.url,
).pathname;
const companionClaudeMarketplaceFile = new URL(
  "../companion/.claude-plugin/marketplace.json",
  import.meta.url,
).pathname;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startCompanion(endpoint) {
  const child = spawn(process.execPath, [companionServer], {
    env: {
      ...process.env,
      EPODE_COMPANION_ENDPOINT: endpoint,
      EPODE_COMPANION_ALLOW_TEST_ENDPOINT: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  const request = (method, params = {}) => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  return { child, request };
}

test("Epode Companion exposes fixed consent and bounded report tools", async () => {
  const handle = `afr2_${"a".repeat(80)}`;
  const calls = [];
  const idempotencyKeys = [];
  const api = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    idempotencyKeys.push(request.headers["idempotency-key"]);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/v2/capabilities/introspect") {
      response.end(
        JSON.stringify({
          state: "consent_required",
          configuredMode: "ask_once",
          consentPolicy: "once",
          productName: "Checkout API",
          canonicalQuestion:
            "May I send Checkout API's provider one short report? Your prompts and task content are never included; nothing is installed.",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      return;
    }
    if (request.url === "/api/v2/consent/decisions") {
      response.end(
        JSON.stringify({
          state: "approved",
          feedback: { submit: { authorization: `Bearer ${handle}` } },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ accepted: true, interactionId: "interaction-test" }));
  });
  const companion = startCompanion(api.endpoint);
  try {
    const initialized = await companion.request("initialize", {
      protocolVersion: "2025-11-25",
    });
    assert.equal(initialized.result.serverInfo.name, "epode-companion");
    assert.equal(initialized.result.serverInfo.version, "0.2.3");
    assert.equal(initialized.result.protocolVersion, "2025-11-25");

    const negotiated = await companion.request("initialize", {
      protocolVersion: "1900-01-01",
    });
    assert.equal(negotiated.result.protocolVersion, "2026-07-28");

    const listed = await companion.request("tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["inspect_product_feedback", "record_product_feedback_consent", "submit_product_feedback"],
    );
    assert.ok(listed.result.tools.every((tool) => tool.inputSchema.additionalProperties === false));

    const inspection = await companion.request("tools/call", {
      name: "inspect_product_feedback",
      arguments: { feedbackHandle: handle },
    });
    assert.equal(inspection.result.structuredContent.verified, true);
    assert.equal(inspection.result.structuredContent.productName, "Checkout API");
    assert.deepEqual(inspection.result.structuredContent.nextAction, {
      type: "ask_user",
      question:
        "May I send Checkout API's provider one short report? Your prompts and task content are never included; nothing is installed.",
    });
    assert.match(
      inspection.result.content[0].text,
      /ask exactly this question.*May I send Checkout API's provider one short report\?.*nothing is installed\./,
    );

    const consent = await companion.request("tools/call", {
      name: "record_product_feedback_consent",
      arguments: { feedbackHandle: handle, decision: "approved" },
    });
    assert.equal(consent.result.structuredContent.feedbackHandle, handle);
    assert.equal(consent.result.structuredContent.state, "feedback_ready");
    assert.match(
      consent.result.content[0].text,
      /do not inspect or record permission again.*submit_product_feedback exactly once/i,
    );
    assert.deepEqual(consent.result.structuredContent.nextAction, {
      tool: "submit_product_feedback",
      feedbackHandle: handle,
    });

    const report = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: {
        feedbackHandle: handle,
        outcome: "completed_with_friction",
        confidence: 0.9,
        signals: ["accurate", "slow"],
        workaroundUsed: false,
      },
    });
    assert.equal(report.result.structuredContent.accepted, true);
    assert.match(
      report.result.content[0].text,
      /routine background success out of the final answer/,
    );
    assert.deepEqual(calls, [
      {
        path: "/api/v2/capabilities/introspect",
        authorization: `Bearer ${handle}`,
        body: {},
      },
      {
        path: "/api/v2/consent/decisions",
        authorization: `Bearer ${handle}`,
        body: { decision: "approved" },
      },
      {
        path: "/api/v2/reports",
        authorization: `Bearer ${handle}`,
        body: {
          summary: "The product completed the requested outcome with friction.",
          impact: "helped_with_friction",
          confidence: 0.9,
          findings: [
            {
              kind: "strength",
              topic: "accuracy",
              severity: "minor",
              detail: "The result was accurate for the requested outcome.",
            },
            {
              kind: "friction",
              topic: "latency",
              severity: "minor",
              detail: "The product responded slowly.",
            },
          ],
          workaround: { used: false },
        },
      },
    ]);
    assert.equal(idempotencyKeys.length, 3);
    assert.ok(idempotencyKeys.every((key) => /^[a-f0-9]{64}$/.test(key)));
    assert.notEqual(idempotencyKeys[0], idempotencyKeys[1]);
  } finally {
    companion.child.kill();
    await api.close();
  }
});

test("Epode Companion suppresses repeated accepted writes without overriding server consent", async () => {
  const consentHandle = `afr2_${"c".repeat(80)}`;
  const declinedHandle = `afr2_${"e".repeat(80)}`;
  const reportHandle = `afr2_${"d".repeat(80)}`;
  const calls = [];
  const decisions = new Map();
  const api = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/v2/consent/decisions") {
      const standing = decisions.get(request.headers.authorization) || body.decision;
      decisions.set(request.headers.authorization, standing);
      response.end(
        JSON.stringify(
          standing === "approved"
            ? {
                state: "approved",
                feedback: { submit: { authorization: `Bearer ${reportHandle}` } },
              }
            : { state: "declined" },
        ),
      );
      return;
    }
    response.end(JSON.stringify({ accepted: true, report: { id: "report-first" } }));
  });
  const companion = startCompanion(api.endpoint);
  try {
    const approve = {
      name: "record_product_feedback_consent",
      arguments: { feedbackHandle: consentHandle, decision: "approved" },
    };
    const firstApproval = await companion.request("tools/call", approve);
    const replayedApproval = await companion.request("tools/call", approve);
    assert.deepEqual(replayedApproval.result, firstApproval.result);

    const firstReport = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: { feedbackHandle: reportHandle, outcome: "completed" },
    });
    const replayedReport = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: {
        feedbackHandle: reportHandle,
        outcome: "not_completed",
        signals: ["incorrect"],
      },
    });
    assert.deepEqual(replayedReport.result, firstReport.result);

    const decline = {
      name: "record_product_feedback_consent",
      arguments: { feedbackHandle: declinedHandle, decision: "declined" },
    };
    const firstDecline = await companion.request("tools/call", decline);
    const replayedDecline = await companion.request("tools/call", decline);
    assert.deepEqual(replayedDecline.result, firstDecline.result);

    // A conflicting decision for one interaction still reaches Epode; the
    // Companion must not manufacture a flip from its cached approval.
    const conflicting = await companion.request("tools/call", {
      name: "record_product_feedback_consent",
      arguments: { feedbackHandle: consentHandle, decision: "declined" },
    });
    assert.equal(conflicting.result.isError, true);
    assert.equal(conflicting.result.structuredContent.accepted, false);
    assert.deepEqual(calls, [
      {
        path: "/api/v2/consent/decisions",
        authorization: `Bearer ${consentHandle}`,
        body: { decision: "approved" },
      },
      {
        path: "/api/v2/reports",
        authorization: `Bearer ${reportHandle}`,
        body: {
          summary: "The product completed the requested outcome.",
          impact: "helped",
        },
      },
      {
        path: "/api/v2/consent/decisions",
        authorization: `Bearer ${declinedHandle}`,
        body: { decision: "declined" },
      },
      {
        path: "/api/v2/consent/decisions",
        authorization: `Bearer ${consentHandle}`,
        body: { decision: "declined" },
      },
    ]);
  } finally {
    companion.child.kill();
    await api.close();
  }
});

test("Epode Companion makes cold Ask-once inspection authoritative", async (testContext) => {
  const handle = `afr2_${"9".repeat(80)}`;
  for (const scenario of [
    {
      name: "remembered approval becomes an immediate report action",
      state: "feedback_ready",
      consentPolicy: "none",
    },
    {
      name: "remembered decline remains silent",
      state: "declined",
      consentPolicy: "once",
    },
  ]) {
    await testContext.test(scenario.name, async () => {
      const api = await listen(async (request, response) => {
        for await (const _chunk of request) {
          // Drain the request body.
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            state: scenario.state,
            configuredMode: "ask_once",
            consentPolicy: scenario.consentPolicy,
            productName: "Cold Process API",
            canonicalQuestion: null,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      });
      const companion = startCompanion(api.endpoint);
      try {
        const inspection = await companion.request("tools/call", {
          name: "inspect_product_feedback",
          arguments: { feedbackHandle: handle },
        });
        assert.equal(inspection.result.structuredContent.verified, true);
        assert.equal(inspection.result.structuredContent.state, scenario.state);
        assert.equal(inspection.result.structuredContent.canonicalQuestion, undefined);
        if (scenario.state === "feedback_ready") {
          assert.equal(inspection.result.structuredContent.feedbackHandle, handle);
          assert.deepEqual(inspection.result.structuredContent.nextAction, {
            tool: "submit_product_feedback",
            feedbackHandle: handle,
          });
          assert.match(
            inspection.result.content[0].text,
            /call submit_product_feedback exactly once now/,
          );
        } else {
          assert.equal(inspection.result.structuredContent.feedbackHandle, undefined);
          assert.equal(inspection.result.structuredContent.nextAction, undefined);
          assert.match(inspection.result.content[0].text, /Do not ask or submit feedback/);
        }
      } finally {
        companion.child.kill();
        await api.close();
      }
    });
  }
});

test("Epode Companion rejects every free-form or unknown field without network access", async () => {
  let requests = 0;
  const api = await listen((_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end();
  });
  const companion = startCompanion(api.endpoint);
  try {
    const handle = `afr2_${"b".repeat(80)}`;
    const unknown = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: {
        feedbackHandle: handle,
        outcome: "completed",
        prompt: "private task",
      },
    });
    assert.equal(unknown.error.message, "report contains an unknown field");

    const freeform = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: {
        feedbackHandle: handle,
        outcome: "completed",
        summary: "The response exposed a name, address, phone number, or secret.",
      },
    });
    assert.equal(freeform.error.message, "report contains an unknown field");

    const ambiguousConsent = await companion.request("tools/call", {
      name: "record_product_feedback_consent",
      arguments: {
        feedbackHandle: handle,
        decision: "maybe",
      },
    });
    assert.equal(ambiguousConsent.error.message, "decision must be approved or declined");
    assert.equal(requests, 0);
  } finally {
    companion.child.kill();
    await api.close();
  }
});

test("Epode Companion keeps invalid, expired, and unavailable capabilities fail-closed", async (testContext) => {
  for (const scenario of [
    { name: "forged capability", status: 401, retryable: false, expectedRequests: 1 },
    { name: "expired capability", status: 410, retryable: false, expectedRequests: 1 },
    { name: "unavailable backend", status: 503, retryable: true, expectedRequests: 2 },
  ]) {
    await testContext.test(scenario.name, async () => {
      let requests = 0;
      const api = await listen(async (request, response) => {
        for await (const _chunk of request) {
          // Drain request bodies so retry behavior is deterministic.
        }
        requests += 1;
        response.writeHead(scenario.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: scenario.name }));
      });
      const companion = startCompanion(api.endpoint);
      try {
        const handle = `afr2_${"7".repeat(80)}`;
        const inspection = await companion.request("tools/call", {
          name: "inspect_product_feedback",
          arguments: { feedbackHandle: handle },
        });
        assert.equal(inspection.result.isError, true);
        assert.equal(inspection.result.structuredContent.verified, false);
        assert.equal(inspection.result.structuredContent.retryable, scenario.retryable);
        assert.match(inspection.result.content[0].text, /Do not ask the user or submit feedback/);
        assert.equal(requests, scenario.expectedRequests);
      } finally {
        companion.child.kill();
        await api.close();
      }
    });
  }
});

test("Epode Companion treats Ask-always as fresh consent after every restart", async () => {
  const handle = `afr2_${"8".repeat(80)}`;
  let inspections = 0;
  const api = await listen(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body.
    }
    if (request.url === "/api/v2/capabilities/introspect") inspections += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        state: "consent_required",
        configuredMode: "ask_always",
        consentPolicy: "always",
        productName: "Per-use API",
        canonicalQuestion: "May I send Per-use API's provider one short report for this use?",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
  });
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      const companion = startCompanion(api.endpoint);
      try {
        const inspection = await companion.request("tools/call", {
          name: "inspect_product_feedback",
          arguments: { feedbackHandle: handle },
        });
        assert.equal(inspection.result.structuredContent.consentPolicy, "always");
        assert.deepEqual(inspection.result.structuredContent.nextAction, {
          type: "ask_user",
          question: "May I send Per-use API's provider one short report for this use?",
        });
        assert.match(
          inspection.result.content[0].text,
          /May I send Per-use API's provider one short report for this use\?/,
        );
      } finally {
        companion.child.kill();
      }
    }
    assert.equal(inspections, 2);
  } finally {
    await api.close();
  }
});

test("Epode Companion refuses to forward report bodies across redirects", async () => {
  let redirectedRequests = 0;
  const sink = await listen(async (request, response) => {
    for await (const _chunk of request) {
      // Drain a body if a regression forwards it.
    }
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
  });
  const redirector = await listen(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before returning the redirect.
    }
    response.writeHead(307, { location: `${sink.endpoint}/capture` });
    response.end();
  });
  const companion = startCompanion(redirector.endpoint);
  try {
    const handle = `afr2_${"c".repeat(80)}`;
    const report = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: { feedbackHandle: handle, outcome: "completed" },
    });
    assert.equal(report.result.isError, true);
    assert.equal(report.result.structuredContent.retryable, true);
    assert.equal(redirectedRequests, 0);
  } finally {
    companion.child.kill();
    await redirector.close();
    await sink.close();
  }
});

test("Epode Companion retries one transient HTTP failure with the same idempotency key", async (t) => {
  for (const status of [408, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const handle = `afr2_${String(status).repeat(40)}`;
      const keys = [];
      let requests = 0;
      const api = await listen(async (request, response) => {
        for await (const _chunk of request) {
          // Drain the request body.
        }
        requests += 1;
        keys.push(request.headers["idempotency-key"]);
        response.writeHead(requests === 1 ? status : 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(requests === 1 ? { error: "temporary" } : { accepted: true }));
      });
      const companion = startCompanion(api.endpoint);
      try {
        const report = await companion.request("tools/call", {
          name: "submit_product_feedback",
          arguments: { feedbackHandle: handle, outcome: "completed" },
        });
        assert.equal(report.result.structuredContent.accepted, true);
        assert.equal(requests, 2);
        assert.equal(keys[0], keys[1]);
      } finally {
        companion.child.kill();
        await api.close();
      }
    });
  }
});

test("Epode Companion never treats a malformed success response as acceptance", async () => {
  const api = await listen(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body.
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: false }));
  });
  const companion = startCompanion(api.endpoint);
  try {
    const report = await companion.request("tools/call", {
      name: "submit_product_feedback",
      arguments: { feedbackHandle: `afr2_${"f".repeat(80)}`, outcome: "completed" },
    });
    assert.equal(report.result.isError, true);
    assert.equal(report.result.structuredContent.accepted, false);
  } finally {
    companion.child.kill();
    await api.close();
  }
});

test("Epode Companion treats backend consent as authoritative", async (testContext) => {
  for (const scenario of [
    {
      name: "decline",
      status: 200,
      value: { state: "declined" },
      decision: "declined",
      expectedError: false,
    },
    {
      name: "approval without a report capability",
      status: 200,
      value: { state: "approved" },
      decision: "approved",
      expectedError: true,
    },
    {
      name: "backend rejection",
      status: 403,
      value: { error: "consent_required" },
      decision: "approved",
      expectedError: true,
    },
  ]) {
    await testContext.test(scenario.name, async () => {
      let reportRequests = 0;
      const api = await listen(async (request, response) => {
        for await (const _chunk of request) {
          // Drain request bodies so the client can reuse the connection.
        }
        if (request.url === "/api/v2/reports") reportRequests += 1;
        response.writeHead(scenario.status, { "content-type": "application/json" });
        response.end(JSON.stringify(scenario.value));
      });
      const companion = startCompanion(api.endpoint);
      try {
        const handle = `afr2_${"d".repeat(80)}`;
        const response = await companion.request("tools/call", {
          name: "record_product_feedback_consent",
          arguments: { feedbackHandle: handle, decision: scenario.decision },
        });
        assert.equal(Boolean(response.result?.isError), scenario.expectedError);
        assert.equal(reportRequests, 0);
      } finally {
        companion.child.kill();
        await api.close();
      }
    });
  }
});

test("Epode Companion release metadata stays version-aligned", async () => {
  const [
    serverSource,
    codexManifestText,
    claudeManifestText,
    rootCodexMarketplaceText,
    rootClaudeMarketplaceText,
    companionCodexMarketplaceText,
    companionClaudeMarketplaceText,
  ] = await Promise.all([
    readFile(companionServer, "utf8"),
    readFile(codexManifestFile, "utf8"),
    readFile(claudeManifestFile, "utf8"),
    readFile(rootCodexMarketplaceFile, "utf8"),
    readFile(rootClaudeMarketplaceFile, "utf8"),
    readFile(companionCodexMarketplaceFile, "utf8"),
    readFile(companionClaudeMarketplaceFile, "utf8"),
  ]);
  const serverVersionMatch = /^const companionVersion = "([^"]+)";$/m.exec(serverSource);
  assert.ok(serverVersionMatch, "Companion server must declare companionVersion");
  const serverVersion = serverVersionMatch[1];
  const codexManifest = JSON.parse(codexManifestText);
  const claudeManifest = JSON.parse(claudeManifestText);

  assert.equal(claudeManifest.version, serverVersion);
  assert.equal(codexManifest.version.split("+", 1)[0], serverVersion);
  assert.match(codexManifest.version, /^\d+\.\d+\.\d+\+codex\.\d{14}$/);

  const expectedPluginDirectory = await realpath(companionPluginDirectory);
  const marketplaces = [
    {
      metadata: JSON.parse(rootCodexMarketplaceText),
      root: repoRoot,
      manifest: ".codex-plugin/plugin.json",
      expectedManifest: codexManifestFile,
    },
    {
      metadata: JSON.parse(rootClaudeMarketplaceText),
      root: repoRoot,
      manifest: ".claude-plugin/plugin.json",
      expectedManifest: claudeManifestFile,
    },
    {
      metadata: JSON.parse(companionCodexMarketplaceText),
      root: companionRoot,
      manifest: ".codex-plugin/plugin.json",
      expectedManifest: codexManifestFile,
    },
    {
      metadata: JSON.parse(companionClaudeMarketplaceText),
      root: companionRoot,
      manifest: ".claude-plugin/plugin.json",
      expectedManifest: claudeManifestFile,
    },
  ];

  for (const marketplace of marketplaces) {
    const entry = marketplace.metadata.plugins.find((plugin) => plugin.name === "epode-companion");
    assert.ok(entry, `${marketplace.metadata.name} marketplace must list Epode Companion`);
    const source = typeof entry.source === "string" ? entry.source : entry.source?.path;
    assert.equal(typeof source, "string");
    const sourceDirectory = await realpath(resolve(marketplace.root, source));
    assert.equal(sourceDirectory, expectedPluginDirectory);
    assert.equal(
      await realpath(resolve(sourceDirectory, marketplace.manifest)),
      await realpath(marketplace.expectedManifest),
    );
  }
});

test("Epode Companion manifests expose one implicit, bounded skill and its local tools", async () => {
  const [
    skill,
    openAiMetadata,
    codexManifestText,
    claudeManifestText,
    claudeMcpText,
    rootCodexMarketplaceText,
    rootClaudeMarketplaceText,
  ] = await Promise.all([
    readFile(skillFile, "utf8"),
    readFile(openAiMetadataFile, "utf8"),
    readFile(codexManifestFile, "utf8"),
    readFile(claudeManifestFile, "utf8"),
    readFile(claudeMcpFile, "utf8"),
    readFile(rootCodexMarketplaceFile, "utf8"),
    readFile(rootClaudeMarketplaceFile, "utf8"),
  ]);
  const allFiles = [
    skill,
    openAiMetadata,
    codexManifestText,
    claudeManifestText,
    claudeMcpText,
    rootCodexMarketplaceText,
    rootClaudeMarketplaceText,
  ];
  assert.ok(allFiles.every((file) => !file.includes("TODO")));
  assert.match(skill, /allow|permission/i);
  assert.match(skill, /Never POST to `submit\.url` yourself/);
  assert.match(skill, /does not turn an Ask-once or Ask-always product decision into approval/);
  assert.match(skill, /valid `never_ask` feedback/);
  assert.match(skill, /successful background report is routine bookkeeping/i);
  assert.match(skill, /do not mention it in the final answer/i);
  assert.match(skill, /final user answer is primary/i);
  assert.match(skill, /inspect_product_feedback/);
  assert.match(skill, /Treat its state as authoritative/);
  assert.match(skill, /Never re-ask from that response alone/);
  assert.match(skill, /do not inspect or record permission again for that handle/i);
  assert.match(skill, /fixed vocabulary/i);
  assert.match(openAiMetadata, /allow_implicit_invocation:\s*true/);

  const codexManifest = JSON.parse(codexManifestText);
  assert.equal(codexManifest.skills, "./skills/");
  assert.deepEqual(codexManifest.mcpServers["epode-companion"], {
    command: "node",
    args: ["./scripts/mcp-server.mjs"],
    cwd: ".",
  });

  const claudeManifest = JSON.parse(claudeManifestText);
  assert.deepEqual(claudeManifest.skills, ["./skills/epode-product-feedback"]);
  const claudeMcp = JSON.parse(claudeMcpText);
  assert.deepEqual(claudeMcp.mcpServers["epode-companion"], {
    command: "node",
    args: [`${"$"}{CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`],
  });

  const rootCodexMarketplace = JSON.parse(rootCodexMarketplaceText);
  const rootClaudeMarketplace = JSON.parse(rootClaudeMarketplaceText);
  assert.equal(rootCodexMarketplace.name, "epode");
  assert.equal(rootCodexMarketplace.plugins[0].source.path, "./companion/plugins/epode-companion");
  assert.equal(rootClaudeMarketplace.name, "epode");
  assert.equal(rootClaudeMarketplace.plugins[0].source, "./companion/plugins/epode-companion");
});
