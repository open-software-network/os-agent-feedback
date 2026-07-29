# Brief: EPD-9 backend — read-scoped keys and MCP read tools

You own the **Rust backend only**. A sibling agent owns the dashboard in parallel.
You start blank; this brief plus the linked artifacts are everything.

**Repo**: `/Users/jakubswierczek/code/alongside/os-epode` (you are in it), branch `main`.

## Your files — touch nothing else

- `backend/migrations/0012_api_key_kinds.sql` (new)
- `backend/src/store.rs`
- `backend/src/main.rs`
- `backend/src/models.rs`

**Do not touch** `backend/public/**` or `tests/setup-page.test.mjs` — the sibling agent
owns those and you will collide. **Do not touch** `protocol/v1/`, `sdk/`, or the
`.well-known` descriptors: explicitly out of scope.

## Context

Agent Feedback: a customer's AI agent uses someone's product, then reports whether it
actually worked — success/partial/failure plus a short note. Product owners read that in a
dashboard.

Today `/mcp` has three **write** tools (`agent_start_session`, `agent_record_event`,
`agent_complete_session`) authenticated by an `af_live_` product key, and **zero read
tools**. The only read surface is `/api/dashboard`, cookie-authed. You are adding the read
path so an agent in a product's repo can pull feedback without a browser.

**Read the issue EPD-9 and `.reviews/epd-6-read-tool-surface.md` before starting.** The
latter has the exact tool schemas and sample responses and is the source of truth for
shapes. Every design decision is settled — implement, do not re-open.

## Shared contract (the sibling agent codes against this — do not deviate)

```sql
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'write'
  CHECK (kind IN ('write', 'read'));
```

- `ApiKeyPublic` gains `kind: String`.
- `CreateApiKeyInput` gains `kind: Option<String>` (absent = `write`), keeps
  `expires_in_seconds`.
- `POST /api/settings/api-keys` accepts `{ label, environmentId, kind, expiresInSeconds }`.
- Dashboard `apiKeys` entries carry `id, environmentId, label, prefix, kind, createdAt,
  lastUsedAt, revokedAt, expiresAt`.
- Read keys are `af_read_<32 hex key id>_<secret>` — identical layout to `af_live_`,
  minted the same way. Stored `prefix` stays the first 16 chars.

## Work

1. **Minting.** `create_api_key` (`store.rs`, currently ~line 640) takes a kind and emits
   the matching prefix. The ten-active-key cap becomes **per kind per environment** — read
   keys must not starve write-key rotation.

2. **Auth.** Leave `agent_product_auth`'s `af_live_` prefix filter **exactly as it is** —
   that filter is what makes read keys unable to authenticate a write *by construction*.
   Add a sibling read-auth path accepting only `af_read_` and additionally verifying
   `kind = 'read'` on the row. Prefix is the fast fail-closed gate; the column is
   authoritative. Both paths update `last_used_at`.

3. **Tool dispatch.** `tools/list` varies by key kind: a read key sees only `feedback_*`,
   a write key only `agent_*`. In MCP the tool list *is* the contract — offering tools the
   caller cannot invoke produces runtime errors no schema warned about.

4. **Two read tools**, per `.reviews/epd-6-read-tool-surface.md`:
   - `feedback_list_outcomes` — `summary`, `since`, `outcome[]`, `operation`,
     `customerRef`, `limit` (default 25, max 100), `cursor`
   - `feedback_list_interactions` — `since`, `reviewed`, `operation`, `customerRef`,
     `surface[]`, `limit`, `cursor`

   `summary: true` returns the whole-product picture (interaction counts *and* outcome
   counts), honouring `since` only. Top-operations carries a per-outcome breakdown. Every
   response states the retained window explicitly, so an agent cannot mistake a 30-day
   slice for all-time.

5. **Cursor pagination** keyed on `(occurred_at, id)` descending, opaque to clients. Never
   offset — the table is concurrently written to *and* retention-pruned, so offset paging
   skips and repeats records. The index `interactions_v2_workspace_occurred_idx` exists.
   An invalid or expired cursor must **not** return 401; that status is reserved for auth.

6. **401 on auth failure, distinguishing expired from invalid.** `mcp_handler` currently
   maps every auth error to `mcp_ok(...)` — HTTP 200 with an `isError` result. That is
   neither correct per the MCP spec's error table nor able to express the difference.

7. **Read tools must not mutate.** Do **not** trigger the retention sweep from the read
   path. `dashboard()` in `store.rs` hard-deletes aged rows as a side effect; replicating
   that here would mean an agent deletes a customer's data by reading it. See EPD-8.

## Verify

`cargo test` in `backend/`, plus `npm run test` and `npm run lint` from the repo root.

Add Rust coverage for: read-key minting produces the right prefix and kind; a read key is
rejected on a write tool; a write key is rejected on a read tool; the per-kind key cap;
expired versus invalid producing distinguishable 401s.

## Rules

- Match surrounding style. No new dependencies. Minimum complexity.
- Read code before changing it.
- **Do not commit, do not push.** Report the diff stat and test output when done.
- If the shared contract above appears wrong, **stop and say so** rather than changing it
  unilaterally — the sibling agent is coding against it.
