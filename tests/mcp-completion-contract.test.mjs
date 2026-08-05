import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const conformance = await readJson("protocol/v1/conformance.json");
const telemetrySchema = await readJson("protocol/v1/telemetry-batch.schema.json");
const completion = conformance.mcpCompletion;
const linkedJourney = conformance.mcpLinkedJourney;

const operationPattern = /^[A-Za-z0-9/_:.*{}-]{1,160}$/;
const referencePattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const asciiWhitespaceEnds = /^[\t-\r ]+|[\t-\r ]+$/g;

function trimAsciiWhitespace(value) {
  return value.replace(asciiWhitespaceEnds, "");
}

function optionalReference(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = trimAsciiWhitespace(value);
  return referencePattern.test(trimmed) ? trimmed : undefined;
}

function optionalRuntimeHint(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = trimAsciiWhitespace(value);
  const codePoints = Array.from(trimmed).length;
  return codePoints > 0 && codePoints <= 200 ? trimmed : undefined;
}

function errorKind(input) {
  if (!operationPattern.test(input.operation) || input.operation.includes("://")) {
    return "invalid_operation";
  }
  return ["success", "error"].includes(input.outcome) ? undefined : "invalid_outcome";
}

function expectedEvent(input) {
  if (errorKind(input)) return null;
  const accountRef = optionalReference(input.accountRef);
  const userRef = optionalReference(input.userRef);
  const anonymousRef = optionalReference(input.anonymousRef);
  let customerRef = optionalReference(input.customerRef);
  const sessionRef = optionalReference(input.sessionRef);
  const runtimeHint = optionalRuntimeHint(input.runtimeHint);
  if (customerRef && (accountRef || userRef) && accountRef !== customerRef) {
    customerRef = undefined;
  }
  return {
    surface: "mcp",
    operation: input.operation,
    statusCode: input.outcome === "success" ? 200 : 500,
    classification: "confirmed",
    confirmationMethod: "mcp",
    ...(accountRef ? { accountRef } : {}),
    ...(userRef ? { userRef } : {}),
    ...(anonymousRef ? { anonymousRef } : {}),
    ...(customerRef ? { customerRef } : {}),
    ...(sessionRef ? { sessionRef, sessionSource: "mcp" } : {}),
    ...(runtimeHint ? { runtimeHint, runtimeHintSource: "mcp" } : {}),
  };
}

test("completed MCP interaction vectors lock the constrained caller and SDK-owned fields", () => {
  assert.equal(completion.version, 1);
  assert.deepEqual(completion.callerFields, [
    "operation",
    "outcome",
    "accountRef",
    "userRef",
    "anonymousRef",
    "customerRef",
    "sessionRef",
    "runtimeHint",
  ]);
  assert.deepEqual(completion.generatedFields, {
    interactionId: "uuid-v4",
    sequence: "positive-monotonic-runtime-integer",
    occurredAt: "rfc3339-utc-completion-time",
  });
  assert.deepEqual(completion.expectedEventComparison, {
    mode: "exact-projection",
    omit: ["interactionId", "sequence", "occurredAt"],
    optionalAdapterMeasured: { durationMs: "nonnegative-integer" },
  });
  assert.deepEqual(
    completion.vectors.map(({ name }) => name),
    [
      "success_linked",
      "success_progressive_identity",
      "success_result_derived_session",
      "error_unlinked",
      "invalid_optionals_fail_open",
      "legacy_identity_conflict_fail_open",
      "trimmed_optionals",
      "runtime_hint_unicode_boundary",
      "invalid_operation",
      "invalid_raw_url_operation",
      "invalid_outcome",
    ],
  );

  const allowedFields = new Set(completion.callerFields);
  for (const vector of completion.vectors) {
    assert.equal(typeof vector.input.operation, "string", `${vector.name} has an operation`);
    assert.equal(typeof vector.input.outcome, "string", `${vector.name} has an outcome`);
    for (const field of Object.keys(vector.input)) {
      assert.equal(
        allowedFields.has(field),
        true,
        `${vector.name} exposes SDK-owned field ${field}`,
      );
    }
    assert.deepEqual(vector.expectedEvent, expectedEvent(vector.input), vector.name);
    if (vector.expectedEvent === null) {
      assert.equal(
        vector.expectedErrorKind,
        errorKind(vector.input),
        `${vector.name} declares its semantic validation failure`,
      );
    } else {
      assert.equal(
        vector.expectedErrorKind,
        undefined,
        `${vector.name} unexpectedly declares an error`,
      );
    }
  }
});

test("linked journey fixture locks the prototype session semantics", () => {
  assert.equal(linkedJourney.version, 1);
  assert.deepEqual(Object.keys(linkedJourney.identity).sort(), [
    "accountRef",
    "anonymousRef",
    "userRef",
  ]);
  assert.equal(
    Object.values(linkedJourney.identity).every((value) => value.length > 0),
    true,
  );
  assert.equal(linkedJourney.runtimeHint.length > 0, true);
  assert.equal(linkedJourney.privateContentSentinel.length > 0, true);
  assert.deepEqual(
    linkedJourney.runs.map(({ name }) => name),
    ["A", "B"],
  );
  assert.notEqual(linkedJourney.runs[0].sessionRef, linkedJourney.runs[1].sessionRef);
  for (const run of linkedJourney.runs) {
    assert.deepEqual(run.completions, [
      { operation: "summarize", outcome: "success" },
      { operation: "get_summary", outcome: "success" },
      { operation: "get_summary", outcome: "success" },
      { operation: "get_summary", outcome: "success" },
    ]);
  }
  assert.deepEqual(linkedJourney.unlinked, [
    { operation: "get_summary", outcome: "success", proof: "missing" },
    {
      operation: "get_summary",
      outcome: "error",
      proof: "invalid",
      candidateSessionRef: "summary/invalid proof",
    },
  ]);
});

test("every emitted completion vector is valid telemetry and keeps source fields conditional", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(telemetrySchema);
  let sequence = 0;

  for (const vector of completion.vectors) {
    if (vector.expectedEvent === null) continue;
    sequence += 1;
    const event = {
      interactionId: `018f1f2e-7b4a-4c12-9c8d-${String(sequence).padStart(12, "0")}`,
      sequence,
      occurredAt: `2026-07-31T00:00:0${sequence}.000Z`,
      ...vector.expectedEvent,
    };
    assert.equal(
      validate({ events: [event] }),
      true,
      `${vector.name}: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal("sessionSource" in event, "sessionRef" in event, vector.name);
    assert.equal("runtimeHintSource" in event, "runtimeHint" in event, vector.name);

    const adapterEvent = { ...event, durationMs: sequence };
    const projected = { ...adapterEvent };
    for (const field of completion.expectedEventComparison.omit) delete projected[field];
    delete projected.durationMs;
    assert.deepEqual(projected, vector.expectedEvent, `${vector.name} exact projection`);
  }
});
