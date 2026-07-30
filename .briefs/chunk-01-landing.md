# Chunk 1 — landing-page port + rendered-html test rewrite

Repo: os-epode, worktree `/Users/jakubswierczek/code/alongside/os-epode/.worktrees/dev-cleanup`,
branch `jakub/dev-cleanup`. Read `.briefs/dev-setup-overhaul.md` first — it is the
master brief. This file is chunk 1 of 6. Do ONLY chunk 1.

## Context

The repo is dropping Next.js + Cloudflare Workers + Vite entirely (chunk 2).
Before that stack is deleted, the marketing landing page must be re-created as
hand-written static HTML/CSS so nothing is lost.

## Scope — do exactly this

1. Create `landing-page/`:
   - `index.html` — port the landing content from `app/page.tsx`, using
     `app/layout.tsx` for `<head>`/metadata and `app/globals.css` for styling.
     Hand-written static HTML + a plain `styles.css`. No React, no build step,
     no Tailwind, no framework. Inline the Tailwind-derived styles as ordinary
     CSS you write yourself.
   - `app/index.html` (serves `/app`) — port `app/app/page.tsx`: a meta-refresh
     redirect to `https://app.epode.ai/auth/start`, plus a plain link fallback
     for no-JS/no-refresh clients.
   - `styles.css` — the hand-written stylesheet.
   - `package.json` — minimal, `"private": true`, name `landing-page`, no deps,
     no build script. It will become a pnpm workspace member in chunk 2.
2. Preserve ALL user-visible copy, headings, and links from `app/page.tsx`
   verbatim. Do not reword, do not "improve" the marketing copy.
3. Rewrite `tests/rendered-html.test.mjs` so it reads `landing-page/index.html`
   (and `landing-page/app/index.html`) from disk as source text and asserts the
   same contract the current test asserts. Keep every existing assertion's
   intent — including the `assert.doesNotMatch` negative assertions. Drop the
   worker/`dist/server` import entirely.

## Do NOT

- Do not delete or modify `app/`, `worker/`, `vite.config.ts`, `package.json`,
  lockfiles, or anything else. Deletion is chunk 2's job.
- Do not touch `backend/`, `backend/public/`, `docs/`, `sdk/`, `protocol/`.
- Do not touch Railway, any `.github/workflows/`, or run any deploy.
- Do not commit. The orchestrator commits.

## Done looks like

- `landing-page/index.html`, `landing-page/app/index.html`,
  `landing-page/styles.css`, `landing-page/package.json` exist.
- `node --test tests/rendered-html.test.mjs` passes with no build step and
  without `dist/` present.
- `git status` shows only additions under `landing-page/` plus the one modified
  test file.

When done, reply with a short summary of what you changed and the test output.
