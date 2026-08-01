import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`manual HTTP server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(100) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timed out waiting for manual HTTP server");
}

test("manual Ask once HTTP stays nonblocking and subject-bound during Epode outage", async () => {
  let consentRequests = 0;
  const epode = createServer((request, response) => {
    request.resume();
    if (request.url === "/api/v2/consent/state") {
      consentRequests += 1;
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end('{"error":"unavailable"}');
        }
      }, 2_000);
      return;
    }
    if (request.url === "/api/v2/telemetry/batches") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const epodePort = await listen(epode);

  const reservation = createServer();
  const productPort = await listen(reservation);
  await new Promise((resolveClose) => reservation.close(resolveClose));

  const keyId = "1".repeat(32);
  const consentScope = "2".repeat(32);
  const apiKey = `af_live_${keyId}_${consentScope}_${"secret".repeat(5)}`;
  const productAuthSecret = "manual-http-nonblocking-product-auth";
  const child = spawn("python3", ["server.py"], {
    cwd: resolve(repo, "examples/setup-matrix-manual-http"),
    env: {
      ...process.env,
      PORT: String(productPort),
      AGENT_FEEDBACK_KEY: apiKey,
      AGENT_FEEDBACK_URL: `http://127.0.0.1:${epodePort}`,
      AGENT_FEEDBACK_MODE: "ask_once",
      AGENT_FEEDBACK_CONSENT_TIMEOUT_MS: "1500",
      SETUP_MATRIX_PRODUCT_AUTH_SECRET: productAuthSecret,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitFor(`http://127.0.0.1:${productPort}/health`, child);
    const customerRef = "account-during-outage";
    const payload = Buffer.from(customerRef, "utf8").toString("base64url");
    const signature = createHmac("sha256", productAuthSecret).update(payload).digest("base64url");
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${productPort}/search`, {
      headers: { authorization: `Bearer ${payload}.${signature}` },
    });
    const elapsed = performance.now() - started;
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(elapsed < 1_000, `product response waited ${Math.round(elapsed)}ms for Epode`);
    assert.equal(body._agentFeedback.mode, "ask_once");
    assert.equal(body._agentFeedback.state, "consent_required");
    const capability = body._agentFeedback.requiredAction.submitDecision.authorization
      .replace(/^Bearer /, "")
      .split(".");
    const claims = JSON.parse(Buffer.from(capability[1], "base64url").toString("utf8"));
    assert.match(claims.s, /^afsub1_/);
    assert.doesNotMatch(JSON.stringify(claims), /account-during-outage/);

    for (let attempt = 0; attempt < 50 && consentRequests === 0; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(
      consentRequests,
      1,
      "eligible response did not start a background consent refresh",
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
    ]);
    epode.closeAllConnections();
    await new Promise((resolveClose) => epode.close(resolveClose));
  }
});
