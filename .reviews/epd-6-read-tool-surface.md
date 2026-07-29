# EPD-6 prototype — the MCP read tool surface

Throwaway artifact to react to. Written against the **live data** in the `Existing product`
workspace: 8 interactions, 5 outcomes, all `mcp` surface.

Constraints inherited (settled, not up for debate here):

- **No product argument** — the read key is product-scoped (EPD-2).
- **Thin** — filter, count, group-by-field only. No grouping, no summarizing, no
  mark-actioned (EPD-4).
- **`since` watermark**, client-tracked per key holder (EPD-4).
- Not protocol surface — this is epode's hosted API (EPD-5).

---

## 1. Naming: break from `agent_*`

The three existing tools are `agent_start_session`, `agent_record_event`,
`agent_complete_session`. They are all spoken by the **customer's agent**, instrumenting
someone else's product from the inside.

Read tools are spoken by a different actor entirely — the **product owner's** repo agent.
Reusing `agent_*` would imply one family. Proposing `feedback_*`:

| Tool | Purpose |
|---|---|
| `feedback_list_outcomes` | reviewed feedback — the actionable content; `summary: true` for aggregates |
| `feedback_list_interactions` | all usage, including what was never reviewed |

**Settled in review**: two tools, not three. `feedback_summary` folds into
`feedback_list_outcomes` as a `summary` flag. `feedback_list_interactions` ships in v1.
`customerRef` is returned (and filterable). `limit` max 100 with cursor paging.

## 2. `tools/list` varies by key kind — yes

**Recommendation: a read key sees only `feedback_*`; a write key sees only `agent_*`.**

MCP has no per-tool authorization concept — `tools/list` *is* the contract. If a read key
sees three write tools, an agent will call one and get a runtime error that no schema
warned it about. That is a worse failure than the tool simply not existing.

Safe to do: `capabilities.tools.listChanged` is already `false`, and a connection's
credential does not change mid-session, so a client caching the list per connection stays
correct.

Same endpoint, different surface by credential — ordinary for a scoped API.

## 3. `tools/list` (read key)

```json
[
  {
    "name": "feedback_list_outcomes",
    "description": "List outcome reviews submitted by customer agents, newest first. Each carries a short free-text note explaining what worked or did not. This is where actionable signal lives. Pass summary:true to get aggregate counts and rates for the whole product instead of individual records — call that first to orient.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "summary": { "type": "boolean", "default": false, "description": "Return aggregate counts and rates for the product instead of records. All other filters except since are ignored." },
        "since": { "type": "string", "format": "date-time", "description": "ISO 8601. Track this per client to poll for what is new." },
        "outcome": {
          "type": "array",
          "items": { "type": "string", "enum": ["success", "partial", "failure"] },
          "description": "Filter to these outcomes. Omit for all. Use [\"partial\",\"failure\"] to find problems."
        },
        "operation": { "type": "string", "description": "Exact operation name, e.g. a tool or route name." },
        "customerRef": { "type": "string", "description": "Opaque customer id as supplied by the product. Use to see whether one customer keeps failing." },
        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
        "cursor": { "type": "string", "description": "Opaque cursor from a previous response's nextCursor." }
      }
    }
  },
  {
    "name": "feedback_list_interactions",
    "description": "List product interactions, newest first, including those with no outcome review. Use reviewed:false to find operations customer agents use but never review.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "since": { "type": "string", "format": "date-time" },
        "reviewed": { "type": "boolean", "description": "true = only interactions with an outcome; false = only those without; omit for both." },
        "operation": { "type": "string" },
        "customerRef": { "type": "string" },
        "surface": {
          "type": "array",
          "items": { "type": "string", "enum": ["http_json", "http_html", "http_headers", "mcp", "unknown"] }
        },
        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
        "cursor": { "type": "string" }
      }
    }
  }
]
```

### The wrinkle in folding summary into the outcomes tool

The summary reports **interaction** statistics (`interactions: 8`, `reviewRate: 0.63`) as
well as outcome ones, so it does not belong purely to either list tool.

Resolved by making `feedback_list_outcomes` with `summary: true` return the **whole
product picture**, not just outcome aggregates. Slightly odd on the name, fixed by the
tool description. The alternative — a `summary` flag on each tool returning only its own
domain's aggregates — is more symmetric but costs two calls to orient, which defeats the
point. `feedback_list_interactions` therefore has no `summary` flag.

### `customerRef` is returned and filterable

Kept in the response, and added as a filter on both tools since the use case that
justifies returning it — *is one customer failing repeatedly?* — is unanswerable without
filtering.

It stays the one field with privacy weight: it is opaque by contract, but it now travels
to every read-key holder. That is a deliberate trade, worth stating in the read-API docs.

## 4. Sample responses — real data

### `feedback_summary` with no arguments

