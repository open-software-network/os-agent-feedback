# Offline OpenAPI-to-company-review prototype

This prototype compiles an OpenAPI document into a deterministic company-review manifest. It does not start an
MCP server, make network requests, accept credentials, proxy traffic, or deploy anything.

Run the Epode review locally:

```sh
node experiments/agent-compliance/openapi-company-review-cli.mjs backend/openapi.json
```

Every operation defaults to excluded. A GET or HEAD operation is only marked `eligible_for_company_review` when
it has stable path and operation metadata, a human-reviewable description, declared JSON success behavior, valid
path parameters, and no reserved or active behavior. Eligibility is a review suggestion, not approval.

The manifest calls out the decisions a company still owns: the exact spec digest, pinned HTTPS upstream base
URLs, operation-by-operation approval, auth alternatives and scopes, and response-data exposure. OpenAPI
descriptions are bounded and labeled untrusted; they never influence eligibility beyond presence and never enter
the approved IR.

An optional approval JSON can produce a small runtime-neutral IR:

```json
{
  "companyApproval": true,
  "specSha256": "<exact manifest digest>",
  "upstreamBaseUrls": ["https://api.example.com/v1"],
  "operations": [
    {
      "operationId": "listWidgets",
      "upstreamBaseUrl": "https://api.example.com/v1",
      "authSchemes": ["api_key"]
    }
  ],
  "acknowledgements": {
    "descriptionsAreUntrusted": true,
    "authorizationAndScopesReviewed": true,
    "responseDataExposureReviewed": true
  }
}
```

```sh
node experiments/agent-compliance/openapi-company-review-cli.mjs backend/openapi.json \
  --approval /path/to/company-approval.json
```

The IR contains only routing metadata, parameter schemas, selected auth scheme names, and pinned origins/base
URLs. Credential values are deliberately unsupported and must remain outside any generated artifact.

## Current limitations

- This is a conservative OpenAPI 3.x JSON prototype, not a server generator or a complete validator.
- Only local `#/...` references are inspected; remote references are not fetched.
- Server URL variables are rejected rather than expanded.
- GET must declare JSON for every 2xx response body. HEAD may have bodyless 2xx responses.
- Schema-level data classification, authorization correctness, redirects, pagination, quotas, timeouts, and SSRF
  defenses still require company/runtime design review.
- A later runtime must independently validate request arguments, response sizes/content types, DNS and redirect
  targets, authorization, and credential isolation before using the IR.
