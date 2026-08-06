import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const AGENT_UA = "Claude-User/1.0";

const batchSchema = JSON.parse(
  await readFile(new URL("../protocol/v1/telemetry-batch.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateBatch = ajv.compile(batchSchema);

function startCollector() {
  const batches = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/v2/telemetry/batches") {
        const parsed = JSON.parse(body);
        batches.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: parsed.events.length, dropped: 0 }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        batches,
        port: server.address().port,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function events(batches) {
  return batches.flatMap((batch) => batch.events);
}

async function waitForEvents(batches, predicate, deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate(events(batches))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`telemetry deadline: only saw ${JSON.stringify(events(batches), null, 2)}`);
}

async function fetchJson(base, path) {
  const response = await fetch(`${base}${path}`, { headers: { "user-agent": AGENT_UA } });
  return { response, body: await response.json() };
}

test("experience payloads flow from graph hops to schema-valid telemetry batches", async () => {
  const collector = await startCollector();
  process.env.EPODE_API_KEY =
    "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse";
  process.env.EPODE_API_URL = `http://127.0.0.1:${collector.port}`;
  const { startServer } = await import(
    "../examples/agent-experience-commerce/server.mjs?telemetry-e2e"
  );
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const guide = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } }).then((r) =>
      r.text(),
    );
    const negotiateUrl = guide.match(
      /lamp: (http:\/\/127\.0\.0\.1:\d+\/agent-negotiate\/j-[a-f0-9-]+\/lamp)/i,
    )?.[1];
    assert.ok(negotiateUrl, "guide must include a negotiation URL");
    const journeyPath = negotiateUrl.replace(base, "");

    let { body: node } = await fetchJson(base, journeyPath);
    const considerBudget = node.nextQuestion.choices.find((choice) => choice.value === "budget");
    ({ body: node } = await fetchJson(base, considerBudget.url.replace(base, "")));
    const hard150 = node.nextQuestion.choices.find(
      (choice) => choice.value === "150" && choice.strength === "hard",
    );
    ({ body: node } = await fetchJson(base, hard150.url.replace(base, "")));
    assert.equal(node.stage, "express_more_or_decide");

    ({ body: node } = await fetchJson(base, node.resultsUrl.replace(base, "")));
    assert.equal(node.exactMatchCount, 5);
    const detailUrl = node.exactMatches[0].detailUrl;
    const { body: detail } = await fetchJson(base, detailUrl.replace(base, ""));
    assert.equal(detail.searchAttribution.resultPosition, 1);

    const productBase = detail.evaluationGraph.startUrl.replace(base, "");
    const { body: productNode } = await fetchJson(base, productBase);
    const considerChoice = productNode.nextQuestion?.choices?.[0];
    assert.ok(considerChoice, "product node must offer a consider edge");
    const { body: consideredProduct } = await fetchJson(base, considerChoice.url.replace(base, ""));
    const valueChoice = consideredProduct.nextQuestion?.choices?.[0];
    assert.ok(valueChoice, "considered product node must offer a value edge");
    const { body: expressedProduct } = await fetchJson(base, valueChoice.url.replace(base, ""));
    assert.ok(["express_more_or_evaluate", "ready_to_evaluate"].includes(expressedProduct.stage));
    const { response: fitResponse } = await fetchJson(base, `${productBase}/evaluate-fit`);
    assert.equal(fitResponse.status, 422);

    const evidenceDecidePath = `${journeyPath.replace("/agent-negotiate/", "/agent-decide/")}/budget-hard-150/evidence-glare-control`;
    const { response: evidenceResponse, body: evidenceNode } = await fetchJson(
      base,
      evidenceDecidePath,
    );
    assert.equal(evidenceResponse.status, 200);
    assert.ok(
      evidenceNode.nearMisses.some((match) =>
        match.violatedHardConstraints.some(
          (violation) => violation.dimension === "evidence:glare_control",
        ),
      ),
      "decide with an evidence requirement must produce evidence-dimension violations",
    );

    await waitForEvents(collector.batches, (seen) => {
      return (
        seen.some((event) => event.operation === "/agent-item") &&
        seen.some((event) => event.operation === "/agent-product/lamp/evaluate-fit") &&
        seen.some((event) =>
          ["express_more_or_evaluate", "ready_to_evaluate"].includes(event.experience?.stage),
        ) &&
        seen.some((event) =>
          event.experience?.decision?.violatedHardConstraints?.some(
            (violation) => violation.dimension === "evidence:glare_control",
          ),
        )
      );
    });

    for (const batch of collector.batches) {
      assert.ok(
        validateBatch(batch),
        `batch must satisfy the telemetry schema: ${JSON.stringify(validateBatch.errors)}`,
      );
    }

    const seen = events(collector.batches);
    const negotiation = seen.find(
      (event) =>
        event.operation === "/agent-negotiate/lamp" &&
        event.experience?.needState?.expressedDimensions,
    );
    assert.ok(negotiation, "an expressed-dimension negotiation hop must be recorded");
    assert.deepEqual(negotiation.experience.needState.expressedDimensions, ["budget"]);
    assert.equal(negotiation.experience.stage, "express_more_or_decide");

    const decision = seen.find((event) => event.operation === "/agent-decide/lamp");
    assert.equal(decision.experience.stage, "decision_support");
    assert.equal(decision.experience.decision.exactMatchCount, 5);
    assert.equal(decision.experience.decision.nearMissCount, 3);
    assert.ok(decision.experience.decision.violatedHardConstraints.length >= 3);
    assert.equal(decision.experience.decision.counterfactuals, undefined);

    const item = seen.find((event) => event.operation === "/agent-item");
    assert.equal(item.experience.search.resultPosition, 1);
    assert.ok(item.experience.search.searchId);

    const fit = seen.find((event) => event.operation === "/agent-product/lamp/evaluate-fit");
    assert.equal(fit.statusCode, 422);

    for (const event of seen) {
      assert.equal(event.sessionSource, "customer");
      assert.equal(event.classification, "unclassified");
    }
  } finally {
    await started.close();
    await collector.close();
    delete process.env.EPODE_API_KEY;
    delete process.env.EPODE_API_URL;
  }
});
