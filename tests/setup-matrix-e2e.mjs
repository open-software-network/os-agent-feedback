#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { submitMcpReportWithOneRetry } from "./setup-matrix-mcp-retry.mjs";
import { assertPortAvailable } from "./setup-matrix-process.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.SETUP_MATRIX_BACKEND_URL || "http://127.0.0.1:3180").replace(
  /\/$/,
  "",
);
const publicBaseUrl = (process.env.SETUP_MATRIX_PUBLIC_BASE_URL || backendUrl).replace(/\/$/, "");
const databaseEnvironment = process.env.SETUP_MATRIX_DB_ENVIRONMENT || "v2-canary";
const localBackend = backendUrl === "http://127.0.0.1:3180";
const scratch = await mkdtemp(join(tmpdir(), "epode-setup-matrix-"));
const children = new Set();
const expected = new Map();
const productAuthSecret = randomBytes(32).toString("base64url");
const selectedIntegrations = new Set(
  (process.env.SETUP_MATRIX_ONLY || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
let databaseUrl = "";
const python = process.env.PYTHON_BIN || runWhich("python3.11") || runWhich("python3");
const envelopeSchema = JSON.parse(
  await readFile(join(repo, "protocol", "v1", "envelope.schema.json"), "utf8"),
);
if (localBackend) {
  envelopeSchema.properties.submit.properties.url.pattern = "^https?://";
  envelopeSchema.properties.requiredAction.properties.submitDecision.properties.url.pattern =
    "^https?://";
}
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateEnvelopeSchema = ajv.compile(envelopeSchema);

function runWhich(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function selected(integration) {
  return selectedIntegrations.size === 0 || selectedIntegrations.has(integration);
}

function productAuthHeaders(customerRef = "setup-matrix-default") {
  const payload = Buffer.from(customerRef, "utf8").toString("base64url");
  const signature = createHmac("sha256", productAuthSecret).update(payload).digest("base64url");
  return { authorization: `Bearer ${payload}.${signature}` };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return (result.stdout || "").trim();
}

function start(command, args, { cwd, env = {}, label }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.label = label;
  child.log = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      child.log = `${child.log}${chunk}`.slice(-12_000);
    });
  }
  children.add(child);
  return child;
}

function childLogTail() {
  const logs = [...children]
    .map((child) => `--- ${child.label} ---\n${child.log || "(no output captured)"}`)
    .join("\n");
  return logs ? `\nProcess log tails:\n${logs}` : "\nNo child process logs were available.";
}

function responseDiagnostic(response, body, label) {
  let rendered;
  try {
    rendered = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    rendered = String(body);
  }
  return `${label} returned HTTP ${response.status}: ${rendered}${childLogTail()}`;
}

function assertResponseStatus(response, expected, body, label) {
  assert.equal(response.status, expected, responseDiagnostic(response, body, label));
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
    }
  }
  children.delete(child);
}

async function waitFor(url, child, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null)
      throw new Error(`${child.label} exited early\n${child.log}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}${child ? `\n${child.log}` : ""}`);
}

function database(action, feedbackMode) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return run("cargo", ["run", "--quiet", "--bin", "setup_matrix_db", "--", action], {
        cwd: join(repo, "backend"),
        env: {
          DATABASE_URL: databaseUrl,
          SETUP_MATRIX_WORKSPACE_ID: workspaceId,
          SETUP_MATRIX_PRODUCT_ID: productId,
          SETUP_MATRIX_ENVIRONMENT_ID: environmentId,
          SETUP_MATRIX_KEY_ID: keyId,
          SETUP_MATRIX_API_KEY: apiKey,
          ...(feedbackMode ? { SETUP_MATRIX_FEEDBACK_MODE: feedbackMode } : {}),
        },
        timeout: 30_000,
      });
    } catch (error) {
      lastError = error;
      if (!String(error).includes("pool timed out") || attempt === 4) throw error;
      spawnSync("sleep", [String(attempt + 1)]);
    }
  }
  throw lastError;
}

