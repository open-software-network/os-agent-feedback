"use client";

import { useQuery } from "@tanstack/react-query";
import { Panel } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/api/client";
import type { DashboardData, DashboardInteractionResponse } from "@/lib/api/dashboard";
import { formatDate, formatDuration, interfaceLabel, titleCase } from "@/lib/dashboard/format";
import { reportFindings } from "@/lib/dashboard/reports";

export function InteractionDetail({
  data,
  interactionId,
  back,
  openFeedback,
  openSession,
}: {
  data: DashboardData;
  interactionId: string;
  back: () => void;
  openFeedback: (reportId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  const productId = data.currentProduct?.id;
  const loadedInteraction = data.interactions.find((item) => item.id === interactionId);
  const detail = useQuery({
    queryKey: ["interaction", data.workspace.id, productId, interactionId],
    queryFn: () =>
      apiRequest<DashboardInteractionResponse>(
        `/api/dashboard/interactions/${interactionId}?productId=${productId}`,
        { workspaceId: data.workspace.id },
      ),
    enabled: Boolean(interactionId && productId && !loadedInteraction),
  });
  const interaction = loadedInteraction ?? detail.data?.interaction;

  if (detail.isError) {
    return (
      <Panel>
        <p role="alert" className="text-sm text-destructive">
          {detail.error.message}
        </p>
        <Button onClick={() => detail.refetch()}>Try again</Button>
      </Panel>
    );
  }
  if (!interaction) {
    return <p className="text-sm text-muted-foreground">Loading interaction…</p>;
  }

  const linkedReport = data.reports.find((report) => report.interactionId === interaction.id);
  const session = data.sessions.find((item) => item.id === interaction.sessionId);
  const findingCount = linkedReport ? reportFindings(linkedReport).length : 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="break-words font-mono text-xl font-medium">{interaction.operation}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {interaction.customerRef ?? "Unknown customer"} · {formatDate(interaction.occurredAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={back}>
            Back
          </Button>
        </div>
      </header>

      <Panel title="Result">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Property
            label="HTTP status"
            value={interaction.statusCode === null ? "Not provided" : interaction.statusCode}
          />
          <Property label="Duration" value={formatDuration(interaction.durationMs)} />
          <Property label="Surface" value={interfaceLabel(interaction.surface)} />
          <Property label="Occurred" value={formatDate(interaction.occurredAt)} />
        </dl>
      </Panel>

      <Panel title="Evidence">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <Property label="Classification" value={titleCase(interaction.classification)} />
          <Property
            label="Confirmed by"
            value={interfaceLabel(interaction.confirmationMethod ?? "Not confirmed")}
          />
        </dl>
        <p className="text-sm leading-6 text-muted-foreground">
          {interaction.classification === "confirmed"
            ? "This interaction carries direct confirmation from the agent workflow."
            : "This response carried feedback instructions, but no agent action has confirmed it yet."}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Epode stores structured metadata, not prompts, transcripts, or raw tool input and output.
        </p>
      </Panel>

      <Panel title="Attached feedback">
        {linkedReport ? (
          <>
            <p className="text-base leading-6">{linkedReport.summary}</p>
            <p className="text-sm text-muted-foreground">
              {titleCase(linkedReport.impact ?? "Unknown impact")} ·{" "}
              {titleCase(linkedReport.workflowStatus)} · {findingCount} structured{" "}
              {findingCount === 1 ? "finding" : "findings"}
            </p>
            <Button variant="outline" size="sm" onClick={() => openFeedback(linkedReport.id)}>
              Open feedback
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No feedback was submitted for this interaction.
          </p>
        )}
      </Panel>

      {session ? (
        <Panel title="Session context">
          <p className="text-sm leading-6">
            This interaction belongs to a continuity group supplied by{" "}
            {interfaceLabel(session.source)}.
          </p>
          <Button variant="outline" size="sm" onClick={() => openSession(session.id)}>
            Open session
          </Button>
        </Panel>
      ) : null}

      <Panel title="Technical metadata">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Property label="Operation" value={interaction.operation} mono />
          <Property label="Interaction ID" value={interaction.id} mono />
          <Property
            label="Runtime hint"
            value={interaction.runtimeHint ?? "Not provided"}
            mono={Boolean(interaction.runtimeHint)}
          />
          <Property
            label="Hint provenance"
            value={interaction.runtimeHintSource ?? "Not provided"}
            mono={Boolean(interaction.runtimeHintSource)}
          />
          <Property label="Customer" value={interaction.customerRef ?? "Not linked"} />
          <Property
            label="Session ID"
            value={interaction.sessionId ?? "Not linked"}
            mono={Boolean(interaction.sessionId)}
          />
        </dl>
      </Panel>
    </div>
  );
}

function Property({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-1 break-all font-mono text-xs" : "mt-1"}>{value}</dd>
    </div>
  );
}
