# Public tunnel lab

Real HTTPS URLs for testing Epode examples from hosted agent surfaces
(ChatGPT connectors, Claude connectors/Desktop, MCP clients) without paying
per-domain or reconfiguring anything per test.

One long-lived Cloudflare named tunnel fronts `*.<your-domain>`; a small local
router (`router.mjs`) dispatches each hostname to the right example's port.
Spinning up a new public URL is a route entry, not a new tunnel.

```text
ChatGPT / Claude
      |  https://commerce.lab.example.com
      v
Cloudflare edge  (wildcard DNS *.lab.example.com)
      |
      v
cloudflared  (one named tunnel, `make tunnel-run`)
      |
      v
router.mjs on 127.0.0.1:8400  (host label -> port, from routes.json)
      |-- commerce -> 127.0.0.1:4311
      |-- context  -> 127.0.0.1:4310
      `-- <name>   -> any port you add
```

## One-time setup

1. Put a dedicated dev domain (or a subdomain of an existing one) on
   Cloudflare DNS. A throwaway `.dev`/`.run` domain is ideal; do not use a
   production zone.
2. Install and authenticate cloudflared:

   ```bash
   brew install cloudflared
   cloudflared login   # browser opens; pick the zone for your dev domain
   ```

3. Create the tunnel, wildcard DNS, and local config:

   ```bash
   make tunnel-setup TUNNEL_DOMAIN=lab.example.com
   ```

   This is idempotent: it reuses an existing `epode-lab` tunnel, (re)writes
   `*.<domain>` and apex DNS records, seeds `routes.json` from
   `routes.defaults.json`, and renders `config.yml`.

## Daily use

```bash
make tunnel-run                          # router + cloudflared, Ctrl-C stops both
make tunnel-route TUNNEL_NAME=demo TUNNEL_PORT=4311   # publish a new URL
make tunnel-routes                       # list routes and public URLs
make tunnel-status                       # login/tunnel/router/routes overview
```

Routes hot-reload: `tunnel-route` takes effect on the next request, no restart
needed. The apex `https://<domain>` serves a live index of routes.

## Testing from ChatGPT / Claude

- Prefer stable names per example (`commerce.lab…`). Hosted agents cache
  connector and OAuth metadata per URL; a fresh hostname means re-registering
  the connector, so mint throwaway names only when the registration flow
  itself is what you are testing.
- Examples must build absolute URLs from `x-forwarded-host` (see
  `examples/agent-experience-commerce/server.mjs`, `originFor`). The router
  always sets `x-forwarded-host` and `x-forwarded-proto: https`. Follow that
  convention in new examples instead of hardcoding `localhost` URLs.
- OAuth redirect URIs and MCP server metadata must use the public URL; with a
  stable route name these can stay registered across runs.
- SSE and WebSocket upgrades pass through the router and cloudflared
  unchanged.

## Security

- Everything under `*.<domain>` is public while the tunnel runs. These are dev
  builds, sometimes with dev auth enabled — put Cloudflare Access in front of
  the wildcard before real testing:
  <https://one.dash.cloudflare.com/> → Access → Applications → Add
  (self-hosted), cover `*.<domain>` and the apex.
- Never commit cloudflared state. `tunnel/config.yml` and
  `tunnel/routes.json` are gitignored; the cert and tunnel credentials live
  in `~/.cloudflared/` outside the repo.
- Stop the tunnel (`Ctrl-C` on `make tunnel-run`) when you are done; the DNS
  records are harmless without a running tunnel, but the exposure window is
  the running process.

## Files

| Path | Committed | Purpose |
| --- | --- | --- |
| `tunnel/router.mjs` | yes | Host-header reverse proxy (HTTP + WebSocket), hot-reloads routes |
| `tunnel/tunnel.sh` | yes | `setup` / `route add|rm|ls` / `run` / `status` |
| `tunnel/routes.defaults.json` | yes | Seed routes for repo examples |
| `tunnel/routes.json` | no (gitignored) | Live routes; edited by `tunnel-route` |
| `tunnel/config.yml` | no (gitignored) | cloudflared ingress config for your domain |

Environment overrides for scripts/tests: `TUNNEL_ROUTES_FILE`,
`TUNNEL_CONFIG_FILE`, `TUNNEL_DEFAULTS_FILE`, `ROUTER_PORT`, `TUNNEL_NAME`
(shell), and `CLOUDFLARED_CERT`.

## Troubleshooting

- `no Cloudflare cert` — run `cloudflared login` and finish the browser flow.
- `port 8400 is already serving HTTP` — a previous `tunnel-run` is still up;
  find it with `lsof -i :8400` (check it belongs to this checkout before
  killing).
- `upstream_unreachable` (502) — the example server for that route is not
  running locally; start it or fix the port in the route.
- New DNS records not resolving — wildcard records can take a minute; check
  `dig +short anything.<domain>` returns Cloudflare addresses.
- `cloudflared tunnel route dns` fails with an authorization error — the zone
  you picked during `cloudflared login` does not match `TUNNEL_DOMAIN`;
  re-run `cloudflared login` against the right zone.
