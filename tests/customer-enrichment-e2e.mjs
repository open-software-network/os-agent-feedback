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
const advertisingProductUrl = (
  process.env.CUSTOMER_ENRICHMENT_AD_PRODUCT_URL || "http://127.0.0.1:4305"
).replace(/\/$/, "");
const databaseUrl = process.env.CUSTOMER_ENRICHMENT_DATABASE_URL || process.env.DATABASE_URL || "";
const localBackend = backendUrl === "http://127.0.0.1:3182";
const localProduct = productUrl === "http://127.0.0.1:4301";
const localAdvertisingProduct = advertisingProductUrl === "http://127.0.0.1:4305";
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

function responseCookieHeader(response, names) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") || ""];
  return names
    .map((name) => {
      const match = setCookies.join(",").match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
      return match ? `${name}=${match[1]}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

let backend;
let product;
let advertisingProduct;
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

  if (localAdvertisingProduct) {
    if (!existsSync(join(repo, "examples", "mvp-anonymous-express", "node_modules", "express"))) {
      throw new Error(
        "Install the advertising example first: pnpm --dir examples/mvp-anonymous-express install --no-frozen-lockfile",
      );
    }
    advertisingProduct = start("node", ["index.js"], {
      cwd: join(repo, "examples", "mvp-anonymous-express"),
      label: "Anonymous advertising example",
      env: {
        EPODE_API_KEY: apiKey,
        EPODE_API_URL: backendUrl,
        VISITOR_COOKIE_SECRET: randomBytes(32).toString("base64url"),
        PORT: "4305",
      },
    });
    await waitFor(`${advertisingProductUrl}/health`, advertisingProduct, 30_000);
  }

  const firstResponse = await fetch(`${productUrl}/api/recommendations`, {
    headers: {
      "user-agent": "Epode-E2E-Browser/1.0",
      "accept-language": "en-US,en;q=0.9",
      referer: "https://shop.example.test/discover?private=discard-me",
      "sec-ch-ua": '"Epode E2E";v="1"',
      "sec-ch-ua-platform": '"macOS"',
      "sec-ch-ua-mobile": "?0",
    },
  });
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
  // Consentless enrichment: the very first response is submit-ready with the
  // field catalog. No question is asked; the opt-out endpoint stays available.
  assert.equal(request.state, "answer_ready");
  assert.equal(request.identityLevel, "pseudonymous");
  assert.equal(request.question, null);
  assert.match(request.stageInstruction, /submit at most one bounded answer/i);
  assert.doesNotMatch(request.stageInstruction, /permission|approval/i);
  assertAgentAction(request.consent, "/_epode/v1/enrichment/consent");
  assert.deepEqual(request.consent.bodySchema.decision, ["approved", "declined"]);
  assertAgentAction(request.submit, "/_epode/v1/enrichment/answers");
  assert.deepEqual(request.submit.bodySchema.status, [
    "answered",
    "declined",
    "no_relevant_context",
  ]);
  assert.equal(request.submit.bodySchema.items.maximum, 8);
  assert.ok(request.submit.bodySchema.items.required.includes("provenance"));
  assert.equal(request.submit.bodySchema.items.catalogVersion, "v1");
  assert.ok(
    request.submit.bodySchema.items.catalog.some(
      (entry) => entry.key === "shopping.priority" && entry.targetedAdvertisingSafe === true,
    ),
  );

  const answerResponse = await fetch(`${productUrl}${request.submit.url}`, {
    method: "POST",
    headers: {
      authorization: request.submit.authorization,
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

  const firstAdvertisingResponse = await fetch(`${advertisingProductUrl}/api/discover`);
  const firstAdvertising = await json(firstAdvertisingResponse, "anonymous advertising placement");
  const advertisingCookie = responseCookieHeader(firstAdvertisingResponse, [
    "example_visitor",
    "example_journey",
  ]);
  const advertisingVisitorCookie = advertisingCookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("example_visitor="));
  assert.ok(advertisingVisitorCookie, "the publisher must issue a first-party visitor ID");
  assert.match(
    advertisingCookie,
    /example_journey=/,
    "the publisher must issue a bounded journey ID",
  );
  assert.equal(firstAdvertising.personalized, false);
  assert.equal(firstAdvertising.placement.campaign, "general");
  const advertisingRequest = firstAdvertising._epode?.customerContext;
  assert.equal(advertisingRequest.purpose, "targeted_advertising");
  assert.equal(advertisingRequest.identityLevel, "pseudonymous");
  assert.equal(advertisingRequest.state, "answer_ready");
  assertAgentAction(advertisingRequest.consent, "/_epode/v1/enrichment/consent");
  assertAgentAction(advertisingRequest.submit, "/_epode/v1/enrichment/answers");
  assert.ok(
    advertisingRequest.submit.bodySchema.items.catalog.some(
      (entry) =>
        entry.key === "interest.topic" &&
        entry.type === "preference" &&
        entry.allowedValues.includes("outdoor_travel") &&
        entry.targetedAdvertisingSafe === true,
    ),
    "the advertising contract must expose the bounded interest consumed by the example",
  );

  const advertisingAnswer = await json(
    await fetch(`${advertisingProductUrl}${advertisingRequest.submit.url}`, {
      method: "POST",
      headers: {
        authorization: advertisingRequest.submit.authorization,
        "content-type": "application/json",
        cookie: advertisingCookie,
      },
      body: JSON.stringify({
        status: "answered",
        items: [
          {
            key: "interest.topic",
            type: "preference",
            value: "outdoor_travel",
            provenance: "agent_reports_user_statement",
            confidence: 1,
            remember: true,
          },
        ],
      }),
    }),
    "advertising context answer",
  );
  assert.equal(advertisingAnswer.signals.length, 1);
  assert.deepEqual(advertisingAnswer.signals[0].allowedUses, ["targeted_advertising"]);

  const personalizedAdvertising = await json(
    await fetch(`${advertisingProductUrl}/api/discover`, {
      headers: { cookie: advertisingCookie },
    }),
    "personalized advertising placement",
  );
  assert.equal(personalizedAdvertising.personalized, true);
  assert.equal(personalizedAdvertising.placement.campaign, "outdoor-travel");
  assert.match(personalizedAdvertising.decisionId, /^[0-9a-f-]{36}$/);

  const advertisingOutcome = await json(
    await fetch(`${advertisingProductUrl}/api/ad-events`, {
      method: "POST",
      headers: { cookie: advertisingCookie, "content-type": "application/json" },
      body: JSON.stringify({ event: "clicked" }),
    }),
    "advertising engagement outcome",
  );
  assert.equal(advertisingOutcome.measured, true);

  const advertisingAnonymousRef = advertisingVisitorCookie
    .slice("example_visitor=".length)
    .split(".")[0];
  const wrongPurposeContext = await json(
    await fetch(`${backendUrl}/api/v2/customer-context`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        anonymousRef: advertisingAnonymousRef,
        purpose: "product_personalization",
      }),
    }),
    "advertising-to-product purpose isolation",
  );
  assert.deepEqual(
    wrongPurposeContext.items,
    [],
    "advertising permission must not authorize general product personalization",
  );

  const unsafeAdvertisingResponse = await fetch(`${advertisingProductUrl}/api/discover`);
  const unsafeAdvertising = await json(unsafeAdvertisingResponse, "unsafe advertising probe");
  const unsafeAdvertisingCookie = responseCookieHeader(unsafeAdvertisingResponse, [
    "example_visitor",
    "example_journey",
  ]);
  const unsafeSubmit = unsafeAdvertising._epode.customerContext.submit;
  const unsafeAnswerResponse = await fetch(`${advertisingProductUrl}${unsafeSubmit.url}`, {
    method: "POST",
    headers: {
      authorization: unsafeSubmit.authorization,
      "content-type": "application/json",
      cookie: unsafeAdvertisingCookie,
    },
    body: JSON.stringify({
      status: "answered",
      items: [
        {
          key: "b2b.company_size",
          type: "constraint",
          value: "enterprise",
          provenance: "agent_reports_user_statement",
          confidence: 1,
          remember: true,
        },
      ],
    }),
  });
  assert.equal(unsafeAnswerResponse.status, 400);
  assert.deepEqual(await unsafeAnswerResponse.json(), {
    error: "Customer context key is not approved for targeted advertising",
  });

  const stored = JSON.parse(
    database("read-enrichment")
      .split("\n")
      .findLast((line) => line.trim().startsWith("{")),
  );
  assert.equal(stored.answers.length, 2);
  assert.equal(stored.signals.length, 4);
  const observedRequest = stored.requestObservations.find(
    (entry) => entry.userAgent === "Epode-E2E-Browser/1.0",
  );
  assert.ok(observedRequest, "company middleware must persist automatic request facts");
  assert.match(observedRequest.clientIp, /^(?:\d{1,3}\.){3}\d{1,3}$|:/);
  assert.equal(observedRequest.method, "GET");
  assert.equal(observedRequest.acceptLanguage, "en-US,en;q=0.9");
  assert.equal(observedRequest.referrerOrigin, "https://shop.example.test");
  assert.equal(observedRequest.secChUa, '"Epode E2E";v="1"');
  assert.equal(observedRequest.secChUaPlatform, '"macOS"');
  assert.equal(observedRequest.secChUaMobile, "?0");
  assert.doesNotMatch(JSON.stringify(observedRequest), /private=discard-me|cookie|authorization/i);
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
  assert.ok(
    stored.contextRetrievals.some(
      (entry) => entry.purpose === "targeted_advertising" && entry.itemCount === 1,
    ),
  );
  assert.ok(
    stored.signals.some(
      (entry) =>
        entry.key === "interest.topic" &&
        entry.value === "outdoor_travel" &&
        entry.provenance === "agent_reports_user_statement",
    ),
  );
  assert.ok(stored.decisions.length >= 3);
  assert.ok(
    stored.decisions.some(
      (entry) => entry.purpose === "targeted_advertising" && entry.variant === "outdoor-travel",
    ),
  );
  assert.deepEqual(
    new Set(stored.outcomes.map((entry) => entry.outcome)),
    new Set(["conversion", "engagement"]),
  );
  assert.ok(stored.resolutions.length >= 1, "anonymous history must resolve after sign-in");
  assert.ok(stored.sessions.length >= 3, "both product journeys must preserve bounded sessions");
  assert.ok(
    stored.interactions.every(
      (interaction) =>
        interaction.surface === "http_json" &&
        interaction.statusCode === 200 &&
        Number.isSafeInteger(interaction.durationMs) &&
        interaction.durationMs >= 0 &&
        interaction.sessionId,
    ),
    "same-call interactions must retain surface, timing, and product journey evidence",
  );
  assert.ok(
    stored.interactions.some((interaction) => interaction.runtimeHint === "retail-express/1.0"),
  );
  assert.ok(
    stored.interactions.some((interaction) => interaction.runtimeHint === "anonymous-express/1.0"),
  );

  console.log(
    JSON.stringify({
      ok: true,
      journey: "anonymous-enrich-personalize-convert-resolve-and-advertise",
      requests: stored.requests.length,
      signals: stored.signals.length,
      decisions: stored.decisions.length,
      outcomes: stored.outcomes.length,
      resolutions: stored.resolutions.length,
      requestObservations: stored.requestObservations.length,
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
