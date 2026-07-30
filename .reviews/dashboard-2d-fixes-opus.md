# Review — 2d fixes (Greptile P1 + P2)

Reviewer: `opus`. Uncommitted delta on `0ca9366`, four files:
`setup-view.tsx`, `dashboard-app.tsx`, and their two test files.

**No defects found.** Both findings are correctly fixed, all three P1 properties
hold, and the tests prove them rather than asserting mocks against themselves.
Two bounded observations at the end — neither is a defect.

---

## Finding 1 (P1) — all three properties hold

**(a) No duplicate or racey creation.** `claimWriteKeyEnsure` is a synchronous
read-then-write on `sessionStorage`; JS is single-threaded, so nothing can
interleave between `getItem` and `setItem`. The `"pending"` state blocks every
caller regardless of `allowCompletedEnsure`:

```ts
if (state === "pending" || (state === "done" && !allowCompletedEnsure)) return false;
```

The manual flag can only bypass `"done"`, never `"pending"` — so it cannot defeat
(a). The button also carries `disabled={creatingWriteKey}` as a second guard. The
`try/catch` fallback map mirrors the same logic for storage-disabled contexts.

**(b) Revoke does not silently auto-recreate.** The effect marks `"done"`
whenever a write key is observed:

```ts
if (writeKeys.length) { finishWriteKeyEnsure(environmentId); return; }
void createWriteKey(false);
```

So the sequence revoke → `refresh()` → `writeKeys.length === 0` → effect →
`createWriteKey(false)` → claim sees `"done"` → returns `false`. No POST. The
auto path hardcodes `false`; `true` is reachable only from the button's
`onClick`, i.e. an explicit user action.

**(c) Manual recovery exists.** With no write key and auto-create declining, the
install panel renders "No product key is active." plus an enabled **Create
product key** button, and the metric reads `Missing` rather than a permanent
`Preparing`. This restores the app.js:705 property (a manual create control is
always reachable) without restoring the app.js:230 unconditional auto-create.

**Error and refresh paths.** `creatingWriteKey` cannot stick true:

- claim rejected → returns *before* `setCreatingWriteKey(true)`;
- POST throws → `releaseWriteKeyEnsure` + `setError` + `setCreatingWriteKey(false)` + `return`;
- POST succeeds, `refresh()` throws → `setError` in `catch`, `setCreatingWriteKey(false)` in `finally`.

**No secret leak.** On POST failure no secret exists. On refresh failure the
secret has already been handed to `rememberSecret`, and the UI still renders it
via the `secrets?.write` branch — correct, since the key really was created and
is shown once. The claim is released only on POST failure (where no key exists),
never after a successful create, so a failed refresh cannot open a second
auto-create.

`createWriteKey`'s `useCallback` deps are all stable (`showNotice` and `refresh`
are `useCallback`-memoised in `dashboard-app.tsx`; `rememberSecret` keys off a
string), so the effect does not churn — and the claim guard would stop it anyway.

## Finding 2 (P2) — notices clear correctly, errors survive

`setNotice(null)` is added at every navigation point: `readLocation` (popstate),
`changeWorkspace`, `changeProduct`, `navigate`, `openFeedback`, `openSession`,
`openInteraction`, and the inline `selectReport` / `selectSession` handlers. The
pre-existing per-notice `timeoutMs` auto-dismiss effect still runs, so this is
additive.

**Clearing cannot wipe a needed error:**

- View-level errors live in each view's local `error` state (`setError`) and
  render through a separate `StatusMessage tone="error"` — untouched by
  `setNotice(null)`. No view routes an error through `setNotice`.
- The only error-toned *notice* is the invalid-invite message, and it is set
  **after** the clear inside `readLocation`, so ordering preserves it.

**No wiped success notice.** `productCreated` and `productDeleted` call
`setView(...)` directly rather than `navigate()`, so the "…created" / "Product
deleted." notices set by `ProductControls` immediately before survive the view
change. That asymmetry is load-bearing, not an oversight.

## Tests

They exercise real behaviour, not mock self-assertions:

- **(a)** `does not create a duplicate write key when Setup remounts during the request`
  uses a never-resolving fetch to pin the claim at `"pending"`, then unmounts and
  remounts (no second POST) *and* clicks the manual button — which takes the
  `allowCompletedEnsure = true` path and is still refused. That is a direct test
  that the flag cannot defeat (a).
- **(b)+(c)** `does not auto-recreate a removed write key and offers manual recovery`
  renders with a key (marking `"done"`), rerenders with `apiKeys: []`, asserts
  `fetchMock` was never called, then clicks the button and asserts the exact POST
  URL and body plus `rememberSecret("write", "af_live_manual_secret")` — the
  secret coming from the mocked *response*, so the data really flows through.
- **P2** `clears a success notice when navigating to another view` drives the real
  UI: rename product → assert "Product renamed." visible → click Feedback →
  assert gone.

## Boundary

`web/lib/api/**`, `web/proxy.ts`, `web/app/{api,auth,mcp,join,static}/**` are all
untouched — `git status --porcelain` and `git diff --stat` are empty for those
paths, and the whole delta is the four named files.

## Non-blocking observations

Neither is a defect; recording so they are decisions rather than surprises.

1. The ensure marker is `sessionStorage`, so it is per-tab and dies with the tab.
   Revoke a key, close the tab, reopen the dashboard on Setup → auto-create runs
   again, because a fresh session cannot distinguish "never had a key" from "key
   was revoked earlier". This is no worse than app.js (which auto-created
   unconditionally) and durable intent would need a server-side signal.
2. In the narrow window the (a) test constructs — a create in flight when Setup
   remounts — the second mount shows an enabled **Create product key** button whose
   click is silently refused by the pending claim. It self-heals once the request
   lands and a refresh runs.

## Verdict

**ship.** Gates not rerun, per your note.
