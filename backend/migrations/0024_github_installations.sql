CREATE TABLE github_installations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,     -- 'User' | 'Organization'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX github_installations_installation_idx
  ON github_installations (installation_id);

CREATE INDEX github_installations_workspace_idx
  ON github_installations (workspace_id) WHERE revoked_at IS NULL;
