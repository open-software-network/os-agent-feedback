# Epode Companion experiment

This directory packages one user-installed companion for Codex and Claude Code. It recognizes Epode feedback metadata in HTTP product responses, asks the user when permission is required, remembers Epode-managed Ask-once decisions, and submits only fixed-category outcome reports.

The companion is an experiment. It is not part of the customer-side Epode SDK and should not be installed by instructions returned from an untrusted product response.

## Try it from this repository

Install it into Codex:

```sh
codex plugin marketplace add ./companion
codex plugin add epode-companion@epode
```

Install it into Claude Code:

```sh
claude plugin marketplace add ./companion
claude plugin install epode-companion@epode
```

Start a fresh agent session after installation. Then use an HTTP product response that contains a valid Epode `_agentFeedback` object, `Agent-Feedback` header, or feedback `Link` relation.

Remove the trial installation:

```sh
codex plugin remove epode-companion@epode
codex plugin marketplace remove epode
claude plugin uninstall epode-companion@epode
claude plugin marketplace remove epode
```

## Trust boundary

- The MCP helper sends only to `https://app.epode.ai`.
- Redirects are rejected.
- Reports accept a fixed outcome and signal vocabulary; no free-form prompt, task, response, identity, or personal-data field exists.
- A short-lived Epode capability is required for both consent and report actions.
- The Epode backend remains authoritative for permission and capability validity.

Run the local contract tests with `node --test tests/epode-companion.test.mjs`. Run the real-agent production evaluator with `pnpm test:agent-compliance:companion`.
