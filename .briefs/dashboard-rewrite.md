# Track 2 — Next.js dashboard rewrite (`web/`)

Prereq: dev-setup-overhaul landed (pnpm workspace, biome, Makefile, trunk CI,
staging env). Sequencing: this track → connectors → VM agent.

## Architecture
- Two services, os-platform copy:
  - `web/` — Next.js (app router, newest TS), Railway service `epode-web`,
    serves app.epode.ai after cutover.
  - Rust API — gains `api.epode.ai` custom domain (additive, add early;
    canonical for SDK/MCP machine traffic going forward).
- Web is a BFF: server-side proxy of `/api/*`, `/mcp`, `/auth/*` to the Rust
  API via Railway-internal `API_URL`. Browser never leaves app.epode.ai; no
  CORS. SDK/MCP compat paths (app.epode.ai/api/v2, /mcp) keep working
  through the proxy; docs later advertise api.epode.ai as canonical.
- Auth plumbing-only (copy os-platform web/proxy.ts + ADR-0006 stance):
  middleware checks cookie PRESENCE only + explicit auth-route allowlist
  (/auth/start, /auth/callback, /auth/logout, signin page); never verifies
  tokens in Node. Rust extractors remain the single trust root. PKCE flow,
  http-only cookies, PUBLIC_BASE_URL=https://app.epode.ai all unchanged →
  no OS Accounts reconfig.
- Impl-time fact-check: does Rust resolve() auto-refresh the token pair on
  every request? If not, copy os-platform's BFF refresh piece.

## Stack
- Next + TypeScript + Tailwind + Base UI + TanStack Query +
  react-hook-form/zod + vitest/RTL.
- Skip: Storybook, OpenTelemetry, tiptap, Playwright (Playwright arrives
  with connectors track).
- Design system: COPY the files from os-platform web/ (components/, design
  tokens, layout shells) into web/ — fork-copy, no cross-repo dep. Epode's
  current dashboard look is retired; parity = same data + capabilities,
  not same pixels.
- OpenAPI typegen: add `utoipa` to the Rust API — ONE dedicated PR
  annotating all handlers + emitting openapi.json — then
  `openapi-typescript` generates web/lib/api/types.ts (os-platform
  gen:types pattern).
- web/ is a pnpm workspace member (pnpm, NOT bun despite os-platform),
  own package.json, biome, no cross-deps with other packages.

## Migration
- Big-bang parity port of all 6 views: Home, Feedback, Sessions, Setup,
  Collection policy, Team. Reference for behavior: backend/public/app.js
  (1,149 lines) + existing API routes in backend/src/main.rs.
- Verify by click-through on staging (seed via setup-matrix agents pointed
  at staging).
- Cutover at promote time: move app.epode.ai domain from epode-api
  service → epode-web. Rollback = re-point domain.
- AFTER verified flip, separate PR: delete backend/public/ dashboard files
  (app.html, app.js, styles.css — keep SDK artifact downloads) + the
  source-text/DOM-harness tests that assert them. vitest/RTL replaces.
  Note: backend/public also hosts SDK tarballs/wheels — those stay served
  by Rust.

## Deploy
- web/Dockerfile — next build standalone output.
- build-web.yml: main push touching web/ → GHCR os-epode-web:<sha>+staging
  → auto-deploy Railway staging.
- promote.yml: add `web` artifact choice.
- epode-web service in staging + production envs; API_URL via Railway
  internal networking.

## Out of scope
- Connectors (next track; its tab is the pilot new feature of web/).
- sdk/, examples/, epode-ask-mcp, epode-ask-http, example-* Railway
  services: untouched.
- Landing page (landing-page/, epode service) untouched.
