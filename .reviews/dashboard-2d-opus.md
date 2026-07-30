# Review — phase 2 chunk 2d (the six dashboard views)

Reviewer: `opus`. Uncommitted delta on `246f4b9`. Reviewed against
`.briefs/phase2-views.md`, with `backend/public/app.js` (1,149 lines) as the
parity reference and `backend/openapi.json` / `web/lib/api/types.ts` as the
contract.

Correctness and data flow only, per scope. Six findings, all minor, plus one
DESIGN.md nit. Role gating in particular is exact — I diffed every client-side
gate against `require_workspace_editor` and the per-endpoint checks in
`store.rs` and found no holes in either direction.

---

## minor — revoking the only write key silently recreates it, so Revoke looks broken

`web/components/views/setup/setup-view.tsx:82-114` (auto-create effect) and `163-176` (`revokeKey`)

The auto-create effect fires whenever an editor is on Setup with an environment
and `writeKeys.length === 0`:

```ts
if (!environment || !editor || writeKeys.length || autoCreating.current) return;
… POST /api/settings/api-keys { kind: "write", label: "Product key" } … await refresh();
```

`revokeKey` deletes a key and then calls `refresh()`. When the revoked key is the
only write key, the refetch drops `writeKeys.length` to 0, the effect re-fires
immediately, and a replacement key is created. Sequence the user sees: confirm
"Revoke Product key? This cannot be undone." → the key disappears → a new
`Product key` row appears with the notice "Product key created. Save it now — it
is shown once." The revoke appears not to have worked.

