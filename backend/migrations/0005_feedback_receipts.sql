CREATE TABLE feedback_receipts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feedback_receipts_session_idx
ON feedback_receipts (session_id, created_at DESC);

CREATE INDEX feedback_receipts_expiry_idx
ON feedback_receipts (expires_at);

