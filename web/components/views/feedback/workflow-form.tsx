"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { NativeSelect, StatusMessage } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/api/client";
import type {
  DashboardData,
  ProductFeedbackReport,
  UpdatedResponse,
  UpdateFeedbackWorkflowInput,
} from "@/lib/api/dashboard";

const workflowSchema = z.object({
  status: z.enum(["new", "investigating", "planned", "resolved", "wont_act"]),
  assigneeOsUserId: z.string(),
  tags: z.string().max(260),
  internalNote: z.string().max(1000),
});

export function WorkflowForm({
  data,
  report,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  report: ProductFeedbackReport;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const form = useForm<z.infer<typeof workflowSchema>>({
    resolver: zodResolver(workflowSchema),
    defaultValues: valuesForReport(report),
  });

  useEffect(() => {
    form.reset(valuesForReport(report));
  }, [form, report]);

  async function submit(values: z.infer<typeof workflowSchema>) {
    if (!data.currentProduct) return;
    setError("");
    try {
      const input: UpdateFeedbackWorkflowInput = {
        productId: data.currentProduct.id,
        status: values.status,
        assigneeOsUserId: values.assigneeOsUserId || null,
        tags: values.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        internalNote: values.internalNote.trim() || null,
      };
      await apiRequest<UpdatedResponse>(`/api/dashboard/reports/${report.id}`, {
        method: "PATCH",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      setNotice("Feedback workflow saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save workflow");
    }
  }

  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={form.handleSubmit(submit)}>
      <label className="space-y-1 text-sm" htmlFor="feedback-status">
        <span>Status</span>
        <NativeSelect id="feedback-status" {...form.register("status")}>
          <option value="new">New</option>
          <option value="investigating">Investigating</option>
          <option value="planned">Planned</option>
          <option value="resolved">Resolved</option>
          <option value="wont_act">Won&apos;t act</option>
        </NativeSelect>
      </label>
      <label className="space-y-1 text-sm" htmlFor="feedback-assignee">
        <span>Assignee</span>
        <NativeSelect id="feedback-assignee" {...form.register("assigneeOsUserId")}>
          <option value="">Unassigned</option>
          {data.teamMembers.map((member) => (
            <option key={member.osUserId} value={member.osUserId}>
              {member.displayName}
            </option>
          ))}
        </NativeSelect>
      </label>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="feedback-tags">Tags</Label>
        <Input id="feedback-tags" placeholder="docs, latency" {...form.register("tags")} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="feedback-note">Internal note</Label>
        <Textarea id="feedback-note" rows={4} {...form.register("internalNote")} />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save triage
        </Button>
      </div>
      {error ? (
        <div className="sm:col-span-2">
          <StatusMessage tone="error">{error}</StatusMessage>
        </div>
      ) : null}
    </form>
  );
}

function valuesForReport(report: ProductFeedbackReport): z.infer<typeof workflowSchema> {
  const statuses = ["new", "investigating", "planned", "resolved", "wont_act"] as const;
  const status = statuses.find((candidate) => candidate === report.workflowStatus) ?? "new";
  return {
    status,
    assigneeOsUserId: report.assigneeOsUserId ?? "",
    tags: report.tags.join(", "),
    internalNote: report.internalNote ?? "",
  };
}
