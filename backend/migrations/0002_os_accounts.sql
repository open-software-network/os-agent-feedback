-- The service was not released before OS Accounts federation was adopted.
-- Remove test-only local-auth data and make OS Accounts the identity source.
TRUNCATE TABLE feedback, agent_events, agent_sessions, api_keys, dashboard_sessions, accounts, workspaces CASCADE;

DROP TABLE dashboard_sessions;
DROP TABLE accounts;

ALTER TABLE workspaces ADD COLUMN os_user_id TEXT NOT NULL UNIQUE;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_os_user_id_shape CHECK (os_user_id ~ '^usr_');
