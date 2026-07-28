CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  os_user_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, os_user_id),
  CHECK (os_user_id ~ '^usr_')
);

INSERT INTO workspace_members
  (workspace_id, os_user_id, handle, display_name, role, joined_at, updated_at)
SELECT id, os_user_id, os_user_id, name, 'owner', created_at, updated_at
FROM workspaces
ON CONFLICT (workspace_id, os_user_id) DO NOTHING;

CREATE INDEX workspace_members_user_idx
ON workspace_members (os_user_id, joined_at);

CREATE TABLE workspace_invitations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by_os_user_id TEXT NOT NULL,
  invitee_kind TEXT NOT NULL CHECK (invitee_kind IN ('email', 'handle')),
  invitee_value TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_os_user_id TEXT,
  revoked_at TIMESTAMPTZ,
  CHECK (invited_by_os_user_id ~ '^usr_'),
  CHECK (accepted_by_os_user_id IS NULL OR accepted_by_os_user_id ~ '^usr_')
);

CREATE UNIQUE INDEX workspace_invitations_pending_target_idx
ON workspace_invitations (workspace_id, invitee_kind, invitee_value)
WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX workspace_invitations_workspace_created_idx
ON workspace_invitations (workspace_id, created_at DESC);
