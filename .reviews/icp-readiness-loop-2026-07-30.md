# Epode ICP readiness loop — 2026-07-30

## Decision

The supported core is production-confident for server-side HTTP/HTML in Node, Python, Go, and Rust,
plus Node and language-neutral MCP 2026-07-28. Confidence is based on fresh-package onboarding and exact
database assertions, not fixture-only response snapshots.

This does not claim that every possible framework is supported. First-class Web Fetch/Next.js serverless
middleware and registry distribution remain adoption work; the documented manual protocol is the current
escape hatch.

## Initial ICPs and source evidence

| Product archetype | Representative official evidence | Likely integration shape | Lab client |
| --- | --- | --- | --- |
| Search/retrieval API | [Firecrawl API](https://docs.firecrawl.dev/api-reference/introduction), [Firecrawl MCP](https://docs.firecrawl.dev/mcp) | TypeScript API/MCP; sync search plus async jobs | `icp-search-express`, `icp-crawl-fastify` |
| Hosted browser automation | [Browserbase MCP](https://docs.browserbase.com/integrations/mcp/introduction), [session metadata](https://docs.browserbase.com/platform/browser/core-features/session-metadata) | Stateful multi-tool MCP with application session IDs | `icp-browser-mcp` |
| Current documentation retrieval | [Context7 client integrations](https://context7.com/docs/resources/all-clients), [Context7 repository](https://github.com/upstash/context7) | Read-heavy TypeScript MCP with resolve/query sequence | `icp-docs-mcp` |
| Transactional email | [Resend MCP](https://resend.com/docs/mcp-server), [Resend MCP repository](https://github.com/resend/resend-mcp) | OAuth/API-key MCP with PII-rich tool inputs | `icp-operations-mcp` |
| Project management | [Linear MCP](https://linear.app/docs/mcp) | OAuth multi-tenant remote MCP with read/write tools | `icp-operations-mcp` |
| Financial operations | [Stripe agents](https://docs.stripe.com/agents), [Stripe MCP](https://docs.stripe.com/mcp) | Restricted-key/OAuth high-stakes API and MCP | `icp-operations-mcp` |

The representative public sites and repositories are predominantly Next.js/Vercel and TypeScript. That
supports Node/MCP as the primary adoption path while keeping the language-neutral contract and server SDKs.

## Loops and failures found

1. **Shared-cache regression.** Global HTTP instrumentation overwrote explicit CDN cache policy.
   Fixed with `cacheMode: safe|request|private`; safe is the default and request mode uses
   `Agent-Feedback-Request: 1`.
2. **MCP micro-feedback.** Every low-level browser tool requested a report. Fixed with independent
   `includeTools`, `excludeTools`, `feedbackTools`, and result-aware `shouldRequestFeedback`.
3. **Session creation gap.** MCP session extractors could not read an ID returned by `start_session`.
   Extractors now receive the completed result.
4. **Silent queue loss.** Node dropped the oldest event without warning and exhausted fast retries during
   transient backend slowness. The queue now logs once, uses bounded exponential retry, has a longer
   background-only timeout, and enforces a hard graceful-shutdown deadline.
5. **Report/telemetry race.** A report can arrive before background metadata. The placeholder timestamp was
   second-granularity and incorrectly sorted the final tool first. Reconciliation now prefers real telemetry
   time for placeholders.
6. **Fast-call ordering.** Wall-clock timestamps alone could not order rapid session calls. Protocol telemetry
   now has an optional monotonic client `sequence`; all first-party SDKs emit it and the backend uses it as a
   timeline tiebreaker.
7. **Cross-language reliability drift.** Python, Go, Rust, and manual examples had shorter or one-shot
   delivery. They now share bounded deadlines/retry intent, sequence metadata, and persistence-aware tests.
8. **Manual MCP breakage.** A protocol sample changed its helper return shape and closed the socket during a
   business tool. The sample now passes modern discovery, header consistency, tool use, feedback submission,
   retry, and persistence.
9. **Canary connection pressure.** Test helpers could fail before product traffic due to a saturated disposable
   database. Both E2E harnesses use bounded helper retries and avoid high-frequency polling.

## Exact acceptance evidence

- Node SDK: 23 unit/adapter tests.
- Python SDK: 9 tests, including transient retry and stable event identity.
- Go SDK: retry, deadline, sequence, buffering, consent, and response-shape tests.
- Rust SDK: clippy clean, 8 tests, bounded shutdown and full multi-batch flush.
- Canonical setup matrix: 7 API + 7 website + 2 MCP permutations; all 16 reports persisted on the exact
  confirmed interaction with the expected surface and normalized operation.
- ICP lab: five independently packaged products, 11 interactions, six exact feedback reports, positive,
  friction, and blocked impacts, multi-tool sessions, CDN opt-in, async terminal selection, PII rejection,
  safe retry, idempotency, and OAuth-style opaque tenant grouping.
- Mintlify validation and accessibility checks pass; public navigation includes the real-world recipes.

## Remaining adoption work (not correctness blockers for the declared surface)

- Publish packages to their native registries so installation is conventional rather than hosted archives.
- Add a first-class Web Fetch/Next.js/Vercel adapter; do not ask customers to put a product key in client code.
- Add framework-native lifecycle hooks for graceful Python/Go/Rust shutdown examples.
- Measure real independent-agent report rates per feedback mode after deployment; protocol compliance cannot
  force generic HTTP agents to perform a second network action.
- Add load testing against production-sized Postgres rather than a deliberately tiny shared canary pool.
