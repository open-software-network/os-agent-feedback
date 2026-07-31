# Epode Companion production readiness — 2026-07-31

## Decision

Use one user-facing **Epode Companion** plugin for Codex and Claude Code. Under the hood it packages trusted guidance plus a local, fixed-destination MCP helper. Companies with an existing MCP server should continue using native Epode MCP instrumentation. Ordinary HTTP APIs and websites use the company SDK plus the Companion reliability layer.

The critical workflow no longer depends on a model loading the bundled skill. Company response instructions name the Companion tools directly; MCP tool descriptions are always visible; the skill remains defense-in-depth.

## Final HTTP flow

1. The company installs its Epode SDK once and instruments selected successful responses.
2. The user's agent completes the product task first.
3. Before any permission question, `inspect_product_feedback` verifies the short-lived capability at Epode and returns the authenticated product name, policy, state, and canonical question.
4. Ask once and Ask every time wait for a later, explicit Yes or No. Never ask does not interrupt.
5. `record_product_feedback_consent` returns an explicit `feedback_ready.nextAction` after approval.
6. `submit_product_feedback` accepts only a fixed outcome/signal vocabulary and sends to `https://app.epode.ai`.
7. Epode enforces signature, expiry, product scope, consent ordering, and one report per interaction.

## Evidence

| Gate | Result |
| --- | --- |
| Company setup canary | 48/48 integration/mode cells; 64 correctly scoped reports |
| Root test suite | 87/87 |
| Node SDK | 27/27 |
| Python SDK | 15/15 |
| Go SDK | pass, including cache-mode subtests |
| Rust SDK | 10/10 plus doc tests |
| PostgreSQL-gated backend suite | 5/5 against disposable `v2-canary` database |
| Companion contract/security | 10/10 |
| Codex marketplace lifecycle | add/install/activate/disable/uninstall/restore passed |
| Claude marketplace lifecycle | add/install/activate/disable/uninstall/restore passed |
| Claude no-skill Ask-once lifecycle | inspect 1 → ask → consent 1 → report 1; fresh report 1 |
| Forged handle | inspect 401; no question, consent, or report |
| Docs | Mintlify validation passed; accessibility check passed |
| Plugin manifests | Codex validator, Claude plugin validator, and Claude marketplace validator passed |

## Production hardening implemented

- Repository-root marketplaces make the GitHub repository directly installable in Codex and Claude Code.
- Added a fixed-destination capability preflight so an arbitrary site cannot borrow Epode's trusted permission prompt.
- Consent approval now returns an unambiguous immediate report action.
- Ask-once consent subjects survive product-key rotation.
- Concurrent same-interaction consent is idempotent and environment scoped.
- Ask-once choices are reversible only through an explicit user request; signed issuance ordering prevents an older conversation from overwriting a newer decision.
- Companion calls retry one transient failure with a stable idempotency key, reject redirects, validate success receipts, and never improvise a transport.
- Public envelope schema conditionally requires and forbids consent/report/management fields by stage.
- Python, Go, and Rust now match Node's safe/request/private cache behavior.
- The public MCP example no longer treats an agent-controlled tool argument as authenticated customer identity.

## Known limits

- A newly installed plugin activates in a fresh agent process/session, not the already-running one.
- Header-only envelopes for arrays/scalars depend on the agent's HTTP tool exposing response headers. Ordinary `curl` without `-i` does not, so this remains lower confidence than JSON-object, HTML, or native MCP paths.
- Capability inspection authenticates the product and makes a copied-handle mismatch visible through the canonical product name, but the Companion cannot cryptographically prove which external HTTP origin the agent observed without owning the HTTP fetch transport.
- Generic agents without the Companion or native Epode support may still ignore response metadata. No product response can force independent-agent compliance.
- Disabling or uninstalling the Companion stops its trusted tools; it cannot prevent a generic model from independently following instructions in a product response.

These limits should be reported as coverage boundaries, not hidden behind an agent-identity or guaranteed-delivery claim.
