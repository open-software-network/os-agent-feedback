#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.SETUP_MATRIX_BACKEND_URL || "http://127.0.0.1:3180").replace(
  /\/$/,
  "",
);
const databaseEnvironment = process.env.SETUP_MATRIX_DB_ENVIRONMENT || "v2-canary";
const localBackend = backendUrl === "http://127.0.0.1:3180";
const scratch = await mkdtemp(join(tmpdir(), "epode-setup-matrix-"));
const children = new Set();
const expected = new Map();
let databaseUrl = "";
const python = process.env.PYTHON_BIN || runWhich("python3.11") || runWhich("python3");
const envelopeSchema = JSON.parse(
  await readFile(join(repo, "protocol", "v1", "envelope.schema.json"), "utf8"),
);
if (localBackend) {
  envelopeSchema.properties.submit.properties.url.pattern = "^https?://";
}
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateEnvelopeSchema = ajv.compile(envelopeSchema);

function runWhich(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
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

async function stop(child) {
  if (!child || child.exitCode !== null) return;
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

function database(action) {
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

function assertEnvelope(envelope) {
  assert.equal(
    validateEnvelopeSchema(envelope),
    true,
    `invalid protocol envelope: ${JSON.stringify(validateEnvelopeSchema.errors)}`,
  );
  assert.equal(envelope.v, 1);
  assert.equal(envelope.mode, "never_ask");
  assert.equal(envelope.requested, true);
  assert.equal(envelope.reliability, "best_effort_without_agent_adapter");
  assert.match(envelope.instruction, /autonomously/i);
  assert.match(envelope.instruction, /do not ask the human/i);
  assert.equal(envelope.submit.url, `${backendUrl}/api/v2/reports`);
  assert.equal(envelope.submit.method, "POST");
  assert.match(envelope.submit.authorization, /^Bearer afr2_/);
  assert.deepEqual(envelope.submit.reportSchema.required, ["summary"]);
  assert.equal(envelope.submit.reportSchema.maxFindings, 8);
  assert.doesNotMatch(JSON.stringify(envelope), /af_live_/);
}

async function submit(envelope, summary) {
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
    workaround: { used: true, detail: "The agent verified the result through the setup harness." },
  };
  const response = await fetch(envelope.submit.url, {
    method: "POST",
    headers: { authorization: envelope.submit.authorization, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.accepted, true);
  assert.equal(body.report.summary, summary);
  assert.equal(body.report.impact, "helped_with_friction");
  assert.equal(body.report.findings.length, 2);
  const duplicate = await fetch(envelope.submit.url, {
    method: "POST",
    headers: { authorization: envelope.submit.authorization, "content-type": "application/json" },
    body: JSON.stringify({ summary: "This duplicate report must not replace the first report." }),
  });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.report.id, body.report.id);
  assert.equal(duplicateBody.report.summary, summary);
  return body;
}

async function testHttp(base, stack) {
  for (const [surfaceName, path, surface] of [
    ["api", "/search", "http_json"],
    ["website", "/docs/test", "http_html"],
  ]) {
    const response = await fetch(`${base}${path}`);
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    assert.equal(response.status, 200);
    const envelope = envelopeFrom(response, body);
    assert.ok(envelope, `${stack}/${surfaceName} did not expose feedback metadata`);
    assertEnvelope(envelope);
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
      ...(name ? { "mcp-name": name } : {}),
      ...headerOverrides,
    },
    body: JSON.stringify(body),
  });
  const payload = await readMcpPayload(response);
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  assert.equal(
    response.headers.get("mcp-session-id"),
    null,
    "modern MCP must not mint transport sessions",
  );
  return payload;
}

async function testMcp(url, stack) {
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
    modernMcpRequest(3, "tools/call", { name: "search", arguments: { query: "setup" } }),
    { expectedStatus: 400, headerOverrides: { "mcp-name": "wrong-tool" } },
  );
  assert.equal(mismatch.error.code, -32020);

  payload = await mcpPost(
    url,
    modernMcpRequest(4, "tools/call", { name: "search", arguments: { query: "setup" } }),
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
    workaround: { used: true, detail: "The agent verified the result through the setup harness." },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    payload = await mcpPost(
      url,
      modernMcpRequest(5 + attempt, "tools/call", {
        name: "report_product_feedback",
        arguments: reportArguments,
      }),
    );
    if (payload.result.structuredContent.accepted || !payload.result.structuredContent.retryable)
      break;
    if (attempt === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
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
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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
  assert.equal(legacyResponse.status, 200, JSON.stringify(legacy));
  assert.equal(legacy.result.protocolVersion, "2025-11-25");
  assert.equal(legacyResponse.headers.get("mcp-session-id"), null);
  console.log(
    `PASS ${stack}/mcp: 2026 discovery, stateless headers, cache hints, confirmed interaction, autonomous review`,
  );
}

async function prepareNode(fixtureName) {
  const target = join(scratch, fixtureName);
  await cp(join(repo, "examples", fixtureName), target, { recursive: true });
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@agent-feedback/node"] =
    `${backendUrl}/static/agent-feedback-node-0.1.0.tgz`;
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
  await cp(join(repo, "examples", "setup-matrix-go"), target, { recursive: true });
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
  run("go", ["get", "github.com/open-software-network/os-epode/sdk/go@latest"], { cwd: target });
  run("go", ["build", "-o", "setup-matrix-go", "."], { cwd: target });
  return target;
}

async function prepareRust() {
  const target = join(scratch, "setup-matrix-rust");
  await cp(join(repo, "examples", "setup-matrix-rust"), target, { recursive: true });
  run("bash", ["prepare.sh"], { cwd: target, env: { EP0DE_ORIGIN: backendUrl } });
  run("cargo", ["build", "--quiet"], { cwd: target });
  return target;
}

async function prepareManual(fixtureName) {
  const target = join(scratch, fixtureName);
  await cp(join(repo, "examples", fixtureName), target, { recursive: true });
  run(
    "curl",
    ["-fsS", "-o", "protocol.zip", `${backendUrl}/static/agent-feedback-protocol-v1.zip`],
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

async function runHttpApp(label, command, args, cwd, port) {
  const child = start(command, args, {
    cwd,
    label,
    env: { PORT: String(port), AGENT_FEEDBACK_KEY: apiKey, AGENT_FEEDBACK_URL: backendUrl },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  await testHttp(`http://127.0.0.1:${port}`, label);
  await waitForPersistedExpected();
  await stop(child);
}

async function runMcpApp(label, command, args, cwd, port) {
  const child = start(command, args, {
    cwd,
    label,
    env: { PORT: String(port), AGENT_FEEDBACK_KEY: apiKey, AGENT_FEEDBACK_URL: backendUrl },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  await testMcp(`http://127.0.0.1:${port}/mcp`, label);
  await waitForPersistedExpected();
  await stop(child);
}

async function waitForPersistedExpected() {
  let lastRows = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = database("read").split("\n").findLast((line) => line.trim().startsWith("["));
    const rows = JSON.parse(raw || "[]");
    lastRows = rows;
    if (
      rows.length === expected.size
      && rows.every((row) => row.surface !== "unknown" && row.operation !== "pending")
    ) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  const unresolved = lastRows.filter((row) => row.surface === "unknown" || row.operation === "pending");
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

  const nodeExpress = await prepareNode("setup-matrix-node-express");
  await runHttpApp("node-express", "node", ["index.js"], nodeExpress, 4101);
  const nodeFastify = await prepareNode("setup-matrix-node-fastify");
  await runHttpApp("node-fastify", "node", ["index.js"], nodeFastify, 4102);
  const pythonAsgi = await preparePython("setup-matrix-python-asgi");
  await runHttpApp(
    "python-asgi",
    join(pythonAsgi, ".venv", "bin", "python"),
    ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "4103"],
    pythonAsgi,
    4103,
  );
  const pythonWsgi = await preparePython("setup-matrix-python-wsgi");
  await runHttpApp(
    "python-wsgi",
    join(pythonWsgi, ".venv", "bin", "python"),
    ["app.py"],
    pythonWsgi,
    4104,
  );
  const go = await prepareGo();
  await runHttpApp("go", join(go, "setup-matrix-go"), [], go, 4105);
  const rust = await prepareRust();
  await runHttpApp("rust", join(rust, "target", "debug", "setup-matrix-rust"), [], rust, 4106);
  const manualHttp = await prepareManual("setup-matrix-manual-http");
  await runHttpApp("manual-http", python, ["server.py"], manualHttp, 4108);
  const nodeMcp = await prepareNode("setup-matrix-node-mcp");
  await runMcpApp("node-mcp", "node", ["index.js"], nodeMcp, 4107);
  const manualMcp = await prepareManual("setup-matrix-manual-mcp");
  await runMcpApp("manual-mcp", python, ["server.py"], manualMcp, 4109);

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
  assert.equal(expected.size, 16);
  assert.equal(rows.length, 16, JSON.stringify(rows, null, 2));
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
    "PASS persistence: all 16 Setup permutations stored the exact structured report on the correct confirmed interaction",
  );
  console.log("PASS setup matrix E2E: 7 API + 7 website + 2 MCP permutations");
} finally {
  for (const child of children) await stop(child);
  try {
    database("delete");
  } catch {}
  await rm(scratch, { recursive: true, force: true });
}
