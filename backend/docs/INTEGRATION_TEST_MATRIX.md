# V2 production integration matrix

## Supported product integrations

| Surface | Company setup | Agent handoff | Classification |
| --- | --- | --- | --- |
| Express and Fastify | Global middleware/plugin with selected routes | JSON object, compact headers, or embedded HTML JSON | Unclassified until review |
| Python ASGI and WSGI | One middleware wrapper | JSON object, compact headers, or embedded HTML JSON | Unclassified until review |
| Go net/http and Rust Tower | One middleware/layer | JSON object, compact headers, or embedded HTML JSON | Unclassified until review |
| Language-neutral HTTP | Public v1 protocol | Same JSON, header, and HTML contract | Unclassified until review |
| Node MCP | `instrumentMcp` immediately after server construction | Decorated business result plus `report_product_outcome` | Confirmed on tool use |
| Language-neutral MCP | Public v1 protocol | Explicit outcome tool and decorated result | Confirmed on tool use |

The Setup page currently exposes 16 enabled permutations: seven HTTP API integrations,
the same seven server-rendered website integrations, and two MCP integrations. Static
site/CMS remains visibly disabled and is not counted as supported.

## Automated acceptance

| Contract | Coverage |
| --- | --- |
| JSON shape preservation | SDK Express test and customer E2E |
| HTML instruction injection | SDK Fastify test and customer E2E |
| Unsafe body types use headers | SDK Express test |
| Errors and unrelated routes untouched | SDK Express test |
| Backend outage never affects product response | SDK Express failure test |
| Locally signed two-hour capability | Rust security test and v2 acceptance |
| Forged/expired capability rejection | Rust security test and v2 acceptance |
| Idempotent first-review-wins behavior | V2 acceptance and customer E2E |
| Recursive sensitive-field rejection | Rust security test, v2 acceptance, customer E2E |
| Anonymous HTTP opportunity, then promotion | V2 acceptance and PostgreSQL assertion |
| MCP immediate confirmation | MCP SDK test and customer E2E |
| Optional customer and MCP session grouping | V2 acceptance and customer E2E |
| V1 writes disabled; data preserved | V2 acceptance and dashboard legacy filter |
| OS Accounts dashboard | Production browser E2E after canary migration |

## Exact setup matrix

`npm run test:setup-matrix` rebuilds the hosted SDK artifacts, creates a fresh disposable
canary product and product key, installs each integration from the same artifact/command
shown by Setup, and launches nine new product examples. A feedback-aware customer-agent
client then exercises every enabled permutation.

For all 16 cases it asserts:

- the product result and existing response shape remain intact;
- never-ask instructions and a scoped capability are present without the company key;
- the agent submits an exact, unique success note;
- a contradictory duplicate returns the original review;
- PostgreSQL contains one linked review with the expected surface and operation;
- HTTP/HTML is confirmed by `outcome_submission`, while MCP remains confirmed by `mcp`.

The test deletes only its randomly generated workspace when it finishes. The current full
run passed `7 API + 7 website + 2 MCP` and stored all 16 exact notes.

## Behavioral agent check

`tests/agent_instruction_probe.py` compares a bare submission URL with the compact self-contained v2 instruction. Current fresh-agent tests used the HTTP product result but ignored the additional side effect even when the compact instruction was explicit. The feedback-aware HTTP adapter submitted the same scoped contract deterministically. A fresh MCP client called `report_product_outcome` autonomously because feedback was exposed as an explicit protocol tool. Production therefore treats HTTP/HTML as best-effort opportunities and MCP as protocol-confirmed behavior.
