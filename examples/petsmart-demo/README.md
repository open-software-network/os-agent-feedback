# PetSmart demo — agent traffic to discoverable customers

A PetSmart-branded storefront that demonstrates the full Epode loop on real
increased-AI-traffic terms:

1. **Crawl** — ChatGPT/Claude fetches the storefront URL and receives the
   faceted agent storefront: plain HTML whose links ARE the experience graph.
   The full catalog with prices sits at the root; "shop by situation" anchors
   carry the need dimensions as ordinary query parameters
   (`/feeders?pets=…&motivation=…&budget=…&journey=…`), and live stock +
   member pricing appear only on those situation pages — the value asymmetry
   that earns the need-carrying second fetch. API-capable agents can instead
   walk the structured JSON graph at `/agent-negotiate/…` (humans keep the
   normal storefront at the same URL, with the same situation links for
   cloud-browser assistants).
2. **Trait capture** — the agent expresses the household's needs through
   merchant-supplied edges: *two cats and a dog, one strongly food-motivated,
   $200 target budget*.
3. **Recommendation** — the graph ranks the **SmartTag RFID Multi-Pet Feeder**
   as the only exact match, with every competing feeder surfaced as a near
   miss backed by catalog evidence.
4. **Click → cookie + session** — the item detail hands the agent an ordinary
   product link. When the user opens it, PetSmart drops signed first-party
   `ps_visitor`/`ps_session` cookies and links them to the agent journey
   (`product_link_click` telemetry).
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
| `PORT` | Storefront port (default 4320). |

## Tests

```sh
pnpm --dir examples/petsmart-demo test   # offline e2e (no backend required)
```
