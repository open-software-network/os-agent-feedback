# Brief: EPD-5 — what does adding a read surface oblige in the public protocol contract?

You are resolving one research ticket on a wayfinding map. You start blank — this
brief is everything you need. Read it fully before touching anything.

**Repo**: `/Users/jakubswierczek/code/alongside/os-epode` (you are in it).
**Do not modify any source.** This is research. Your only write is one markdown file.

## The product

Agent Feedback ("epode"): a customer's AI agent uses someone's product (HTTP API,
MCP server, agent-readable website), and afterwards reports whether it actually
*worked* — success / partial / failure plus one short note. The product owner sees
that feedback in a dashboard.

Rust backend in `backend/`, vanilla-JS dashboard in `backend/public/`, public
protocol in `protocol/v1/`, five SDKs in `sdk/` (node, python, go, rust, + MCP).

## The effort this ticket belongs to

We are adding a **read** path so an agent working in a product's repo can pull that
product's feedback and file issues, without a human opening the dashboard.

Already decided (do not re-open):

- Read access rides on the **existing `/mcp` endpoint**, which today has three
  write tools (`agent_start_session`, `agent_record_event`, `agent_complete_session`)
  and zero read tools.
- Auth is a **new read-scoped product key**: prefix `af_read_`, a `kind` column on
  `api_keys`, product-scoped, 90-day default expiry. Distinct from the existing
  write key `af_live_`, which stays write-only.
- Static bearer tokens in MCP client config are confirmed to work everywhere
  (see `docs/mcp-client-config.md`). Not your problem.

## Your question

**Is reading part of the PROTOCOL, or is it a PRODUCT API of epode's hosted service?**

That is the fork. It decides how much surface area a read path drags with it.

- **Protocol** = something any third-party implementer of Agent Feedback must also
  offer. Then the `.well-known` descriptor, the five SDKs, and the conformance
  suite all grow a read half.
- **Product API** = epode's hosted service offers it; the open protocol stays
  emit-only. Much cheaper, but may strand third-party implementers and could be
  awkward to reverse later.

Answer these, with evidence from the repo:

1. **What does the current v1 contract actually claim to be?** Read
   `protocol/v1/` in full — README, conformance.json, and any schema. Is it a
   wire format for emitting receipts, or a broader service contract? Does anything
   in it forbid, constrain, or anticipate a read path?
2. **What exactly would change under each branch?** Enumerate concrete artifacts:
   the `.well-known/agent-feedback.json` and `/.well-known/agent-feedback-v1.json`
   descriptors (find where they are served in `backend/src/main.rs`), each SDK,
   `tests/cross_language_conformance.sh`, `tests/setup-matrix-e2e.mjs`, and the
   `examples/setup-matrix-*` apps. Be specific — file paths and what would need
   adding.
3. **Must the descriptor advertise a read endpoint for discovery?** What does the
   descriptor currently advertise, who consumes it, and what would versioning look
   like if it grew a read section?
4. **Is there prior art worth copying?** How do comparable products separate an
   open emit/ingest protocol from a proprietary read API? OpenTelemetry (OTLP
   ingest vs vendor query APIs) is the obvious parallel — is it the right one?
   Sentry, PostHog, and Statsig may also be instructive. Use web research for this
   part; do not guess.

## How to work

- Read the repo first, web second. Repo evidence beats speculation.
- For web research prefer `firecrawl` (there is a `/firecrawl` skill) or WebFetch.
- Use Context7 for any library/spec documentation lookups.
- **Call the fork.** Do not present a balanced menu and stop. Give a recommendation
  with the reasoning, and state plainly what would change your mind. A hedged
  answer is a failed ticket.
- Flag anything you could not verify rather than asserting it.

## Output

Write **one file**: `.reviews/epd-5-protocol-contract.md`

Structure it as:

1. **Verdict** — protocol or product API, one paragraph, no hedging.
2. **Why** — the reasoning, grounded in what `protocol/v1/` actually is.
3. **What changes under the branch you chose** — concrete file list.
4. **What changes under the branch you rejected** — same, so the cost delta is visible.
5. **Prior art** — what comparable products do, with links.
6. **Unverified** — anything you could not confirm.

Aim for something a person can act on in ten minutes of reading. Dense over long.

When done, reply with **only the file path**. Do not summarise in the pane —
the orchestrator reads the file.

Do not commit. Do not push. Do not touch the issue tracker.
