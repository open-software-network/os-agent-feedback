"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  NativeSelect,
  PageHeader,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api/client";
import type {
  CreateTeamInvitationInput,
  DashboardData,
  RemovedResponse,
  RevokedResponse,
  TeamInvitationCreatedResponse,
  TeamMemberResponse,
  TransferredResponse,
  UpdateNameInput,
  UpdateTeamMemberInput,
  WorkspaceResponse,
} from "@/lib/api/dashboard";
import { copyText } from "@/lib/dashboard/clipboard";
import { formatDate, titleCase } from "@/lib/dashboard/format";

const invitationSchema = z.object({
  invitee: z.string().email("Enter a valid email address"),
  role: z.enum(["member", "admin"]),
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export function TeamView({
  data,
  refresh,
  setNotice,
  embedded = false,
}: {
  data: DashboardData;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
  embedded?: boolean;
}) {
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const isOwner = data.currentRole === "owner";
  const isAdmin = data.currentRole === "admin";
  const canInvite = isOwner || isAdmin;
  const inviteForm = useForm<z.infer<typeof invitationSchema>>({
    resolver: zodResolver(invitationSchema),
    defaultValues: { invitee: "", role: "member" },
  });
  const renameForm = useForm<z.infer<typeof renameSchema>>({
    resolver: zodResolver(renameSchema),
    values: { name: data.workspace.name },
  });

  async function run(action: () => Promise<unknown>, success: string) {
    setError("");
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Team update failed");
    }
  }

  async function createInvitation(input: CreateTeamInvitationInput) {
    return apiRequest<TeamInvitationCreatedResponse>("/api/team/invitations", {
      method: "POST",
      workspaceId: data.workspace.id,
      body: JSON.stringify(input),
    });
  }

  async function inviteByEmail(values: z.infer<typeof invitationSchema>) {
    setError("");
    try {
      const created = await createInvitation(values);
      const joinUrl = new URL(created.joinPath, window.location.origin).toString();
      const subject = encodeURIComponent(`Join ${data.workspace.name} on Epode`);
      const body = encodeURIComponent(`Join the team using this private link:\n\n${joinUrl}`);
      inviteForm.reset({ invitee: "", role: "member" });
      setNotice("Invitation created. Opening an email draft.");
      await refresh();
      window.location.href = `mailto:${encodeURIComponent(values.invitee)}?subject=${subject}&body=${body}`;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create invitation");
    }
  }

  async function createMemberLink() {
    setError("");
    try {
      const created = await createInvitation({ role: "member", invitee: null });
      await copyText(new URL(created.joinPath, window.location.origin).toString());
      setNotice("Member invitation link copied.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create invitation link");
    }
  }

  async function renameTeam(values: z.infer<typeof renameSchema>) {
    const input: UpdateNameInput = values;
    await run(
      () =>
        apiRequest<WorkspaceResponse>("/api/team", {
          method: "PATCH",
          workspaceId: data.workspace.id,
          body: JSON.stringify(input),
        }),
      "Team renamed.",
    );
    setRenaming(false);
  }

  async function changeRole(osUserId: string, role: string) {
    const input: UpdateTeamMemberInput = { role };
    await run(
      () =>
        apiRequest<TeamMemberResponse>(`/api/team/members/${encodeURIComponent(osUserId)}`, {
          method: "PATCH",
          workspaceId: data.workspace.id,
          body: JSON.stringify(input),
        }),
      "Member role updated.",
    );
  }

  async function removeMember(osUserId: string) {
    if (!window.confirm("Remove this member from the team?")) return;
    await run(
      () =>
        apiRequest<RemovedResponse>(`/api/team/members/${encodeURIComponent(osUserId)}`, {
          method: "DELETE",
          workspaceId: data.workspace.id,
        }),
      "Team member removed.",
    );
  }

  async function transferOwnership(osUserId: string, displayName: string) {
    if (!window.confirm(`Transfer team ownership to ${displayName}? You will become an admin.`)) {
      return;
    }
    await run(
      () =>
        apiRequest<TransferredResponse>(`/api/team/ownership/${encodeURIComponent(osUserId)}`, {
          method: "POST",
          workspaceId: data.workspace.id,
        }),
      "Team ownership transferred.",
    );
  }

  async function revokeInvitation(invitationId: string) {
    if (!window.confirm("Revoke this invitation?")) return;
    await run(
      () =>
        apiRequest<RevokedResponse>(`/api/team/invitations/${encodeURIComponent(invitationId)}`, {
          method: "DELETE",
          workspaceId: data.workspace.id,
        }),
      "Invitation revoked.",
    );
  }

  const pendingInvitations = data.teamInvitations.filter(
    (invitation) => invitation.inviteeKind !== "link",
  );

  return (
    <div className="flex flex-col gap-6">
      {embedded ? null : (
        <PageHeader
          eyebrow="Team"
          title={data.workspace.name}
          description={`${data.teamMembers.length} member${data.teamMembers.length === 1 ? "" : "s"}`}
          actions={
            canInvite ? (
              <Button variant="outline" onClick={() => setRenaming(true)}>
                Rename team
              </Button>
            ) : null
          }
        />
      )}
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {renaming ? (
        <Panel title="Rename team">
          <form
            className="flex max-w-md items-end gap-2"
            onSubmit={renameForm.handleSubmit(renameTeam)}
          >
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="team-name">Team name</Label>
              <Input id="team-name" {...renameForm.register("name")} />
            </div>
            <Button type="submit" disabled={renameForm.formState.isSubmitting}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        </Panel>
      ) : null}

      {canInvite ? (
        <Panel title="Invite teammates">
          <form
            className="grid max-w-2xl gap-3 sm:grid-cols-[1fr_10rem_auto]"
            onSubmit={inviteForm.handleSubmit(inviteByEmail)}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="email"
                {...inviteForm.register("invitee")}
              />
              {inviteForm.formState.errors.invitee ? (
                <p className="text-xs text-destructive">
                  {inviteForm.formState.errors.invitee.message}
                </p>
              ) : null}
            </div>
            <label className="flex flex-col gap-1 text-sm" htmlFor="invite-role">
              <span>Role</span>
              <NativeSelect id="invite-role" {...inviteForm.register("role")}>
                <option value="member">Member</option>
                {isOwner ? <option value="admin">Admin</option> : null}
              </NativeSelect>
            </label>
            <Button className="self-end" type="submit" disabled={inviteForm.formState.isSubmitting}>
              Open email draft
            </Button>
          </form>
          <Button variant="link" className="px-0" onClick={() => void createMemberLink()}>
            Copy member invite link
          </Button>
        </Panel>
      ) : (
        <Panel>Your member role can view this team. An owner or admin manages membership.</Panel>
      )}

      <Panel title="Members">
        <div className="flex flex-col gap-3">
          {data.teamMembers.map((member) => {
            const self = member.osUserId === data.user.id;
            const canRemove =
              !self &&
              member.role !== "owner" &&
              (isOwner || (isAdmin && member.role === "member"));
            const canTransfer = isOwner && !self && member.role !== "owner";
            return (
              <div
                className="grid items-center gap-3 border-b pb-3 last:border-0 sm:grid-cols-[1fr_10rem_auto]"
                key={member.osUserId}
              >
                <div>
                  <p className="font-medium">
                    {member.displayName}
                    {self ? " (you)" : ""}
                  </p>
                  {member.email ? (
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  ) : null}
                </div>
                {isOwner && member.role !== "owner" ? (
                  <NativeSelect
                    aria-label={`Role for ${member.displayName}`}
                    value={member.role}
                    onChange={(event) => void changeRole(member.osUserId, event.target.value)}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </NativeSelect>
                ) : (
                  <strong>{titleCase(member.role)}</strong>
                )}
                <div className="flex flex-wrap gap-2">
                  {canTransfer ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void transferOwnership(member.osUserId, member.displayName)}
                    >
                      Transfer ownership
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void removeMember(member.osUserId)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {canInvite ? (
        <Panel title="Pending invitations">
          {pendingInvitations.length ? (
            <div className="flex flex-col gap-3">
              {pendingInvitations.map((invitation) => {
                const canRevoke = isOwner || (isAdmin && invitation.role === "member");
                const joinUrl = new URL(
                  `/join/${invitation.id}`,
                  window.location.origin,
                ).toString();
                return (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0"
                    key={invitation.id}
                  >
                    <div>
                      <p className="font-medium">
                        {invitation.inviteeKind === "email"
                          ? invitation.inviteeValue
                          : "Private invitation"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {titleCase(invitation.role)} · expires {formatDate(invitation.expiresAt)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void copyText(joinUrl).then(() => setNotice("Invitation link copied."))
                        }
                      >
                        Copy link
                      </Button>
                      {canRevoke ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void revokeInvitation(invitation.id)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
