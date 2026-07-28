CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  feedback_mode TEXT NOT NULL DEFAULT 'auto' CHECK (feedback_mode IN ('auto', 'ask', 'off')),
  collect_event_summaries BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE dashboard_sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT,
  agent_name TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, external_id)
);

CREATE TABLE agent_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'info')),
  duration_ms BIGINT,
  summary TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence)
);

CREATE TABLE feedback (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
  worked BOOLEAN NOT NULL,
  summary TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  would_use_again BOOLEAN,
  friction TEXT NOT NULL DEFAULT 'none',
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX agent_sessions_workspace_created_idx ON agent_sessions(workspace_id, created_at DESC);
CREATE INDEX agent_events_session_sequence_idx ON agent_events(session_id, sequence);
CREATE INDEX feedback_workspace_created_idx ON feedback(workspace_id, created_at DESC);
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions(expires_at);
