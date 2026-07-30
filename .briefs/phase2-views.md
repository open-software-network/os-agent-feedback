# Chunk 2d — the six views (functional parity)

Chunks 2a (scaffold), 2b (BFF proxy) and 2c (deploy) are done. Read
`.briefs/dashboard-rewrite.md` and `.briefs/phase2-web.md` first.

## The one thing that matters

**A designer (Andrew) and his coding agent take over UI polish as soon as these
views exist.** So:

- Optimise for **shipping working views fast**, not for how they look.
- **Functional parity** with `backend/public/app.js` — same data, same
  capabilities, real data through the BFF, working actions. Parity is behaviour,
  not pixels. The old dashboard's look is explicitly retired.
- **Deliberately minimal styling.** Use the copied os-platform design-system
  components straight out of the box. No custom polish, no pixel work, no bespoke
  CSS. If a view looks plain, that is correct and expected.
- **Structure for easy restyling**: one component per view, view-local components
  kept separate from shared primitives, and **no styling logic tangled into data
  fetching**. The designer must be able to restyle without touching data or auth
  code.

Speed over granularity. Do not gold-plate. Do not invent abstractions you do not
need yet.

## Hard limits

- Nothing outside this worktree. `/Users/jakubswierczek/code/alongside/os-platform`
  is **READ-ONLY** — copy from it, never write to it.
- No `git push`, no live infrastructure, do not commit.
- pnpm, never bun.

## 1. Copy the design system

Fork-copy from `os-platform/web` into `web/` — no cross-repo dependency:

- design tokens (`app/globals.css` — Tailwind 4 `@theme`)
- the Base UI component layer (`components/ui/`)
- layout shells / dashboard shell components as needed

**Skip**: `*.stories.tsx` (no Storybook), tiptap/markdown-editor, OpenTelemetry,
and any component pulling deps outside the approved stack. If a component drags
in a dependency you do not need, drop the component rather than the dependency.
Check licences/registry names for anything unusual (os-platform uses a
`central-icons` alias) — if an icon or font package is awkward, substitute
something trivial rather than blocking.

Copy as-is. Do not "improve" the components while copying.

## 2. The six views

Port all six, referencing `backend/public/app.js` (1,149 lines) for behaviour and
`backend/openapi.json` + `web/lib/api/types.ts` for the contracts:

1. **Home** — overview, recent feedback, usage
2. **Feedback** — list + detail, workflow state changes
3. **Sessions** — list + detail
4. **Setup** — API keys (create/revoke/rotate, shown-once secrets), install
   snippets
5. **Collection policy**
6. **Team** — members, roles, invitations, ownership transfer, rename

Requirements:

- Real data through the BFF (`/api/*`), typed via `web/lib/api/types.ts`. Do not
  hand-write request/response types that already exist there.
- TanStack Query for fetching/caching; react-hook-form + zod for forms.
- Actions must actually work: create/rename/delete product, API key lifecycle,
  policy updates, team management, feedback workflow updates.
- Handle loading, empty and error states — plainly. A simple message is fine.
- Destructive actions keep the confirmation semantics the current dashboard has
  (e.g. product deletion requires typing the exact name — check `app.js`).
- Shown-once secrets must stay shown-once.
- Respect roles: viewers must not get editor-only actions. `require_workspace_editor`
  in the backend is the source of truth for what is editor-gated.

Read `app.js` carefully for behaviour that is easy to miss: workspace/product
switching, limits and pagination defaults, cursor handling, and which actions are
role-gated.

## 3. `web/DESIGN.md`

Write a short, practical working doc for the incoming designer and his coding
agent. **Not an essay** — a page or so, skimmable. Cover:

- **Design tokens**: where they live (the copied os-platform files) and how to
  change them.
- **Component conventions**: what counts as a shared primitive vs a view-local
  component, and where each lives.
- **Safe to restyle vs do-not-touch**: which files can be freely restyled, and
  which carry data/auth/behaviour that must not change — `web/lib/api/**`,
  `web/proxy.ts`, the BFF route handlers, and the generated
  `web/lib/api/types.ts` (regenerated from `backend/openapi.json`, never edited
  by hand).
- **Running locally** against the staging API: `pnpm dev` plus the env vars
  needed (`API_URL`), and the Node version requirement (`>=22.13 <25`; use
  `fnm use 22.23.1`).
- **How checks gate their PRs**: `make web-check`, `make web-typecheck`,
  `make web-test`, biome, and the types drift check.
- **The rule**: visual changes should not touch `lib/api` or proxy code.

State the rule plainly and give them the commands they will actually run.

## 4. Tests

vitest/RTL. Cover data flow and behaviour, not appearance: rendering with mocked
query data, action handlers firing the right mutations, role gating, and
shown-once secret handling. Do not snapshot-test markup — the designer is about
to change all of it, and brittle snapshots would block them.

Do not touch the existing `tests/*.test.mjs` suite or `backend/public/` — the old
dashboard is deleted in a separate PR only after the flip is verified.

## Gate

```
fnm use 22.23.1
pnpm --filter @epode/web typecheck && pnpm --filter @epode/web test && pnpm --filter @epode/web build
pnpm check
make check
```

## Reporting

Report per-view: what works, what is stubbed, and anything in `app.js` you could
not reach parity on. Be explicit about gaps rather than quietly dropping them —
a known gap is fine, a silent one is not. Then stop. Do not commit.

If this is too large for one pass, do Home + Feedback + Sessions first, report,
and stop — the orchestrator will dispatch the rest. Say so early rather than
running out of room mid-view.
