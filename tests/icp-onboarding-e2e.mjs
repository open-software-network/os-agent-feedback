#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.ICP_LAB_BACKEND_URL || "http://127.0.0.1:3190").replace(/\/$/, "");
const localBackend = backendUrl === "http://127.0.0.1:3190";
const databaseEnvironment = process.env.ICP_LAB_DB_ENVIRONMENT || "v2-canary";
const scratch = await mkdtemp(join(tmpdir(), "epode-icp-lab-"));
const children = new Set();
let databaseUrl = process.env.ICP_LAB_DATABASE_URL || "";
const selectedScenarios = new Set(
  (process.env.ICP_LAB_SCENARIOS || "search,crawl,browser,docs,operations")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
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
      child.log = `${child.log}${chunk}`.slice(-16_000);
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

async function waitFor(url, child, timeoutMs = 180_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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

function identity(name) {
  const workspaceId = randomUUID();
  const productId = randomUUID();
  const environmentId = randomUUID();
  const keyId = randomUUID();
  return {
    name,
    workspaceId,
    productId,
    environmentId,
    keyId,
    apiKey: `af_live_${keyId.replaceAll("-", "")}_${randomBytes(30).toString("base64url")}`,
  };
}

function database(client, action) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return run("cargo", ["run", "--quiet", "--bin", "setup_matrix_db", "--", action], {
        cwd: join(repo, "backend"),
        env: {
          DATABASE_URL: databaseUrl,
          SETUP_MATRIX_WORKSPACE_ID: client.workspaceId,
          SETUP_MATRIX_PRODUCT_ID: client.productId,
          SETUP_MATRIX_ENVIRONMENT_ID: client.environmentId,
          SETUP_MATRIX_KEY_ID: client.keyId,
          SETUP_MATRIX_API_KEY: client.apiKey,
        },
        timeout: 45_000,
      });
    } catch (error) {
      lastError = error;
      if (!String(error).includes("pool timed out") || attempt === 4) throw error;
      spawnSync("sleep", [String(attempt + 1)]);
    }
  }
  throw lastError;
}

async function observations(client, expectedMinimum) {
  let rows = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = database(client, "read-observations")
      .split("\n")
      .findLast((line) => line.trim().startsWith("["));
    rows = JSON.parse(raw || "[]");
    if (
      rows.length >= expectedMinimum &&
      rows.every((row) => row.operation !== "pending" && row.surface !== "unknown")
    )
      return rows;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return rows;
}

async function prepareExample(name) {
  const target = join(scratch, name);
  await cp(join(repo, "examples", name), target, { recursive: true });
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies["@agent-feedback/node"] =
    `${backendUrl}/static/agent-feedback-node-0.2.0.tgz`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: target,
    timeout: 180_000,
  });
  return target;
}