function envelopeFrom(response, body) {
  if (body && typeof body === "object" && !Array.isArray(body) && body._agentFeedback)
    return body._agentFeedback;
  if (typeof body === "string") {
    const match = /<script[^>]+id=["']agent-feedback["'][^>]*>([\s\S]*?)<\/script>/i.exec(body);
    if (match) return JSON.parse(match[1]);
  }
  const header = response.headers.get("agent-feedback");
  return header ? JSON.parse(Buffer.from(header, "base64url").toString("utf8")) : undefined;
}

function assertProtocolEnvelope(envelope) {
  const schemaEnvelope = localBackend
    ? JSON.parse(
        JSON.stringify(envelope, (_key, value) =>
          typeof value === "string" && value.startsWith(`${backendUrl}/`)
            ? `https://epode.test/${value.slice(backendUrl.length + 1)}`
            : value,
        ),
      )
    : envelope;
  assert.equal(
    validateEnvelopeSchema(schemaEnvelope),
    true,
    `invalid protocol envelope: ${JSON.stringify(validateEnvelopeSchema.errors)}`,
  );
  assert.equal(envelope.v, 1);
  assert.equal(envelope.requested, true);
  assert.equal(envelope.reliability, "best_effort_without_agent_adapter");
  assert.doesNotMatch(JSON.stringify(envelope), /af_live_/);
}

function assertFeedbackEnvelope(envelope, configuredMode, expectedBaseUrl = backendUrl) {
  assertProtocolEnvelope(envelope);
  assert.equal(envelope.mode, "never_ask");
  assert.equal(envelope.state, "feedback_ready");
  assert.equal(envelope.consentRequired, false);
  assert.equal(envelope.consentPolicy, "none");
  assert.equal(envelope.configuredMode, configuredMode);
  assert.match(envelope.instruction, /before your final response/i);
  assert.match(
    envelope.instruction,
    configuredMode ? /do not ask again/i : /do not ask the human/i,
  );
  assert.match(envelope.instruction, /topic:lowercase_slug/i);
  assert.match(envelope.instruction, /successful background report is routine bookkeeping/i);
  assert.match(envelope.instruction, /do not mention it in the final response/i);
  assert.equal(envelope.submit.url, `${expectedBaseUrl}/api/v2/reports`);
  assert.equal(envelope.submit.method, "POST");
  assert.match(envelope.submit.authorization, /^Bearer afr2_/);
  assert.deepEqual(envelope.submit.reportSchema.required, ["summary"]);
  assert.deepEqual(envelope.submit.reportSchema.findingRequired, ["kind", "topic", "detail"]);
  assert.deepEqual(envelope.submit.reportSchema.workaroundRequired, ["used"]);
  assert.equal(envelope.submit.reportSchema.maxFindings, 8);
}

function assertConsentEnvelope(envelope, mode) {
  assertProtocolEnvelope(envelope);
  assert.equal(envelope.mode, mode);
  assert.equal(envelope.configuredMode, mode);
  assert.equal(envelope.state, "consent_required");
  assert.equal(envelope.consentRequired, true);
  assert.equal(envelope.consentPolicy, mode === "ask_once" ? "once" : "always");
  assert.equal(envelope.consentManagedBy, "epode");
  assert.equal(envelope.submit, undefined);
  assert.equal(envelope.requiredAction.type, "ask_user");
  assert.match(envelope.requiredAction.question, /^May I send this product's provider/);
  if (mode === "ask_once") {
    assert.match(envelope.requiredAction.question, /future uses without asking again/);
    assert.match(envelope.requiredAction.question, /nothing is installed/);
  } else {
    assert.doesNotMatch(envelope.requiredAction.question, /future uses/);
  }
  assert.deepEqual(envelope.requiredAction.submitDecision.bodySchema, {
    decision: ["approved", "declined"],
  });
  assert.match(envelope.instruction, /^First complete the user's product task\./);
  assert.match(envelope.instruction, /after the product answer/);
  assert.match(envelope.instruction, /silence, uncertainty, or ambiguity, submit nothing/);
  assert.match(
    envelope.instruction,
    /Do not install software, write files, or save a local preference/,
  );
  assert.doesNotMatch(envelope.instruction, /reportSchema|summary:string/);
}

function assertDisabledEnvelope(envelope) {
  const schemaEnvelope = localBackend
    ? JSON.parse(
        JSON.stringify(envelope, (_key, value) =>
          typeof value === "string" && value.startsWith(`${backendUrl}/`)
            ? `https://epode.test/${value.slice(backendUrl.length + 1)}`
            : value,
        ),
      )
    : envelope;
  assert.equal(
    validateEnvelopeSchema(schemaEnvelope),
    true,
    `invalid disabled envelope: ${JSON.stringify(validateEnvelopeSchema.errors)}`,
  );
  assert.equal(envelope.v, 1);
  assert.equal(envelope.requested, false);
  assert.equal(envelope.state, "feedback_disabled");
  assert.equal(envelope.mode, "ask_once");
  assert.equal(envelope.configuredMode, "ask_once");
  assert.equal(envelope.consentRequired, false);
  assert.equal(envelope.consentPolicy, "once");
  assert.equal(envelope.consentManagedBy, "epode");
  assert.equal(envelope.requiredAction, undefined);
  assert.equal(envelope.submit, undefined);
  assert.equal(envelope.manageConsent.current, "declined");
  assert.match(envelope.instruction, /Do not ask or submit feedback/);
}

async function decide(envelope, decision) {
  const action = envelope.requiredAction.submitDecision;
  const response = await fetch(action.url, {
    method: action.method,
    headers: {
      authorization: action.authorization,
      "content-type": action.contentType,
    },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json();
  assertResponseStatus(response, 200, body, "consent decision");
  assert.equal(body.state, decision);
  if (decision === "approved") {
    assert.ok(body.feedback);
    assertFeedbackEnvelope(body.feedback, envelope.configuredMode, publicBaseUrl);
  } else {
    assert.equal(body.feedback, null);
  }
  return body;
}

async function inspectConsentEnvelope(envelope) {
  const authorization = envelope?.requiredAction?.submitDecision?.authorization;
  assert.match(authorization || "", /^Bearer afr2_/);
  return inspectFeedbackHandle(authorization.replace(/^Bearer\s+/i, ""));
}

async function inspectFeedbackHandle(feedbackHandle) {
  assert.match(feedbackHandle || "", /^afr2_/);
  const authorization = `Bearer ${feedbackHandle}`;
  const response = await fetch(`${backendUrl}/api/v2/capabilities/introspect`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "{}",
  });
  const body = await response.json();
  assertResponseStatus(response, 200, body, "capability inspection");
  return { authorization, body };
}

async function submitAction(action, summary) {
  const report = {
    summary,
    impact: "helped_with_friction",
    confidence: 0.91,
    findings: [
      {
        kind: "strength",
        topic: "integration",
        detail: "The configured product surface returned the expected result.",
      },
      {
        kind: "friction",
        topic: "verification",
        severity: "minor",
        detail: "The agent performed one additional verification step.",
      },
    ],
    workaround: {
      used: true,
      detail: "The agent verified the result through the setup harness.",
    },
  };
  const response = await fetch(action.url, {
    method: "POST",
    headers: {
      authorization: action.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(report),
  });
  const body = await response.json();
  assertResponseStatus(response, 200, body, "feedback submission");
  assert.equal(body.accepted, true);
  assert.equal(body.report.summary, summary);
  assert.equal(body.report.impact, "helped_with_friction");
  assert.equal(body.report.findings.length, 2);
  const duplicate = await fetch(action.url, {
    method: "POST",
    headers: {
      authorization: action.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      summary: "This duplicate report must not replace the first report.",
    }),
  });
  const duplicateBody = await duplicate.json();
  assertResponseStatus(duplicate, 200, duplicateBody, "duplicate feedback replay");
  assert.equal(duplicateBody.report.id, body.report.id);
  assert.equal(duplicateBody.report.summary, summary);
  return body;
}

async function submit(envelope, summary) {
  return submitAction(envelope.submit, summary);
}

async function testHttp(base, stack) {
  for (const [surfaceName, path, surface] of [
    ["api", "/search", "http_json"],
    ["website", "/docs/test", "http_html"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      headers: productAuthHeaders(`${stack}-${surfaceName}-never-ask`),
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    assertResponseStatus(response, 200, body, `${stack}/${surfaceName} product response`);
    const envelope = envelopeFrom(response, body);
    assert.ok(envelope, `${stack}/${surfaceName} did not expose feedback metadata`);
    assertFeedbackEnvelope(envelope);
    const summary = `Epode ${stack} ${surfaceName} setup returned the expected result.`;
    const report = await submit(envelope, summary);
    expected.set(summary, {
      surface,
      operation: path,
      confirmationMethod: "feedback_report",
      interactionId: report.interactionId,
    });
    console.log(`PASS ${stack}/${surfaceName}: response contract, autonomous report, idempotency`);
  }
}

async function testHttpOff(base, stack) {
  for (const [surfaceName, path] of [
    ["api", "/search"],
    ["website", "/docs/test"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      headers: productAuthHeaders(`${stack}-${surfaceName}-off`),
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    assertResponseStatus(response, 200, body, `${stack}/${surfaceName}/off product response`);
    assert.equal(envelopeFrom(response, body), undefined);
    assert.equal(response.headers.get("agent-feedback"), null);
    assert.doesNotMatch(response.headers.get("link") || "", /agent-feedback/i);
    if (surfaceName === "website") {
      assert.doesNotMatch(body, /id=["']agent-feedback["']/i);
      assert.doesNotMatch(body, /rel=["']agent-feedback["']/i);
    }
    console.log(`PASS ${stack}/${surfaceName}/off: product response untouched, no instructions`);
  }
}

async function assertHttpAuthBoundary(base, stack) {
  for (const headers of [
    {},
    {
      authorization: "Bearer forged.invalid",
      "x-customer-ref": "spoofed-tenant",
    },
  ]) {
    const response = await fetch(`${base}/search`, { headers });
    const body = await response.json();
    assertResponseStatus(response, 401, body, `${stack} product authentication`);
    assert.equal(envelopeFrom(response, body), undefined);
  }
}

async function readHttpSurface(base, path, customerRef) {
  const response = await fetch(`${base}${path}`, {
    headers: productAuthHeaders(customerRef || "setup-matrix-default"),
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  assertResponseStatus(response, 200, body, `HTTP product response ${path}`);
  return { body, envelope: envelopeFrom(response, body) };
}

async function testHttpConsent(base, stack, mode) {
  for (const [surfaceName, path, surface] of [
    ["api", "/search", "http_json"],
    ["website", "/docs/test", "http_html"],
  ]) {
    const approvedRef = `${stack}-${surfaceName}-${mode}-approved`;
    let result = await readHttpSurface(base, path, approvedRef);
    assert.ok(result.envelope, `${stack}/${surfaceName}/${mode} omitted its permission action`);
    assertConsentEnvelope(result.envelope, mode);

    // Silence is never interpreted as a decision.
    result = await readHttpSurface(base, path, approvedRef);
    assertConsentEnvelope(result.envelope, mode);

    const approval = await decide(result.envelope, "approved");
    const approvedSummary = `Epode ${stack} ${surfaceName} ${mode} approval returned a valid report action.`;
    let report = await submit(approval.feedback, approvedSummary);
    expected.set(approvedSummary, {
      surface,
      operation: path,
      confirmationMethod: "feedback_report",
      interactionId: report.interactionId,
    });

    result = await readHttpSurface(base, path, approvedRef);
    if (mode === "ask_once") {
      const rememberedSummary = `Epode ${stack} ${surfaceName} remembered Ask once approval without asking again.`;
      if (result.envelope?.state === "feedback_ready") {
        assertFeedbackEnvelope(result.envelope, "ask_once");
        report = await submit(result.envelope, rememberedSummary);
      } else {
        assertConsentEnvelope(result.envelope, "ask_once");
        const inspection = await inspectConsentEnvelope(result.envelope);
        assert.equal(inspection.body.state, "feedback_ready");
        assert.equal(inspection.body.configuredMode, "ask_once");
        assert.equal(inspection.body.consentPolicy, "none");
        report = await submitAction(
          {
            url: `${backendUrl}/api/v2/reports`,
            authorization: inspection.authorization,
          },
          rememberedSummary,
        );
      }
      expected.set(rememberedSummary, {
        surface,
        operation: path,
        confirmationMethod: "feedback_report",
        interactionId: report.interactionId,
      });
    } else {
      assertConsentEnvelope(result.envelope, "ask_always");
    }

    const declinedRef = `${stack}-${surfaceName}-${mode}-declined`;
    const declined = await readHttpSurface(base, path, declinedRef);
    assertConsentEnvelope(declined.envelope, mode);
    await decide(declined.envelope, "declined");
    const afterDecline = await readHttpSurface(base, path, declinedRef);
    if (mode === "ask_once") {
      if (afterDecline.envelope?.state === "feedback_disabled") {
        assertDisabledEnvelope(afterDecline.envelope);
      } else if (afterDecline.envelope !== undefined) {
        assertConsentEnvelope(afterDecline.envelope, "ask_once");
        const inspection = await inspectConsentEnvelope(afterDecline.envelope);
        assert.equal(
          inspection.body.state,
          "declined",
          `${stack}/${surfaceName} did not preserve the durable refusal`,
        );
        assert.equal(inspection.body.consentPolicy, "once");
      }
    } else {
      assertConsentEnvelope(afterDecline.envelope, "ask_always");
    }

    console.log(
      `PASS ${stack}/${surfaceName}/${mode}: answer first, silence safe, approval report${mode === "ask_once" ? ", remembered decision" : ", fresh next question"}, refusal safe`,
    );
  }
}

const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_CLIENT_INFO = { name: "epode-setup-matrix-agent", version: "2.0.0" };

function modernMcpRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

async function readMcpPayload(response) {
  const text = await response.text();
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    assert.ok(data, `MCP SSE response had no data event: ${text}`);
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function mcpPost(url, body, { expectedStatus = 200, headerOverrides = {} } = {}) {
  const name = ["tools/call", "resources/read", "prompts/get"].includes(body.method)
    ? body.params?.name || body.params?.uri
    : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": body.method,
      ...productAuthHeaders("setup-matrix-mcp-default"),
      ...(name ? { "mcp-name": name } : {}),
      ...headerOverrides,
    },
    body: JSON.stringify(body),
  });
  const payload = await readMcpPayload(response);
  assertResponseStatus(response, expectedStatus, payload, `MCP ${body.method}`);
  assert.equal(
    response.headers.get("mcp-session-id"),
    null,
    "modern MCP must not mint transport sessions",
  );
  return payload;
}

async function testMcp(url, stack) {
  const unauthorized = await mcpPost(url, modernMcpRequest(0, "server/discover"), {
    expectedStatus: 401,
    headerOverrides: {
      authorization: "Bearer forged.invalid",
      "x-customer-ref": "spoofed-tenant",
    },
  });
  assert.equal(unauthorized.error.code, -32001);

  let payload = await mcpPost(url, modernMcpRequest(1, "server/discover"));
  assert.equal(payload.result.resultType, "complete");
  assert.ok(payload.result.supportedVersions.includes(MCP_PROTOCOL_VERSION));
  assert.equal(
    payload.result._meta["io.modelcontextprotocol/serverInfo"].name,
    stack === "node-mcp" ? "setup-matrix-node-mcp" : "setup-matrix-manual-mcp",
  );
  assert.ok(["public", "private"].includes(payload.result.cacheScope));
  assert.ok(Number.isSafeInteger(payload.result.ttlMs));

  const rejectedOrigin = await mcpPost(url, modernMcpRequest(100, "server/discover"), {
    expectedStatus: 403,
    headerOverrides: { origin: "https://untrusted-agent.example" },
  });
  assert.ok(rejectedOrigin.error, JSON.stringify(rejectedOrigin));

  const unsupportedRequest = modernMcpRequest(101, "server/discover");
  unsupportedRequest.params._meta["io.modelcontextprotocol/protocolVersion"] = "1900-01-01";
  const unsupported = await mcpPost(url, unsupportedRequest, {
    expectedStatus: 400,
    headerOverrides: { "mcp-protocol-version": "1900-01-01" },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.ok(unsupported.error.data.supported.includes(MCP_PROTOCOL_VERSION));

  payload = await mcpPost(url, modernMcpRequest(2, "tools/list"));
  assert.equal(payload.result.resultType, "complete");
  assert.equal(payload.result.cacheScope, "private");
  assert.ok(Number.isSafeInteger(payload.result.ttlMs));
  const names = payload.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("search"));
  assert.ok(names.includes("report_product_feedback"));

  const mismatch = await mcpPost(
    url,
    modernMcpRequest(3, "tools/call", {
      name: "search",
      arguments: { query: "setup" },
    }),
    { expectedStatus: 400, headerOverrides: { "mcp-name": "wrong-tool" } },
  );
  assert.equal(mismatch.error.code, -32020);

  payload = await mcpPost(
    url,
    modernMcpRequest(4, "tools/call", {
      name: "search",
      arguments: { query: "setup" },
    }),
  );
  assert.equal(payload.result.resultType, "complete");
  const feedback = payload.result.structuredContent._agentFeedback;
  assert.equal(feedback.reliability, "protocol_tool");
  assert.equal(feedback.reportTool, "report_product_feedback");
  assert.match(feedback.feedbackHandle, /^afr2_/);
  assert.match(feedback.instruction, /autonomously/i);
  const summary = `Epode ${stack} MCP setup returned the expected result.`;
  const reportArguments = {
    feedbackHandle: feedback.feedbackHandle,
    summary,
    impact: "helped_with_friction",
    confidence: 0.91,
    findings: [
      {
        kind: "strength",
        topic: "integration",
        detail: "The MCP tool returned the expected result.",
      },
      {
        kind: "friction",
        topic: "verification",
        severity: "minor",
        detail: "The agent performed one additional verification step.",
      },
    ],
    workaround: {
      used: true,
      detail: "The agent verified the result through the setup harness.",
    },
  };
  ({ payload } = await submitMcpReportWithOneRetry({
    id: 5,
    reportArguments,
    call: ({ requestId, reportArguments: retryArguments }) =>
      mcpPost(
        url,
        modernMcpRequest(requestId, "tools/call", {
          name: "report_product_feedback",
          arguments: retryArguments,
        }),
      ),
  }));
  assert.equal(payload.result.resultType, "complete");
  assert.equal(payload.result.structuredContent.accepted, true, JSON.stringify(payload.result));
  assert.equal(payload.result.structuredContent.report.summary, summary);
  expected.set(summary, {
    surface: "mcp",
    operation: "search",
    confirmationMethod: "mcp",
    interactionId: payload.result.structuredContent.interactionId,
  });

  const legacyResponse = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...productAuthHeaders("setup-matrix-mcp-default"),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 102,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "epode-legacy-probe", version: "1.0.0" },
      },
    }),
  });
  const legacy = await readMcpPayload(legacyResponse);
  assertResponseStatus(legacyResponse, 200, legacy, "legacy MCP initialize");
  assert.equal(legacy.result.protocolVersion, "2025-11-25");
  assert.equal(legacyResponse.headers.get("mcp-session-id"), null);
  console.log(
    `PASS ${stack}/mcp: 2026 discovery, stateless headers, cache hints, confirmed interaction, autonomous review`,
  );
}

async function testMcpOff(url, stack) {
  let payload = await mcpPost(url, modernMcpRequest(300, "tools/list"));
  const names = payload.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("search"));
  assert.ok(!names.includes("report_product_feedback"));
  assert.ok(!names.includes("record_product_feedback_consent"));

  payload = await mcpPost(
    url,
    modernMcpRequest(301, "tools/call", {
      name: "search",
      arguments: { query: "setup" },
    }),
    { headerOverrides: productAuthHeaders(`${stack}-mcp-off`) },
  );
  assert.equal(payload.result.resultType, "complete");
  assert.equal(payload.result.structuredContent?._agentFeedback, undefined);
  assert.doesNotMatch(JSON.stringify(payload.result), /feedbackHandle|report_product_feedback/);
  console.log(`PASS ${stack}/mcp/off: no feedback tools, metadata, or instructions`);
}

async function submitMcpReport(url, feedbackHandle, summary, id, headerOverrides = {}) {
  const reportArguments = {
    feedbackHandle,
    summary,
    impact: "helped_with_friction",
    confidence: 0.91,
    findings: [
      {
        kind: "strength",
        topic: "integration",
        detail: "The MCP tool returned the expected result.",
      },
      {
        kind: "friction",
        topic: "verification",
        severity: "minor",
        detail: "The agent performed one additional verification step.",
      },
    ],
    workaround: {
      used: true,
      detail: "The agent verified the result through the setup harness.",
    },
  };
  const { payload, attempts } = await submitMcpReportWithOneRetry({
    id,
    reportArguments,
    call: ({ requestId, reportArguments: retryArguments }) =>
      mcpPost(
        url,
        modernMcpRequest(requestId, "tools/call", {
          name: "report_product_feedback",
          arguments: retryArguments,
        }),
        { headerOverrides },
      ),
  });
  assert.equal(payload.result.resultType, "complete");
  assert.equal(
    payload.result.structuredContent.accepted,
    true,
    `MCP report was not accepted after ${attempts.length} attempt(s): ${JSON.stringify(
      attempts.map((attempt) => attempt.result),
    )}`,
  );
  assert.equal(payload.result.structuredContent.report.summary, summary);
  return payload.result.structuredContent;
}

function assertMcpConsent(feedback, mode) {
  assert.equal(feedback.mode, mode);
  assert.equal(feedback.configuredMode, mode);
  assert.equal(feedback.state, "consent_required");
  assert.equal(feedback.required, false);
  assert.equal(feedback.consentRequired, true);
  assert.equal(feedback.consentPolicy, mode === "ask_once" ? "once" : "always");
  assert.equal(feedback.consentManagedBy, "epode");
  assert.equal(feedback.reportTool, undefined);
  assert.equal(feedback.consentTool, "record_product_feedback_consent");
  assert.match(feedback.feedbackHandle, /^afr2_/);
  assert.match(feedback.question, /^May I send this product's provider/);
  if (mode === "ask_once") {
    assert.match(feedback.question, /future uses without asking again/);
    assert.match(feedback.question, /nothing is installed/);
  } else {
    assert.doesNotMatch(feedback.question, /future uses/);
  }
  assert.match(feedback.instruction, /^First complete the user's product task\./);
  assert.match(feedback.instruction, /after the product answer/);
  assert.match(feedback.instruction, /silence, uncertainty, or ambiguity, submit nothing/);
  assert.doesNotMatch(feedback.instruction, /reportSchema|summary:string/);
}

function assertMcpFeedbackReady(feedback, configuredMode) {
  assert.equal(feedback.mode, "never_ask");
  assert.equal(feedback.configuredMode, configuredMode);
  assert.equal(feedback.state, "feedback_ready");
  assert.equal(feedback.required, true);
  assert.equal(feedback.consentRequired, false);
  assert.equal(feedback.reportTool, "report_product_feedback");
  assert.equal(feedback.consentTool, undefined);
  assert.match(feedback.feedbackHandle, /^afr2_/);
  assert.match(feedback.instruction, /do not ask again/i);
}

function assertMcpFeedbackDisabled(feedback) {
  assert.equal(feedback.mode, "ask_once");
  assert.equal(feedback.configuredMode, "ask_once");
  assert.equal(feedback.state, "feedback_disabled");
  assert.equal(feedback.required, false);
  assert.equal(feedback.consentRequired, false);
  assert.equal(feedback.consentPolicy, "once");
  assert.equal(feedback.consentManagedBy, "epode");
  assert.equal(feedback.reportTool, undefined);
  assert.equal(feedback.consentTool, undefined);
  assert.equal(feedback.question, undefined);
  assert.match(feedback.instruction, /Do not ask or submit feedback/);
}

async function callMcpSearch(url, id, customerRef) {
  const payload = await mcpPost(
    url,
    modernMcpRequest(id, "tools/call", {
      name: "search",
      arguments: { query: "setup" },
    }),
    { headerOverrides: productAuthHeaders(customerRef) },
  );
  return payload.result.structuredContent._agentFeedback;
}

async function testMcpConsent(url, stack, mode) {
  const approvedRef = `${stack}-${mode}-approved`;
  const headers = productAuthHeaders(approvedRef);
  let feedback = await callMcpSearch(url, 200, approvedRef);
  assertMcpConsent(feedback, mode);

  // A second product call without a recorded answer must still ask.
  feedback = await callMcpSearch(url, 201, approvedRef);
  assertMcpConsent(feedback, mode);

  let payload = await mcpPost(
    url,
    modernMcpRequest(202, "tools/call", {
      name: "record_product_feedback_consent",
      arguments: {
        feedbackHandle: feedback.feedbackHandle,
        decision: "approved",
      },
    }),
    { headerOverrides: headers },
  );
  assert.equal(payload.result.structuredContent.state, "approved");
  assert.equal(payload.result.structuredContent.reportTool, "report_product_feedback");
  assert.match(payload.result.structuredContent.feedbackHandle, /^afr2_/);
  const approvedSummary = `Epode ${stack} MCP ${mode} approval returned a valid report action.`;
  let report = await submitMcpReport(
    url,
    payload.result.structuredContent.feedbackHandle,
    approvedSummary,
    203,
    headers,
  );
  expected.set(approvedSummary, {
    surface: "mcp",
    operation: "search",
    confirmationMethod: "mcp",
    interactionId: report.interactionId,
  });

  feedback = await callMcpSearch(url, 205, approvedRef);
  if (mode === "ask_once") {
    const rememberedSummary = `Epode ${stack} MCP remembered Ask once approval without asking again.`;
    if (feedback?.state === "feedback_ready") {
      assertMcpFeedbackReady(feedback, "ask_once");
    } else {
      assertMcpConsent(feedback, "ask_once");
      const inspection = await inspectFeedbackHandle(feedback.feedbackHandle);
      assert.equal(inspection.body.state, "feedback_ready");
      assert.equal(inspection.body.configuredMode, "ask_once");
    }
    report = await submitMcpReport(url, feedback.feedbackHandle, rememberedSummary, 206, headers);
    expected.set(rememberedSummary, {
      surface: "mcp",
      operation: "search",
      confirmationMethod: "mcp",
      interactionId: report.interactionId,
    });
  } else {
    assertMcpConsent(feedback, "ask_always");
  }

  const declinedRef = `${stack}-${mode}-declined`;
  const declinedHeaders = productAuthHeaders(declinedRef);
  feedback = await callMcpSearch(url, 208, declinedRef);
  assertMcpConsent(feedback, mode);
  payload = await mcpPost(
    url,
    modernMcpRequest(209, "tools/call", {
      name: "record_product_feedback_consent",
      arguments: {
        feedbackHandle: feedback.feedbackHandle,
        decision: "declined",
      },
    }),
    { headerOverrides: declinedHeaders },
  );
  assert.equal(payload.result.structuredContent.state, "declined");
  assert.equal(payload.result.structuredContent.reportTool, undefined);
  feedback = await callMcpSearch(url, 210, declinedRef);
  if (mode === "ask_once") {
    if (feedback?.state === "feedback_disabled") {
      assertMcpFeedbackDisabled(feedback);
    } else if (feedback !== undefined) {
      assertMcpConsent(feedback, "ask_once");
      const inspection = await inspectFeedbackHandle(feedback.feedbackHandle);
      assert.equal(
        inspection.body.state,
        "declined",
        `${stack}/mcp did not preserve the durable refusal`,
      );
    }
  } else {
    assertMcpConsent(feedback, "ask_always");
  }

  console.log(
    `PASS ${stack}/mcp/${mode}: answer first, silence safe, approval report${mode === "ask_once" ? ", remembered decision" : ", fresh next question"}, refusal safe`,
  );
}

function readObservations() {
  const raw = database("read-observations")
    .split("\n")
    .findLast((line) => line.trim().startsWith("["));
  return JSON.parse(raw || "[]");
}

async function stableObservationCount() {
  let previous = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const count = readObservations().length;
    if (count === previous) return count;
    previous = count;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Setup observation count did not settle before the Off-mode assertion");
}

async function assertOffCreatedNoObservation(before, label) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  const after = await stableObservationCount();
  assert.equal(after, before, `${label}/off created ${after - before} unexpected interaction(s)`);
}

async function prepareNode(fixtureName) {
  const target = join(scratch, fixtureName);
  await cp(join(repo, "examples", fixtureName), target, { recursive: true });
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@agent-feedback/node"] =
    `${backendUrl}/static/agent-feedback-node-0.2.2.tgz`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run("npm", ["install", "--ignore-scripts"], { cwd: target });
  return target;
}

async function preparePython(fixtureName) {
  const target = join(scratch, fixtureName);
  await cp(join(repo, "examples", fixtureName), target, { recursive: true });
  const requirements = join(target, "requirements.txt");
  await writeFile(
    requirements,
    (await readFile(requirements, "utf8")).replaceAll("https://app.epode.ai", backendUrl),
  );
  run(python, ["-m", "venv", ".venv"], { cwd: target });
  run(
    join(target, ".venv", "bin", "python"),
    ["-m", "pip", "install", "-q", "-r", "requirements.txt"],
    { cwd: target },
  );
  return target;
}

async function prepareGo() {
  const target = join(scratch, "setup-matrix-go");
  await cp(join(repo, "examples", "setup-matrix-go"), target, {
    recursive: true,
  });
  await rm(join(target, "go.mod"));
  run("go", ["mod", "init", "setup-matrix-go"], { cwd: target });
  run(
    "go",
    [
      "mod",
      "edit",
      "-replace",
      `github.com/open-software-network/os-epode/sdk/go=${join(repo, "sdk", "go")}`,
    ],
    { cwd: target },
  );
  run("go", ["mod", "edit", "-require=github.com/open-software-network/os-epode/sdk/go@v0.2.2"], {
    cwd: target,
  });
  run("go", ["mod", "tidy"], { cwd: target });
  run("go", ["build", "-o", "setup-matrix-go", "."], { cwd: target });
  return target;
}

async function prepareRust() {
  const target = join(scratch, "setup-matrix-rust");
  await cp(join(repo, "examples", "setup-matrix-rust"), target, {
    recursive: true,
  });
  run("bash", ["prepare.sh"], {
    cwd: target,
    env: { EP0DE_ORIGIN: backendUrl },
  });
  run("cargo", ["build", "--quiet"], { cwd: target });
  return target;
}

async function prepareManual(fixtureName) {
  const target = join(scratch, fixtureName);
  await cp(join(repo, "examples", fixtureName), target, { recursive: true });
  run(
    "curl",
    ["-fsS", "-o", "protocol.zip", `${backendUrl}/static/agent-feedback-protocol-v1-0.2.2.zip`],
    { cwd: target },
  );
  run("unzip", ["-q", "protocol.zip"], { cwd: target });
  assert.ok(
    (await readFile(join(target, "protocol", "v1", "README.md"), "utf8")).includes(
      "Agent Feedback Protocol v1",
    ),
  );
  return target;
}

async function runHttpApp(label, command, args, cwd, port, mode = "never_ask") {
  database("set-mode", mode);
  const observationsBefore = mode === "off" ? await stableObservationCount() : undefined;
  await assertPortAvailable(port, `${label}/${mode}`);
  const child = start(command, args, {
    cwd,
    label: `${label}/${mode}`,
    env: {
      PORT: String(port),
      AGENT_FEEDBACK_KEY: apiKey,
      AGENT_FEEDBACK_URL: backendUrl,
      AGENT_FEEDBACK_MODE: mode,
      SETUP_MATRIX_PRODUCT_AUTH_SECRET: productAuthSecret,
      ...(localBackend ? { AGENT_FEEDBACK_CONSENT_TIMEOUT_MS: "5000" } : {}),
    },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  try {
    await assertHttpAuthBoundary(`http://127.0.0.1:${port}`, label);
    if (mode === "off") await testHttpOff(`http://127.0.0.1:${port}`, label);
    else if (mode === "never_ask") await testHttp(`http://127.0.0.1:${port}`, label);
    else await testHttpConsent(`http://127.0.0.1:${port}`, label, mode);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : error}${childLogTail()}`);
  }
  await waitForPersistedExpected();
  if (observationsBefore !== undefined)
    await assertOffCreatedNoObservation(observationsBefore, label);
  await stop(child);
}

async function runMcpApp(label, command, args, cwd, port, mode = "never_ask") {
  database("set-mode", mode);
  const observationsBefore = mode === "off" ? await stableObservationCount() : undefined;
  await assertPortAvailable(port, `${label}/${mode}`);
  const child = start(command, args, {
    cwd,
    label: `${label}/${mode}`,
    env: {
      PORT: String(port),
      AGENT_FEEDBACK_KEY: apiKey,
      AGENT_FEEDBACK_URL: backendUrl,
      AGENT_FEEDBACK_MODE: mode,
      SETUP_MATRIX_PRODUCT_AUTH_SECRET: productAuthSecret,
      ...(localBackend ? { AGENT_FEEDBACK_CONSENT_TIMEOUT_MS: "5000" } : {}),
    },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  try {
    if (mode === "off") await testMcpOff(`http://127.0.0.1:${port}/mcp`, label);
    else if (mode === "never_ask") await testMcp(`http://127.0.0.1:${port}/mcp`, label);
    else await testMcpConsent(`http://127.0.0.1:${port}/mcp`, label, mode);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : error}${childLogTail()}`);
  }
  await waitForPersistedExpected();
  if (observationsBefore !== undefined)
    await assertOffCreatedNoObservation(observationsBefore, label);
  await stop(child);
}

async function runAllHttpModes(label, command, args, cwd, port) {
  for (const mode of ["never_ask", "ask_once", "ask_always", "off"])
    await runHttpApp(label, command, args, cwd, port, mode);
}

async function runAllMcpModes(label, command, args, cwd, port) {
  for (const mode of ["never_ask", "ask_once", "ask_always", "off"])
    await runMcpApp(label, command, args, cwd, port, mode);
}

async function waitForPersistedExpected() {
  let lastRows = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = database("read")
      .split("\n")
      .findLast((line) => line.trim().startsWith("["));
    const rows = JSON.parse(raw || "[]");
    lastRows = rows;
    if (
      rows.length === expected.size &&
      rows.every((row) => row.surface !== "unknown" && row.operation !== "pending")
    )
      return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  const unresolved = lastRows.filter(
    (row) => row.surface === "unknown" || row.operation === "pending",
  );
  throw new Error(
    `Timed out waiting for ${expected.size} fully reconciled Setup interactions: ${JSON.stringify(unresolved)}`,
  );
}

const workspaceId = randomUUID();
const productId = randomUUID();
const environmentId = randomUUID();
const keyId = randomUUID();
const apiKey = `af_live_${keyId.replaceAll("-", "")}_${randomBytes(30).toString("base64url")}`;

try {
  if (process.env.SETUP_MATRIX_SKIP_BUILD !== "true") {
    run("bash", ["tests/build-hosted-artifacts.sh"]);
  }
  if (process.env.SETUP_MATRIX_DATABASE_URL) {
    databaseUrl = process.env.SETUP_MATRIX_DATABASE_URL;
  } else {
    const railwayVariables = JSON.parse(
      run("railway", [
        "variables",
        "--service",
        "Postgres",
        "--environment",
        databaseEnvironment,
        "--json",
      ]),
    );
    databaseUrl = railwayVariables.DATABASE_PUBLIC_URL;
  }
  if (!databaseUrl)
    throw new Error(`Postgres in ${databaseEnvironment} has no DATABASE_PUBLIC_URL`);
  if (localBackend) {
    await assertPortAvailable(3180, "Epode Rust backend");
    const backend = start("cargo", ["run", "--quiet", "--bin", "agent-feedback"], {
      cwd: join(repo, "backend"),
      label: "Epode Rust backend",
      env: {
        DATABASE_URL: databaseUrl,
        PUBLIC_BASE_URL: backendUrl,
        OS_ACCOUNTS_URL: "https://accounts.example.test",
        OS_ACCOUNTS_API_URL: "https://accounts-api.example.test",
        OS_ACCOUNTS_CLIENT_ID: "ocl_setup_matrix",
        DATABASE_MAX_CONNECTIONS: "2",
        PORT: "3180",
      },
    });
    await waitFor(`${backendUrl}/api/health`, backend, 240_000);
  } else {
    await waitFor(`${backendUrl}/api/health`, undefined, 60_000);
  }
  database("seed");

  if (selected("node-express")) {
    const fixture = await prepareNode("setup-matrix-node-express");
    await runAllHttpModes("node-express", "node", ["index.js"], fixture, 4101);
  }
  if (selected("node-fastify")) {
    const fixture = await prepareNode("setup-matrix-node-fastify");
    await runAllHttpModes("node-fastify", "node", ["index.js"], fixture, 4102);
  }
  if (selected("python-asgi")) {
    const fixture = await preparePython("setup-matrix-python-asgi");
    await runAllHttpModes(
      "python-asgi",
      join(fixture, ".venv", "bin", "python"),
      ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "4103"],
      fixture,
      4103,
    );
  }
  if (selected("python-wsgi")) {
    const fixture = await preparePython("setup-matrix-python-wsgi");
    await runAllHttpModes(
      "python-wsgi",
      join(fixture, ".venv", "bin", "python"),
      ["app.py"],
      fixture,
      4104,
    );
  }
  if (selected("go")) {
    const fixture = await prepareGo();
    await runAllHttpModes("go", join(fixture, "setup-matrix-go"), [], fixture, 4105);
  }
  if (selected("rust")) {
    const fixture = await prepareRust();
    await runAllHttpModes(
      "rust",
      join(fixture, "target", "debug", "setup-matrix-rust"),
      [],
      fixture,
      4106,
    );
  }
  let manualHttp;
  if (selected("manual-http") || selected("manual-mcp")) {
    manualHttp = await prepareManual("setup-matrix-manual-http");
  }
  if (selected("manual-http")) {
    await runAllHttpModes("manual-http", python, ["server.py"], manualHttp, 4108);
  }
  if (selected("node-mcp")) {
    const fixture = await prepareNode("setup-matrix-node-mcp");
    await runAllMcpModes("node-mcp", "node", ["index.js"], fixture, 4107);
  }
  if (selected("manual-mcp")) {
    const fixture = await prepareManual("setup-matrix-manual-mcp");
    await runAllMcpModes("manual-mcp", python, ["server.py"], fixture, 4109);
  }

  let rows = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const raw = database("read")
      .split("\n")
      .findLast((line) => line.trim().startsWith("["));
    rows = JSON.parse(raw || "[]");
    if (
      rows.length === expected.size &&
      rows.every((row) => row.surface !== "unknown" && row.operation !== "pending")
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (selectedIntegrations.size === 0) assert.equal(expected.size, 64);
  else assert.ok(expected.size > 0, "the selected setup matrix produced no reports");
  assert.equal(rows.length, expected.size, JSON.stringify(rows, null, 2));
  for (const row of rows) {
    const contract = expected.get(row.summary);
    assert.ok(contract, `Unexpected stored report: ${row.summary}`);
    assert.equal(row.id, contract.interactionId);
    assert.equal(
      row.surface,
      contract.surface,
      `surface mismatch for ${row.summary}: ${JSON.stringify(row)}`,
    );
    assert.equal(
      row.operation,
      contract.operation,
      `operation mismatch for ${row.summary}: ${JSON.stringify(row)}`,
    );
    assert.equal(row.classification, "confirmed");
    assert.equal(row.confirmationMethod, contract.confirmationMethod);
    assert.equal(row.impact, "helped_with_friction");
    assert.equal(row.findings.length, 2);
    assert.equal(row.workaround.used, true);
  }
  console.log(
    `PASS persistence: all ${expected.size} Setup and consent permutations stored the exact structured report on the correct confirmed interaction`,
  );
  console.log(
    `PASS setup matrix E2E: ${
      selectedIntegrations.size === 0
        ? "7 API + 7 website + 2 MCP integrations"
        : [...selectedIntegrations].sort().join(", ")
    } across Never ask, Ask once, Ask always, and Off`,
  );
} finally {
  for (const child of children) await stop(child);
  try {
    database("delete");
  } catch {}
  await rm(scratch, { recursive: true, force: true });
}
