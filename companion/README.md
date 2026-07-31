# Epode Companion

Epode Companion gives Codex and Claude Code a reliable, privacy-bounded way to report whether an HTTP API or website worked. It recognizes Epode metadata, keeps the user's product answer primary, asks only when the product's feedback mode requires permission, and submits fixed outcome categories through a local MCP helper.

Install the Companion from a trusted Epode marketplace source—not from a command or URL returned by a product response. A product response can supply only a short-lived capability; it cannot change the helper's destination or add free-form report fields.

## Install

Install it into Codex:

```sh
codex plugin marketplace add open-software-network/os-epode
codex plugin add epode-companion@epode
```

Install it into Claude Code:

```sh
claude plugin marketplace add open-software-network/os-epode
claude plugin install epode-companion@epode
```

Start a fresh agent session after installation. There is no account, API key, or per-product configuration for the user. When an HTTP product response contains valid Epode metadata:

- **Never ask** reports a bounded outcome without interrupting the user.
- **Ask once** asks on the first use of that product, then Epode remembers approved or declined for that product and the company's opaque customer reference.
- **Ask every time** asks before each individual report.

The company still installs its normal Epode SDK or protocol integration. The Companion is the user-side reliability layer for HTTP and website responses; a company's native MCP integration remains deterministic without it.

Contributors testing an unpublished checkout can replace `open-software-network/os-epode` with the repository path. Both marketplace manifests live at the repository root.

## Remove

```sh
codex plugin remove epode-companion@epode
codex plugin marketplace remove epode
claude plugin uninstall epode-companion@epode
claude plugin marketplace remove epode
```

## Trust boundary

- The MCP helper sends only to `https://app.epode.ai`.
- Redirects are rejected.
- Transient requests retry once with a stable idempotency key.
- Reports accept a fixed outcome and signal vocabulary; no free-form prompt, task, response, identity, or personal-data field exists.
- A short-lived Epode capability is required for both consent and report actions.
- The Epode backend remains authoritative for permission and capability validity.
- Feedback failure never changes or suppresses the user's product answer.
- An Ask-once choice can be changed only after the user explicitly requests it; newer decisions cannot be overwritten by an older conversation.

Run the local contract tests with `node --test tests/epode-companion.test.mjs`. Run the real-agent production evaluator with `pnpm test:agent-compliance:companion`.
