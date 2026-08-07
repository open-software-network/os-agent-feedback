# PetSmart demo — agent traffic to discoverable customers

A PetSmart-branded storefront that demonstrates the full Epode loop on real
increased-AI-traffic terms:

1. **Crawl** — ChatGPT, Claude, Gemini, and other user-triggered fetchers
   receive the
   faceted agent storefront: plain HTML whose links ARE the experience graph.
   ChatGPT receives the exact faceted-query anchor shape validated in PR #119,
   such as `/feeders?pets=multiple_cats&motivation=one_food_motivated&budget=200&journey=<compact-signed-journey>`.
   The compact capability is UUID-shaped so the proven link grammar remains
   intact while tampering, expiry, restarts, and load-balanced hops remain
   verifiable. Gemini and Meta receive a signed journey path such as
   `/shop/automatic-feeders/<signed-expiring-journey>/multiple-cats-food-stealing-under-200`,
   plus a short public citation such as
   `/s/multiple-cats-one-steals-food-under-200`; the merchant-owned slug
   resolves the closed need dimensions without a fragile query string. Live
   stock and exact fit evidence appear only on those pages — the value
   asymmetry that earns a need-carrying second fetch.
   When none of the named situations is exact, the storefront publishes a
   composable `/feeders?...` template. Its results use durable `/c/<signed
   need>/product/<id>` links: the signature covers only bounded catalog
   facets, carries no identity, and does not expire.
   ChatGPT and Claude also receive the full catalog at the root; Gemini's
   observed `Google` fetcher receives a link-first root because it otherwise
   stops after one page. API-capable agents can still walk the structured JSON
   graph at `/agent-negotiate/…`.
2. **Trait capture** — the agent expresses the household's needs through
   merchant-supplied edges: *two cats and a dog, one strongly food-motivated,
   $200 target budget*.
3. **Recommendation** — the graph ranks the **SmartTag RFID Multi-Pet Feeder**
   as the only exact match, with every competing feeder surfaced as a near
   miss backed by catalog evidence.
4. **Click → cookie + session** — the answer includes an ordinary situation
   or product link. PetSmart drops signed first-party `ps_visitor`/`ps_session`
   cookies only on a user-activated navigation. A situation landing is
   recorded as first-party intent, not as a product handoff.
   `product_link_click` requires an actual product navigation plus either a
   valid signed agent capability, a signed same-site continuation, or a
   recognized chat referrer. Preview fetches, ordinary crawlers, forged UUIDs,
   and background cloud-browser visits therefore cannot fabricate AI
   attribution. Public `/s/` and `/c/` links retain the bounded need facets
   without putting a private, expiring journey in the shopper-visible URL.
5. **Traits → signals** — the product page carries Epode's customer-context
   contract; the agent submits the household traits through the merchant's
   same-origin relay (completing the contract's consent step first when the
   backend requires one). They persist as customer signals bound to the
   visitor.
6. **Discoverable return visit** — next time the shopper arrives, the
   homepage greets the household, features the feeder, and records a
   personalization decision; add-to-cart records a conversion outcome.
7. **Dashboard** — the journey, the customer, the pet-household traits, and
   the outcome are all visible live, and Data destinations can stream the
   same signals to PetSmart's warehouse.

## Consumer chat behavior

The matched live matrix found one website representation winner: a hybrid
full-catalog HTML root, signed private traversal links, stable public
situation links, a composable custom-situation URL, and the JSON graph as an
optional deeper surface. Seven page shapes were screened in fresh chats on
Gemini, Grok, Meta AI, Perplexity, Copilot, ChatGPT, and Claude; the hybrid was
the only shape that preserved useful one-fetch fallbacks while still earning
need-carrying second hops where the platform supports them.

The selected delivery policy is platform-specific:

