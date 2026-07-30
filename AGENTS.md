# os-epode — Agent Instructions

## Project

Agent Feedback: structured product feedback from customer agents. Rust backend
(`backend/`) serving a vanilla-JS dashboard (`backend/public/`), a hand-written
static HTML/CSS marketing site (`landing-page/`), SDKs (`sdk/`), and the public
protocol (`protocol/v1/`).

## Agent skills

### Issue tracker

Issues live on the Open Software platform (os-platform), Product `epode` — not
GitHub Issues. Primary interface is the OS Platform MCP
(`mcp__claude_ai_OS_Platform__fellow_*`); the vendored `os-platform` skill
script is the shell fallback and cannot set labels, parents, or relations.
Bodies are append-only, writes are probe-then-verify. See
`docs/agents/issue-tracker.md`.

That doc's **Wayfinding operations** section defines how the `wayfinder` skill
maps onto this tracker. Parent/child, labels, and assignment are native;
**blocking is not** — relation kinds are only `related` / `duplicate_of`, so
blocking is a body convention and the frontier must be computed client-side
and narrated.

## Verification

- `pnpm test` — runs `node --test tests/*.test.mjs`.

The dashboard test suite asserts against the **source text** of
`backend/public/app.js`, `app.html`, and `styles.css`, plus a DOM harness in
`tests/dashboard-runtime.test.mjs`. Asset URLs in `app.html` are cache-busted
(`?v=YYYYMMDD-<name>`) and the version string is asserted by the tests — bump
both the file and the assertion together.
