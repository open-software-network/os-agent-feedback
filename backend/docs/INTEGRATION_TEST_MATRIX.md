# V2 production integration matrix

## Supported product integrations

| Surface | Company setup | Agent handoff | Classification |
| --- | --- | --- | --- |
| Express JSON API | Global middleware with selected routes | `_agentFeedback` on JSON objects; headers for arrays/scalars | Unclassified until review |
| Fastify API/website | One registered plugin | JSON object, compact headers, or embedded HTML JSON | Unclassified until review |
| Node MCP | `instrumentMcp` immediately after server construction | Decorated business result plus `report_product_outcome` | Confirmed on tool use |

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

## Behavioral agent check

`tests/agent_instruction_probe.py` compares a bare submission URL with the compact self-contained v2 instruction. Current fresh-agent tests used the HTTP product result but ignored the additional side effect even when the compact instruction was explicit. The feedback-aware HTTP adapter submitted the same scoped contract deterministically. A fresh MCP client called `report_product_outcome` autonomously because feedback was exposed as an explicit protocol tool. Production therefore treats HTTP/HTML as best-effort opportunities and MCP as protocol-confirmed behavior.
