#!/usr/bin/env node

// End-to-end coverage for data destinations: the dashboard API creates a
// destination, the sync worker pipes real workspace data into a scratch
// Postgres "warehouse" and a local NDJSON collector, and the cursor makes
// reruns idempotent. Requires DATABASE_URL pointing at a scratch database
// (the script creates and drops its own sink database in the same instance).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.DATA_DESTINATIONS_BACKEND_URL || "http://127.0.0.1:3189").replace(
  /\/$/,
  "",
);
const databaseUrl = process.env.DATA_DESTINATIONS_DATABASE_URL || process.env.DATABASE_URL || "";
const localBackend = backendUrl === "http://127.0.0.1:3189";
const devEmail = `destinations-${randomUUID().slice(0, 8)}@example.test`;
const sinkDatabase = `epode_destination_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const children = new Set();

if (!databaseUrl) {
  throw new Error(
    "DATA_DESTINATIONS_DATABASE_URL (or DATABASE_URL) is required for the data destinations e2e",
  );
}

function start(command, args, { cwd, env, label }) {
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
}

function logs() {
  return [...children]
    .map((child) => `--- ${child.label} ---\n${child.log || "(no output)"}`)
    .join("\n");
}

async function waitFor(url, child, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child?.exitCode !== null) throw new Error(`${child.label} exited early\n${child.log}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}\n${logs()}`);
}

function psql(database, sql) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const result = spawnSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

function psqlScalar(database, sql) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const result = spawnSync(
    "psql",
    [url.toString(), "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

async function api(path, { method = "GET", cookie, body, workspaceId } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${backendUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function apiOk(response, label, expected = 200) {
  assert.equal(
    response.status,
    expected,
    `${label} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`,
  );
  return response.body;
}

async function devLogin() {
  const response = await fetch(`${backendUrl}/__dev/log-me-in`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: backendUrl,
    },
    body: new URLSearchParams({ email: devEmail, returnTo: "/" }).toString(),
    redirect: "manual",
  });
  assert.ok([303, 302].includes(response.status), `dev login returned HTTP ${response.status}`);
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") || ""];
  const match = setCookies.join(",").match(/(?:^|[,;]\s*)af_dev_identity=([^;,]+)/);
  assert.ok(match, "dev login must set the af_dev_identity cookie");
  return `af_dev_identity=${match[1]}`;
}

// A minimal NDJSON collector: accepts POSTs, records each line.
function startCollector() {
  const received = [];
  const auths = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    auths.add(request.headers.authorization ?? null);
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      for (const line of body.split("\n")) {
        if (line.trim()) received.push(JSON.parse(line));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListen({ server, received, auths, url: `http://127.0.0.1:${port}/ingest` });
    });
  });
}

