# Review task — chunk 1 (landing-page port)

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`.

## Context

The repo is dropping Next.js + Cloudflare Workers + Vite. Master brief:
`.briefs/dev-setup-overhaul.md`. Chunk 1 brief: `.briefs/chunk-01-landing.md`.

Chunk 1 re-created the marketing landing page as hand-written static HTML/CSS in
the new `landing-page/` directory, ported from `app/page.tsx`, `app/app/page.tsx`,
`app/layout.tsx`, `app/globals.css` (all still present — they get deleted in
chunk 2), and rewrote `tests/rendered-html.test.mjs` to assert against the static
source instead of the built worker.

## What to review

- Everything untracked under `landing-page/` (`git status --short`).
- The diff of `tests/rendered-html.test.mjs` (`git diff tests/rendered-html.test.mjs`).
- Compare against the React sources in `app/` for fidelity.

## What matters

1. **Copy fidelity** — is any user-visible heading, paragraph, link, or CTA from
   `app/page.tsx` missing, reworded, or truncated? Diff the rendered text
   carefully; this is the highest-value check.
2. **Link correctness** — `https://app.epode.ai/auth/start`, `https://docs.epode.ai`,
   the `/.well-known/agent-feedback-v1.json` protocol link, anchors.
3. **`/app` redirect** — does `landing-page/app/index.html` actually redirect to
   `https://app.epode.ai/auth/start`, with a working no-JS fallback link?
4. **CSS fidelity** — the original used Tailwind utility classes plus
   `app/globals.css`. Did the port lose layout, responsive behavior, dark mode,
   or font setup? Note anything visually load-bearing that was dropped.
5. **Test quality** — does the rewritten test still cover every assertion the
   old one made, including the negative `assert.doesNotMatch` ones? Are the
   assertions actually meaningful against static HTML, or did they become
   trivially-true string checks?
6. **Scope violations** — anything touched outside `landing-page/` and
   `tests/rendered-html.test.mjs` is out of scope for this chunk.
7. **Correctness bugs** — broken HTML, unclosed tags, missing `<meta charset>`,
   missing viewport, broken asset paths, accessibility regressions.

Do not review `backend/`, `docs/`, `sdk/`, or `protocol/`.

## Output

Write your findings to the file named in the prompt that dispatched you. Use
this structure:

```
# Review — chunk 1 (landing-page) — <your reviewer name>

## Blocking
- <finding> — file:line — why it must be fixed

## Non-blocking
- <finding> — file:line

## Verdict
SHIP / FIX-FIRST — one sentence
```

Be concrete: cite file and line. Report only actionable findings — no praise, no
summary of what the code does. If you find nothing blocking, say so plainly.
Write the file, then reply with only the file path and your one-line verdict.
