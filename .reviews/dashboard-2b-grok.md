# Phase 2 chunk 2b review — BFF proxy + auth plumbing

Reviewer: grok. Uncommitted delta on `jakub/dashboard-rewrite`.
Against `.briefs/phase2-web.md`, `.briefs/dashboard-rewrite.md`.

---

## blocker — `/join/*` is neither proxied nor allowlisted; team invite links are dead
file: web/proxy.ts:7-18, missing `web/app/join/`

Rust serves `GET /join/{invitation_id}`: sets `af_team_invite` cookie, redirects to
`/auth/start`. Dashboard emits invite URLs as `${location.origin}/join/${id}`
(`backend/public/app.js`, create-invitation response `joinPath`).

Next app after 2b:

1. No route under `web/app/join/` (build only has `/api/[...path]`, `/auth/[...path]`,
   `/mcp`, `/auth/signin`).
2. Middleware allowlist is only
   `/auth/signin|start|callback|logout`. Path `/join/…` with no session cookie →
   redirect to `/auth/signin?return_to=/join/…`.
3. Sign-in page only links to `/auth/start` — never hits join — so
   `af_team_invite` is never set and `auth_callback` cannot accept the invite.

Failure mode: shareable/email invite links on app.epode.ai always fail (404 after
auth, or signin loop). Auth plumbing chunk owns this path.

Suggested fix: proxy `GET /join/*` → Rust (e.g. `web/app/join/[invitation_id]/route.ts`
or catch-all) and add `/join` (prefix) to the middleware public allowlist. Do not
require cookies on join.

---

## major — `/.well-known/agent-feedback-v1.json` not proxied; discovery breaks on app host
file: missing route; web/proxy.ts:16-17, 25-31

Protocol discovery is on the public base URL (`feedback_discovery` in Rust;
setup UI and install prompts use `/.well-known/agent-feedback-v1.json` on
`location.origin`). Plan keeps `PUBLIC_BASE_URL=https://app.epode.ai`.

Unauthenticated GET → middleware redirect to signin HTML. Authenticated GET →
Next 404 (no page/proxy). Agents and “Protocol contract” links break on the app
host.

Suggested fix: BFF route for `/.well-known/agent-feedback-v1.json` (and allowlist
in middleware without cookie). Exact path is enough.

---

## major — `/static/*` not proxied; SDK artifact URLs on app host break
file: missing route; web/proxy.ts matcher/allowlist

Discovery and setup use `${public_base_url}/static/agent-feedback-*.tgz` (and
wheel/zip). Same origin as the app when `PUBLIC_BASE_URL` is app.epode.ai. Rust
still nests `ServeDir` at `/static`.

Without a proxy + public middleware pass-through, install artifact downloads from
the app host 404 or bounce to signin (matcher excludes only a few extensions, not
`.tgz`/`.whl`/`.zip`).

Suggested fix: proxy `/static/*` to Rust; treat `/static` as public in middleware
(no cookie).

---

## Checked clean (no finding)

### Cookie forwarding
`requestHeaders` strips hop-by-hop, `authorization`, `x-api-key`, `x-forwarded-*`,
`host`, etc., and does **not** strip `cookie`. Test asserts
`cookie: af_oa_access=…; af_oa_refresh=…` on upstream. Matches Rust
`OsAccountsClient::resolve` cookie auth.

### Set-Cookie pass-through
Upstream multi-value `set-cookie` array is `headers.append`’d per value; test
uses real Node server + `response.headers.getSetCookie()` for both access and
refresh. Rust cookies are `Path=/; HttpOnly; SameSite=Lax` (no Domain) — correct
for app-host BFF.

### Auth injection / strip
Client `Authorization` / `x-api-key` always stripped; re-injected only as
`Bearer <token>` when path is exactly
`/api/v2/telemetry/batches` + `af_live_`,
`/api/v2/reports` + `afr2_`,
`/mcp` + `af_read_`.
Prefixes match `store.rs` / `product_feedback_handler`. Wrong prefix on allowlisted
path stripped (test). Path `===` is fail-closed under `..` normalization (auth
check uses pre-normalize string; no inject onto `/api/dashboard`). Hop-by-hop
`Connection` tokens stripped both ways; `content-length` /
`transfer-encoding` / `accept-encoding` / response `content-encoding` handled.

### Middleware plumbing-only
Cookie **presence** of `af_oa_access` | `af_oa_refresh` only; no JWT decode.
`/api/*` and `/mcp` skip redirect. Auth allowlist exact paths. `proxy.ts` is
picked up as Next 16 Proxy/middleware (build: `ƒ Proxy (Middleware)`).

### SDK/MCP paths that are implemented
`/api/[...path]`, `/mcp`, `/auth/*` (logout → `/api/auth/logout`) proxied; tests
hit real upstream.

### Tests
Not mock-only: local `http.createServer`, assert upstream method/url/headers/body
and multi Set-Cookie. Proxy tests cover allowlist, return_to, cookie presence,
API/MCP bypass.

### CI/Makefile
`web-types-check` (gen:types + `git diff --exit-code` on types.ts) and
`web-build` in CI; types check green when in sync.

---

## Verification

```
fnm use 22.23.1
pnpm --filter @epode/web typecheck   → 0
pnpm --filter @epode/web test        → 3 files, 9 tests pass
pnpm --filter @epode/web build       → 0 (routes: api/auth/mcp/signin + Proxy)
pnpm check                           → 0
make web-types-check                 → 0
```

## Verdict
do not ship

Must fix `/join` (blocker). Should fix `/.well-known` and `/static` before app
host is `PUBLIC_BASE_URL` / cutover traffic, or agents and setup downloads fail
on the same origin the plan keeps.