Worse, the revoke itself has no grace period: `revoke_api_key` sets `revoked_at =
NOW()` and `product_auth_for_key` filters `revoked_at IS NULL`, so every deployed
integration using that key starts failing immediately. `app.js` deliberately
offered **only rotate** for this reason — `data-revokeKey` in `app.js` calls
`/rotate`, never `DELETE`, and the confirm text says "The current key will keep
working for one hour so you can deploy the replacement safely." `DELETE
/api/settings/api-keys/{key_id}` is a real endpoint but the old dashboard never
called it.

Suggested fix: either drop the Revoke button for write keys (restoring app.js
parity — rotate is the safe operation), or guard the auto-create effect so it does
not run immediately after an explicit revoke.

## minor — `findings` array guard dropped; one malformed row breaks the whole Feedback list

`web/components/views/feedback/feedback-view.tsx:92` and `263-277`

`app.js` treated `findings` defensively everywhere:

```js
const reportFindings = (report) => Array.isArray(report.findings) ? report.findings : [];
```

The port calls `report.findings.flatMap(...)` inside the list filter and
`report.findings.length` in the detail, with no guard. The generated type says
`FeedbackFinding[]`, but that schema was deliberately made permissive in chunk 1b
for exactly this reason — `backend/src/models.rs:329` documents it as "Schema-only
view of legacy JSONB findings… additional properties remain allowed because stored
output is passed through", and the column is JSONB, not a typed array.

Failure mode: a report whose `findings` is `null` or a non-array throws
`TypeError: report.findings.flatMap is not a function` inside the `useMemo`
filter. Because that filter runs over *every* loaded report, one bad row blanks the
entire Feedback view rather than one line — and the error boundary here is the
whole `main`, so the user sees nothing.

Rows written by the current backend are always arrays, so this needs a legacy or
hand-edited row to trigger. Reporting it because the guard was present and was
dropped, and the type system cannot catch it.

## minor — the interaction detail view is gone, and nothing links to it

`web/components/dashboard/types.ts:3`, `web/components/views/sessions/sessions-view.tsx:251-275`, `web/components/views/feedback/feedback-view.tsx:290-306`

`app.js` has a full `interactionsView()` detail (lines 460-489) showing
classification and what confirms it, the confirmation method, linked feedback,
session context, and a property list with customer ref, runtime hint and hint
provenance. It is reachable two ways: clicking an interaction row in the sessions
timeline (`data-interaction`), and "Open interaction" from the feedback detail
(`data-open-interaction`).

Neither path exists now. The sessions timeline renders interaction rows as static
`<li>` elements with no click target, and the feedback detail offers only "Open
linked session". `GET /api/dashboard/interactions/{interaction_id}` is not called
anywhere in `web/` — it appears only in the generated `types.ts`.

This may be an intentional scope call: the brief names six views and interactions
is not one of them. Flagging it because the brief also says "be explicit about
gaps rather than quietly dropping them", and runtime-hint provenance /
confirmation method have no other surface in the new dashboard.

## minor — browser Back no longer navigates inside the dashboard

`web/components/dashboard/dashboard-app.tsx:100-109`

The URL sync effect always calls `window.history.replaceState`. `pushState` is
never called anywhere in `web/` (grep confirms: only `replaceState`, in
`dashboard-app.tsx` and two test setups). The `popstate` listener at line 65 is
therefore wired to an event that can never fire from in-app navigation.

`app.js` pushed a history entry on every drill-in and drill-out —
`syncUrl("push")` on selecting a report, interaction or session, on `data-back`,
and on the investigate shortcuts — with `syncUrl("replace")` reserved for filter
changes.

Failure mode: open a feedback report, press Back, and you leave the dashboard
entirely (back to whatever preceded it) instead of returning to the feedback list.
The URL does carry `?report=…` so a reload or a shared link still restores the
detail; only in-app history is lost.

## minor — status notices never clear

`web/components/dashboard/dashboard-app.tsx:44, 275-279`

`notice` is set by every successful mutation and is never reset — no timeout, and
nothing clears it on view change. `app.js` auto-dismissed via
`setNotice(message, timeoutMs = 2800)` with a tracked `noticeTimer`, using 1800ms
for copies and up to 6000ms for warnings.

Failure mode: after "Product deleted." the banner stays pinned above every
subsequent view — Home, Feedback, Team — until another action happens to overwrite
it. Deleting a product and then browsing shows a stale success message about a
product that no longer exists.

## minor — the feedback time filter reads a different field than the one displayed

`web/components/views/feedback/feedback-view.tsx:101` vs `210-212`

The range filter compares `report.occurredAt`, but the table's "Received" column
renders `report.createdAt`, and `app.js` filtered on `createdAt`
(`inTimeRange(entry.createdAt)` — the only `inTimeRange` call in its
`feedbackView`).

`occurredAt` is the interaction time; `createdAt` is when the report was
submitted. They diverge when an agent submits feedback well after the interaction
— exactly what the `afr2_` capability window allows.

Failure mode with the default 30-day range: a report submitted today about a
45-day-old interaction is filtered out, even though the row would have shown
"Received: today" had it been listed. The same report is visible in `app.js`.

## nit — DESIGN.md omits `components/dashboard-header.tsx` from both lists

`web/DESIGN.md:5-9, 18-28`

The "Where to work" section maps `components/ui/`, `components/dashboard/` and
`components/views/<view>/`, and the "Safe to restyle" list names
`app/globals.css`, `components/ui/**`,
`components/dashboard/view-primitives.tsx` and view markup.
`web/components/dashboard-header.tsx` sits at the `components/` root and is
mentioned nowhere, so a designer restyling the header has no signal that it is
safe to touch.

Everything else in DESIGN.md checks out — I verified each claim rather than
assuming. The do-not-touch list is accurate against the real tree, including
`app/static/**/route.ts` and `app/join/**/route.ts`, which do exist
(`web/app/static/[...path]`, `web/app/join/[invitation_id]`). All four documented
`make` targets exist and the `pnpm --filter @epode/web dev` invocation is real.
Naming only `view-primitives.tsx` out of `components/dashboard/` is precisely
right — `dashboard-app.tsx` and `product-controls.tsx` in that folder do own data
fetching and mutations.

---

## Checked clean

**Role gating (2) — exact in both directions.** I diffed every client-side gate
against the backend. `require_workspace_editor` (owner|admin) guards
`update_feedback_workflow`, `create_product`, `rename_product`, `rename_team`,
`delete_product`, `create_api_key`, `revoke_api_key`, `rotate_api_key`,
`update_policy` — and the UI matches: `ProductControls` returns `null` for
members, `SetupView` and `PolicyView` render a refusal panel, `WorkflowForm` is
replaced by explanatory text, and Setup/Policy are filtered out of the nav *and*
force-redirected to Home in the data effect. Triple-gated, no member-visible
button that would 403.

The team endpoints are gated inside `store.rs` with finer rules, and `team-view.tsx`
mirrors them exactly:

| action | backend rule | client gate |
|---|---|---|
| invite | owner\|admin; admin → member role only | `canInvite`; Admin option only when `isOwner` |
| change role | **owner only**; owner's role immutable | `isOwner && member.role !== "owner"` |
| remove member | owner\|admin; not owner, not self, admin → members only | `!self && role !== "owner" && (isOwner \|\| (isAdmin && role === "member"))` |
| transfer ownership | **owner only**; not self, target not owner | `isOwner && !self && member.role !== "owner"` |
| revoke invitation | owner\|admin; admin → member invitations only | `isOwner \|\| (isAdmin && invitation.role === "member")` |

**Shown-once secrets (3) — correct.** Secrets live only in React state
(`ShownSecrets`) plus `sessionStorage`, keyed with the same
`agent-feedback:product-key:<envId>` / `agent-feedback:read-key:<envId>` scheme
`app.js` used. They are never placed in the TanStack Query cache, never in a query
key, never logged, and never refetched — the only sources are the create/rotate
mutation responses and `sessionStorage` recall. The `rememberSecret` reducer
preserves the sibling kind (`{environmentId, ...current, [kind]: secret}`), so
creating a read key does not drop a held write secret. Workspace and product
switches null the state and then re-recall from storage for the new environment,
matching `app.js`. `SecretCallout` renders from state only; when no secret is held
the view shows the truncated `prefix…` and tells you to rotate.

**Destructive confirmation (4) — preserved.** `submitDelete` requires
`values.confirmation !== data.currentProduct.name` to fail before any request, and
sends the typed string as `DeleteProductInput.confirmation`; the backend
independently re-checks `input.confirmation.trim() != product.name`. `app.js`
required the same exact-name match. The new form is marginally stricter (no
client-side trim) which fails safe. Member removal, ownership transfer, invitation
revoke and key rotate all keep their `window.confirm` prompts.

**Limits, switching, pagination (5) — correct.** `DASHBOARD_LIMIT_DEFAULTS` is
`{interactionLimit: 250, reportLimit: 250, sessionLimit: 100}`, matching `app.js`
exactly, and the query string is built with all three. Load-more increments match
(`+250` reports, `+100` sessions, both `Math.min(…, 10_000)`), and the buttons only
render while `…Loaded < …Total`. Workspace and product switches clear the selected
report/session, clear held secrets and reset limits to defaults — the same reset
`app.js` performed. `localStorage["epode:last-team"]` is written and read with the
same key. The `x-workspace-id` header is set on every `/api/` mutation via
`apiRequest({workspaceId})`, matching `app.js`'s `request()`.

**Mutation → state invalidation (6).** Every mutation awaits `refresh()`
(`dashboardQuery.refetch`) before returning, and the feedback detail refetches both
the dashboard and its own detail query. Product create/delete additionally reset
`productId`, selection and view. No mutation leaves stale data on screen.

**Loading / empty / error (7).** Dashboard-level pending, error-with-retry and
`!data` guards; per-view empty states for feedback, sessions, insight lists and
invitations; detail-level loading text and `ErrorState` with retry. Optional fields
are handled with `??` throughout (`customerRef ?? "Not linked"`, `statusCode ?? "—"`,
`impact ?? "unspecified"`, `member.email` conditional, `workaround` conditional).
The one unguarded spot is `findings`, above.

**Generated types (8).** `lib/api/dashboard.ts` re-exports 30+ types straight from
`components["schemas"]` and `operations[…]`; no request/response shape is
hand-written. `web/lib/api/types.ts` is unmodified — `git diff` is empty and `make
web-types-check` reports it in sync with `backend/openapi.json`.

**BFF/auth boundary (9) — untouched.** `git status --porcelain` and `git diff` are
both empty for `web/lib/api/bff.ts`, `web/proxy.ts`, `web/app/api/**`,
`web/app/auth/**`, `web/app/mcp/**` and `web/lib/api/types.ts`. Every view request
goes through `apiRequest`, which issues same-origin relative paths (`/api/…`) — no
absolute API URL, no direct upstream call anywhere in `web/components`.

**Tests (10) — behaviour, not markup.** No `toMatchSnapshot`,
`toMatchInlineSnapshot` or `__snapshots__` anywhere. The 24 tests assert data flow:
the exact `UpdateFeedbackWorkflowInput` body sent, that session detail is fetched
before the timeline renders, that a missing write key is created and its
shown-once secret reaches the controller, that rotation surfaces the replacement
secret, that a full key renders only while the controller supplies it, exact-name
delete confirmation, policy preserving `collectEventSummaries`/`retentionDays`,
member role gating, invitation create-and-copy, and the three limit parameters in
the dashboard request. Queries are by role and accessible name, so restyling will
not break them.

Also verified: `data.apiKeys` from the dashboard query already filters
`revoked_at IS NULL` in `store.rs`, so the Setup key list cannot show dead rows;
and the `autoCreating` ref plus the `.finally` ordering (reset only after
`refresh()` resolves) means the auto-create cannot fire twice concurrently.

## Verification

Read-only. Nothing edited, staged, committed or pushed; `os-platform` untouched.

```
$ eval "$(fnm env)" && fnm use 22.23.1        v22.23.1
$ pnpm --filter @epode/web typecheck          exit 0
$ pnpm --filter @epode/web test               4 files, 24 tests passed
$ pnpm --filter @epode/web build              ✓ Compiled successfully in 2.2s
$ pnpm check                                  Checked 80 files. No fixes applied.
$ make check                                  MAKE_CHECK_EXIT=0
$ make web-types-check                        types.ts in sync with openapi.json
$ git diff/status on bff.ts, proxy.ts, app/{api,auth,mcp}, types.ts
                                              empty — boundary untouched
```

## Verdict

**ship with fixes** — the auto-recreate-after-revoke behaviour is the one I would
fix before the designer starts, because it makes a destructive action look broken
and can silently kill a production key. The rest are small parity gaps that can be
picked up alongside the UI work; none of them block restyling, and none is a
security or role-gating problem.
