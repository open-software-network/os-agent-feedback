"use client";

import { useQuery } from "@tanstack/react-query";
import { Metrics, PageHeader, Panel } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/api/client";
import type { DashboardData, DashboardInteractionResponse } from "@/lib/api/dashboard";
import { formatDate, formatDuration, titleCase } from "@/lib/dashboard/format";
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

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Interaction"
        title={interaction.operation}
        description={formatDate(interaction.occurredAt)}
        actions={
          <Button variant="outline" onClick={back}>
            Back
          </Button>
        }
      />
      <Metrics
        items={[
          { label: "Classification", value: titleCase(interaction.classification) },
          { label: "Surface", value: titleCase(interaction.surface) },
          { label: "HTTP status", value: interaction.statusCode ?? "—" },
          { label: "Duration", value: formatDuration(interaction.durationMs) },
        ]}
      />
      <Panel title="Evidence">
        <p>
          {interaction.classification === "confirmed"
            ? `Confirmed by ${titleCase(interaction.confirmationMethod ?? "feedback report")}.`
            : "This response carried feedback instructions, but no agent action has confirmed it yet."}
        </p>
      </Panel>
      <Panel title="Agent feedback">
        {linkedReport ? (
          <>
            <p>{linkedReport.summary}</p>
            <p className="text-sm text-muted-foreground">
              {reportFindings(linkedReport).length} structured finding(s)
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
          <p>
            This interaction belongs to a continuity group supplied by {titleCase(session.source)}.
          </p>
          <Button variant="outline" size="sm" onClick={() => openSession(session.id)}>
            Open session
          </Button>
        </Panel>
      ) : null}
      <Panel title="Properties">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <Property label="Occurred" value={formatDate(interaction.occurredAt)} />
          <Property label="Operation" value={interaction.operation} />
          <Property label="Customer" value={interaction.customerRef ?? "Not linked"} />
          <Property
            label="Confirmation"
            value={titleCase(interaction.confirmationMethod ?? "none")}
          />
          <Property label="Runtime hint" value={interaction.runtimeHint ?? "Not provided"} />
          <Property
            label="Hint provenance"
            value={interaction.runtimeHintSource ?? "Not provided"}
          />
        </dl>
        <code className="block break-all text-xs">{interaction.id}</code>
      </Panel>
    </div>
  );
}

function Property({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
