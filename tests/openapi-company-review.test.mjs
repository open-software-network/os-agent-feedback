import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  analyzeOpenApi,
  compileApprovedIr,
} from "../experiments/agent-compliance/openapi-company-review.mjs";

const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test("safe GET and HEAD operations are suggestions but remain excluded by default", async () => {
  const bytes = await readFile(fixtureUrl("openapi-company-review-safe.json"));
  const manifest = analyzeOpenApi(bytes, { sourceName: "safe.json" });

  assert.deepEqual(manifest.summary, {
    totalOperations: 3,
    readOnlyGetOrHead: 2,
    eligibleForCompanyReview: 2,
    excludedByPolicy: 1,
    approvedForIr: 0,
    exclusionReasonCounts: {
      method_not_read_only: 1,
      request_body_present: 1,
    },
  });
  assert.equal(manifest.compilerMode.defaultDecision, "exclude");
  assert.equal(manifest.compilerMode.networkAccess, "none");
  assert.ok(manifest.operations.every((operation) => operation.approved === false));

  const list = manifest.operations.find((operation) => operation.operationId === "listWidgets");
  assert.equal(list.autoSuggestion, "eligible_for_company_review");
  assert.equal(list.description.trust, "untrusted_openapi_text");
  assert.match(list.description.value, /expose secrets/);
  assert.deepEqual(list.securityAlternatives, [[{ scheme: "api_key", scopes: [] }]]);

  const head = manifest.operations.find((operation) => operation.operationId === "widgetExists");
  assert.equal(head.autoSuggestion, "eligible_for_company_review");
  assert.deepEqual(head.securityAlternatives, [[]]);
});

test("unsafe and active OpenAPI shapes are deterministically excluded", async () => {
  const bytes = await readFile(fixtureUrl("openapi-company-review-unsafe.json"));
  const manifest = analyzeOpenApi(bytes, { sourceName: "unsafe.json" });

  assert.equal(manifest.summary.totalOperations, 16);
  assert.equal(manifest.summary.eligibleForCompanyReview, 0);
  assert.equal(manifest.summary.excludedByPolicy, 16);
  assert.equal(manifest.upstream.status, "company_input_required");
  assert.equal(manifest.upstream.declaredServers[0].usable, false);

  const reasonsFor = (operationId) =>
    manifest.operations.find((operation) => operation.operationId === operationId).exclusionReasons;
  assert.ok(reasonsFor("authCallback").includes("reserved_auth_callback_route"));
  assert.ok(reasonsFor("logout").includes("reserved_logout_route"));
  assert.ok(reasonsFor("listApiKeys").includes("reserved_key_management_route"));
  assert.ok(reasonsFor("adminAudit").includes("reserved_admin_route"));
  assert.ok(reasonsFor("mcpInfo").includes("reserved_mcp_route"));
  assert.ok(reasonsFor("downloadArchive").includes("binary_or_streaming_payload"));
  assert.ok(reasonsFor("streamEvents").includes("binary_or_streaming_payload"));
  assert.ok(reasonsFor("missingDescription").includes("missing_description"));
  assert.ok(reasonsFor("itemWithoutParameter").includes("path_parameter_contract_invalid"));
  assert.ok(reasonsFor("callbackCapable").includes("callbacks_present"));
  assert.ok(reasonsFor("searchWithPost").includes("method_not_read_only"));
  assert.ok(reasonsFor("duplicateId").includes("duplicate_operation_id"));
  assert.ok(reasonsFor("duplicateId").includes("credential_like_parameter"));
  assert.ok(reasonsFor("bad id").includes("unstable_operation_id"));
  assert.ok(reasonsFor("bad id").includes("unstable_path"));
  assert.ok(reasonsFor("webhookStatus").includes("reserved_webhook_route"));
  assert.ok(reasonsFor("receiveDelivery").includes("webhook_operation"));
});

