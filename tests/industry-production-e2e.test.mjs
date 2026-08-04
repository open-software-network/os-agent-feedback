import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { INDUSTRY_E2E_PRODUCTS } from "../experiments/agent-compliance/industry-e2e-config.mjs";
import { runIndustryProductionE2E } from "../experiments/agent-compliance/industry-production-e2e.mjs";

test("production industry matrix has distinct products and bounded multi-journey context", () => {
  assert.deepEqual(
    INDUSTRY_E2E_PRODUCTS.slice(0, 4).map((product) => product.productName),
    [
      "Shopwise Retail Demo",
      "Tripwise Travel Demo",
      "Ledgerwise Finance Demo",
      "Carewise Healthcare Demo",
    ],
  );
  assert.equal(
    new Set(INDUSTRY_E2E_PRODUCTS.map((product) => product.slug)).size,
    INDUSTRY_E2E_PRODUCTS.length,
  );
  assert.equal(
    new Set(INDUSTRY_E2E_PRODUCTS.map((product) => product.actionTool)).size,
    INDUSTRY_E2E_PRODUCTS.length,
  );
  for (const product of INDUSTRY_E2E_PRODUCTS) {
    assert.ok(Object.keys(product.query).length >= 2, product.slug);
    assert.ok(product.rememberedItems.length >= 3, product.slug);
    assert.ok(product.followupItems.length >= 1, product.slug);
    assert.ok(product.sessionItems.length >= 1, product.slug);
    assert.ok(product.rejectedItem.key.includes("."), product.slug);
    for (const item of [
      ...product.rememberedItems,
      ...product.followupItems,
      ...product.sessionItems,
    ]) {
      assert.match(item.key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
      assert.match(item.value, /^[a-z0-9_]+$/);
      assert.ok(["preference", "constraint", "intent", "interest"].includes(item.type));
      assert.ok(item.summary.length >= 3 && item.summary.length <= 350);
      assert.equal(item.remember, true);
    }
    assert.equal("prompt" in product, false);
    assert.equal("memory" in product, false);
    assert.equal("transcript" in product, false);
  }
});

test("finance and healthcare runs include explicit sensitive-boundary attempts", () => {
  const finance = INDUSTRY_E2E_PRODUCTS.find((product) => product.slug === "ledgerwise");
  const healthcare = INDUSTRY_E2E_PRODUCTS.find((product) => product.slug === "carewise");
  assert.equal(finance.rejectedItem.key, "private.financial_profile");
  assert.equal(healthcare.rejectedItem.key, "private.clinical_profile");
  assert.equal(finance.rejectedItem.value, "not_shared");
  assert.equal(healthcare.rejectedItem.value, "not_shared");
  assert.ok(
    finance.rememberedItems.every((item) => !/balance|income|credit|holding/i.test(item.key)),
  );
  assert.ok(
    healthcare.rememberedItems.every((item) => !/diagnosis|symptom|medication/i.test(item.key)),
  );
});

test("production execution is explicit and never inferred from a key file", async () => {
  const productKeys = Object.fromEntries(
    INDUSTRY_E2E_PRODUCTS.map((product) => [product.slug, "af_live_test_only"]),
  );
  await assert.rejects(
    runIndustryProductionE2E({ productKeys }),
    /endpoint is required; production is never selected implicitly/,
  );
  await assert.rejects(
    runIndustryProductionE2E({ productKeys, endpoint: "https://api.epode.ai" }),
    /Production execution requires confirmProduction: true/,
  );
});

test("production runner can be imported by desktop harnesses without a process global", async () => {
  const runnerUrl = new URL(
    "../experiments/agent-compliance/industry-production-e2e.mjs",
    import.meta.url,
  ).href;
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "--eval",
    `globalThis.process = undefined; await import(${JSON.stringify(runnerUrl)});`,
  ]);
});

test("production runner loads MCP through its package instead of importing its internal CJS file", async () => {
  const runnerUrl = new URL(
    "../experiments/agent-compliance/industry-production-e2e.mjs",
    import.meta.url,
  );
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /require\("@modelcontextprotocol\/server"\)/);
  assert.doesNotMatch(source, /require\.resolve\("@modelcontextprotocol\/server"\)/);
  assert.doesNotMatch(source, /import\(pathToFileURL\(packageEntry\)/);
});
