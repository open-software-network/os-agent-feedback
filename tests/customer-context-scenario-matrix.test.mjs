import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { customerContextScenarios } from "../examples/customer-context-scenarios/matrix.js";
import {
  CustomerContextStateMachine,
  runScenarioMatrix,
} from "../examples/customer-context-scenarios/run-matrix.js";

test("scenario matrix covers realistic industries, customers, sessions, choices, and provenance", () => {
  assert.deepEqual(customerContextScenarios.map((scenario) => scenario.industry).sort(), [
    "e-commerce",
    "education",
    "finance",
    "healthcare",
    "travel",
  ]);
  const steps = customerContextScenarios.flatMap((scenario) => scenario.steps);
  const choices = new Set(steps.map((step) => step.choice).filter(Boolean));
  assert.deepEqual(choices, new Set(["always_allow", "this_session_only", "dont_allow"]));
  assert.ok(new Set(steps.map((step) => step.sessionRef)).size >= 10);
  assert.ok(new Set(steps.map((step) => step.identity?.userRef).filter(Boolean)).size >= 7);
  const provenance = new Set(
    steps.flatMap((step) => step.signals || []).map((item) => item.provenance),
  );
  assert.deepEqual(
    provenance,
    new Set(["agent_reports_user_statement", "agent_reports_current_task", "agent_inference"]),
  );
});

test("all five scenarios execute their declared state transitions", () => {
  const reports = runScenarioMatrix();
  assert.equal(reports.length, 5);
  for (const { scenario, results, trace } of reports) {
    assert.equal(results.length, scenario.steps.length);
    assert.ok(trace.every((entry, index) => entry.sequence === index + 1));
    assert.ok(
      trace.some(
        (entry) => entry.event === "context_retrieved" || entry.event === "context_submitted",
      ),
    );
  }
});

test("every accepted scenario value exists in the backend production catalog", async () => {
  const backend = await readFile(new URL("../backend/src/store.rs", import.meta.url), "utf8");
  const start = backend.indexOf("const ENRICHMENT_CATALOG:");
  const end = backend.indexOf("fn enrichment_catalog_schema", start);
  assert.ok(start >= 0 && end > start, "backend catalog declaration is missing");
  const catalogSource = backend.slice(start, end);

  for (const scenario of customerContextScenarios) {
    for (const step of scenario.steps.filter((entry) => entry.action === "share")) {
      const accepted = new Set(step.expect.acceptedKeys);
      for (const item of step.signals.filter((entry) => accepted.has(entry.key))) {
        assert.ok(
          catalogSource.includes(`key: "${item.key}"`),
          `${scenario.product} uses unknown catalog key ${item.key}`,
        );
        assert.ok(
          catalogSource.includes(`"${item.value}"`),
          `${scenario.product} uses unknown catalog value ${item.key}:${item.value}`,
        );
      }
    }
  }
});

test("durable, session-only, declined, and identity-isolated flows produce different state", () => {
  const reports = new Map(runScenarioMatrix().map((report) => [report.scenario.id, report]));

  const commerce = reports.get("commerce-remembered-across-sessions");
  assert.equal(commerce.results[3].result.items.length, 3);
  assert.equal(commerce.results[4].result.items.length, 0);

  const travel = reports.get("travel-session-only-isolation");
  assert.equal(travel.results[1].result.items.length, 2);
  assert.equal(travel.results[2].result.removedSignals, 2);
  assert.equal(travel.results[3].result.items.length, 0);

  const finance = reports.get("finance-decline-and-sensitive-boundary");
  assert.equal(finance.results[0].result.state, "declined");
  assert.equal(finance.results[1].result.items.length, 0);
  assert.equal(finance.results[2].result.state, "no_relevant_context");
  assert.deepEqual(finance.results[2].result.rejected.map((item) => item.key).sort(), [
    "creditworthiness",
    "financial_account.balance",
  ]);
});

test("accepted context retains exact provenance and source linkage without raw prompts", () => {
  const reports = runScenarioMatrix();
  const submitted = reports.flatMap(({ trace }) =>
    trace.filter((entry) => entry.event === "context_submitted"),
  );
  assert.ok(submitted.length >= 5);
  for (const event of submitted) {
    assert.ok(event.sessionRef);
    assert.ok(event.retention === "customer" || event.retention === "session");
    assert.ok(Object.values(event.provenance).every((value) => value.startsWith("agent_")));
    assert.equal("prompt" in event, false);
    assert.equal("query" in event, false);
    assert.equal("memory" in event, false);
  }
  const healthcare = reports.find((report) => report.scenario.industry === "healthcare");
  const saved = healthcare.results[0].result.accepted;
  assert.ok(saved.every((item) => item.sourceSessionRef === "care_visit_1"));
  assert.ok(saved.every((item) => item.sourceOperation === "prepare_visit"));
  assert.ok(saved.every((item) => item.remember === true));
});

test("remembered approval removes repeat elicitation while session-only approval expires", () => {
  const state = new CustomerContextStateMachine();
  const identity = { accountRef: "account_1", userRef: "user_1" };
  const durable = state.share({
    product: "Example",
    identity,
    sessionRef: "one",
    operation: "search",
    query: "Prefer concise results",
    choice: "always_allow",
    signals: [
      {
        key: "content.format",
        type: "preference",
        value: "short",
        provenance: "agent_reports_user_statement",
        confidence: 1,
      },
    ],
  });
  assert.equal(durable.elicited, true);
  const repeat = state.share({
    product: "Example",
    identity,
    sessionRef: "two",
    operation: "search",
    query: "Prefer practical results too",
    signals: [
      {
        key: "content.topic_depth",
        type: "preference",
        value: "practical",
        provenance: "agent_reports_current_task",
        confidence: 1,
      },
    ],
  });
  assert.equal(repeat.elicited, false);
  assert.equal(state.trace.filter((entry) => entry.event === "permission_elicited").length, 1);
});

test("matrix runner emits deterministic machine-readable transition evidence", () => {
  const script = new URL("../examples/customer-context-scenarios/run-matrix.js", import.meta.url);
  const first = execFileSync(process.execPath, [script.pathname], { encoding: "utf8" });
  const second = execFileSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(first, second);
  const report = JSON.parse(first);
  assert.equal(report.scenarios.length, 5);
  assert.ok(report.scenarios.every((scenario) => scenario.transitions.length > 0));
});
