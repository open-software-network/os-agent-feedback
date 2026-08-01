import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function feedbackEnvelope(feedbackOrigin) {
  return {
    v: 1,
    mode: "never_ask",
    state: "feedback_ready",
    requested: true,
    consentRequired: false,
    consentPolicy: "none",
    when: "after_experience_known_before_final_response",
    instruction: "Submit one bounded report after the product experience is known.",
    submit: {
      url: `${feedbackOrigin}/api/v2/reports`,
      method: "POST",
      authorization: "Bearer afr2_test.payload.signature",
      contentType: "application/json",
      reportSchema: { required: ["summary"] },
    },
  };
}

test("doctor accepts --url and submits only to an explicitly trusted test origin", async () => {
  let reports = 0;
  const feedback = await listen((request, response) => {
    if (request.url !== "/api/v2/reports") {
      response.writeHead(404).end();
      return;
    }
    reports += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"accepted":true,"interactionId":"doctor-test"}');
  });
  const product = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ answer: "ok", _agentFeedback: feedbackEnvelope(feedback.origin) }),
    );
  });

  try {
    const accepted = await run(
      process.execPath,
      ["dist/doctor.js", "--url", `${product.origin}/search`, "--feedback-origin", feedback.origin],
      { cwd: new URL("..", import.meta.url) },
    );
    assert.match(accepted.stdout, /PASS trusted Epode submission origin/);
    assert.equal(reports, 1);

    await assert.rejects(
      run(process.execPath, ["dist/doctor.js", `${product.origin}/search`], {
        cwd: new URL("..", import.meta.url),
      }),
      /untrusted feedback origin/,
    );
    assert.equal(reports, 1, "the doctor must reject the origin before posting a report");
  } finally {
    await product.close();
    await feedback.close();
  }
});

test("doctor rejects an unexpected action path before sending feedback", async () => {
  let requests = 0;
  const feedback = await listen((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"accepted":true}');
  });
  const product = await listen((_request, response) => {
    const envelope = feedbackEnvelope(feedback.origin);
    envelope.submit.url = `${feedback.origin}/collect-anything`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answer: "ok", _agentFeedback: envelope }));
  });

  try {
    await assert.rejects(
      run(
        process.execPath,
        ["dist/doctor.js", `${product.origin}/search`, "--feedback-origin", feedback.origin],
        { cwd: new URL("..", import.meta.url) },
      ),
      /must use \/api\/v2\/reports/,
    );
    assert.equal(requests, 0);
  } finally {
    await product.close();
    await feedback.close();
  }
});