async function runExample(name, port, client) {
  const cwd = await prepareExample(name);
  const child = start("node", ["index.js"], {
    cwd,
    label: name,
    env: {
      PORT: String(port),
      AGENT_FEEDBACK_KEY: client.apiKey,
      AGENT_FEEDBACK_URL: backendUrl,
    },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  return { child, base: `http://127.0.0.1:${port}` };
}

function httpEnvelope(response, body) {
  if (body && typeof body === "object" && !Array.isArray(body)) return body._agentFeedback;
  const encoded = response.headers.get("agent-feedback");
  return encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) : undefined;
}

async function submitHttp(envelope, report, expectedStatus = 200) {
  const response = await fetch(envelope.submit.url, {
    method: "POST",
    headers: { authorization: envelope.submit.authorization, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

const MCP_VERSION = "2026-07-28";
function mcpRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "epode-icp-simulator", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

async function mcpPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_VERSION,
      "mcp-method": body.method,
      ...(body.params?.name ? { "mcp-name": body.params.name } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = (response.headers.get("content-type") || "").includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text;
  const payload = JSON.parse(data || "{}");
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function callTool(base, id, name, arguments_) {
  const payload = await mcpPost(
    `${base}/mcp`,
    mcpRequest(id, "tools/call", { name, arguments: arguments_ }),
  );
  assert.ok(payload.result, JSON.stringify(payload));
  return payload.result;
}

async function reportTool(base, id, feedbackHandle, report) {
  return callTool(base, id, "report_product_feedback", { feedbackHandle, ...report });
}

async function reportToolWithRetry(base, id, feedbackHandle, report) {
  let result = await reportTool(base, id, feedbackHandle, report);
  if (!result.structuredContent?.accepted && result.structuredContent?.retryable) {
    result = await reportTool(base, id + 1, feedbackHandle, report);
  }
  return result;
}

async function searchApiScenario() {
  const client = identity("search-api");
  database(client, "seed");
  const { child, base } = await runExample("icp-search-express", 4201, client);
  try {
    let response = await fetch(`${base}/v1/search?q=agents`);
    let body = await response.json();
    assert.equal(httpEnvelope(response, body), undefined);
    assert.match(response.headers.get("cache-control") || "", /public/);

    response = await fetch(`${base}/v1/search?q=agents`, {
      headers: {
        "agent-feedback-request": "1",
        "x-workspace-id": "acct_search_42",
        "x-agent-run-id": "run_search_42",
        "x-agent-runtime": "openai-codex",
      },
    });
    body = await response.json();
    assert.deepEqual(body.results, [{ title: "Primary-source result", score: 0.97 }]);
    const envelope = httpEnvelope(response, body);
    assert.ok(envelope);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    await submitHttp(envelope, {
      summary: "Search returned a highly relevant primary-source result without retries.",
      impact: "helped",
      confidence: 0.97,
      findings: [
        {
          kind: "strength",
          topic: "relevance",
          detail: "The first result directly answered the task.",
        },
      ],
    });
    const rows = await observations(client, 1);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].operation, "/v1/search", child.log);
    assert.equal(rows[0].customerRef, "acct_search_42");
    assert.equal(rows[0].classification, "confirmed");
    assert.ok(rows[0].sessionId);
    console.log(
      "PASS search API: CDN-safe opt-in, opaque customer/run grouping, exact positive feedback",
    );
  } finally {
    await stop(child);
    database(client, "delete");
  }
}

async function crawlApiScenario() {
  const client = identity("crawl-api");
  database(client, "seed");
  const { child, base } = await runExample("icp-crawl-fastify", 4202, client);
  try {
    const headers = {
      "content-type": "application/json",
      "x-team-id": "team_crawl_9",
      "x-agent-run-id": "run_crawl_9",
    };
    let response = await fetch(`${base}/v1/crawls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://example.test" }),
    });
    const created = await response.json();
    assert.equal(response.status, 202);
    assert.equal(httpEnvelope(response, created), undefined);
    response = await fetch(`${base}/v1/crawls/${created.id}`, { headers });
    const running = await response.json();
    assert.equal(running.status, "running");
    assert.equal(httpEnvelope(response, running), undefined);
    response = await fetch(`${base}/v1/crawls/${created.id}`, { headers });
    const completed = await response.json();
    assert.equal(completed.status, "completed");
    const envelope = httpEnvelope(response, completed);
    assert.ok(envelope);
    await submitHttp(envelope, {
      summary: "The crawl completed and produced usable Markdown after one polling retry.",
      impact: "helped_with_friction",
      confidence: 0.94,
      findings: [
        {
          kind: "friction",
          topic: "polling",
          severity: "minor",
          detail: "One additional status poll was required.",
        },
      ],
      workaround: { used: true, detail: "The agent waited for the documented terminal status." },
    });
    const rows = await observations(client, 1);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].operation, "/v1/crawls/:id");
    assert.equal(rows[0].customerRef, "team_crawl_9");
    console.log(
      "PASS crawl API: async polling suppressed, terminal outcome instrumented, friction preserved",
    );
  } finally {
    await stop(child);
    database(client, "delete");
  }
}

async function browserMcpScenario() {
  const client = identity("browser-mcp");
  database(client, "seed");
  const { child, base } = await runExample("icp-browser-mcp", 4203, client);
  try {
    const started = await callTool(base, 1, "browser_start", { runId: "77" });
    const sessionId = started.structuredContent.sessionId;
    assert.equal(started.structuredContent._agentFeedback, undefined);
    assert.equal(
      (await callTool(base, 2, "browser_navigate", { sessionId, url: "https://shop.example.test" }))
        .structuredContent._agentFeedback,
      undefined,
    );
    assert.equal(
      (await callTool(base, 3, "browser_act", { sessionId, action: "open pricing" }))
        .structuredContent._agentFeedback,
      undefined,
    );
    assert.equal(
      (await callTool(base, 4, "browser_extract", { sessionId, field: "price" })).structuredContent
        ._agentFeedback,
      undefined,
    );
    const closed = await callTool(base, 5, "browser_close", { sessionId });
    const feedback = closed.structuredContent._agentFeedback;
    assert.ok(feedback?.feedbackHandle);
    const accepted = await reportToolWithRetry(base, 6, feedback.feedbackHandle, {
      summary:
        "The browser completed the four-step pricing journey, though navigation added latency.",
      impact: "helped_with_friction",
      confidence: 0.92,
      findings: [
        {
          kind: "friction",
          topic: "latency",
          severity: "minor",
          detail: "Navigation was the slowest part of the journey.",
        },
      ],
    });
    assert.equal(accepted.structuredContent.accepted, true, JSON.stringify(accepted));
    const rows = await observations(client, 5);
    assert.deepEqual(
      rows.map((row) => row.operation),
      ["browser_start", "browser_navigate", "browser_act", "browser_extract", "browser_close"],
    );
    assert.equal(new Set(rows.map((row) => row.sessionId)).size, 1, JSON.stringify(rows));
    assert.equal(rows.filter((row) => row.summary).length, 1);
    assert.ok(rows.every((row) => row.classification === "confirmed"));
    console.log(
      "PASS browser MCP: full five-tool trace, returned session ID grouping, one journey-level report",
    );
  } finally {
    await stop(child);
    database(client, "delete");
  }
}

async function docsMcpScenario() {
  const client = identity("docs-mcp");
  database(client, "seed");
  const { child, base } = await runExample("icp-docs-mcp", 4204, client);
  try {
    const resolved = await callTool(base, 1, "resolve_library", {
      name: "next.js",
      runId: "docs_run_5",
    });
    assert.equal(resolved.structuredContent._agentFeedback, undefined);
    const queried = await callTool(base, 2, "query_docs", {
      libraryId: resolved.structuredContent.libraryId,
      question: "How does caching work?",
      runId: "docs_run_5",
    });
    const feedback = queried.structuredContent._agentFeedback;
    assert.ok(feedback?.feedbackHandle);
    const accepted = await reportToolWithRetry(base, 3, feedback.feedbackHandle, {
      summary: "Current documentation answered the caching question with a direct citation.",
      impact: "helped",
      confidence: 0.96,
      findings: [
        {
          kind: "strength",
          topic: "freshness",
          detail: "The result described the current framework option.",
        },
      ],
    });
    assert.equal(accepted.structuredContent.accepted, true);
    const rows = await observations(client, 2);
    assert.deepEqual(
      rows.map((row) => row.operation),
      ["resolve_library", "query_docs"],
    );
    assert.equal(new Set(rows.map((row) => row.sessionId)).size, 1);
    assert.equal(rows.filter((row) => row.summary).length, 1);
    console.log(
      "PASS docs MCP: read-heavy two-tool trace, feedback requested only on answer-bearing query",
    );
  } finally {
    await stop(child);
    database(client, "delete");
  }
}

async function operationsMcpScenario() {
  const client = identity("operations-mcp");
  database(client, "seed");
  const { child, base } = await runExample("icp-operations-mcp", 4205, client);
  try {
    const sent = await callTool(base, 1, "send_email", {
      workflowId: "workflow_ops_8",
      to: "buyer@example.com",
      subject: "Receipt",
    });
    const sentFeedback = sent.structuredContent._agentFeedback;
    const rejected = await reportTool(base, 2, sentFeedback.feedbackHandle, {
      summary: "Email to buyer@example.com was queued successfully.",
      impact: "helped",
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.accepted, false);
    assert.equal(rejected.structuredContent.retryable, false);
    const accepted = await reportToolWithRetry(base, 3, sentFeedback.feedbackHandle, {
      summary: "The transactional email was queued successfully on the first attempt.",
      impact: "helped",
      findings: [
        {
          kind: "strength",
          topic: "delivery",
          detail: "The operation returned a stable delivery identifier.",
        },
      ],
    });
    assert.equal(accepted.structuredContent.accepted, true, JSON.stringify(accepted));

    const payment = await callTool(base, 4, "create_payment_link", {
      workflowId: "workflow_ops_8",
      priceId: "price_restricted",
    });
    assert.equal(payment.isError, true);
    const paymentFeedback = payment.structuredContent._agentFeedback;
    const blocked = await reportToolWithRetry(base, 5, paymentFeedback.feedbackHandle, {
      summary: "The payment-link workflow was blocked because the selected price was not enabled.",
      impact: "blocked",
      confidence: 0.99,
      findings: [
        {
          kind: "gap",
          topic: "price_support",
          severity: "blocking",
          detail: "Restricted prices cannot currently produce a payment link.",
        },
      ],
    });
    assert.equal(blocked.structuredContent.accepted, true, JSON.stringify(blocked));
    const rows = await observations(client, 2);
    assert.deepEqual(
      rows.map((row) => row.operation),
      ["send_email", "create_payment_link"],
    );
    assert.deepEqual(
      rows.map((row) => row.statusCode),
      [200, 500],
    );
    assert.equal(new Set(rows.map((row) => row.sessionId)).size, 1);
    assert.equal(
      rows.every((row) => row.customerRef === "acct_operations_demo"),
      true,
    );
    assert.equal(rows.filter((row) => row.summary).length, 2);
    assert.doesNotMatch(JSON.stringify(rows), /buyer@example\.com/);
    console.log(
      "PASS operations MCP: PII rejected, safe retry accepted, negative outcome retained, OAuth-style tenant grouping",
    );
  } finally {
    await stop(child);
    database(client, "delete");
  }
}

try {
  if (process.env.ICP_LAB_SKIP_BUILD !== "true") {
    run("bash", ["tests/build-hosted-artifacts.sh"], { timeout: 240_000 });
  }
  if (!databaseUrl) {
    const variables = JSON.parse(
      run("railway", [
        "variables",
        "--service",
        "Postgres",
        "--environment",
        databaseEnvironment,
        "--json",
      ]),
    );
    databaseUrl = variables.DATABASE_PUBLIC_URL;
  }
  assert.ok(databaseUrl, "A disposable Postgres URL is required");
  if (localBackend) {
    const backend = start("cargo", ["run", "--quiet", "--bin", "agent-feedback"], {
      cwd: join(repo, "backend"),
      label: "Epode ICP lab backend",
      env: {
        DATABASE_URL: databaseUrl,
        PUBLIC_BASE_URL: backendUrl,
        OS_ACCOUNTS_URL: "https://accounts.example.test",
        OS_ACCOUNTS_API_URL: "https://accounts-api.example.test",
        OS_ACCOUNTS_CLIENT_ID: "ocl_icp_lab",
        DATABASE_MAX_CONNECTIONS: "2",
        PORT: "3190",
      },
    });
    await waitFor(`${backendUrl}/api/health`, backend, 240_000);
  } else {
    await waitFor(`${backendUrl}/api/health`, undefined, 60_000);
  }
  if (selectedScenarios.has("search")) await searchApiScenario();
  if (selectedScenarios.has("crawl")) await crawlApiScenario();
  if (selectedScenarios.has("browser")) await browserMcpScenario();
  if (selectedScenarios.has("docs")) await docsMcpScenario();
  if (selectedScenarios.has("operations")) await operationsMcpScenario();
  console.log(
    `PASS ICP onboarding lab: ${selectedScenarios.size} realistic client scenario(s) completed with exact persistence checks`,
  );
} finally {
  for (const child of [...children]) await stop(child);
  await rm(scratch, { recursive: true, force: true });
}
