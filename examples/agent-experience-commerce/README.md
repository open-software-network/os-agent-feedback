# Agent experience commerce reference

Fieldnote-style reference product for Epode's agent experience graph pivot.

Humans and crawlers receive ordinary HTML at `/`. Known agent user agents
receive a machine-readable guide that opens a merchant-authored need
negotiation graph. Ranked results require at least one current-task decision
input. Exact matches are separated from near misses, and counterfactuals appear
only when hard requirements produce zero exact matches.

## Run

```bash
# from repo root, after building the Node SDK
pnpm --dir sdk/node build
node examples/agent-experience-commerce/server.mjs
```

Optional Epode telemetry:

```bash
EPODE_API_KEY=af_live_... EPODE_API_URL=https://app.epode.ai node examples/agent-experience-commerce/server.mjs
```

## Agent journey

1. `GET /` with an agent user agent → guide with exact `/agent-negotiate/<journey>/lamp`
2. Choose one supplied need edge at a time
3. `GET /agent-decide/<journey>/lamp/...` after at least one real decision input
4. Open a returned `detailUrl` for a product you actually evaluate

## Tests

```bash
node --test tests/agent-experience-commerce-e2e.mjs
```
