ALTER TABLE workspace_invitations
  DROP CONSTRAINT workspace_invitations_invitee_kind_check;

ALTER TABLE workspace_invitations
  ADD CONSTRAINT workspace_invitations_invitee_kind_check
  CHECK (invitee_kind IN ('email', 'handle', 'link'));
