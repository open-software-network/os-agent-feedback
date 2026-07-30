import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(new URL("../backend/public/app.js", import.meta.url), "utf8");
const dashboardHtml = await readFile(new URL("../backend/public/app.html", import.meta.url), "utf8");
const backendMain = await readFile(new URL("../backend/src/main.rs", import.meta.url), "utf8");
const backendStore = await readFile(new URL("../backend/src/store.rs", import.meta.url), "utf8");
const teamMigration = await readFile(new URL("../backend/migrations/0010_teams.sql", import.meta.url), "utf8");
const shareableInviteMigration = await readFile(new URL("../backend/migrations/0011_shareable_team_invites.sql", import.meta.url), "utf8");
const ephemeralInviteMigration = await readFile(new URL("../backend/migrations/0018_ephemeral_team_invite_link.sql", import.meta.url), "utf8");

test("dashboard exposes team switching and membership management", () => {
  assert.match(dashboardHtml, /data-view="team"/);
  assert.match(dashboardScript, /id="workspace-select"/);
  assert.match(dashboardScript, /Invite teammates/);
  assert.match(dashboardScript, /type="email"/);
  assert.match(dashboardScript, />Open email draft<\/button>/);
  assert.match(dashboardScript, /Copy member invite link/);
  assert.match(dashboardScript, /data-create-invite-link/);
  assert.match(dashboardScript, /teamInvitations\.filter\(\(invitation\) => invitation\.inviteeKind !== "link"\)/);
  assert.doesNotMatch(dashboardScript, /invite-link-role/);
  assert.doesNotMatch(dashboardScript, /latestInviteLink|latestInviteEmail|inviteResult/);
  assert.doesNotMatch(dashboardScript, /Anyone with this link can join/);
  assert.doesNotMatch(dashboardScript, /OS Account|@handle/);
  assert.match(dashboardScript, /data-member-role/);
  assert.match(dashboardScript, /data-remove-member/);
  assert.match(dashboardScript, /data-transfer-owner/);
  assert.match(dashboardScript, /data-revoke-invitation/);
});

test("team APIs enforce workspace identity and role boundaries", () => {
  assert.match(backendMain, /x-workspace-id/);
  assert.match(backendMain, /require_workspace_editor/);
  assert.match(backendStore, /Only the owner can change member roles/);
  assert.match(backendStore, /Admins can only invite members/);
  assert.match(backendStore, /The team owner cannot be removed/);
  assert.match(backendStore, /different email address/);
});

test("email-bound and shareable invitations survive sign-in", () => {
  assert.match(teamMigration, /CREATE TABLE workspace_members/);
  assert.match(teamMigration, /CREATE TABLE workspace_invitations/);
  assert.match(teamMigration, /role IN \('owner', 'admin', 'member'\)/);
  assert.match(shareableInviteMigration, /'email', 'handle', 'link'/);
  assert.match(backendMain, /\/join\/\{invitation_id\}/);
  assert.match(backendMain, /accept_team_invitation/);
  assert.match(backendStore, /accept_matching_invitations/);
  assert.match(backendStore, /"link" => true/);
});

test("the member invite link is reusable for 24 hours and never becomes pending", () => {
  const shareLinkHandler = dashboardScript.match(/if \(target\.hasAttribute\("data-create-invite-link"\)\) \{([\s\S]*?)\n    \}/)?.[1] || "";
  assert.match(ephemeralInviteMigration, /created_at \+ INTERVAL '24 hours'/);
  assert.match(ephemeralInviteMigration, /workspace_invitations_active_link_idx/);
  assert.match(backendStore, /NOW\(\) \+ INTERVAL '24 hours'/);
  assert.match(backendStore, /ON CONFLICT \(workspace_id\) WHERE invitee_kind = 'link'/);
  assert.match(backendStore, /invitee_kind <> 'link'/);
  assert.match(backendStore, /CASE WHEN invitee_kind = 'link' THEN NULL ELSE NOW\(\) END/);
  assert.match(backendStore, /copied_link\.id == link_invitation\.id/);
  assert.doesNotMatch(shareLinkHandler, /await refresh\(\)/);
});
