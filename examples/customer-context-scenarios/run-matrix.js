import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { customerContextScenarios } from "./matrix.js";

const catalog = new Map([
  ["shopping.priority", ["preference", ["price", "quality", "speed", "convenience", "sustainability"]]],
  ["shopping.sustainability", ["preference", ["low", "medium", "high"]]],
  ["shopping.budget_band", ["constraint", ["under_50", "50_150", "150_500", "over_500", "flexible"]]],
  ["shopping.delivery_window", ["constraint", ["same_day", "next_day", "two_to_three_days", "within_week", "flexible"]]],
  ["content.format", ["preference", ["short", "long_form", "video", "audio", "interactive"]]],
  ["content.topic_depth", ["preference", ["overview", "practical", "expert"]]],
  ["interest.topic", ["preference", ["outdoor_travel", "technology", "wellness", "home", "entertainment"]]],
  ["b2b.company_size", ["constraint", ["solo", "small", "mid_market", "enterprise"]]],
  ["b2b.primary_goal", ["intent", ["evaluate", "integrate", "automate", "analyze", "collaborate"]]],
  ["b2b.purchase_timeline", ["intent", ["now", "this_month", "this_quarter", "later", "exploring"]]],
  ["b2b.integration_priority", ["preference", ["security", "reliability", "speed", "ease_of_use", "cost", "interoperability"]]],
]);

const stableKey = (product, identity) => {
  if (identity.userRef) return `${product}:account:${identity.accountRef || "-"}:user:${identity.userRef}`;
  if (identity.anonymousRef) return `${product}:anonymous:${identity.anonymousRef}`;
  throw new Error("A stable userRef or anonymousRef is required");
};

const sessionKey = (product, identity, sessionRef) =>
  `${stableKey(product, identity)}:session:${sessionRef}`;

const sortedKeys = (items) => [...items].map((item) => item.key).sort();

const validSignal = (item) => {
  const definition = catalog.get(item.key);
  return Boolean(
    definition &&
      item.type === definition[0] &&
      definition[1].includes(item.value) &&
      [
        "agent_reports_user_statement",
        "agent_reports_current_task",
        "agent_inference",
      ].includes(item.provenance) &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 0 &&
      item.confidence <= 1,
  );
};

export class CustomerContextStateMachine {
  constructor() {
    this.customerConsent = new Map();
    this.sessionConsent = new Map();
    this.customerSignals = new Map();
    this.sessionSignals = new Map();
    this.trace = [];
    this.sequence = 0;
  }

  record(event, detail) {
    this.sequence += 1;
    this.trace.push({ sequence: this.sequence, event, ...detail });
  }

  permission(product, identity, sessionRef) {
    const customer = stableKey(product, identity);
    const session = sessionKey(product, identity, sessionRef);
    return this.sessionConsent.get(session) || this.customerConsent.get(customer) || "not_set";
  }

