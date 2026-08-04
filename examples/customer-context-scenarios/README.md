# Customer-context scenario matrix

## Runnable Shopwise MCP server

Shopwise is also a real stateless HTTP MCP server, not just an in-process
fixture. It exposes exactly one business tool: `search_catalog({
shopperContext })`. The context is bounded to that call, the response contains
the exact received/applied context, and retention is always `none`.

```bash
npm ci --prefix examples/customer-context-scenarios
npm test --prefix examples/customer-context-scenarios
PORT=4310 npm start --prefix examples/customer-context-scenarios
```

Connect an MCP client to `http://127.0.0.1:4310/mcp`. `GET /health` is available
for deployment probes. There is deliberately no `begin_task`, context-sharing,
profile, or memory-import tool on this server.

This executable matrix exercises Epode's customer-context lifecycle across five products and
industries. It is a state-transition fixture, not a collection of mocked screenshots: every
scenario starts from an empty store and performs context retrievals, MCP permission choices,
context submissions, session termination, and later retrievals.

Run it directly to inspect the ordered audit trace:

```sh
node examples/customer-context-scenarios/run-matrix.js
```

The scenarios cover:

- **Shopwise / e-commerce:** remembered preferences cross a session boundary, but not a user
  identity boundary.
- **Roamwise / travel:** session-only trip context disappears when the planning session ends.
- **Ledgerly / finance:** a decline stores no context, and financial-account and credit signals
  fail the catalog boundary even when another customer allows personalization.
- **Carepath / healthcare:** safe content-format preferences persist while clinical information
  is rejected.
- **Learnwise / education:** remembered context remains isolated between two users in the same
  household account, including a bounded assistant inference with explicit provenance.

All accepted values use Epode's production `v1` enrichment catalog. The matrix intentionally
does not pretend the current catalog can store arbitrary hotel, financial, or clinical facts.
Each accepted item retains its source session, source operation, provenance, confidence, and
effective retention scope so dashboard and audit consumers can explain what was learned.

## Production-shaped Shopwise MCP contract

`shopwise-mcp.js` is the executable server core for the Shopwise harness. Live Claude Desktop
testing of `shopwise-industry-demo@1.0.0` at `https://alongside.ngrok.io/mcp` exposed two problems:
the two-tool sequence could trigger two host approvals, and neither tool returned the complete
context used for the result. The hardened example uses one atomic business call:

| Flow | Possible host approvals | Structured output |
| --- | --- | --- |
| Live `begin_task` + `search_catalog` | two | context count, then result items |
| Hardened `search_catalog({ shopperContext })` | one | results, exact received/applied fields, data use, match trace |

1. `search_catalog` accepts size, width, preferred and excluded colors, use case, budget, required
   and excluded features, and optional brand constraints in one bounded `shopperContext`.
2. That same call returns results, exact `receivedContext` and normalized `appliedContext`, plus an
   explicit call-only `dataUse` receipt. Unsupported fields fail instead of being silently ignored.
3. Every accepted field participates in matching, and the response includes a per-product match
   trace. There is no opaque context handle or state to reuse across fresh or incognito sessions.
4. Context exists only while the call executes, imports no assistant memory, and is never saved to
   a profile. Standard versus incognito origin remains explicit in the receipt.

The server deliberately does **not** require a `share_customer_context` call. Live harnesses did
not reliably select that tool even when prompted, so correctness cannot depend on agent prose or
tool-selection compliance. The only business tool carries its own exact context receipt.

Claude Desktop's `Always allow` / `Allow once` / `Deny` prompts remain host-owned. A server can
provide read-only/idempotence annotations, but it cannot suppress or combine host approvals. A
denial happens before `tools/call`, so the correct server-side outcome is no request and no audit
event—not a second consent record.
