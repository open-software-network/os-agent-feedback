"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  NativeSelect,
  PageHeader,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api/client";
import type { DashboardData, EnvironmentResponse, PolicyInput } from "@/lib/api/dashboard";
import { isEditor } from "@/lib/dashboard/format";

const policySchema = z.object({
  feedbackMode: z.enum(["never_ask", "ask_once", "ask_always", "off"]),
});

export function PolicyView({
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
  const environment = data.currentEnvironment;
  const form = useForm<z.infer<typeof policySchema>>({
    resolver: zodResolver(policySchema),
    defaultValues: { feedbackMode: mode(environment?.feedbackMode) },
  });

  useEffect(() => {
    form.reset({ feedbackMode: mode(environment?.feedbackMode) });
  }, [environment, form]);

  if (!environment || !data.currentProduct) {
    return <Panel>No product environment is selected.</Panel>;
  }
  if (!isEditor(data.currentRole)) {
    return <Panel>Only a team owner or admin can change collection policy.</Panel>;
  }

  async function submit(values: z.infer<typeof policySchema>) {
    if (!environment) return;
    setError("");
    try {
      const input: PolicyInput = {
        environmentId: environment.id,
        feedbackMode: values.feedbackMode,
        collectEventSummaries: false,
        retentionDays: environment.retentionDays,
      };
      await apiRequest<EnvironmentResponse>("/api/settings/policy", {
        method: "POST",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      setNotice("Collection policy saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save collection policy");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {embedded ? null : (
        <PageHeader
          eyebrow="Collection policy"
          title="Data controls"
          description="These controls are enforced when a report reaches Epode. Product traffic stays available even if Epode is unavailable."
        />
      )}
      <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(submit)}>
        <Panel title="Feedback collection">
          <Label htmlFor="feedback-mode">Feedback mode</Label>
          <NativeSelect
            id="feedback-mode"
            className="w-full max-w-xl"
            {...form.register("feedbackMode")}
          >
            <option value="never_ask">Never ask: submit autonomously</option>
            <option value="ask_once">Ask once: remember this product&apos;s permission</option>
            <option value="ask_always">Ask every time: request permission for each report</option>
            <option value="off">Off: do not request feedback</option>
          </NativeSelect>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Ask once is remembered under an HMAC-derived subject, so it can survive new agent
            sessions without showing the customer reference to the agent. Epode stores the opaque
            customer reference separately with interaction telemetry for dashboard grouping. Without
            a customer reference, permission is safely requested for each use. Ask every time always
            requires fresh permission. For MCP, Never ask is currently the most reliable choice;
            consent modes depend on the client surfacing and resuming permission, so verify the
            exact client versions before enabling them.
          </p>
        </Panel>
        <Panel title="Outside the feedback protocol">
          <p className="text-sm text-muted-foreground">
            Integrations must not send prompts, transcripts, secrets, authentication payloads,
            personal data, raw customer content, or raw tool inputs and outputs.
          </p>
        </Panel>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save changes
        </Button>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      </form>
    </div>
  );
}

function mode(value: string | null | undefined): z.infer<typeof policySchema>["feedbackMode"] {
  if (value === "ask_once" || value === "ask_always" || value === "off") return value;
  return "never_ask";
}
