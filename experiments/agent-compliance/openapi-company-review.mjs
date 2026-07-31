import { createHash } from "node:crypto";

const HTTP_METHODS = ["delete", "get", "head", "options", "patch", "post", "put", "trace"];
const READ_ONLY_METHODS = new Set(["get", "head"]);
const OPERATION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const PATH_PATTERN = /^\/(?:[^?#\s]*)$/;
const JSON_MEDIA_TYPE_PATTERN = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const BINARY_MEDIA_TYPE_PATTERN = new RegExp(
  "^(?:application/(?:octet-stream|pdf|zip|gzip)|text/event-stream|" +
    "multipart/|image/|audio/|video/)",
  "i",
);
const DESCRIPTION_LIMIT = 500;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseInput(input) {
  if (typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const bytes = Buffer.from(input);
    const document = JSON.parse(bytes.toString("utf8"));
    return { bytes, document };
  }
  if (!isObject(input)) throw new TypeError("OpenAPI input must be JSON bytes or an object");
  const bytes = Buffer.from(stableStringify(input));
  return { bytes, document: input };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function untrustedDescription(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .trim();
  return {
    value: normalized.slice(0, DESCRIPTION_LIMIT),
    truncated: normalized.length > DESCRIPTION_LIMIT,
    trust: "untrusted_openapi_text",
    allowedUse: "company_review_display_only",
  };
}

function resolveLocalRef(document, value) {
  if (!isObject(value) || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("#/")) return value;
  let current = document;
  for (const rawSegment of value.$ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !(segment in current)) return value;
    current = current[segment];
  }
  return current;
}

function containsBinarySchema(document, schema, seen = new Set()) {
  const resolved = resolveLocalRef(document, schema);
  if (!isObject(resolved)) return false;
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  if (["binary", "byte"].includes(resolved.format) || resolved.contentEncoding === "base64") {
    return true;
  }
  if (
    typeof resolved.contentMediaType === "string" &&
    BINARY_MEDIA_TYPE_PATTERN.test(resolved.contentMediaType)
  ) {
    return true;
  }
  return Object.entries(resolved).some(([key, value]) => {
    if (key === "description" || key === "title" || key === "example" || key === "examples") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsBinarySchema(document, item, seen));
    }
    return isObject(value) && containsBinarySchema(document, value, seen);
  });
}

function responseProfile(document, operation, method) {
  const successResponses = Object.entries(operation.responses ?? {})
    .filter(([status]) => /^2(?:\d\d|XX)$/i.test(status))
    .map(([status, response]) => [status, resolveLocalRef(document, response)]);
  const mediaTypes = [];
  let hasBinaryOrStreaming = false;
  let hasNonJsonSuccess = false;
  let hasBodylessSuccess = false;

  for (const [, response] of successResponses) {
    if (!isObject(response)) {
      hasNonJsonSuccess = true;
      continue;
    }
    const entries = Object.entries(response.content ?? {});
    if (entries.length === 0) {
      hasBodylessSuccess = true;
      continue;
    }
    for (const [mediaType, body] of entries) {
      mediaTypes.push(mediaType.toLowerCase());
      if (BINARY_MEDIA_TYPE_PATTERN.test(mediaType)) hasBinaryOrStreaming = true;
      if (!JSON_MEDIA_TYPE_PATTERN.test(mediaType)) hasNonJsonSuccess = true;
      if (isObject(body) && containsBinarySchema(document, body.schema)) {
        hasBinaryOrStreaming = true;
      }
    }
  }

  if (isObject(operation.requestBody)) {
    const requestBody = resolveLocalRef(document, operation.requestBody);
    for (const [mediaType, body] of Object.entries(requestBody?.content ?? {})) {
      if (BINARY_MEDIA_TYPE_PATTERN.test(mediaType)) hasBinaryOrStreaming = true;
      if (isObject(body) && containsBinarySchema(document, body.schema)) {
        hasBinaryOrStreaming = true;
      }
    }
  }

  const jsonCompatible =
    successResponses.length > 0 &&
    !hasNonJsonSuccess &&
    !hasBinaryOrStreaming &&
    (method === "head" || (!hasBodylessSuccess && mediaTypes.length > 0));
  return {
    successMediaTypes: sortedUnique(mediaTypes),
    hasSuccessResponse: successResponses.length > 0,
    hasBinaryOrStreaming,
    jsonCompatible,
  };
}

