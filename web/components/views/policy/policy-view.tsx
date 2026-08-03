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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api/client";
import type { DashboardData, EnvironmentResponse, PolicyInput } from "@/lib/api/dashboard";
import { isEditor } from "@/lib/dashboard/format";

const policySchema = z.object({
  feedbackMode: z.enum(["never_ask", "ask_once", "ask_always", "off"]),
  retentionDays: z
    .number()
    .int("Retention must be a whole number of days.")
    .min(1, "Retention must be between 1 and 365 days.")
    .max(365, "Retention must be between 1 and 365 days."),
});

const retentionPresets = [7, 30, 90, 180, 365] as const;

export function PolicyView({
  data,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const environment = data.currentEnvironment;
  const form = useForm<z.infer<typeof policySchema>>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      feedbackMode: mode(environment?.feedbackMode),
      retentionDays: retention(environment?.retentionDays),
    },
  });

  useEffect(() => {
    form.reset({
      feedbackMode: mode(environment?.feedbackMode),
      retentionDays: retention(environment?.retentionDays),
    });
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
        retentionDays: values.retentionDays,
      };
      await apiRequest<EnvironmentResponse>("/api/settings/policy", {
        method: "POST",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      setNotice(
        `Retention saved. Legacy outcome feedback is ${values.feedbackMode}; customer enrichment permission is unchanged.`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save collection policy");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Collection policy"
        title="Data controls"
        description="Retention and legacy outcome settings are stored here. Enrichment permission is granted by the customer for each exact purpose."
      />
      <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(submit)}>
        <Panel title="Allowed customer information">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Epode can store only bounded answers that help personalize the customer&apos;s product
            experience. Sensitive categories are never collected in the MVP.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Current intent", "What the customer is trying to accomplish now"],
              ["Preferences", "What the customer explicitly likes or prioritizes"],
              ["Constraints", "Budget, timing, format, or other task requirements"],
            ].map(([title, detail]) => (
              <div key={title} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{title}</h3>
                  <Badge variant="secondary">Permissioned</Badge>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Allowed uses">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Product personalization</h3>
                <Badge variant="secondary">Available with permission</Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Personalize products, recommendations, content, and offers for this company.
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Targeted advertising</h3>
                <Badge variant="outline">Off by default</Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Advertising is a separate purpose. Epode returns no customer information for it
                unless the customer explicitly approved that use.
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Enrichment permission">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Epode asks the customer through their agent and returns answers only while the exact
            purpose grant is active. Product personalization never authorizes targeted advertising,
            and silence or ambiguity never becomes approval.
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Known and anonymous references can support remembered permission. Without a stable
            company reference, answers stay bounded to the current session and expire with it.
          </p>
        </Panel>
        <Panel title="Data retention">
          <div className="flex flex-col gap-2">
            <Label htmlFor="retention-days">Retention days</Label>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Retention presets</legend>
              {retentionPresets.map((days) => (
                <Button
                  key={days}
                  type="button"
                  size="sm"
                  variant={form.watch("retentionDays") === days ? "secondary" : "outline"}
                  onClick={() =>
                    form.setValue("retentionDays", days, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                >
                  {days} days
                </Button>
              ))}
            </fieldset>
            <Input
              id="retention-days"
              className="max-w-40"
              type="number"
              min={1}
              max={365}
              step={1}
              aria-invalid={Boolean(form.formState.errors.retentionDays)}
              aria-describedby={
                form.formState.errors.retentionDays
                  ? "retention-days-help retention-days-error"
                  : "retention-days-help"
              }
              {...form.register("retentionDays", { valueAsNumber: true })}
            />
            {form.formState.errors.retentionDays ? (
              <p id="retention-days-error" role="alert" className="text-sm text-destructive">
                {form.formState.errors.retentionDays.message}
              </p>
            ) : null}
          </div>
          <p id="retention-days-help" className="max-w-3xl text-sm text-muted-foreground">
            Dashboard filtering changes immediately. Feedback reports, interactions, and sessions
            outside this window stop appearing right away. Physical deletion may take up to the
            scheduled purge interval; expired feedback, interactions, and sessions are then
            permanently removed.
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Durable Ask-once permission is a separate data control. It survives retention until the
            permission is explicitly changed or the product is deleted.
          </p>
        </Panel>
        <Panel title="Sensitive data">
          <p className="text-sm text-muted-foreground">
            Epode does not collect sensitive traits, prompts, transcripts, secrets, authentication
            payloads, raw customer content, or raw tool inputs and outputs. Unknown fields and
            common secret patterns are rejected.
          </p>
        </Panel>
        <details className="rounded-lg border bg-background p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced: legacy outcome feedback
          </summary>
          <div className="mt-4 flex max-w-3xl flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This persisted setting controls the earlier structured product-outcome workflow only.
              It does not approve, disable, or configure customer enrichment.
            </p>
            <Label htmlFor="feedback-mode">Outcome feedback mode</Label>
            <NativeSelect
              id="feedback-mode"
              className="w-full max-w-xl"
              {...form.register("feedbackMode")}
            >
              <option value="never_ask">Never ask</option>
              <option value="ask_once">Ask once</option>
              <option value="ask_always">Ask every time</option>
              <option value="off">Off</option>
            </NativeSelect>
          </div>
        </details>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Save retention and outcome settings
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

function retention(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 365) {
    return 30;
  }
  return value;
}
