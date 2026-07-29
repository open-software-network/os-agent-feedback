# Issue tracker: os-platform

Issues for this repo live on the Open Software platform (os-platform), Product
`epode` — NOT GitHub Issues. GitHub Issues exist on the repo but are a
legacy/watchdog surface, not the triage queue.

## Two interfaces

**Primary: the OS Platform MCP** (`mcp__claude_ai_OS_Platform__fellow_*`). Use
it whenever it is connected. It is strictly richer than the CLI — it is the
only interface that can set labels, parents/children, and relations.

**Fallback: the vendored `os-platform` skill** (`.agents/skills/os-platform/`),
for shell contexts with no MCP. Run its script from that directory; it needs
`OS_PLATFORM_API_KEY` in the environment (never paste keys into chat).
Defaults (Product `epode`, limit 20) come from `os-platform.json` at the repo
root. The CLI covers issue list/search/show/create/assign/status and comments —
**and nothing else**. It cannot set labels, parents, or relations.

Every MCP tool takes `org` — pass the handle `epode`.

## Read conventions

- **List issues**: `fellow_list_product_issues` with `org: "epode"`
  (filters: `status`, `labels`, `assignee`, `priority`, `project`, `q`, `type`
  — all CSV where plural).
- **Search**: `fellow_search_product_issues` with `q` (max 100 bytes,
  limit clamped to 25).
- **Read an issue**: `fellow_get_issue`; comments via
  `fellow_list_issue_comments`; children via `fellow_list_issue_children`.

CLI equivalents: `issues list epode --status todo`,
`issues search epode "<query>"`, `issues show epode <number>`.

## Write conventions

- **Create**: `fellow_create_product_issue` (directly under the Product) or
  `fellow_create_issue_child` (under a parent Issue). `title` required;
  optional `body_markdown`, `type`, `priority`, `status`, `assignee_user_id`,
  `project_id`.
- **Update**: `fellow_update_issue` — including `body_markdown` for a full
  body rewrite.
- **Status**: `fellow_set_issue_status`.
- **Comment**: `fellow_create_issue_comment`.
- **Labels**: `fellow_set_issue_labels` — a **full replacement** list of slugs.
- **Parent**: `fellow_set_issue_parent` (pass `parent_issue_ref: null` to
  detach).

Pass `idempotency_key` on creates and status changes — there is no automatic
retry protection, and a re-run after an ambiguous failure will otherwise
duplicate.

Verify each write with a read before any fan-out. Confirm a fan-out mutation on
one Issue before applying it to many — this is a shared production tracker.

**Issue bodies are append-only by convention**: fetch the current body, append,
never overwrite. The one exception is a Wayfinder map — see below.

### Enums

- status: `proposed | todo | in_progress | in_review | completed | cancelled`
  (`completed` / `cancelled` are rejected at create)
- type: `feature | bug | improvement | design | docs | refactor | other`
- priority: `none | low | med | high | urgent`
- label slug: `^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$` — **no colons**

## Language

User-facing product language says **Product**, **Initiative**, and **Issue**
(internal API paths still say `orgs`, `projects`, and `bounties`). Issues carry
an `external_id` like `EPD-12` — use that when referring to one.

## Pull requests as a triage surface

No. PRs live on GitHub (`gh` CLI) and are not a request surface for triage.

---

## Wayfinding operations

How the `wayfinder` skill expresses its primitives here. Three of the four are
native; **blocking is not**.

| Wayfinder primitive | This tracker |
|---|---|
| Map | Issue titled `Wayfinder map: …` + `<!-- wayfinder:map -->` marker |
| Child ticket | **native** child (`fellow_create_issue_child`) |
| Ticket type | body `Type:` line |
| Claim | **native** assignee |
| Blocking | **body convention** — no native support |

**Labels do not work for this.** Verified live: `fellow_set_issue_labels` with a
fresh slug fails `4201 label(s) not found in project`. Label slugs must already
exist **on an Initiative**, and the MCP only exposes label CRUD for Initiative
labels (`fellow_*_initiative_label`). Since a Wayfinder map need not belong to
an Initiative, map and ticket type are carried by title and body instead. If
this effort later gets an Initiative, revisit — labels would be nicer.

### The map

One Issue, `type: other`, titled `Wayfinder map: <destination name>`, with
`<!-- wayfinder:map -->` as the first body line. Find every map with
`fellow_search_product_issues` + `q: "Wayfinder map:"`.

Its body is the skill's Destination / Notes / Decisions so far / Not yet
specified / Out of scope structure. The map is a **living index**, so it is the
one Issue whose body is rewritten rather than appended — fog graduates *out* of
"Not yet specified" as it becomes tickets. Rewrite with `fellow_update_issue`
(`body_markdown`), then re-read to confirm.

The map stays `todo`/`in_progress` until every ticket is closed, then
`completed`.

### Tickets

Create with `fellow_create_issue_child` against the map's number — that sets
parentage natively, so the tracker UI shows the map's children without any
convention. `type: other`. The body opens with the header lines, then the
question:

```
<!-- wayfinder:ticket -->
Type: research | prototype | grilling | task
Blocked by: EPD-<n>, EPD-<m>     (omit the line entirely when nothing blocks it)

## Question

<the decision or investigation this ticket resolves>
```

Ticket bodies stay append-only; the resolution goes in a comment.

### Claiming

Native. Set `assignee_user_id` (via `fellow_create_issue_child` at create or
`fellow_update_issue` after). An open, **unassigned** ticket is unclaimed.
Jakub is `usr_utEzdXaTSbeU`.

### Blocking — the one gap

Relation kinds on this platform are **`related` and `duplicate_of` only**.
There is no `blocks` / `blocked_by`, so blocking is a body convention: a
blocked ticket's body opens with

```
Blocked by: EPD-<n>, EPD-<m>
```

Omit the line entirely when nothing blocks it. Optionally also create a
`related` relation (`fellow_create_issue_relation`) so the link is visible in
the UI — but the body line stays authoritative, because `related` carries no
direction.

**Consequence**: blocking is invisible in the platform UI, and the frontier
cannot be rendered there. State the frontier explicitly in narration each
session — the human cannot otherwise see what is takeable.

### The frontier

A ticket is **unblocked** when every `EPD-<n>` on its `Blocked by:` line is
`completed` or `cancelled`. The **frontier** is every child of the map that is
`todo`, unassigned, and unblocked.

No server-side query covers this. Compute it:

1. `fellow_list_issue_children` on the map → the ticket set
2. keep `status == "todo"` and `assignee == null`
3. read each body's `Blocked by:` line and drop any with an unresolved blocker

### Resolving

1. `fellow_create_issue_comment` — the answer.
2. `fellow_set_issue_status` → `completed`.
3. Rewrite the map body: append the one-line pointer to **Decisions so far**,
   and clear any fog the answer graduated from **Not yet specified**.

### Ruling out of scope

`fellow_set_issue_status` → `cancelled` (not `completed`, so it never reads as
a step on the route), then add the line to the map's **Out of scope** section.

### Live maps

- [EPD-1](https://app.opensoftware.co/epode/issues/1) — Read Agent Feedback over
  MCP with a read-scoped product key.