function routeReasons(path, operationId) {
  const haystack = `${path} ${operationId ?? ""}`.toLowerCase();
  const reasons = [];
  if (/(?:^|[^a-z0-9])mcp(?:$|[^a-z0-9])/.test(haystack)) reasons.push("reserved_mcp_route");
  if (/auth[\/_-]?callback|oauth[\/_-]?callback|sso[\/_-]?callback/.test(haystack)) {
    reasons.push("reserved_auth_callback_route");
  } else if (/(?:^|[^a-z0-9])auth(?:$|[^a-z0-9])|oauth|sso/.test(haystack)) {
    reasons.push("reserved_auth_route");
  }
  if (/(?:^|[^a-z0-9])(?:logout|signout)(?:$|[^a-z0-9])/.test(haystack)) {
    reasons.push("reserved_logout_route");
  }
  if (
    /(?:^|[^a-z0-9])(?:api[\/_-]?)?keys?(?:$|[^a-z0-9])/.test(haystack) ||
    /(?:^|[^a-z0-9])credentials?(?:$|[^a-z0-9])/.test(haystack) ||
    /tokens?[\/_-]?(?:rotate|revoke|create)/.test(haystack)
  ) {
    reasons.push("reserved_key_management_route");
  }
  if (/(?:^|[^a-z0-9])(?:admin|administrator|superuser)(?:$|[^a-z0-9])/.test(haystack)) {
    reasons.push("reserved_admin_route");
  }
  if (/(?:^|[^a-z0-9])webhooks?(?:$|[^a-z0-9])/.test(haystack)) {
    reasons.push("reserved_webhook_route");
  }
  return reasons;
}

function parameterContract(document, path, pathItem, operation) {
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  const merged = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => resolveLocalRef(document, parameter))
    .filter(isObject);
  const pathParameters = merged.filter((parameter) => parameter.in === "path");
  const pathNames = pathParameters.map((parameter) => parameter.name);
  const valid =
    placeholders.length === new Set(placeholders).size &&
    sortedUnique(placeholders).join("\0") === sortedUnique(pathNames).join("\0") &&
    pathParameters.every((parameter) => parameter.required === true);
  return { merged, valid };
}

function normalizedSecurity(document, operation) {
  const raw = operation.security ?? document.security ?? [];
  if (!Array.isArray(raw)) return { alternatives: [], unknownSchemes: ["<invalid-security>"] };
  if (raw.length === 0) return { alternatives: [[]], unknownSchemes: [] };
  const knownSchemes = document.components?.securitySchemes ?? {};
  const unknownSchemes = [];
  const alternatives = raw.map((alternative) => {
    if (!isObject(alternative)) {
      unknownSchemes.push("<invalid-security-alternative>");
      return [];
    }
    return Object.entries(alternative)
      .map(([scheme, scopes]) => {
        if (!(scheme in knownSchemes)) unknownSchemes.push(scheme);
        return { scheme, scopes: Array.isArray(scopes) ? [...scopes].sort() : [] };
      })
      .sort((left, right) => left.scheme.localeCompare(right.scheme));
  });
  return { alternatives, unknownSchemes: sortedUnique(unknownSchemes) };
}

function runtimeSchema(document, schema, seen = new Set(), depth = 0) {
  if (depth > 16) return {};
  const resolved = resolveLocalRef(document, schema);
  if (!isObject(resolved) || seen.has(resolved)) return {};
  seen.add(resolved);
  const output = {};
  for (const key of [
    "type",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (["string", "number", "boolean"].includes(typeof resolved[key])) output[key] = resolved[key];
  }
  if (Array.isArray(resolved.enum)) output.enum = structuredClone(resolved.enum);
  if (Object.hasOwn(resolved, "const")) output.const = structuredClone(resolved.const);
  if (Array.isArray(resolved.required)) {
    output.required = resolved.required.filter((value) => typeof value === "string");
  }
  if (isObject(resolved.properties)) {
    output.properties = Object.fromEntries(
      Object.entries(resolved.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) => [
          name,
          runtimeSchema(document, property, new Set(seen), depth + 1),
        ]),
    );
  }
  if (isObject(resolved.items)) {
    output.items = runtimeSchema(document, resolved.items, new Set(seen), depth + 1);
  }
  if (typeof resolved.additionalProperties === "boolean") {
    output.additionalProperties = resolved.additionalProperties;
  } else if (isObject(resolved.additionalProperties)) {
    output.additionalProperties = runtimeSchema(
      document,
      resolved.additionalProperties,
      new Set(seen),
      depth + 1,
    );
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(resolved[keyword])) {
      output[keyword] = resolved[keyword].map((item) =>
        runtimeSchema(document, item, new Set(seen), depth + 1),
      );
    }
  }
  return output;
}

