#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.ICP_LAB_BACKEND_URL || "http://127.0.0.1:3190").replace(/\/$/, "");
const localBackend = backendUrl === "http://127.0.0.1:3190";
const databaseEnvironment = process.env.ICP_LAB_DB_ENVIRONMENT || "v2-canary";
const scratch = await mkdtemp(join(tmpdir(), "epode-icp-lab-"));
const children = new Set();
let databaseUrl = process.env.ICP_LAB_DATABASE_URL || "";
const selectedScenarios = new Set(
  (process.env.ICP_LAB_SCENARIOS || "search,consent,crawl,static,browser,docs,operations")
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
          ...(client.feedbackMode ? { SETUP_MATRIX_FEEDBACK_MODE: client.feedbackMode } : {}),
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
    `${backendUrl}/static/agent-feedback-node-0.2.1.tgz`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: target,
    timeout: 180_000,
  });
  return target;
}

async function runExample(name, port, client, options = {}) {
  const cwd = options.cwd || (await prepareExample(name));
  const child = start("node", ["index.js"], {
    cwd,
    label: name,
    env: {
      PORT: String(port),
      AGENT_FEEDBACK_KEY: client.apiKey,
      AGENT_FEEDBACK_URL: backendUrl,
      ...options.env,
    },
  });
  await waitFor(`http://127.0.0.1:${port}/health`, child);
  return { child, base: `http://127.0.0.1:${port}`, cwd };
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

async function submitConsent(envelope, decision, expectedStatus = 200) {
  const action = envelope.requiredAction?.submitDecision || envelope.manageConsent;
  assert.ok(action, `No consent action in ${JSON.stringify(envelope)}`);
  const response = await fetch(action.url, {
    method: "POST",
    headers: { authorization: action.authorization, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

function capabilityClaims(authorization) {
  const token = authorization.replace(/^Bearer\s+/, "");
  const payload = token.split(".")[1];
  assert.ok(payload, "Feedback capability has no signed claims payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function edgeExecutionContext() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
  };
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
        authorization: "Bearer demo-search-workspace-token",
        "x-workspace-id": "acct_spoofed_by_caller",
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

async function consentPolicyScenario() {
  const client = identity("consent-policy-api");
  client.feedbackMode = "ask_once";
  database(client, "seed");
  database(client, "set-mode");
  const cwd = await prepareExample("icp-search-express");
  const headers = {
    "agent-feedback-request": "1",
    authorization: "Bearer demo-search-workspace-token",
    "x-workspace-id": "acct_spoofed_by_caller",
    "x-agent-run-id": "run_consent_42",
  };
  const askOnceEnvironment = {
    AGENT_FEEDBACK_MODE: "ask_once",
    ...(localBackend ? { AGENT_FEEDBACK_CONSENT_TIMEOUT_MS: "5000" } : {}),
  };
  let running;
  try {
    running = await runExample("icp-search-express", 4206, client, {
      cwd,
      env: askOnceEnvironment,
    });
    let response = await fetch(`${running.base}/v1/search?q=permission`, { headers });
    let body = await response.json();
    const first = httpEnvelope(response, body);
    assert.equal(first.state, "consent_required");
    assert.equal(first.mode, "ask_once");
    assert.equal(first.consentPolicy, "once");
    assert.equal(first.submit, undefined);

    const approved = await submitConsent(first, "approved");
    assert.equal(approved.state, "approved");
    assert.equal(approved.changed, true);
    assert.equal(approved.feedback.state, "feedback_ready");
    const repeatedApproval = await submitConsent(first, "approved");
    assert.equal(repeatedApproval.state, "approved");
    assert.equal(repeatedApproval.changed, false);
    const subject = capabilityClaims(first.requiredAction.submitDecision.authorization).s;
    const storedConsentResponse = await fetch(`${backendUrl}/api/v2/consent/state`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ subject }),
    });
    const storedConsent = await storedConsentResponse.json();
    assert.equal(storedConsentResponse.status, 200, JSON.stringify(storedConsent));
    assert.equal(storedConsent.state, "approved");

    const report = await submitHttp(approved.feedback, {
      summary: "The authenticated search result answered the request after explicit permission.",
      impact: "helped",
      findings: [
        {
          kind: "strength",
          topic: "permission_flow",
          detail: "The answer remained available before the permission decision.",
        },
      ],
    });
    const duplicate = await submitHttp(approved.feedback, {
      summary: "This contradictory duplicate must not replace the first customer outcome.",
      impact: "blocked",
    });
    assert.equal(duplicate.report.id, report.report.id);
    assert.equal(duplicate.report.summary, report.report.summary);
    assert.equal(duplicate.report.impact, "helped");

    let remembered;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${running.base}/v1/search?q=remembered`, { headers });
      body = await response.json();
      remembered = httpEnvelope(response, body);
      if (remembered?.state === "feedback_ready") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    assert.equal(remembered?.configuredMode, "ask_once");
    assert.equal(remembered?.state, "feedback_ready", running.child.log);
    assert.equal(remembered?.manageConsent?.current, "approved");
    assert.equal(remembered?.requiredAction, undefined);

    await stop(running.child);
    running = undefined;
    client.feedbackMode = "ask_always";
    database(client, "set-mode");
    running = await runExample("icp-search-express", 4206, client, {
      cwd,
      env: {
        AGENT_FEEDBACK_MODE: "ask_always",
        ...(localBackend ? { AGENT_FEEDBACK_CONSENT_TIMEOUT_MS: "5000" } : {}),
      },
    });
    response = await fetch(`${running.base}/v1/search?q=per-use`, { headers });
    body = await response.json();
    const perUse = httpEnvelope(response, body);
    assert.equal(perUse.state, "consent_required");
    assert.equal(perUse.mode, "ask_always");
    assert.equal(perUse.consentPolicy, "always");
    const perUseApproval = await submitConsent(perUse, "approved");
    assert.equal(perUseApproval.feedback.state, "feedback_ready");
    await submitHttp(perUseApproval.feedback, {
      summary: "The second authenticated search use was approved independently.",
      impact: "helped",
    });

    response = await fetch(`${running.base}/v1/search?q=ask-again`, { headers });
    body = await response.json();
    const nextPerUse = httpEnvelope(response, body);
    assert.equal(nextPerUse.state, "consent_required");
    assert.equal(nextPerUse.consentPolicy, "always");
    const declined = await submitConsent(nextPerUse, "declined");
    assert.equal(declined.state, "declined");
    assert.equal(declined.feedback, null);

    const rows = await observations(client, 3);
    assert.ok(rows.length >= 3, JSON.stringify(rows));
    assert.equal(rows.filter((row) => row.summary).length, 2, JSON.stringify(rows));
    assert.ok(
      rows.some((row) => row.classification === "unclassified"),
      JSON.stringify(rows),
    );
    assert.ok(rows.every((row) => row.customerRef === "acct_search_42"));
    assert.doesNotMatch(JSON.stringify(rows), /acct_spoofed_by_caller/);
    console.log(
      "PASS consent policy API: verified auth binding, Ask once memory, per-use consent, idempotent decisions and reports",
    );
  } finally {
    await stop(running?.child);
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

async function staticEdgeScenario() {
  const client = identity("static-docs-edge");
  database(client, "seed");
  const cwd = await prepareExample("static-docs-edge");
  const nativeFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const upstreamBody = "<!doctype html><html><body>Customer documentation</body></html>";
  try {
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://docs-origin.test") {
        upstreamCalls += 1;
        return new Response(upstreamBody, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(upstreamBody)),
            "cache-control": "public, max-age=300",
            vary: "Accept-Encoding",
          },
        });
      }
      return nativeFetch(input, init);
    };
    const worker = (
      await import(`${pathToFileURL(join(cwd, "worker.js")).href}?scenario=${client.productId}`)
    ).default;
    const env = {
      AGENT_FEEDBACK_KEY: client.apiKey,
      AGENT_FEEDBACK_URL: backendUrl,
      AGENT_FEEDBACK_MODE: "never_ask",
      DOCS_UPSTREAM_ORIGIN: "https://docs-origin.test",
    };

    let context = edgeExecutionContext();
    let result = await worker.fetch(
      new Request("https://docs.example.test/docs/start?lang=en"),
      env,
      context,
    );
    assert.equal(result.status, 200);
    assert.equal(await result.text(), upstreamBody);
    assert.equal(result.headers.get("cache-control"), "public, max-age=300");
    assert.equal(result.headers.get("agent-feedback"), null);
    assert.match(result.headers.get("link") || "", /^<\/docs\/start\?lang=en>/);

    result = await worker.fetch(
      new Request("https://docs.example.test/admin"),
      env,
      edgeExecutionContext(),
    );
    assert.equal(result.status, 404);
    result = await worker.fetch(
      new Request("https://docs.example.test/docs/start", { method: "POST" }),
      env,
      edgeExecutionContext(),
    );
    assert.equal(result.status, 405);
    assert.equal(result.headers.get("allow"), "GET, HEAD");
    assert.equal(upstreamCalls, 1);

    context = edgeExecutionContext();
    result = await worker.fetch(
      new Request("https://docs.example.test/docs/start?lang=en", {
        headers: { "agent-feedback-request": "1" },
      }),
      env,
      context,
    );
    assert.equal(await result.text(), upstreamBody);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    const envelope = httpEnvelope(result);
    assert.equal(envelope.state, "feedback_ready");
    assert.doesNotMatch(JSON.stringify(envelope), /af_live_/);
    await Promise.all(context.promises);
    await submitHttp(envelope, {
      summary: "The static documentation page answered the setup question directly.",
      impact: "helped",
      findings: [
        {
          kind: "strength",
          topic: "documentation",
          detail: "The requested setup guidance was present on the first page.",
        },
      ],
    });
    const rows = await observations(client, 1);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].operation, "/docs/start");
    assert.equal(rows[0].surface, "http_headers");
    assert.equal(rows[0].classification, "confirmed");
    assert.equal(rows[0].customerRef, null);
    assert.equal(upstreamCalls, 2);
    console.log(
      "PASS static edge: fresh package, cache-safe handoff, fail-closed route boundary, exact persisted report",
    );
  } finally {
    globalThis.fetch = nativeFetch;
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
    assert.equal(rejected.structuredContent.retryable, true);
    assert.match(
      rejected.content[0].text,
      /exactly once with only feedbackHandle and a concise summary/,
    );
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
  if (selectedScenarios.has("consent")) await consentPolicyScenario();
  if (selectedScenarios.has("crawl")) await crawlApiScenario();
  if (selectedScenarios.has("static")) await staticEdgeScenario();
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
