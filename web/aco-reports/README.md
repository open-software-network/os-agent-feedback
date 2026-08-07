# ACO Reports

AI Commerce Optimization (ACO) Reports: per-prospect, password-protected
report pages served at `/aco-report/<slug>` by the web app. They are part of
the growth motion — each report walks a prospect through real agent journeys
against a demo storefront built on their own catalog domain.

## Layout

```
aco-reports/
  registry.ts      # slug → report component loader (what makes a report renderable)
  <slug>/
    report.tsx     # the report page, built from the app's components and tokens
    assets/*.png   # screenshots referenced by the page, served gated
```

Report pages are ordinary React server components rendered inside the app's
layout, so they inherit the MD UI fonts, the design tokens in
`app/globals.css`, and the shared primitives in `components/ui/`. Do not add
one-off colors, fonts, or standalone CSS — style with tokens and components
(see `web/DESIGN.md`).

## Access control

- Passwords are configured with one environment variable on the web service:
  `ACO_REPORT_PASSWORDS="petsmart:some-password,acme:another-password"`.
- A slug without a configured password 404s (fail closed) even when its
  content is deployed — provisioning the password is what publishes a report.
- Unlocking (a form POST to `/aco-report/<slug>/unlock`) sets an HttpOnly
  cookie scoped to `/aco-report/<slug>`, valid for 30 days. The cookie is an
  HMAC keyed by the report password, so rotating the password in the
  environment invalidates every outstanding cookie.
- The dashboard's session auth does not apply: `/aco-report` is on the
  proxy's public-route list and carries only its own gate.

## Adding a report

1. Create `aco-reports/<slug>/` with `assets/` and a `report.tsx` (copy the
   petsmart one as a template) whose default export is the report page.
2. Register the slug in `aco-reports/registry.ts`.
3. Add `<slug>:<password>` to `ACO_REPORT_PASSWORDS` on the deployed web
   service (Railway) — and locally in `web/.env.local` when testing.
4. Share `https://app.tryintents.com/aco-report/<slug>` and the password with
   the prospect.