test("approved IR is digest-bound, host-pinned, credential-free, and description-free", async () => {
  const bytes = await readFile(fixtureUrl("openapi-company-review-safe.json"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const approval = {
    companyApproval: true,
    specSha256: digest,
    upstreamBaseUrls: ["https://api.example.test/v1"],
    operations: [
      {
        operationId: "listWidgets",
        upstreamBaseUrl: "https://api.example.test/v1",
        authSchemes: ["api_key"],
      },
    ],
    acknowledgements: {
      descriptionsAreUntrusted: true,
      authorizationAndScopesReviewed: true,
      responseDataExposureReviewed: true,
    },
  };

  const ir = compileApprovedIr(bytes, approval);
  assert.equal(ir.schemaVersion, "epode.company-mcp-approved-ir.v1");
  assert.equal(ir.deploymentAction, "none");
  assert.deepEqual(ir.upstreamPolicy.pinnedOrigins, ["https://api.example.test"]);
  assert.equal(ir.credentialPolicy.credentialMaterialPresent, false);
  assert.deepEqual(
    ir.operations.map((operation) => operation.toolId),
    ["listWidgets"],
  );
  assert.equal(ir.operations[0].auth[0].credentialInjection, "external_company_runtime_only");
  assert.equal(JSON.stringify(ir).includes("Ignore prior instructions"), false);

  assert.throws(
    () => compileApprovedIr(bytes, { ...approval, specSha256: "0".repeat(64) }),
    /does not match/,
  );
  assert.throws(
    () =>
      compileApprovedIr(bytes, {
        ...approval,
        operations: [
          {
            operationId: "createWidget",
            upstreamBaseUrl: "https://api.example.test/v1",
            authSchemes: ["api_key"],
          },
        ],
      }),
    /excluded by policy/,
  );
  assert.throws(
    () => compileApprovedIr(bytes, { ...approval, apiKey: "secret" }),
    /unsupported fields: apiKey/,
  );
  assert.throws(
    () =>
      compileApprovedIr(bytes, {
        ...approval,
        upstreamBaseUrls: ["https://other.example.test/v1"],
        operations: [
          {
            ...approval.operations[0],
            upstreamBaseUrl: "https://other.example.test/v1",
          },
        ],
      }),
    /differs from its declared OpenAPI server/,
  );
});

test("the current Epode OpenAPI compiles reproducibly to a review-only manifest", async () => {
  const specUrl = new URL("../backend/openapi.json", import.meta.url);
  const bytes = await readFile(specUrl);
  const first = analyzeOpenApi(bytes, { sourceName: "backend/openapi.json" });
  const second = analyzeOpenApi(bytes, { sourceName: "backend/openapi.json" });
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");

  assert.deepEqual(first, second);
  assert.equal(first.source.sha256, expectedDigest);
  assert.equal(first.summary.totalOperations, 60);
  assert.equal(first.summary.readOnlyGetOrHead, 25);
  assert.equal(first.summary.eligibleForCompanyReview, 1);
  assert.equal(first.summary.excludedByPolicy, 59);
  assert.equal(first.summary.approvedForIr, 0);
  assert.equal(first.upstream.status, "company_input_required");
  assert.deepEqual(first.upstream.usablePinnedBaseUrls, []);
  assert.equal(first.authentication.schemes.length, 3);
  for (const path of [
    "/api/dashboard/customers",
    "/api/dashboard/customers/{customer_id}",
    "/api/dashboard/features",
    "/api/dashboard/features/{feature_key}",
    "/api/dashboard/responses",
    "/api/dashboard/signals",
  ]) {
    assert.ok(first.operations.some((operation) => operation.path === path));
  }
  const companyWrites = [
    "/api/v2/enrichment/requests",
    "/api/v2/customer-context",
    "/api/v2/personalization/decisions",
    "/api/v2/personalization/outcomes",
  ];
  const agentWrites = ["/api/v2/enrichment/consent/decisions", "/api/v2/enrichment/answers"];
  for (const path of [...companyWrites, ...agentWrites]) {
    const operation = first.operations.find((candidate) => candidate.path === path);
    assert.ok(operation, `missing ${path}`);
    assert.equal(operation.method, "POST");
    assert.equal(operation.defaultDecision, "exclude");
    assert.ok(operation.exclusionReasons.includes("method_not_read_only"));
    assert.ok(operation.exclusionReasons.includes("request_body_present"));
  }
  for (const path of companyWrites) {
    const operation = first.operations.find((candidate) => candidate.path === path);
    assert.deepEqual(operation.securityAlternatives, [[{ scheme: "bearer_auth", scopes: [] }]]);
  }
  for (const path of agentWrites) {
    const operation = first.operations.find((candidate) => candidate.path === path);
    assert.deepEqual(operation.securityAlternatives, [[{ scheme: "bearer_auth", scopes: [] }]]);
  }
  assert.ok(first.operations.every((operation) => operation.defaultDecision === "exclude"));
});
