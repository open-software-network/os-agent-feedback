CREATE TABLE sessions_v2 (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('customer', 'mcp', 'continuation')),
  ref_hash BYTEA NOT NULL,
  ref_hint TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source, ref_hash)
);

CREATE TABLE interactions_v2 (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions_v2(id) ON DELETE SET NULL,
  surface TEXT NOT NULL DEFAULT 'unknown'
    CHECK (surface IN ('unknown', 'http_json', 'http_html', 'http_headers', 'mcp')),
  operation TEXT NOT NULL DEFAULT 'pending',
  status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  customer_ref TEXT,
  classification TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN ('unclassified', 'confirmed')),
  confirmation_method TEXT
    CHECK (confirmation_method IS NULL OR confirmation_method IN ('mcp', 'outcome_submission')),
  runtime_hint TEXT,
  runtime_hint_source TEXT,
  capability_nonce_hash BYTEA,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE outcomes_v2 (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  interaction_id UUID NOT NULL UNIQUE REFERENCES interactions_v2(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'failure')),
  note TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'customer_agent' CHECK (source = 'customer_agent'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX interactions_v2_workspace_occurred_idx
ON interactions_v2 (workspace_id, occurred_at DESC);

CREATE INDEX interactions_v2_workspace_classification_idx
ON interactions_v2 (workspace_id, classification, occurred_at DESC);

CREATE INDEX interactions_v2_session_idx
ON interactions_v2 (session_id, occurred_at);

CREATE INDEX outcomes_v2_workspace_created_idx
ON outcomes_v2 (workspace_id, created_at DESC);

CREATE INDEX sessions_v2_workspace_last_seen_idx
ON sessions_v2 (workspace_id, last_seen_at DESC);
