# Review — phase 2 chunk 2b (BFF proxy + auth plumbing)

Reviewer: `opus`. Uncommitted delta on `101ab9f`. Reviewed against
`.briefs/phase2-web.md` chunk 2b.

**One minor finding.** The two behaviours that would have been silent
catastrophes — cookie forwarding and multi-`Set-Cookie` pass-through — are both
correct, and I verified them on the wire through a real built Next server rather
than through the unit tests. The auth-injection allowlist held against every
bypass I could construct (23 probes: casing, whitespace, duplicate headers,
traversal, percent-encoding, query smuggling, CL/TE desync).

---

## minor — CORS preflight never reaches the backend, breaking browser-origin MCP clients

`web/app/api/[...path]/route.ts`, `web/app/mcp/route.ts` — no `OPTIONS` export

The route handlers export GET/POST/PUT/PATCH/DELETE/HEAD but not OPTIONS, so
Next auto-generates an OPTIONS responder. Verified against the built server:

```
$ curl -X OPTIONS /mcp -H 'Origin: https://trusted.example' \
       -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: mcp-method'
HTTP/1.1 204 No Content
allow: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
   OPTIONS requests that reached upstream: 0
   access-control-allow-origin present: no
```

Next answers the preflight locally; the Rust `CorsLayer` never sees it. That
layer is deliberately configured (`backend/src/main.rs`): `allow_origin(Any)`,
OPTIONS in `allow_methods`, and custom `allow_headers` for `x-api-key`,
`x-workspace-id`, `mcp-protocol-version`, `mcp-method`, `mcp-name`. Those custom
headers *always* trigger a preflight, so once the proxy fronts the domain in 2e,
any cross-origin browser caller fails at preflight and never issues the real
request.

Blast radius is narrow and worth stating plainly: every documented integration is
server-side and unaffected. `docs/quickstart.mdx` and `docs/integrations/manual-http.mdx`
say "never place the key in a browser", and `docs/integrations/choose.mdx` says
direct browser integration "is not yet supported". The one case this does break is
browser MCP, which `docs/integrations/node-mcp.mdx:28` documents as a supported
opt-in — "`[]` rejects browser Origin requests. Add only trusted browser client
origins." A deployment that has configured `MCP_ALLOWED_ORIGINS` for a trusted
browser origin works today and stops working behind the proxy.

Non-preflighted responses are fine: `access-control-allow-origin` is not in
`STRIPPED_RESPONSE_HEADERS`, so the backend's CORS headers pass through on actual
requests. Only the preflight is swallowed.

Fix is one line per route file — export an `OPTIONS` that goes through
`proxyToApi` like the others, so the backend answers its own preflight. If
browser-origin traffic is considered out of scope for app.epode.ai, this is a
non-issue and can be closed as won't-fix; flagging it so that is a decision rather
than an accident.

---

## 1. Cookie forwarding — correct

`cookie` is absent from `STRIPPED_REQUEST_HEADERS`, and confirmed on the wire
against the built standalone server with a fake upstream:

```
$ curl /api/dashboard -H 'Cookie: af_oa_access=VICTIM_ACCESS; af_oa_refresh=VICTIM_REFRESH'
  upstream saw cookie: af_oa_access=VICTIM_ACCESS; af_oa_refresh=VICTIM_REFRESH
  upstream saw host  : 127.0.0.1:9911     (rewritten, not the client's Host)
```

Both cookies arrive verbatim in one header, which is what
`backend/src/os_accounts.rs` `cookie(headers, ACCESS_COOKIE)` parses. The
os-platform divergence called out in the brief (strip cookie, inject bearer) was
correctly *not* copied.

## 2. Set-Cookie pass-through — correct, including the multi-cookie case

This is the one I most expected to fail, because `Headers` + `Response` +
Next's response serialisation each have a history of collapsing `Set-Cookie` into
one comma-joined header. It does not:

```
$ curl -D - /api/dashboard        # upstream returns two Set-Cookie headers
HTTP/1.1 200 OK
set-cookie: af_oa_access=ROTATED_ACCESS; Path=/; HttpOnly; SameSite=Lax
set-cookie: af_oa_refresh=ROTATED_REFRESH; Path=/; HttpOnly; SameSite=Lax
x-upstream: preserved
--- count of Set-Cookie headers on the wire: 2
```

Two distinct headers reach the client. `responseHeaders()` handles this by
iterating Node's `IncomingMessage.headers`, where `set-cookie` is always an array,
and calling `headers.append()` per value — undici keeps `set-cookie` un-coalesced,
and Next emits them separately. Token rotation will work.

## 3. Auth injection — no bypass found

