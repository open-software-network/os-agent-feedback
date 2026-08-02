#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (process.env.CUSTOMER_ENRICHMENT_BACKEND_URL || "http://127.0.0.1:3182").replace(
  /\/$/,
  "",
);
const productUrl = (process.env.CUSTOMER_ENRICHMENT_PRODUCT_URL || "http://127.0.0.1:4301").replace(
  /\/$/,
  "",
);
const databaseUrl = process.env.CUSTOMER_ENRICHMENT_DATABASE_URL || process.env.DATABASE_URL || "";
const localBackend = backendUrl === "http://127.0.0.1:3182";
const localProduct = productUrl === "http://127.0.0.1:4301";
const workspaceId = randomUUID();
const productId = randomUUID();
const environmentId = randomUUID();
const keyId = randomUUID();
const apiKey = `af_live_${keyId.replaceAll("-", "")}_${randomBytes(30).toString("base64url")}`;
const children = new Set();

if (!databaseUrl) {
  throw new Error(
    "CUSTOMER_ENRICHMENT_DATABASE_URL (or DATABASE_URL) is required for the disposable customer journey",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 240_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return (result.stdout || "").trim();
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

function database(action) {
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
  });
}

async function json(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text}\n${logs()}`);
  }
  assert.ok(response.ok, `${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function assertAgentAction(action, path) {
  assert.equal(action.url, path, "agents must submit through the company's same-origin relay");
  assert.equal(action.method, "POST");
  assert.match(action.authorization, /^Bearer aqr1_[A-Za-z0-9._-]+$/);
  assert.equal(action.contentType, "application/json");
  assert.equal(typeof action.bodySchema, "object");
  assert.doesNotMatch(JSON.stringify(action), /af_live_/);
  assert.doesNotMatch(JSON.stringify(action), /app\.epode\.ai/);
}

let backend;
let product;
try {
  if (localBackend) {
    backend = start("cargo", ["run", "--quiet", "--bin", "agent-feedback"], {
      cwd: join(repo, "backend"),
      label: "Epode backend",
      env: {
        DATABASE_URL: databaseUrl,
        PUBLIC_BASE_URL: backendUrl,
        OS_ACCOUNTS_URL: "https://accounts.example.test",
        OS_ACCOUNTS_API_URL: "https://accounts-api.example.test",
        OS_ACCOUNTS_CLIENT_ID: "ocl_customer_enrichment_e2e",
        DATABASE_MAX_CONNECTIONS: "3",
        PORT: "3182",
      },
    });
    await waitFor(`${backendUrl}/api/health`, backend);
  }

  database("seed");

  if (localProduct) {
    if (!existsSync(join(repo, "examples", "mvp-retail-express", "node_modules", "express"))) {
      throw new Error(
        "Install the retail example first: pnpm --dir examples/mvp-retail-express install --no-frozen-lockfile",
      );
    }
    run("pnpm", ["--dir", "sdk/node", "build"]);
    product = start("node", ["index.js"], {
      cwd: join(repo, "examples", "mvp-retail-express"),
      label: "Retail Express example",
      env: {
        EPODE_API_KEY: apiKey,
        EPODE_API_URL: backendUrl,
        RETAIL_COOKIE_SECRET: randomBytes(32).toString("base64url"),
        PORT: "4301",
      },
    });
    await waitFor(`${productUrl}/health`, product, 30_000);
  }

  const firstResponse = await fetch(`${productUrl}/api/recommendations`);
  const first = await json(firstResponse, "anonymous recommendations");
  const setCookies =
    typeof firstResponse.headers.getSetCookie === "function"
      ? firstResponse.headers.getSetCookie()
      : [firstResponse.headers.get("set-cookie") || ""];
  const cookie = ["retail_visitor", "retail_journey"]
    .map((name) => {
      const match = setCookies.join(",").match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
      return match ? `${name}=${match[1]}` : "";
    })
    .filter(Boolean)
    .join("; ");
  const visitorCookie = cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("retail_visitor="));
  assert.ok(visitorCookie, "the company must issue its first-party ID");
  assert.match(cookie, /retail_journey=/, "the company must issue its first-party journey ID");
  assert.equal(first.personalized, false);
  const request = first._epode?.customerContext;
  assert.equal(request.state, "consent_required");
  assert.equal(request.identityLevel, "pseudonymous");
  assert.match(request.stageInstruction, /ask the exact question once/i);
  assertAgentAction(request.consent, "/_epode/v1/enrichment/consent");
  assert.deepEqual(request.consent.bodySchema.decision, ["approved", "declined"]);

  const consentResponse = await fetch(`${productUrl}${request.consent.url}`, {
    method: "POST",
    headers: {
      authorization: request.consent.authorization,
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ decision: "approved" }),
  });
  const consent = await json(consentResponse, "customer-context permission");
  assert.equal(consent.state, "answer_ready");
  assert.match(consent.stageInstruction, /submit at most one bounded answer/i);
  assertAgentAction(consent.submit, "/_epode/v1/enrichment/answers");
  assert.deepEqual(consent.submit.bodySchema.status, [
    "answered",
    "declined",
    "no_relevant_context",
  ]);
  assert.equal(consent.submit.bodySchema.items.maximum, 8);
  assert.ok(consent.submit.bodySchema.items.required.includes("provenance"));
  assert.equal(consent.submit.bodySchema.items.catalogVersion, "v1");
  assert.ok(
    consent.submit.bodySchema.items.catalog.some(
      (entry) => entry.key === "shopping.priority" && entry.targetedAdvertisingSafe === true,
    ),
  );

  const answerResponse = await fetch(`${productUrl}${consent.submit.url}`, {
    method: "POST",
    headers: {
      authorization: consent.submit.authorization,
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      status: "answered",
      items: [
        {
          key: "shopping.priority",
          type: "preference",
          value: "sustainability",
          provenance: "agent_reports_user_statement",
          confidence: 1,
          remember: true,
        },
        {
          key: "shopping.budget_band",
          type: "constraint",
          value: "50_150",
          provenance: "agent_reports_current_task",
          confidence: 1,
          remember: true,
        },
        {
          key: "shopping.delivery_window",
          type: "constraint",
          value: "within_week",
          provenance: "agent_reports_current_task",
          confidence: 1,
          remember: true,
        },
      ],
    }),
  });
  const answer = await json(answerResponse, "customer-context answer");
  assert.equal(answer.accepted, true);
  assert.equal(answer.signals.length, 3);
  assert.ok(answer.signals.every((signal) => signal.allowedUses.length === 1));
  assert.ok(answer.signals.every((signal) => signal.allowedUses[0] === "product_personalization"));

  const personalizedResponse = await fetch(`${productUrl}/api/recommendations`, {
    headers: { cookie },
  });
  const personalized = await json(personalizedResponse, "personalized recommendations");
  assert.equal(personalized.personalized, true);
  assert.equal(personalized.products[0].id, "gift-fast");
  assert.match(personalized.decisionId, /^[0-9a-f-]{36}$/);

  const order = await json(
    await fetch(`${productUrl}/api/orders`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decisionId: personalized.decisionId }),
    }),
    "purchase outcome",
  );
  assert.equal(order.recorded, true);

  const advertisingContext = await json(
    await fetch(`${backendUrl}/api/v2/customer-context`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        anonymousRef: visitorCookie.slice("retail_visitor=".length).split(".")[0],
        purpose: "targeted_advertising",
      }),
    }),
    "purpose-separated advertising context",
  );
  assert.deepEqual(
    advertisingContext.items,
    [],
    "product-personalization permission must not authorize targeted advertising",
  );

  const signedIn = await json(
    await fetch(`${productUrl}/api/recommendations`, {
      headers: { cookie, authorization: "Bearer demo-retail-customer-token" },
    }),
    "signed-in recommendations",
  );
  assert.equal(signedIn.personalized, true);
  assert.equal(signedIn.products[0].id, "gift-fast");

  const stored = JSON.parse(
    database("read-enrichment")
      .split("\n")
      .findLast((line) => line.trim().startsWith("{")),
  );
  assert.equal(stored.answers.length, 1);
  assert.equal(stored.signals.length, 3);
  assert.ok(stored.requests.some((entry) => entry.identityLevel === "pseudonymous"));
  assert.ok(stored.requests.some((entry) => entry.identityLevel === "verified"));
  assert.ok(
    stored.contextRetrievals.some(
      (entry) => entry.purpose === "product_personalization" && entry.itemCount === 3,
    ),
  );
  assert.ok(
    stored.contextRetrievals.some(
      (entry) => entry.purpose === "targeted_advertising" && entry.itemCount === 0,
    ),
  );
  assert.ok(stored.decisions.length >= 2);
  assert.equal(stored.outcomes.length, 1);
  assert.equal(stored.outcomes[0].outcome, "conversion");
  assert.ok(stored.resolutions.length >= 1, "anonymous history must resolve after sign-in");
  assert.ok(stored.sessions.length >= 1, "same-call enrichment must preserve product sessions");
  assert.ok(
    stored.interactions.every(
      (interaction) =>
        interaction.surface === "http_json" &&
        interaction.statusCode === 200 &&
        Number.isSafeInteger(interaction.durationMs) &&
        interaction.durationMs >= 0 &&
        interaction.sessionId &&
        interaction.runtimeHint === "retail-express/1.0",
    ),
    "same-call interactions must retain surface, timing, product journey, and runtime evidence",
  );

  console.log(
    JSON.stringify({
      ok: true,
      journey: "anonymous-consent-enrich-personalize-convert-resolve",
      requests: stored.requests.length,
      signals: stored.signals.length,
      decisions: stored.decisions.length,
      outcomes: stored.outcomes.length,
      resolutions: stored.resolutions.length,
    }),
  );
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs()}`);
} finally {
  try {
    database("delete");
  } catch (error) {
    console.error(`Cleanup failed: ${String(error)}`);
  }
  await Promise.all([...children].map(stop));
}