function normalizedParameters(document, parameters) {
  return parameters
    .map((parameter) => resolveLocalRef(document, parameter))
    .filter(isObject)
    .map((parameter) => ({
      name: String(parameter.name ?? ""),
      in: String(parameter.in ?? ""),
      required: parameter.required === true,
      schema: runtimeSchema(document, parameter.schema),
    }))
    .sort((left, right) => `${left.in}:${left.name}`.localeCompare(`${right.in}:${right.name}`));
}

function hasCredentialLikeParameter(parameters) {
  return parameters.some((parameter) => {
    if (!isObject(parameter) || !["cookie", "header", "query"].includes(parameter.in)) return false;
    const name = String(parameter.name ?? "").toLowerCase();
    const credentialName =
      /(?:^|[-_])(?:authorization|api[-_]?key|access[-_]?token|password|secret|credential)/;
    return credentialName.test(name);
  });
}

function analyzeServerUrl(url) {
  if (typeof url !== "string" || url.includes("{") || url.includes("}")) {
    return {
      declaredUrl: String(url ?? ""),
      usable: false,
      reason: "server_url_is_templated_or_invalid",
    };
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        declaredUrl: url,
        usable: false,
        reason: "server_url_must_be_credential_free_https",
      };
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    const baseUrl = `${parsed.origin}${pathname}`;
    return { declaredUrl: url, usable: true, origin: parsed.origin, baseUrl };
  } catch {
    return { declaredUrl: url, usable: false, reason: "server_url_is_not_absolute" };
  }
}