| Platform | Selected approach | What it optimizes |
| --- | --- | --- |
| ChatGPT | Full catalog root + PR #119 faceted-query anchors | Need-state fetch and same-URL human handoff |
| Gemini | Link-first root + signed situation paths | Forces live price/stock verification and yields a permanent `/s/` PDP |
| Grok | `/agent-experience.json` JSON graph, linked from the human storefront | Exact multi-step evaluation and a permanent signed-need `/c/` PDP |
| Claude | Full HTML root + signed situation paths; JSON remains optional | Reliable price/stock traversal with a clean direct product handoff |
| Meta AI | Indexable one-page catalog + public custom `/feeders?...` URL | Accurate one-fetch recommendation and a useful first-party landing despite blocked second hops |
| Perplexity | Stable indexed hostname and product/index feeds | Its Search surface does not fetch pasted quick-tunnel pages; no response shape won |
| Copilot | Microsoft Merchant Center/Bing catalog distribution | Shopping does not fetch the supplied storefront; no response shape won |

The platform behavior differs:

- **Gemini** — its `Google` fetcher traversed the signed situation page and
  returned permanent `/s/.../product/...` links with exact price and stock.
  Clicking the real completed answer preserved `gemini.google.com` as the
  referrer, providing direct platform-attributed handoff evidence.
- **ChatGPT** — the PR #119 faceted-query surface remains a required
  compatibility contract. Replacing it with signed path anchors caused a
  measured regression: five of five fresh runs fetched only the root. In a
  same-day A/B, the exact PR #119 surface immediately fetched `/feeders`,
  reported live stock, and handed its need-bearing URL to the user. Restoring
  that source shape with a compact signed capability restored the same
  traversal. The clicked situation URL joins the user to the agent journey;
  its product links are permanent signed-need `/c/` URLs.
- **Claude** — regular claude.ai reliably followed the signed HTML edges and
  produced accurate price, stock, constraint, and counterfactual reasoning.
  The implementation also exposes permanent public or signed-need handoffs in
  both HTML and JSON; Grok live-confirmed the complete JSON path, while Claude's
  latest JSON retry was less reliable than its HTML runs.
- **Cloud browser** — Grok used ordinary Safari/Chrome user agents, traversed
  the human root, the production `/agent-experience.json` graph, public
  situations, and a custom `$150` hard budget URL. It returned exact catalog
  facts. A real answer click carried
  browser activation but stripped the Grok referrer, so it is deliberately
  recorded as first-party custom-need intent rather than falsely attributed.
- **Meta AI** — `meta-webindexer/1.1` supports an accurate one-fetch answer.
  Both ordinary and Discover Products modes constructed the exact custom URL,
  but second hops returned `LIVE_CRAWL_POLICY_BLOCKED`; Meta rendered the URL
  as code and wrapped root links through `l.meta.ai`, so seamless product-link
  handoff is not yet demonstrated.
- **Perplexity** — Search rejected every pasted quick-tunnel page without an
  origin request. Computer exposed its UI on the signed-in free account but
  required a Pro upgrade before executing. This needs a mature indexed host
  (or Computer access), not another response shape.
- **Copilot** — regular and Shopping modes ignored the store restriction and
  substituted Microsoft/Amazon shopping results without an origin request.
  This needs Microsoft Merchant Center/Bing discovery; no pasted-page method
  won.

Do not assume a pasted URL will be fetched. Perplexity Search, in particular,
may answer from its index and never issue `Perplexity-User`; allow
`PerplexityBot` to index the merchant site and use the `browse` fallback.
If a WAF sits in front of the storefront, follow the chat vendor's published
IP ranges and user-agent guidance rather than trusting a user-agent string
alone. The lab's `robots.txt` is permissive, but a CDN can still replace or
augment it and can block the request before it reaches the origin.

The short `/s/` route is intentional. Live testing showed a chat product
compressing a UUID-bearing situation URL into a plausible but nonexistent
short citation. Publishing the short route directly makes that citation
stable, indexable, and useful to humans. A browser navigation must include
`Sec-Fetch-User: ?1`, `Sec-Fetch-Mode: navigate`, and
`Sec-Fetch-Dest: document`; this is activation evidence, not proof of AI
origin. Signed, 24-hour journey capabilities protect issued agent paths.
ChatGPT's faceted query uses a UUID-shaped compact HMAC capability; other
agent paths use the expanded representation. Both are stateless, and the JSON
graph carries the same capability so traversal survives a restart or
load-balanced server hop. Indexers receive neither ephemeral
journeys nor the customer-context contract. When an allowlisted chat referrer
is present, its bounded platform name is preserved in telemetry; otherwise
the event remains explicitly unattributed first-party intent. Referrer-derived
`*-referrer` hints are lower-confidence evidence. In production, verify vendor
IP ranges or CDN bot provenance at the edge and pass that trusted result
inward; user-agent and fetch headers alone are spoofable. HTTPS-facing routes
add `Secure` to every first-party cookie.

