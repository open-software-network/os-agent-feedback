UPDATE workspace_invitations
SET expires_at = LEAST(expires_at, created_at + INTERVAL '24 hours')
WHERE invitee_kind = 'link';

WITH ranked_links AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at DESC, id DESC) AS position
  FROM workspace_invitations
  WHERE invitee_kind = 'link' AND accepted_at IS NULL AND revoked_at IS NULL
)
UPDATE workspace_invitations AS invitation
SET revoked_at = NOW()
FROM ranked_links
WHERE invitation.id = ranked_links.id AND ranked_links.position > 1;

CREATE UNIQUE INDEX workspace_invitations_active_link_idx
ON workspace_invitations (workspace_id)
WHERE invitee_kind = 'link' AND accepted_at IS NULL AND revoked_at IS NULL;
