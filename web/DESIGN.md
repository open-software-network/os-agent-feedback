# Dashboard design handoff

## Where to work

- Design tokens and Tailwind 4 theme mappings: `app/globals.css`.
- Shared, copied design-system primitives: `components/ui/`.
- Shared dashboard layout pieces: `components/dashboard/`.
- View-specific UI: `components/views/<view>/`. Keep components used by only one
  view in that view's folder.

Change tokens in `app/globals.css` instead of introducing one-off colors. Promote
a component to `components/ui/` only when it is a reusable, behavior-light
primitive. Data fetching and mutations stay in the dashboard/view components,
not inside UI primitives.

## Restyling boundary

Safe to restyle: `app/globals.css`, `components/ui/**`,
`components/dashboard-header.tsx`, `components/dashboard/view-primitives.tsx`,
and presentation markup/classes in `components/views/**`.

Do not change data/auth behavior while doing visual work:

- `lib/api/**`
- `proxy.ts`
- `app/api/**/route.ts`, `app/auth/**/route.ts`, `app/mcp/route.ts`,
  `app/static/**/route.ts`, and `app/join/**/route.ts`
- `lib/api/types.ts`

`lib/api/types.ts` is generated from `backend/openapi.json`; never edit it by
hand. **Visual changes must not touch `lib/api` or proxy code.**

## Run locally

Use the supported Node version and point the BFF at an API:

```sh
fnm use 22.23.1
API_URL=https://your-staging-api.example pnpm --filter @epode/web dev
```

Supported Node range is `>=22.13.0 <25`. Keep API keys and auth cookies out of
client code; the BFF and Rust API own that boundary.

## Before a PR

```sh
fnm use 22.23.1
make web-check
make web-typecheck
make web-test
make web-types-check
```

`web-check` runs Biome. CI also builds the production image/app, and the types
drift check fails when `web/lib/api/types.ts` is stale.