The `/c/` route is the arbitrary-facet counterpart to `/s/`. It signs the
normalized need tokens (for example pets, motivation, and hard budget), not a
person or agent session. Tampering returns 404. A valid link remains useful
after the private 24-hour agent capability expires; an activated visit records
the exact facets, while platform attribution is included only when the real
browser supplies a recognized referrer.

## Offline quickstart (no backend)

```sh
pnpm --dir sdk/node build
pnpm --dir examples/petsmart-demo install --no-frozen-lockfile
LOCAL_DEMO=true node examples/petsmart-demo/server.mjs
node examples/petsmart-demo/agent-journey.mjs
```

Offline mode verifies the crawl, negotiation, ranking, and cookie drop. The
discoverability beats (signals, personalization, outcome, dashboard) need the
live backend below.

## Live demo (dashboard walkthrough)

From the repo root:

```sh
# 1. Postgres + the Rust API on http://localhost:8080
make dev-backend
```

If Docker is unavailable, any local PostgreSQL works — create a dedicated
database and start the backend directly (startup owns migrations):

```sh
createdb epode_petsmart_demo
cd backend && DATABASE_URL=postgres://$USER@127.0.0.1:5432/epode_petsmart_demo \
PUBLIC_BASE_URL=http://127.0.0.1:8080 PORT=8080 \
cargo run --locked --bin agent-feedback
```

```sh
# 2. Provision a PetSmart product + API key in your dashboard team.
#    Sign in to the dashboard first (dev auth: see CLAUDE.md) so your team
#    exists, then (Docker default DATABASE_URL shown; use your own otherwise):
cd backend
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/agent_feedback \
PLAYGROUND_OWNER_EMAIL=you@example.com \
PLAYGROUND_PRODUCT_NAME="PetSmart" \
PLAYGROUND_KEY_LABEL="PetSmart demo" \
cargo run --bin provision_agent_playground -- provision
# prints the af_live_… key on stdout
```

```sh
# 3. Start the storefront against the live backend (this also registers the
#    pet.* customer-context fields for the product):
cd examples/petsmart-demo
EPODE_API_KEY=af_live_… \
EPODE_API_URL=http://127.0.0.1:8080 \
LOCAL_DEMO=true \
node server.mjs
```

```sh
# 4. Run the scripted journey (agent + user browser):
node agent-journey.mjs
```

Then walk the dashboard: the session timeline shows the agent journey hops,
the customer view shows the visitor with `pet.household_mix`,
`pet.food_motivation`, and `pet.life_stage` signals, personalization shows the
recorded decision and conversion, and Data destinations connects the same
signals to a warehouse.

To present the storefront itself, open `http://127.0.0.1:4320/` in a browser:
first as an anonymous shopper, then re-run the journey and reload to see the
personalized hero.

## Environment

| Variable | Meaning |
| --- | --- |
| `EPODE_API_KEY` | Product API key (`af_live_…`). Omit for offline mode. |
| `EPODE_API_URL` | Backend origin, e.g. `http://127.0.0.1:8080`. |
| `PETSMART_COOKIE_SECRET` | ≥32-byte first-party cookie signing secret. |
| `LOCAL_DEMO=true` | Use the built-in demo cookie secret instead. |
| `PETSMART_REQUEST_LOG=1` | Log bounded method/path/UA/accept/user-activation fields for compatibility tests; query strings and journey capability segments are redacted. |
| `PORT` | Storefront port (default 4320). |

## Tests

```sh
pnpm --dir examples/petsmart-demo test   # offline e2e (no backend required)
```