```json
{
  "product": "Existing product",
  "window": { "since": "2026-06-29T12:00:00Z", "retentionDays": 30 },
  "interactions": 8,
  "reviewed": 5,
  "reviewRate": 0.63,
  "confirmationRate": 1.0,
  "outcomes": { "success": 3, "partial": 1, "failure": 1 },
  "outcomeSuccessRate": 0.6,
  "topOperations": [
    { "operation": "fellow_get_me", "interactions": 2, "outcomes": { "success": 1 } },
    { "operation": "fellow_list_my_products", "interactions": 2, "outcomes": { "success": 1 } },
    { "operation": "fellow_get_product", "interactions": 1, "outcomes": { "success": 1 } },
    { "operation": "fellow_create_product", "interactions": 1, "outcomes": {} },
    { "operation": "fellow_get_notification_unread_count", "interactions": 1, "outcomes": { "failure": 1 } },
    { "operation": "fellow_discover_products", "interactions": 1, "outcomes": { "partial": 1 } }
  ],
  "surfaces": [ { "surface": "mcp", "interactions": 8 } ]
}
```

Two deliberate changes from the dashboard's `insights`:

- **`topOperations` carries an outcome breakdown.** The dashboard's version is a bare
  count, which tells an agent nothing about whether an operation is *working*. Adding the
  per-outcome split is still pure counting — it stays inside the thin line — and it is
  what makes one call actionable.
- **`window` is explicit.** An agent must know the retention horizon, or it will read
  "5 outcomes" as all-time.

### `feedback_list_outcomes` with `outcome: ["partial","failure"]`

The call that answers *what should I fix?*

```json
{
  "outcomes": [
    {
      "id": "67d5e0db-d942-4376-a31b-044c38d983f7",
      "outcome": "failure",
      "note": "Count endpoint responded but the task needed per-product breakdown it does not provide.",
      "operation": "fellow_get_notification_unread_count",
      "surface": "mcp",
      "durationMs": 18,
      "statusCode": null,
      "occurredAt": "2026-07-28T21:06:00Z",
      "createdAt": "2026-07-28T21:06:14Z",
      "interactionId": "e9c3806b-c2ac-4ceb-887d-b7563f5eb949"
    },
    {
      "id": "…",
      "outcome": "partial",
      "note": "Discovery worked but results lacked the filter granularity the task needed.",
      "operation": "fellow_discover_products",
      "surface": "mcp",
      "durationMs": 15,
      "statusCode": null,
      "occurredAt": "2026-07-28T21:06:00Z",
      "createdAt": "2026-07-28T21:06:22Z",
      "interactionId": "…"
    }
  ],
  "nextCursor": null,
  "window": { "since": "2026-06-29T12:00:00Z", "retentionDays": 30 }
}
```

**This is the whole product in one response.** Two records, and the theme is visible —
*right endpoint, wrong granularity*. Per EPD-4 epode does not say that; the agent does.

Dropped from the dashboard shape: `customerRef` (an opaque user id — no value to a repo
agent, and it is the one field with any privacy weight), `sessionId`, `classification`,
`confirmationMethod`, `runtimeHint`, `runtimeHintSource`. All available on
`feedback_list_interactions` if wanted.

### `feedback_list_interactions` with `reviewed: false`

```json
{
  "interactions": [
    {
      "id": "…",
      "operation": "fellow_create_product",
      "surface": "mcp",
      "classification": "confirmed",
      "durationMs": 22,
      "statusCode": null,
      "occurredAt": "2026-07-29T10:39:29Z"
    }
  ],
  "nextCursor": null,
  "window": { "since": "2026-06-29T12:00:00Z", "retentionDays": 30 }
}
```

3 of 8 interactions have no review — the 63% review rate made concrete. Whether that is
worth a tool or is noise is the main open question below.

## 5. Cursor pagination, not offset

`(occurred_at DESC, id DESC)` keyed cursor. Offset paging over a table that is being
written to and retention-pruned skips and repeats records. There is already an index on
`(workspace_id, occurred_at DESC)`.

## 6. Resolved in review

1. **`feedback_list_interactions` ships in v1.** The unreviewed-usage question is worth a
   tool of its own.
2. **`feedback_summary` folds in** as `summary: true` on `feedback_list_outcomes`. Two
   tools total. See the wrinkle noted above.
3. **`customerRef` is returned**, and filterable on both tools.
4. **`limit` default 25, max 100**, with cursor paging as specified.

## 7. Still open — for the implementing ticket, not this one

- Exact cursor encoding. Keyed on `(occurred_at, id)`; opaque to clients either way.
- Whether `summary` respects `since` only, or also `operation` / `customerRef`. Specified
  above as `since` only, to keep it a cheap orientation call — revisit if scoped summaries
  turn out to be what people actually want.
- Error shape for an invalid or expired cursor. Should not be a 401; that status is
  reserved for auth per EPD-3.
