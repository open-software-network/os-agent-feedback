-- Data destinations: continuous piping of Epode data into a customer's own
-- data system (warehouse, lake, transactional database, or HTTP collector).
--
-- A destination is workspace-scoped: companies aggregate user data in one
-- place, so the pipe carries every product in the workspace and each exported
-- row names its product. Credentials are sealed with AES-256-GCM under a key
-- derived from EPODE_IDENTITY_HMAC_SECRET and are never returned by the API.
CREATE TABLE data_destinations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- 'postgres' pipes into a PostgreSQL-compatible database.
  -- 'http_ndjson' POSTs newline-delimited JSON batches to a collector URL,
  -- which covers lake/object-store ingestion endpoints without holding cloud
  -- credentials. Warehouse-specific kinds join this constraint as they land.
  kind TEXT NOT NULL CHECK (kind IN ('postgres', 'http_ndjson')),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  credentials_sealed BYTEA,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (sync_interval_seconds BETWEEN 5 AND 86400),
  -- Scheduling state. The worker claims a destination by setting claimed_at
  -- and claim_token before any network call, so concurrent workers (or a
  -- worker racing a manual "sync now") cannot double-export a batch.
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claim_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX data_destinations_due_idx
  ON data_destinations (next_sync_at) WHERE enabled;

-- Keyset cursor per exported stream. Interactions use updated_at so later
-- classification changes are re-exported as upserts; feedback reports are
-- append-only and use created_at.
CREATE TABLE data_destination_cursors (
  destination_id UUID NOT NULL REFERENCES data_destinations(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('feedback_reports', 'interactions')),
  last_record_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  last_record_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (destination_id, stream)
);

-- Run history for dashboard observability. Bounded by retention in the
-- purge worker path is unnecessary: runs are small and capped per query.
CREATE TABLE data_destination_sync_runs (
  id UUID PRIMARY KEY,
  destination_id UUID NOT NULL REFERENCES data_destinations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  records_exported BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CHECK (status = 'running' OR finished_at IS NOT NULL)
);

CREATE INDEX data_destination_sync_runs_destination_idx
  ON data_destination_sync_runs (destination_id, started_at DESC);

-- The export reader walks each stream in keyset order on every sync; give the
-- pipe its own indexes so continuous polling never degenerates into a sort.
CREATE INDEX interactions_v2_destination_export_idx
  ON interactions_v2 (workspace_id, updated_at, id);

CREATE INDEX feedback_reports_destination_export_idx
  ON feedback_reports (workspace_id, created_at, id);