async function waitForRun(cookie, workspaceId, destinationId, predicate, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = apiOk(
      await api(`/api/data-destinations/${destinationId}/runs`, { cookie, workspaceId }),
      "sync runs",
    );
    const match = runs.runs.find(predicate);
    if (match) return match;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for a sync run of ${destinationId}\n${logs()}`);
}

let backend;
let collector;
try {
  collector = await startCollector();

  if (localBackend) {
    backend = start("cargo", ["run", "--quiet", "--offline", "--bin", "agent-feedback"], {
      cwd: join(repo, "backend"),
      label: "Epode backend",
      env: {
        DATABASE_URL: databaseUrl,
        PUBLIC_BASE_URL: backendUrl,
        WEB_APP_URL: "http://127.0.0.1:3000",
        OS_ACCOUNTS_URL: "https://accounts.example.test",
        OS_ACCOUNTS_API_URL: "https://accounts-api.example.test",
        OS_ACCOUNTS_CLIENT_ID: "ocl_data_destinations_e2e",
        EPODE_IDENTITY_HMAC_SECRET: randomBytes(32).toString("base64url"),
        DATABASE_MAX_CONNECTIONS: "3",
        PORT: "3189",
        APP_ENV: "development",
        DEV_AUTH_ENABLED: "true",
        DEV_AUTH_SIGNING_KEY: randomBytes(32).toString("base64url"),
      },
    });
    await waitFor(`${backendUrl}/api/health`, backend);
  }

  // Sign in through the local dev-auth bypass; the first dashboard request
  // provisions the personal workspace this run then uses.
  const cookie = await devLogin();
  const dashboard = apiOk(await api("/api/dashboard", { cookie }), "dashboard");
  const workspaceId = dashboard.workspace.id;

  // Seed product-shaped rows directly: the destinations pipe reads them
  // exactly as it reads ingested production data.
  const productId = randomUUID();
  const environmentId = randomUUID();
  const interactionId = randomUUID();
  const reportId = randomUUID();
  psql(
    new URL(databaseUrl).pathname.slice(1),
    `INSERT INTO products (id, workspace_id, name, slug)
       VALUES ('${productId}', '${workspaceId}', 'Destinations product', 'destinations-product-${productId.slice(0, 8)}');
     INSERT INTO product_environments (id, workspace_id, product_id, name, slug)
       VALUES ('${environmentId}', '${workspaceId}', '${productId}', 'Production', 'production');
     INSERT INTO interactions_v2
       (id, workspace_id, environment_id, surface, operation, classification, confirmation_method, occurred_at)
       VALUES ('${interactionId}', '${workspaceId}', '${environmentId}', 'mcp', 'submit_feedback',
         'confirmed', 'mcp', NOW());
     INSERT INTO feedback_reports (id, workspace_id, interaction_id, summary, impact, confidence)
       VALUES ('${reportId}', '${workspaceId}', '${interactionId}',
         'The data destinations e2e exports this report.', 'helped', 0.9);`,
  );

  // --- Validation and auth boundaries -------------------------------------
  const unauthenticated = await api("/api/data-destinations");
  assert.equal(unauthenticated.status, 401, "destinations require authentication");

  const badKind = await api("/api/data-destinations", {
    method: "POST",
    cookie,
    workspaceId,
    body: { name: "Nope", kind: "snowflake", config: {} },
  });
  assert.equal(badKind.status, 400, "unknown kinds are rejected");

  const embeddedPassword = await api("/api/data-destinations", {
    method: "POST",
    cookie,
    workspaceId,
    body: {
      name: "Unsafe URL",
      kind: "postgres",
      config: { connectionUrl: "postgres://user:secret@localhost/warehouse" },
    },
  });
  assert.equal(embeddedPassword.status, 400, "embedded passwords are rejected");
  assert.match(embeddedPassword.body.error, /must not embed a password/);

  // --- Test-before-create against the live sink ---------------------------
  psql("postgres", `CREATE DATABASE "${sinkDatabase}"`);
  const admin = new URL(databaseUrl);
  const sinkUrl = `postgres://${admin.username}@${admin.host}/${sinkDatabase}`;

  const testResult = apiOk(
    await api("/api/data-destinations/test", {
      method: "POST",
      cookie,
      workspaceId,
      body: {
        kind: "postgres",
        config: { connectionUrl: sinkUrl },
        credentials: admin.password ? { password: admin.password } : undefined,
      },
    }),
    "destination test",
  );
  assert.equal(testResult.ok, true);

  // --- Create and sync a Postgres destination -----------------------------
  const created = apiOk(
    await api("/api/data-destinations", {
      method: "POST",
      cookie,
      workspaceId,
      body: {
        name: "Scratch warehouse",
        kind: "postgres",
        config: { connectionUrl: sinkUrl, schema: "public" },
        credentials: admin.password ? { password: admin.password } : undefined,
        syncIntervalSeconds: 300,
      },
    }),
    "create destination",
  );
  const destination = created.destination;
  assert.equal(destination.kind, "postgres");
  assert.equal(destination.enabled, true);
  // The API never returns credentials, sealed or otherwise.
  assert.ok(!("credentials" in destination), "responses must not carry credentials");
  assert.ok(!("credentialsSealed" in destination));
  assert.equal(JSON.stringify(destination).includes(admin.password || "\0"), false);

  const triggered = apiOk(
    await api(`/api/data-destinations/${destination.id}/sync`, {
      method: "POST",
      cookie,
      workspaceId,
    }),
    "manual sync",
  );
  assert.equal(triggered.triggered, true);

  // A second manual sync while the first is running conflicts.
  const duplicate = await api(`/api/data-destinations/${destination.id}/sync`, {
    method: "POST",
    cookie,
    workspaceId,
  });
  assert.ok(
    [200, 409].includes(duplicate.status),
    `duplicate sync must conflict or no-op, got HTTP ${duplicate.status}`,
  );

  const run = await waitForRun(
    cookie,
    workspaceId,
    destination.id,
    (candidate) => candidate.status === "succeeded" && candidate.trigger === "manual",
  );
  assert.equal(run.recordsExported, 2, "one interaction plus one report");

  // The sink database received both streams, keyed by id, with product context.
  const exportedRows = psqlScalar(
    sinkDatabase,
    "SELECT stream || ':' || id FROM epode_data_exports ORDER BY stream",
  ).split("\n");
  assert.deepEqual(exportedRows, [`feedback_reports:${reportId}`, `interactions:${interactionId}`]);
  const exportedReport = JSON.parse(
    psqlScalar(
      sinkDatabase,
      `SELECT record FROM epode_data_exports WHERE stream = 'feedback_reports'`,
    ),
  );
  assert.equal(exportedReport.productId, productId);
  assert.equal(exportedReport.summary, "The data destinations e2e exports this report.");

  // Rerun: the cursor holds, so nothing new is exported.
  apiOk(
    await api(`/api/data-destinations/${destination.id}/sync`, {
      method: "POST",
      cookie,
      workspaceId,
    }),
    "second manual sync",
  );
  const rerun = await waitForRun(
    cookie,
    workspaceId,
    destination.id,
    (candidate) => candidate.status === "succeeded" && candidate.id !== run.id,
  );
  assert.equal(rerun.recordsExported, 0, "cursor-resumed sync exports nothing new");
  assert.equal(
    psqlScalar(sinkDatabase, "SELECT COUNT(*) FROM epode_data_exports"),
    "2",
    "sink rows are idempotent upserts",
  );

  // --- HTTP NDJSON destination --------------------------------------------
  const collectorToken = `e2e-${randomBytes(12).toString("base64url")}`;
  const httpDestination = apiOk(
    await api("/api/data-destinations", {
      method: "POST",
      cookie,
      workspaceId,
      body: {
        name: "Local collector",
        kind: "http_ndjson",
        config: { url: collector.url },
        credentials: { token: collectorToken },
        syncIntervalSeconds: 60,
      },
    }),
    "create http destination",
  ).destination;

  apiOk(
    await api(`/api/data-destinations/${httpDestination.id}/sync`, {
      method: "POST",
      cookie,
      workspaceId,
    }),
    "http manual sync",
  );
  await waitForRun(
    cookie,
    workspaceId,
    httpDestination.id,
    (candidate) => candidate.status === "succeeded",
  );
  assert.equal(collector.received.length, 2, "collector received both streams");
  const envelopeStreams = collector.received.map((envelope) => envelope.stream).sort();
  assert.deepEqual(envelopeStreams, ["feedback_reports", "interactions"]);
  const reportEnvelope = collector.received.find(
    (envelope) => envelope.stream === "feedback_reports",
  );
  assert.equal(reportEnvelope.id, reportId);
  assert.equal(reportEnvelope.record.summary, "The data destinations e2e exports this report.");
  assert.ok(reportEnvelope.exportedAt, "envelopes carry an export timestamp");
  assert.deepEqual(
    [...collector.auths],
    [`Bearer ${collectorToken}`],
    "collector saw exactly the configured bearer token",
  );

  // --- Failure reporting: a dead destination surfaces its error ------------
  const deadDestination = apiOk(
    await api("/api/data-destinations", {
      method: "POST",
      cookie,
      workspaceId,
      body: {
        name: "Dead collector",
        kind: "http_ndjson",
        config: { url: "http://127.0.0.1:1/never" },
        syncIntervalSeconds: 60,
      },
    }),
    "create dead destination",
  ).destination;
  apiOk(
    await api(`/api/data-destinations/${deadDestination.id}/sync`, {
      method: "POST",
      cookie,
      workspaceId,
    }),
    "dead destination sync",
  );
  const failedRun = await waitForRun(
    cookie,
    workspaceId,
    deadDestination.id,
    (candidate) => candidate.status === "failed",
  );
  assert.match(failedRun.error, /delivery failed|HTTP/, "failures carry the transport error");

  // --- Pause, resume, delete ----------------------------------------------
  const paused = apiOk(
    await api(`/api/data-destinations/${destination.id}`, {
      method: "PATCH",
      cookie,
      workspaceId,
      body: { enabled: false },
    }),
    "pause destination",
  );
  assert.equal(paused.destination.enabled, false);

  const removed = apiOk(
    await api(`/api/data-destinations/${destination.id}`, {
      method: "DELETE",
      cookie,
      workspaceId,
    }),
    "delete destination",
  );
  assert.equal(removed.removed, true);
  const afterDelete = await api(`/api/data-destinations/${destination.id}/runs`, {
    cookie,
    workspaceId,
  });
  assert.equal(afterDelete.status, 404, "deleted destinations forget their runs");

  // --- Scheduled pickup: a fresh destination becomes due on its own --------
  const scheduledDestination = apiOk(
    await api("/api/data-destinations", {
      method: "POST",
      cookie,
      workspaceId,
      body: {
        name: "Scheduled collector",
        kind: "http_ndjson",
        config: { url: collector.url },
        syncIntervalSeconds: 5,
      },
    }),
    "create scheduled destination",
  ).destination;
  const scheduledRun = await waitForRun(
    cookie,
    workspaceId,
    scheduledDestination.id,
    (candidate) => candidate.status === "succeeded" && candidate.trigger === "scheduled",
    60_000,
  );
  assert.ok(
    scheduledRun.recordsExported >= 2,
    "the worker pipes due destinations without a manual trigger",
  );

  console.log("data destinations e2e: ok");
  console.log(
    `  postgres destination exported ${run.recordsExported} records; ` +
      `collector received ${collector.received.length} envelopes; ` +
      `scheduled run exported ${scheduledRun.recordsExported}`,
  );
} finally {
  await Promise.all([...children].map((child) => stop(child)));
  if (collector) {
    await new Promise((resolveClose) => collector.server.close(resolveClose));
  }
  try {
    psql("postgres", `DROP DATABASE IF EXISTS "${sinkDatabase}"`);
  } catch (error) {
    console.error(`sink database cleanup failed: ${error.message}`);
  }
}
