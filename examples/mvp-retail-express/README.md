# Retail Express — Fortune 100 anchor

This company-owned example proves the complete anonymous-to-known loop:

1. The retailer issues a signed first-party visitor cookie.
2. Epode asks for relevant shopping context through the retailer's response and same-origin relay.
3. The next recommendation request retrieves only permitted context and reranks products.
4. The retailer records the exact personalization decision and purchase outcome.
5. Reuse the cookie with `Authorization: Bearer demo-retail-customer-token` to deterministically resolve the anonymous journey after sign-in.

```bash
EPODE_API_KEY=af_live_... RETAIL_COOKIE_SECRET=$(openssl rand -hex 32) npm start
```

The process fails closed when `RETAIL_COOKIE_SECRET` is absent or shorter than 32 bytes. For an explicit local
demo only, set `LOCAL_DEMO=true`; never use that mode in a deployed environment.

The customer never installs Epode, creates an Epode account, or sends data directly to an unfamiliar domain.
