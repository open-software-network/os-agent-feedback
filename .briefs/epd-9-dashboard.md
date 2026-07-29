# Brief: EPD-9 dashboard — surface read keys in the existing UI

You own the **dashboard only**. A sibling agent owns the Rust backend in parallel.
You start blank; this brief plus the linked artifacts are everything.

**Repo**: `/Users/jakubswierczek/code/alongside/os-epode` (you are in it), branch `main`.

## Your files — touch nothing else

- `backend/public/app.js`
- `backend/public/app.html`
- `backend/public/styles.css`
- `tests/setup-page.test.mjs`
- `tests/dashboard-runtime.test.mjs`

**Do not touch** `backend/src/**` or `backend/migrations/**` — the sibling agent owns those
and you will collide. **Do not touch** `protocol/v1/`, `sdk/`, or the `.well-known`
descriptors: explicitly out of scope.

## Context

Agent Feedback: a customer's AI agent uses someone's product, then reports whether it
actually worked. Product owners read that in this dashboard.

Today there is one kind of product key — a **write** key, `af_live_...`, which goes in the
product server's `AGENT_FEEDBACK_KEY` environment variable so the SDK can emit feedback.

We are adding a second kind — a **read** key, `af_read_...`, which goes in an *MCP client
config* so an agent in the product's repo can pull feedback. Your job is to let people
mint and manage it.

**Read the issue EPD-9 and `docs/mcp-client-config.md` before starting.** Every design
decision is settled — implement, do not re-open.

## The backend contract (already agreed; code against it)

- Each entry in the dashboard's `apiKeys` array carries `id, environmentId, label, prefix,
  kind, createdAt, lastUsedAt, revokedAt, expiresAt`. `kind` is `"write"` or `"read"`.
- `POST /api/settings/api-keys` accepts `{ label, environmentId, kind, expiresInSeconds }`.
  Omitting `kind` means write. `expiresInSeconds` must be 60..31536000 or absent for never.
- Read keys look like `af_read_<32 hex>_<secret>`; the `prefix` field is the first 16
  characters, so `af_read_` plus 8 hex.

If the backend is not finished when you start, code against this contract anyway — the
tests assert against source text, so they pass without a running server.

## Work

**1. The rotate path must become kind-aware. This is the highest-risk item.**

Today the `data-revoke-key` handler in `app.js` revokes whatever key the row targets, then
unconditionally creates a **write** key:

```js
body: JSON.stringify({ label: "Default product key", environmentId: ... })
```

The moment read keys exist they appear in the same list, so rotating a read key silently
converts it into a write key — privilege escalation through the UI. Rotation must preserve
the kind of the key being rotated, and the confirm text should name which kind.

**2. `isLegacyKeyPrefix` must learn the read prefix.** It is currently
`!/^af_live_[0-9a-f]{8}$/`, so every read key would render with the red legacy warning. A
v2 key of *either* kind is `af_live_` or `af_read_` followed by 8 hex characters.

**3. Key rows show kind, expiry and last-used.** The `existing-connections` disclosure
already lists keys with label, prefix and created date. Add the kind, the expiry (or
"never"), and last-used (or "never used"). `lastUsedAt` is already returned by the backend
and simply not rendered today.

**4. Creating a read key.** Offer it wherever write-key creation lives now. The create
form gains an expiry choice **defaulting to 90 days**, with an explicit "never" option.
Reuse the shown-once `secret-callout` pattern and `rememberSetupSecret` exactly as the
write key does.

**5. Install snippet for read keys, with per-client variants.** A read key's destination is
an MCP client config, not a server environment variable. Claude Code, Cursor and VS Code
each interpolate secrets differently — the exact snippets are in
`docs/mcp-client-config.md`. Reuse the existing `install-methods` tab pattern (already used
for the agent-versus-manual choice) and `copy-block`.

## Constraints

**Reuse existing patterns. No new design.** The dashboard is being redesigned shortly, so
anything invented here is waste. Use the `existing-connections` disclosure, the
`secret-callout`, `copy-block`, and `install-methods` tabs. New CSS only for a kind label.

**Cache-busting**: `app.html` pins `?v=20260728-rename` on both `app.js` and `styles.css`,
and `tests/setup-page.test.mjs` asserts both strings. Bump all four together to
`20260729-readkeys`. Missing one means a stale bundle or a failing test.

## Verify

`npm run test` and `npm run lint`.

The suite asserts against the **source text** of `app.js` / `app.html` / `styles.css`
(regex over file contents) and there is a DOM harness in `tests/dashboard-runtime.test.mjs`
whose fixture uses `prefix: "af_live_1234abcd"`. Follow both existing styles; do not
introduce a new harness.

Add coverage for: the rotate path preserving kind, `isLegacyKeyPrefix` accepting both v2
prefixes and still rejecting legacy, kind/expiry/last-used rendering, and the read-key
install snippet. **Add a runtime-harness fixture with a read key** — the DOM harness
currently only has a write key, so the read path would otherwise be untested at runtime.

## Rules

- Match surrounding style: this file builds UI from template-literal strings; keep using
  `esc()` on every interpolated value.
- No new dependencies. Minimum complexity. Read code before changing it.
- **Do not commit, do not push.** Report the diff stat and test output when done.
- If the backend contract above appears wrong, **stop and say so** rather than changing it
  unilaterally — the sibling agent is coding against it.