  retrieve({ product, identity, sessionRef, operation, query }) {
    const customer = stableKey(product, identity);
    const session = sessionKey(product, identity, sessionRef);
    const items = [
      ...(this.customerSignals.get(customer)?.values() || []),
      ...(this.sessionSignals.get(session)?.values() || []),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const permission = this.permission(product, identity, sessionRef);
    this.record("context_retrieved", {
      product,
      customer,
      sessionRef,
      operation,
      queryProvided: Boolean(query),
      permission,
      signalKeys: sortedKeys(items),
    });
    return { items, permission };
  }

  share({ product, identity, sessionRef, operation, query, choice, signals }) {
    const customer = stableKey(product, identity);
    const session = sessionKey(product, identity, sessionRef);
    const existing = this.permission(product, identity, sessionRef);
    const elicited = existing === "not_set";
    this.record("request_created", {
      product,
      customer,
      sessionRef,
      operation,
      queryProvided: Boolean(query),
    });

    const effectiveChoice = existing === "not_set" ? choice : existing;
    if (elicited) {
      assert.ok(
        ["always_allow", "this_session_only", "dont_allow"].includes(choice),
        "A first request requires one explicit MCP elicitation choice",
      );
      this.record("permission_elicited", { product, customer, sessionRef });
      if (choice === "this_session_only") this.sessionConsent.set(session, choice);
      else this.customerConsent.set(customer, choice);
      this.record("permission_decided", {
        product,
        customer,
        sessionRef,
        choice,
        retention: choice === "always_allow" ? "customer" : choice === "this_session_only" ? "session" : "none",
      });
    }

    if (effectiveChoice === "dont_allow") {
      this.record("context_declined", { product, customer, sessionRef });
      return { state: "declined", elicited, accepted: [], rejected: [], retention: "none" };
    }

    const retention = effectiveChoice === "always_allow" ? "customer" : "session";
    const accepted = [];
    const rejected = [];
    for (const item of signals) {
      if (validSignal(item)) {
        accepted.push({
          ...item,
          remember: retention === "customer",
          sourceSessionRef: sessionRef,
          sourceOperation: operation,
        });
      }
      else rejected.push({ ...item });
    }
    const target = retention === "customer" ? this.customerSignals : this.sessionSignals;
    const targetKey = retention === "customer" ? customer : session;
    if (!target.has(targetKey)) target.set(targetKey, new Map());
    for (const item of accepted) {
      target.get(targetKey).set(item.key, item);
    }
    this.record("context_submitted", {
      product,
      customer,
      sessionRef,
      retention,
      acceptedKeys: sortedKeys(accepted),
      rejectedKeys: sortedKeys(rejected),
      provenance: Object.fromEntries(accepted.map((item) => [item.key, item.provenance])),
    });
    return {
      state: accepted.length > 0 ? "answered" : "no_relevant_context",
      elicited,
      accepted,
      rejected,
      retention,
    };
  }

  endSession({ product, identity, sessionRef }) {
    const session = sessionKey(product, identity, sessionRef);
    const removedSignals = this.sessionSignals.get(session)?.size || 0;
    this.sessionSignals.delete(session);
    this.sessionConsent.delete(session);
    this.record("session_ended", { product, sessionRef, removedSignals });
    return { removedSignals };
  }
}

const verify = (step, actual) => {
  const expected = step.expect;
  if (!expected) return;
  if (step.action === "retrieve") {
    assert.deepEqual(sortedKeys(actual.items), expected.keys);
    assert.equal(actual.permission, expected.permission);
    return;
  }
  assert.equal(actual.state, expected.state);
  assert.equal(actual.elicited, expected.elicited);
  assert.equal(actual.retention, expected.retention);
  assert.deepEqual(sortedKeys(actual.accepted), expected.acceptedKeys);
  assert.deepEqual(sortedKeys(actual.rejected), expected.rejectedKeys || []);
};

export function runScenario(scenario) {
  const state = new CustomerContextStateMachine();
  const results = [];
  for (const [index, step] of scenario.steps.entries()) {
    const input = { ...step, product: scenario.product };
    let result;
    if (step.action === "retrieve") result = state.retrieve(input);
    else if (step.action === "share") result = state.share(input);
    else if (step.action === "end_session") result = state.endSession(input);
    else throw new Error(`Unknown scenario action: ${step.action}`);
    verify(step, result);
    results.push({ index, action: step.action, result });
  }
  return { scenario, results, trace: state.trace };
}

export function runScenarioMatrix(scenarios = customerContextScenarios) {
  return scenarios.map(runScenario);
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  const reports = runScenarioMatrix().map(({ scenario, trace }) => ({
    id: scenario.id,
    product: scenario.product,
    industry: scenario.industry,
    transitions: trace,
  }));
  process.stdout.write(`${JSON.stringify({ scenarios: reports }, null, 2)}\n`);
}
