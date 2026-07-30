import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";

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
  const api = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
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

    const listed = await companion.request("tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["record_product_feedback_consent", "submit_product_feedback"],
    );
    assert.ok(listed.result.tools.every((tool) => tool.inputSchema.additionalProperties === false));

    const consent = await companion.request("tools/call", {
      name: "record_product_feedback_consent",
      arguments: { feedbackHandle: handle, decision: "approved" },
    });
    assert.equal(consent.result.structuredContent.feedbackHandle, handle);

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
    assert.deepEqual(calls, [
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
  } finally {
    companion.child.kill();
    await api.close();
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
    assert.equal(requests, 0);
  } finally {
    companion.child.kill();
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
    assert.match(report.error.message, /fetch failed/i);
    assert.equal(redirectedRequests, 0);
  } finally {
    companion.child.kill();
    await redirector.close();
    await sink.close();
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

test("Epode Companion manifests expose one implicit, bounded skill and its local tools", async () => {
  const [skill, openAiMetadata, codexManifestText, claudeManifestText, claudeMcpText] =
    await Promise.all([
      readFile(skillFile, "utf8"),
      readFile(openAiMetadataFile, "utf8"),
      readFile(codexManifestFile, "utf8"),
      readFile(claudeManifestFile, "utf8"),
      readFile(claudeMcpFile, "utf8"),
    ]);
  const allFiles = [skill, openAiMetadata, codexManifestText, claudeManifestText, claudeMcpText];
  assert.ok(allFiles.every((file) => !file.includes("TODO")));
  assert.match(skill, /allow|permission/i);
  assert.match(skill, /Never POST to `submit\.url` yourself/);
  assert.match(skill, /Never treat installation of this companion as blanket feedback consent/);
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
});
