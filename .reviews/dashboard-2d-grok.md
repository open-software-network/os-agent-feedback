# Phase 2 chunk 2d review — six dashboard views

Reviewer: grok. Against `.briefs/phase2-views.md`, parity ref
`backend/public/app.js`, contract `backend/openapi.json` / `web/lib/api/types.ts`.
Aesthetics out of scope.

---

## major — Setup auto-creates a write key in a racey `useEffect` (duplicate keys)
file: web/components/views/setup/setup-view.tsx:62-114

When `writeKeys.length === 0`, an effect POSTs `/api/settings/api-keys` with
`kind: "write"`. Guard is only `useRef(autoCreating)`:

- Ref resets on remount (React Strict Mode in Next dev remounts once).
- No in-flight abort/dedupe by `environmentId`.
- `environment` is in the dependency array (new object every dashboard
  refetch). While keys are still empty, each completed poll can re-arm the
  effect after `finally` clears the ref.

Failure mode: open Setup on a product with zero write keys (or hit Strict Mode
mount) → two (or more) write keys created before the list refreshes; user does
not know which secret is current; burns the 10-key cap. Product create already
mints a default key server-side, so the dangerous window is “no write keys”
(e.g. all revoked), not first-time product create.

Suggested fix: track `ensuredEnvironmentId` in state/ref (persist for the
session), or mutate only from an explicit query (`enabled: writeKeys.length===0`
with a single mutation and `staleTime: Infinity` until success), and remove
`environment` object identity from deps (use `environment.id`).

---

## minor — Sign-out does not leave the app if logout fails
file: web/components/dashboard/dashboard-app.tsx:188-191

```ts
await apiRequest("/api/auth/logout", { method: "POST" });
window.location.assign("/");
```

Old app always sent the browser home even when logout failed. Here a non-2xx
throws and skips redirect → user stays in the shell with a possibly half-cleared
session.

Suggested fix: `try/finally { window.location.assign("/") }` (or assign in
`finally` after best-effort logout).

---

## minor — `?invite=invalid` no longer surfaces an error
file: web/components/dashboard/dashboard-app.tsx (no handling)

Old app stripped `invite=invalid` and showed a 6s error toast after a failed
join. New app ignores the query param. Users bouncing from join/auth with that
flag get no explanation.

Suggested fix: on ready, if `invite=invalid`, `setNotice(...)` and drop the
param from the URL.

---

## Known gap (brief), not a ship blocker

**Interactions explorer / “Open interaction”** from feedback detail existed in
`app.js` but is outside the six named views. New app shows interaction fields on
the feedback row/session timeline only—no interaction detail route. Acceptable
under the brief’s view list; call out if product still wants that surface.

---

## Parity / checklist (no further findings)

| Area | Result |
|---|---|
| Home | Insights, recent feedback → detail, refresh; no mutations |
| Feedback | List filters, load +250 to 10k, detail hydrate GET, workflow PATCH (productId/status/assignee/tags/note), editor-only form |
| Sessions | Filters, load +100 to 10k, detail GET, timeline → feedback |
| Setup | Auto write key, rotate, create read key + expiry, shown-once via React state + `sessionStorage` (not query cache), 5s poll, install snippets; extra **Revoke** (API exists; old UI only rotated) |
| Policy | Modes, forces `collectEventSummaries: false`, keeps `retentionDays` |
| Team | Rename, email invite + mailto, member link `invitee: null`, role/remove/transfer/revoke with owner vs admin rules matching old UI |
| Product CRUD | Create/rename/delete; delete requires **exact** name then `DELETE` `{ confirmation }` |
| Roles | Setup/Policy nav + views gated; product controls `isEditor`; triage editor-only; backend still enforces `require_workspace_editor` |
| Limits | Defaults 250/250/100 via `DASHBOARD_LIMIT_DEFAULTS` |
| Team/product switch | Clears detail/secrets/limits; `epode:last-team` |
| Types | `lib/api/dashboard.ts` only re-exports generated schemas; `types.ts` not hand-edited |
| BFF | Views use relative `/api/...` via `apiRequest`; bff/proxy routes not part of this delta’s behavior changes |
| Tests | Behavior/fetch/role/secret/delete/policy/invite — no snapshots |
| DESIGN.md | Tokens/ui/views paths OK; do-not-touch covers `lib/api`, proxy, BFF routes, generated types; commands match Makefile |

---

## Verification

```
fnm use 22.23.1
pnpm --filter @epode/web typecheck  → 0
pnpm --filter @epode/web test       → 4 files, 24 tests pass
pnpm --filter @epode/web build      → 0
pnpm check                          → 0
make check                          → 0
```

## Verdict
ship with fixes

Fix Setup key auto-create dedupe before merge; logout/`invite=invalid` are small
follow-ups.
