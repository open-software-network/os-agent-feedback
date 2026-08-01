# Static docs trusted-edge example

This Cloudflare Worker-compatible reverse proxy adds Epode's header handoff to finite HTML from a static
site, CMS, or hosted documentation origin. It never edits the page body and never puts the product key in
browser JavaScript. Feedback reports still go directly to Epode with a short-lived `afr2_` capability; this
proxy is not a feedback relay.

The public Worker route and `DOCS_UPSTREAM_ORIGIN` must use different origins. Route only the public docs
paths through the Worker, keep the upstream origin out of public links, and store `AGENT_FEEDBACK_KEY` as an
edge secret. Do not deploy the example until `docs-origin.example.com` and the include patterns have been
replaced with infrastructure your team controls.

Ordinary responses retain their public `Cache-Control`, body, content encoding, and authentication context.
They add only `Vary: Agent-Feedback-Request` and a same-public-URL discovery `Link`. An opted-in refetch gets
the same upstream body with `Cache-Control: private, no-store` and an `Agent-Feedback` capability header.
Configure any CDN outside the Worker to honor `Vary`, or include `Agent-Feedback-Request` in its cache key.

The proxy supports static HTML with or without `Content-Length`, including compressed responses. It skips
explicit transfer-encoded streams, attachments, declared bodies over 1 MiB, non-HTML bodies, non-2xx results,
and responses already carrying `Agent-Feedback`. Same-upstream redirects are rewritten back to the public
origin; other trusted-upstream redirects pass through unchanged to preserve existing login and download flows
and are never instrumented.

Run locally after installing dependencies:

```bash
npm install
npx wrangler secret put AGENT_FEEDBACK_KEY
npm run dev
```

Use `npm run check` for a dry-run bundle. No deploy is required to validate the example.
