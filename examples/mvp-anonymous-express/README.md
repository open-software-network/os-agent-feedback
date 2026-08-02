# Anonymous pre-login personalization

This example proves that anonymous customers are first-class. A signed, product-owned first-party cookie creates continuity without inventing identity. Epode can remember permission for that pseudonymous customer and the company can personalize an ad placement only under the separate `targeted_advertising` purpose.

Generic product personalization permission never authorizes targeted advertising. If advertising consent is absent, declined, expired, or revoked, context retrieval returns no advertising-eligible signals and the default placement remains available.

`GET /api/discover` demonstrates a first-party pseudonymous visitor. `GET /api/ephemeral-discover` deliberately
omits every identity reference: after permission and an answer, the agent returns the response's
`Epode-Context-Interaction` header on the immediate retry. `customer.contextFor(request)` retrieves context for
that interaction only; it does not create cross-visit identity.

```bash
EPODE_API_KEY=af_live_... VISITOR_COOKIE_SECRET=$(openssl rand -hex 32) npm start
```

The process fails closed when `VISITOR_COOKIE_SECRET` is absent or shorter than 32 bytes. For an explicit local
demo only, set `LOCAL_DEMO=true`; never use that mode in a deployed environment.
