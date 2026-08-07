# Consumer chat commerce — live methodology

This is the release methodology for testing the PetSmart reference storefront
in real consumer AI products. It is not a prompt simulator. Every scored run
uses the actual signed-in chat UI, a public storefront origin, and origin-side
request evidence.

The fixtures in `cases.json` deliberately include both a zero-match case and
positive controls. A storefront that always recommends, or always refuses,
fails even when one answer happens to sound plausible.

## Release gates

Score each run on seven independent gates:

1. **Origin reached** — the storefront log contains a request caused by this
   run. Search results or model claims without an origin request do not count.
2. **Need carried** — a situation, faceted, or native-graph request carries the
   merchant's expected need dimensions. A root-only fetch is a safe fallback,
   not a need-capture win.
3. **Catalog fidelity** — names, prices, features, and stock match the merchant
   response; no outside retailer is substituted.
4. **Constraint fidelity** — hard constraints exclude products. A near miss is
   never scored as a recommendation unless the user explicitly changes the
   constraint.
5. **Decision quality** — zero-match and positive-control cases produce the
   expected different outcomes from `cases.json`.
6. **Durable handoff** — the answer exposes a clickable merchant-owned `/s/`
   or `/c/` result, or a permanent product URL. Private `j-...` URLs may be
   sources, but clicking them must redirect to a permanent shopper URL.
7. **Activated attribution** — when the returned link is clicked, the browser
   lands on the merchant URL and the storefront records at most one bounded
   intent/handoff. Background fetches must not mint shopper identity.

A platform/method pair is a release candidate only after at least five fresh
repetitions of every case, with zero hard-constraint violations and no
catalog fabrication. Report counts per gate; do not collapse the result into
one subjective pass rate.

## Experimental hygiene

- Use the prompt text in `cases.json` without adding traversal instructions,
  route names, expected products, or hints about the storefront's graph.
- Use each product's memory-free mode where available. Account memory is a
  separate personalization trial, not part of the compatibility baseline.
- Use a new chat for every run. For page-shape A/B tests on quick tunnels,
  rotate the hostname as well: consumer chats cache fetched pages across
  nominally fresh sessions.
- A quick-tunnel run can eliminate a bad response shape, but it cannot approve
  a release for index-driven platforms. Final release trials require one
  stable merchant hostname, normal TLS, permissive robots, and enough time for
  indexing.
- Keep the request logger enabled. It records bounded method/path/UA/fetch
  fields and redacts query strings and journey capabilities. Never commit raw
  prompts, transcripts, cookies, IPs, or account identifiers.
- Run ordinary chat and shopping/product modes as separate surfaces. Do not
  pool them.

## Platform procedures

### ChatGPT

- Start a **Temporary chat** in the normal Chat surface and use Instant mode.
- The observed user-triggered fetcher is `ChatGPT-User`. The compatible root
  keeps facets first, exact `/feeders?...` anchors, and a full catalog fallback.
- Score a root-only answer as retrieval success but need-capture failure. Never
  infer a second hop from citations alone; require the origin path.
- ChatGPT rejects some new `trycloudflare.com` origins as invalid. Such a run
  is an origin-reputation failure and cannot compare page shapes.

### Claude

- Start **Incognito** and keep the normal Chat surface. This prevents remembered
  pet preferences from contaminating constraint scoring.
- Claude reliably follows named situation links. Signed situation paths are
  attribution hops and redirect to permanent `/s/...` results.
- Inspect the final answer anchors, not only the prose. The shared-feeder case
  must recommend nothing; the one-cat protection case must link the permanent
  SureFeed PDP.

### Gemini

- Start a **Temporary chat** in Thinking mode.
- The observed live fetcher can be the literal UA `Google`; it receives the
  link-first root so price, stock, and fit require a situation fetch.
- No origin request is a platform retrieval failure. Do not respond by putting
  unverified stock on the root just to make the test pass.

### Grok

- Start a **Private chat** in Auto mode.
- Grok's cloud browser uses ordinary Safari/Chrome UAs. Treat it as unverified
  cloud-browser traffic unless a signed path or activated chat referrer supplies
  stronger evidence.
- Score the public `/s/...` and native JSON graph separately. The answer must
  keep the hard budget and expose a permanent result link.

### Perplexity

- Start **Incognito** and test Search. Test Computer separately; do not pool it
  with Search.
- Search often refuses unindexed quick tunnels without touching the origin.
  The corrective method is a stable indexed hostname plus product/catalog
  feeds, not more response-local instructions.

### Meta AI

- Use a fresh ordinary chat; test **Discover products** as a separate surface.
- `meta-webindexer` root traffic proves indexing, not a live user traversal.
  A `LIVE_CRAWL_POLICY_BLOCKED` second hop remains a platform-policy failure.
- Keep stable public `/s/` and `/feeders` routes because Meta may construct or
  display them even when it declines the live second fetch.

### Copilot

- Start a **Temporary chat** in Smart mode. Test Shopping separately.
- A result assembled from Bing/Amazon without an origin request fails catalog
  fidelity even if the product category is right.
- The corrective method is Bing/Microsoft merchant distribution and a stable
  indexed host; pasted-page markup cannot force origin retrieval.

## Current live evidence — 2026-08-07

- Claude Incognito passed both opposing cases on a fresh hostname: zero
  recommendations for `shared_feeder_hard_175`, and the $169.99 SureFeed with
  9 nearby units plus a clickable permanent product URL for
  `protect_one_cat_hard_175`.
- Grok Private traversed the public situation and native graph for the shared
  case, preserved the hard cap, reported zero exact matches, and cited the
  permanent `/s/...` result.
- ChatGPT safely refused the shared case on one reachable quick-tunnel run but
  did not fetch beyond the root; a later fresh hostname was rejected before an
  origin request. A stable-host release result is still required.
- Gemini, Perplexity Search, and Copilot produced no usable origin retrieval in
  the matched quick-tunnel baseline. Meta indexed the root but blocked the
  situation hop. These are distribution/origin requirements, not page-shape
  wins.

This evidence supports the scoped-intent graph and permanent-handoff pattern.
It does not support an "absolute" universal claim: platform browsing and
indexing policies are external, change over time, and must remain visible in
the scorecard.