function authSchemes(document) {
  return Object.entries(document.components?.securitySchemes ?? {})
    .map(([name, rawScheme]) => {
      const scheme = resolveLocalRef(document, rawScheme);
      return {
        name,
        type: isObject(scheme) ? String(scheme.type ?? "unknown") : "unknown",
        location: isObject(scheme) && typeof scheme.in === "string" ? scheme.in : null,
        parameterName: isObject(scheme) && typeof scheme.name === "string" ? scheme.name : null,
        httpScheme: isObject(scheme) && typeof scheme.scheme === "string" ? scheme.scheme : null,
        credentialMaterialIncluded: false,
        requiresCompanyDecision: true,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function operationEntries(document) {
  const entries = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      if (isObject(pathItem[method])) {
        entries.push({ source: "path", path, pathItem, method, operation: pathItem[method] });
      }
    }
  }
  for (const [name, pathItem] of Object.entries(document.webhooks ?? {})) {
    const resolvedPathItem = resolveLocalRef(document, pathItem);
    if (!isObject(resolvedPathItem)) continue;
    for (const method of HTTP_METHODS) {
      if (isObject(resolvedPathItem[method])) {
        entries.push({
          source: "webhook",
          path: `webhook:${name}`,
          pathItem: resolvedPathItem,
          method,
          operation: resolvedPathItem[method],
        });
      }
    }
  }
  return entries.sort((left, right) => {
    return `${left.source}:${left.path}:${left.method}`.localeCompare(
      `${right.source}:${right.path}:${right.method}`,
    );
  });
}

function operationIdCounts(entries) {
  const counts = new Map();
  for (const { operation } of entries) {
    if (typeof operation.operationId === "string" && operation.operationId !== "") {
      counts.set(operation.operationId, (counts.get(operation.operationId) ?? 0) + 1);
    }
  }
  return counts;
}

function analyzeOperation(document, entry, idCounts) {
  const { source, path, pathItem, method, operation } = entry;
  const operationId = typeof operation.operationId === "string" ? operation.operationId : null;
  const description = untrustedDescription(operation.description);
  const response = responseProfile(document, operation, method);
  const parameters = parameterContract(document, path, pathItem, operation);
  const security = normalizedSecurity(document, operation);
  const declaredServers = (operation.servers ?? pathItem.servers ?? document.servers ?? []).map(
    (server) => analyzeServerUrl(server?.url),
  );
  const reasons = [];

  if (source === "webhook") reasons.push("webhook_operation");
  if (!READ_ONLY_METHODS.has(method)) reasons.push("method_not_read_only");
  reasons.push(...routeReasons(path, operationId));
  if (operation.requestBody !== undefined) reasons.push("request_body_present");
  if (operation.callbacks && Object.keys(operation.callbacks).length > 0) {
    reasons.push("callbacks_present");
  }
  if (hasCredentialLikeParameter(parameters.merged)) reasons.push("credential_like_parameter");
  if (operationId === null || operationId === "") reasons.push("missing_operation_id");
  else if (!OPERATION_ID_PATTERN.test(operationId)) reasons.push("unstable_operation_id");
  else if ((idCounts.get(operationId) ?? 0) > 1) reasons.push("duplicate_operation_id");
  if (!PATH_PATTERN.test(path) || path.includes("//") || path.split("/").includes("..")) {
    reasons.push("unstable_path");
  }
  if (source === "path" && !parameters.valid) reasons.push("path_parameter_contract_invalid");
  if (description === null) reasons.push("missing_description");
  if (!response.hasSuccessResponse) reasons.push("no_success_response");
  if (response.hasBinaryOrStreaming) reasons.push("binary_or_streaming_payload");
  if (!response.jsonCompatible) reasons.push("non_json_success_response");
  if (security.unknownSchemes.length > 0) reasons.push("unknown_security_scheme");
  if (declaredServers.some((server) => !server.usable)) reasons.push("unsafe_declared_server");

  const exclusionReasons = sortedUnique(reasons);
  return {
    key: `${method.toUpperCase()} ${path}`,
    source,
    method: method.toUpperCase(),
    path,
    operationId,
    description,
    descriptionContentInfluencesEligibility: false,
    parameters: normalizedParameters(document, parameters.merged),
    successMediaTypes: response.successMediaTypes,
    securityAlternatives: security.alternatives,
    declaredUpstreamBaseUrls: declaredServers
      .filter((server) => server.usable)
      .map((server) => server.baseUrl),
    defaultDecision: "exclude",
    autoSuggestion: exclusionReasons.length === 0 ? "eligible_for_company_review" : "not_eligible",
    approved: false,
    exclusionReasons,
  };
}

function buildSummary(operations) {
  const exclusionReasonCounts = {};
  for (const operation of operations) {
    for (const reason of operation.exclusionReasons) {
      exclusionReasonCounts[reason] = (exclusionReasonCounts[reason] ?? 0) + 1;
    }
  }
  return {
    totalOperations: operations.length,
    readOnlyGetOrHead: operations.filter((operation) =>
      READ_ONLY_METHODS.has(operation.method.toLowerCase()),
    ).length,
    eligibleForCompanyReview: operations.filter(
      (operation) => operation.autoSuggestion === "eligible_for_company_review",
    ).length,
    excludedByPolicy: operations.filter((operation) => operation.autoSuggestion === "not_eligible")
      .length,
    approvedForIr: 0,
    exclusionReasonCounts: Object.fromEntries(
      Object.entries(exclusionReasonCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function analyzeOpenApi(input, options = {}) {
  const { bytes, document } = parseInput(input);
  if (!isObject(document) || typeof document.openapi !== "string" || !isObject(document.paths)) {
    throw new TypeError("Input must be an OpenAPI document with a paths object");
  }
  const entries = operationEntries(document);
  const ids = operationIdCounts(entries);
  const operations = entries.map((entry) => analyzeOperation(document, entry, ids));
  const servers = (document.servers ?? []).map((server) => analyzeServerUrl(server?.url));
  const usableServers = servers.filter((server) => server.usable);

  return {
    schemaVersion: "epode.company-mcp-review.v1",
    artifactKind: "company_review_manifest",
    compilerMode: {
      offline: true,
      networkAccess: "none",
      deploymentAction: "none",
      defaultDecision: "exclude",
    },
    source: {
      name: options.sourceName ?? "openapi.json",
      openapiVersion: document.openapi,
      sha256: sha256(bytes),
      digestBasis: "exact_input_bytes",
    },
    descriptionPolicy: {
      trust: "untrusted_openapi_text",
      allowedUse: "company_review_display_only",
      executableUse: "forbidden",
      maximumStoredCharacters: DESCRIPTION_LIMIT,
    },
    upstream: {
      declaredServers: servers,
      usablePinnedBaseUrls: usableServers.map((server) => server.baseUrl),
      status: usableServers.length > 0 ? "company_must_confirm" : "company_input_required",
    },
    authentication: {
      credentialMaterialPresent: false,
      schemes: authSchemes(document),
      status: "company_mapping_required_before_runtime",
    },
    requiredCompanyDecisions: [
      "Approve the exact source.sha256; regenerate and re-review after any spec change.",
      "Pin an HTTPS upstream base URL and host for every approved operation.",
      "Approve each operation individually; auto-suggestions remain excluded by default.",
      "Choose one declared security alternative per operation and configure credentials outside " +
        "this artifact.",
      "Review authorization scopes and the response fields exposed to agents.",
      "Treat every OpenAPI description as untrusted display-only data, never runtime instructions.",
    ],
    summary: buildSummary(operations),
    operations,
  };
}

function assertExactKeys(value, allowedKeys, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extras.sort().join(", ")}`);
  }
}

function normalizeApprovedBaseUrl(value) {
  const analyzed = analyzeServerUrl(value);
  if (!analyzed.usable) throw new Error(`Approved upstream is unsafe: ${analyzed.reason}`);
  return { baseUrl: analyzed.baseUrl, origin: analyzed.origin };
}

function selectedAuthAlternative(expected, selectedNames) {
  const selected = sortedUnique(selectedNames);
  return expected.find((alternative) => {
    const names = alternative.map(({ scheme }) => scheme);
    return (
      names.length === selected.length && names.every((name, index) => name === selected[index])
    );
  });
}

export function compileApprovedIr(input, approval, options = {}) {
  assertExactKeys(
    approval,
    ["companyApproval", "specSha256", "upstreamBaseUrls", "operations", "acknowledgements"],
    "approval",
  );
  const manifest = analyzeOpenApi(input, options);
  if (approval.companyApproval !== true) throw new Error("companyApproval must be true");
  if (approval.specSha256 !== manifest.source.sha256) {
    throw new Error("Approval specSha256 does not match the exact OpenAPI bytes");
  }
  assertExactKeys(
    approval.acknowledgements,
    ["descriptionsAreUntrusted", "authorizationAndScopesReviewed", "responseDataExposureReviewed"],
    "approval.acknowledgements",
  );
  for (const [key, value] of Object.entries(approval.acknowledgements)) {
    if (value !== true) throw new Error(`approval.acknowledgements.${key} must be true`);
  }
  if (!Array.isArray(approval.upstreamBaseUrls) || approval.upstreamBaseUrls.length === 0) {
    throw new Error("At least one pinned upstreamBaseUrl is required");
  }
  const approvedUpstreams = approval.upstreamBaseUrls.map(normalizeApprovedBaseUrl);
  const uniqueBaseUrls = sortedUnique(approvedUpstreams.map(({ baseUrl }) => baseUrl));
  if (uniqueBaseUrls.length !== approvedUpstreams.length) {
    throw new Error("upstreamBaseUrls must be unique after normalization");
  }
  if (!Array.isArray(approval.operations) || approval.operations.length === 0) {
    throw new Error("At least one explicit operation approval is required");
  }

  const approvedOperations = [];
  const seenOperationIds = new Set();
  for (const selected of approval.operations) {
    assertExactKeys(
      selected,
      ["operationId", "upstreamBaseUrl", "authSchemes"],
      "operation approval",
    );
    const operation = manifest.operations.find(
      (candidate) => candidate.operationId === selected.operationId,
    );
    if (!operation) throw new Error(`Unknown operationId: ${selected.operationId}`);
    if (operation.autoSuggestion !== "eligible_for_company_review") {
      throw new Error(`Operation is excluded by policy: ${selected.operationId}`);
    }
    if (seenOperationIds.has(selected.operationId)) {
      throw new Error(`Operation approved more than once: ${selected.operationId}`);
    }
    seenOperationIds.add(selected.operationId);
    const upstream = normalizeApprovedBaseUrl(selected.upstreamBaseUrl);
    if (!uniqueBaseUrls.includes(upstream.baseUrl)) {
      throw new Error(`Operation uses an unpinned upstreamBaseUrl: ${selected.operationId}`);
    }
    if (
      operation.declaredUpstreamBaseUrls.length > 0 &&
      !operation.declaredUpstreamBaseUrls.includes(upstream.baseUrl)
    ) {
      throw new Error(
        "Operation upstreamBaseUrl differs from its declared OpenAPI server: " +
          selected.operationId,
      );
    }
    if (
      !Array.isArray(selected.authSchemes) ||
      !selected.authSchemes.every((name) => typeof name === "string")
    ) {
      throw new TypeError(`authSchemes must be an array of names: ${selected.operationId}`);
    }
    if (new Set(selected.authSchemes).size !== selected.authSchemes.length) {
      throw new Error(`authSchemes must not contain duplicates: ${selected.operationId}`);
    }
    const authAlternative = selectedAuthAlternative(
      operation.securityAlternatives,
      selected.authSchemes,
    );
    if (!authAlternative) {
      throw new Error(
        "Selected authSchemes do not match a declared security alternative: " +
          selected.operationId,
      );
    }
    const selectedAuth = authAlternative.map(({ scheme: name, scopes }) => {
      const scheme = manifest.authentication.schemes.find((candidate) => candidate.name === name);
      return {
        schemeName: name,
        type: scheme?.type ?? "unknown",
        requiredScopes: scopes,
        credentialInjection: "external_company_runtime_only",
      };
    });
    approvedOperations.push({
      toolId: operation.operationId,
      method: operation.method,
      pathTemplate: operation.path,
      upstream,
      auth: selectedAuth,
      parameters: operation.parameters,
      successMediaTypes: operation.successMediaTypes,
    });
  }

  approvedOperations.sort((left, right) => left.toolId.localeCompare(right.toolId));
  return {
    schemaVersion: "epode.company-mcp-approved-ir.v1",
    artifactKind: "approved_runtime_input",
    deploymentAction: "none",
    networkAccessPerformedByCompiler: false,
    specSha256: manifest.source.sha256,
    upstreamPolicy: {
      pinnedBaseUrls: uniqueBaseUrls,
      pinnedOrigins: sortedUnique(approvedUpstreams.map(({ origin }) => origin)),
      redirects: "deny_unless_future_runtime_revalidates_origin",
    },
    credentialPolicy: {
      credentialMaterialPresent: false,
      acceptedCredentialValues: false,
      injection: "external_company_runtime_only",
    },
    operations: approvedOperations,
  };
}

export const policyReasonDescriptions = Object.freeze({
  binary_or_streaming_payload: "Binary and streaming payloads are outside this prototype.",
  callbacks_present: "Operations that can trigger callbacks are not eligible.",
  credential_like_parameter:
    "Credential-like operation parameters must use reviewed auth mapping instead.",
  duplicate_operation_id: "Operation identifiers must be unique.",
  method_not_read_only: "Only GET and HEAD may be suggested.",
  missing_description: "A human-reviewable operation description is required.",
  missing_operation_id: "A stable operationId is required.",
  no_success_response: "At least one declared 2xx response is required.",
  non_json_success_response: "GET responses must be JSON; HEAD may be bodyless.",
  path_parameter_contract_invalid: "Path placeholders must have matching required path parameters.",
  request_body_present: "Read operations with request bodies are not eligible.",
  reserved_admin_route: "Administrative routes are explicitly excluded.",
  reserved_auth_callback_route: "Authentication callback routes are explicitly excluded.",
  reserved_auth_route: "Authentication control routes are explicitly excluded.",
  reserved_key_management_route: "Credential and key-management routes are explicitly excluded.",
  reserved_logout_route: "Logout routes are explicitly excluded.",
  reserved_mcp_route: "Existing MCP transport routes are explicitly excluded.",
  reserved_webhook_route: "Webhook control and delivery routes are explicitly excluded.",
  unstable_operation_id: "The operationId is unsuitable as a stable tool identifier.",
  unstable_path: "The path is not a stable absolute OpenAPI path template.",
  unknown_security_scheme: "Every security scheme must resolve in the OpenAPI document.",
  unsafe_declared_server: "Declared servers must be absolute, credential-free HTTPS URLs.",
  webhook_operation: "OpenAPI webhook operations are never facade candidates.",
});