`authorization` and `x-api-key` are both stripped unconditionally on the way in,
then re-injected only when path *and* token prefix both match. The check and the
destination are the same `upstreamPath` string, so there is no TOCTOU gap between
"what was authorised" and "where it was sent". 23 probes against the running
server:

| probe | result |
|---|---|
| telemetry + `Bearer af_live_` / reports + `afr2_` / mcp + `af_read_` | injected ✅ (intended) |
| telemetry + `x-api-key: af_live_` | injected ✅ (intended) |
| telemetry + `afr2_`, reports + `af_live_`, mcp + `af_live_` | **stripped** ✅ |
| `/api/dashboard`, `/api/products`, `/auth/start` + any token | **stripped** ✅ |
| arbitrary token `Bearer ATTACKER` on telemetry | **stripped** ✅ |
| `authorization:` / `AUTHORIZATION:`, `bearer` / `BEARER` | scheme match is case-insensitive ✅ |
| `AF_LIVE_` uppercase prefix | **stripped** ✅ — matches Rust's case-sensitive `starts_with` |
| extra spaces, tab separator | trimmed and injected correctly ✅ |
| **two `Authorization` headers** (`ATTACKER` + `af_live_S`) | **stripped** ✅ fail-closed — `Headers` joins them, the joined value fails the prefix test |
| `/api/v2/telemetry/batches/` (trailing slash) | Next normalises → correct path ✅ |
| `/api/v2/./telemetry/batches`, `/api/v2/../v2/telemetry/batches` | Next normalises before the catch-all; path and injection stay consistent ✅ |
| `/api/../auth/start` | resolves to `/auth/start`, **no injection** ✅ |
| `/api/v2%2Ftelemetry%2Fbatches` | upstreamPath `/api/v2%2F…` ≠ allowlist → **stripped** ✅ |
| `/api/v2/telemetry/%62atches` | decoded+re-encoded to the real path, injected ✅ (correct round-trip) |
| `/api/dashboard?x=/api/v2/telemetry/batches` | query cannot influence the path → **stripped** ✅ |
| `/api/v2/telemetry/batches;x=1` | segment encoded, ≠ allowlist → **stripped** ✅ |

The three prefixes match the Rust side: `af_live_` → `agent_product_auth`,
`afr2_` → `product_feedback_handler`'s capability filter, `af_read_` →
`read_product_auth`. `pathFromSegments` percent-encodes each decoded segment, so a
segment can never introduce `/`, `?` or `#` into the upstream path.

Worth noting for completeness: injecting an attacker's *own* `af_live_`/`afr2_`
token from a browser is not a privilege gain — those Rust handlers read the bearer
and ignore cookies, so the request authenticates as the attacker's product, and
cross-site cookie-bearing POSTs are separately blocked by the backend's
`SameSite=Lax`.

## 4. Middleware is plumbing only

`web/proxy.ts` reads `request.cookies.get(...)?.value` for presence only — no
decode, no verify, no signature check, no expiry check. Confirmed by the test
`checks cookie presence only and leaves verification to Rust`, which passes a
literal `not-a-verified-token` and expects `next()`. Machine traffic short-circuits
before the cookie check (`pathname.startsWith("/api/") || pathname === "/mcp"`),
so SDK and MCP callers are never redirected.

The file is named `proxy.ts`, which is Next 16's rename of `middleware.ts` — and it
is genuinely wired up, not silently dead: the build prints `ƒ Proxy (Middleware)`
and an unauthenticated `GET /` returns `307 → /auth/signin` on the running server.

No open redirect: the redirect target is a fixed `/auth/signin`, and `return_to`
carries only same-origin `pathname + search`, URL-encoded. `//evil.example/x` is
normalised by Next before middleware sees it; `/%2F%2Fevil.example` encodes to
`%2F%252F%252F…`. `return_to` is not consumed anywhere yet, so nothing acts on it.

## 5. Header policy

RFC 7230 hop-by-hop set is complete (`connection`, `keep-alive`,
`proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`,
`transfer-encoding`, `upgrade`), plus dynamic stripping of everything named in the
client's own `Connection:` header — in both directions. Verified on the wire:

```
x-forwarded-for/host/proto  (stripped)   forwarded   (stripped)
x-real-ip, x-user-id        (stripped)   cookie      forwarded
x-custom-keep               forwarded    content-length / transfer-encoding (stripped)
accept-encoding             (stripped)
```

Request framing has no smuggling surface: `content-length` and
`transfer-encoding` are both stripped inbound and Node re-frames the buffered body
itself — a POST arrives upstream with exactly one `content-length: 19` and no
`transfer-encoding`. A raw-socket CL+TE desync attempt is rejected before reaching
the handler:

```
$ printf 'POST /api/v2/reports HTTP/1.1\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n...' | nc
HTTP/1.1 400 Bad Request
```

`accept-encoding` stripped outbound with `content-encoding` stripped inbound is a
consistent pair — upstream won't compress, and the belt-and-braces strip prevents
a mislabelled body. `content-length` is stripped from responses too, which is
required since the body is re-framed.

## 6. SDK / MCP compatibility

`/api/v2/telemetry/batches`, `/api/v2/reports` and `/mcp` all proxy through with
the correct upstream path, query string preserved
(`/api/v2/telemetry/batches?source=test`), body preserved byte-for-byte, and the
machine bearer restored. GET/POST/PUT/PATCH/DELETE/HEAD all reach upstream. The
middleware never redirects them. The only gap is the OPTIONS preflight above.

Full response buffering (`Buffer.concat` before returning) is safe here — I checked
for `text/event-stream` / `Sse` / `from_stream` across `backend/src/` and the
backend has no streaming responses; `/mcp` is stateless JSON-RPC with
`transport_sessions: false`.

## 7. Do the tests prove the behaviour?

Yes. `bff.test.ts` stands up a real `node:http` server, points `API_URL` at it,
calls the actual exported route handlers, and asserts on **what the upstream
process actually received** (`request.headers.cookie`, `request.url`,
`request.body`) — not on mocks of the proxy's own internals. The upstream returns
two real `Set-Cookie` headers and the test asserts `getSetCookie()` returns both.
`proxy.test.ts` asserts the real `NextResponse` markers (`x-middleware-next`,
`location`).

One thing the tests can't reach on their own: `getSetCookie()` on the returned
`Response` proves the object is right, not that Next serialises it as two headers
on the wire. That is exactly the historical failure mode, which is why I ran it
end-to-end against the built server — it passes there too.

## CI additions

Both are correctly wired and both actually fire.

- `web-types-check` regenerates `web/lib/api/types.ts` from `backend/openapi.json`
  and `git diff --exit-code`s it. Passes on the current tree (regeneration is
  byte-identical). I reproduced the failure path in a scratch git repo: on drift it
  prints the diff plus "Generated web API types are stale…" and **exits 1**, which
  fails the step. `types.ts` is tracked, so `git diff` is a valid detector, and a
  failure of `pnpm run gen:types` itself aborts the target since each recipe line
  is its own shell.
- The `web` job's path filter includes `backend/openapi.json`, so a backend-only
  PR that changes the spec does trigger the drift check. That closes the gap I
  flagged in the 2a review.
- `make web-build` added as a CI step gives a production-build gate without
  slowing `make check`.

Note that `web-types-check` and `web-build` are CI-only — `make check` still runs
only `web-check web-typecheck web-test`. CI is the enforcement point so nothing
escapes, but a local `make check` will not catch stale generated types.

## Verification

Read-only. Nothing edited, staged, committed or pushed; `os-platform` untouched.
Background servers used for the wire tests were started from the scratchpad and
stopped afterwards; final `git status` is unchanged from the start.

```
$ eval "$(fnm env)" && fnm use 22.23.1                 v22.23.1
$ pnpm --filter @epode/web typecheck                   exit 0
$ pnpm --filter @epode/web test                        3 files, 9 tests passed
$ pnpm --filter @epode/web build                       ✓ Compiled; routes:
                                                       ƒ /api/[...path]  ƒ /auth/[...path]
                                                       ○ /auth/signin    ƒ /mcp
                                                       ƒ Proxy (Middleware)
$ pnpm check                                           Checked 47 files. No fixes applied.
$ make check                                           MAKE_CHECK_EXIT=0 (full run incl. web steps)
$ make web-types-check                                 exit 0, tree unchanged

--- end-to-end on the built standalone server (API_URL -> instrumented upstream) ---
Set-Cookie pass-through          2 separate headers on the wire ✅
cookie forwarding                verbatim, host rewritten ✅
auth allowlist                   23 probes, table above, no bypass ✅
identity headers                 x-forwarded-*/x-real-ip/x-user-id/forwarded stripped ✅
framing                          one content-length, no TE; CL+TE raw request → 400 ✅
middleware live                  GET / (no cookie) → 307 /auth/signin ✅
machine traffic                  /api/v2/*, /mcp not redirected ✅
OPTIONS                          answered by Next, 0 reached upstream, no ACAO ← the finding
```

## Verdict

**ship** — the finding is narrow, only manifests once the proxy fronts the domain
in 2e, and only for browser-origin callers that the docs largely say aren't
supported. Worth a decision (add the `OPTIONS` export, or record that
browser-origin API access is out of scope) rather than a blocker.
