"use client";

import { useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { Panel } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const loadedReport = data.reports.find((report) => report.interactionId === interactionId);
  const loadedSession = data.sessions.find((item) => item.id === loadedInteraction?.sessionId);
  const needsExactDetail = Boolean(
    interactionId &&
      productId &&
      (!loadedInteraction || !loadedReport || (loadedInteraction.sessionId && !loadedSession)),
  );
  const detail = useQuery({
    queryKey: ["interaction", data.workspace.id, productId, interactionId],
    queryFn: () =>
      apiRequest<DashboardInteractionResponse>(
        `/api/dashboard/interactions/${interactionId}?productId=${productId}`,
        { workspaceId: data.workspace.id },
      ),
    enabled: needsExactDetail,
  });
  const interaction = loadedInteraction ?? detail.data?.interaction;

  if (detail.isError && !loadedInteraction) {
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

  const linkedReport = detail.data?.report ?? loadedReport;
  const session = detail.data === undefined ? loadedSession : detail.data.session;
  const isLoadingExactAssociations = Boolean(
    loadedInteraction && needsExactDetail && detail.isLoading && !detail.data,
  );
  const exactAssociationError = loadedInteraction && detail.isError ? detail.error : null;
  const findingCount = linkedReport ? reportFindings(linkedReport).length : 0;
  const customerDisplay =
    interaction.customerRef ?? (interaction.customerId ? "Linked customer" : null);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <button
          type="button"
          onClick={back}
          className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Back
        </button>
        <IconChevronRightSmall size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Interaction</span>
        <IconChevronRightSmall size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span aria-current="page" className="truncate font-mono text-xs text-foreground">
          {interaction.operation}
        </span>
      </nav>

      <header className="min-w-0">
        <h2 className="break-words font-mono text-xl font-medium">{interaction.operation}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {customerDisplay ?? "Unknown customer"} · {formatDate(interaction.occurredAt)}
        </p>
      </header>

      {exactAssociationError ? (
        <Panel>
          <p role="alert" className="text-sm text-destructive">
            Could not load linked feedback and session. {exactAssociationError.message}
          </p>
          <Button variant="outline" size="sm" className="w-fit" onClick={() => detail.refetch()}>
            Try again
          </Button>
        </Panel>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <main className="flex min-w-0 flex-col gap-6">
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

          <Panel title="Verification">
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
            <p className="font-sans text-xs leading-5 text-muted-foreground">
              Epode stores structured metadata, not prompts, transcripts, or raw tool input and
              output.
            </p>
          </Panel>

          <section aria-labelledby="attached-feedback-heading" className="flex flex-col gap-3">
            <h2 id="attached-feedback-heading" className="text-base font-medium">
              Attached feedback
            </h2>
            {isLoadingExactAssociations ? (
              <Panel>
                <p role="status" className="text-sm text-muted-foreground">
                  Loading linked feedback and session…
                </p>
              </Panel>
            ) : exactAssociationError && !linkedReport ? (
              <Panel>
                <p className="text-sm text-muted-foreground">
                  Linked feedback status is unavailable.
                </p>
              </Panel>
            ) : linkedReport ? (
              <Card size="sm">
                <CardHeader className="border-b">
                  <CardTitle className="max-w-2xl text-base leading-6">
                    {linkedReport.summary}
                  </CardTitle>
                  <CardAction>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openFeedback(linkedReport.id)}
                    >
                      Open feedback
                      <IconArrowUpRight data-icon="inline-end" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-3 text-sm sm:grid-cols-3">
                    <Property
                      label="Impact"
                      value={titleCase(linkedReport.impact ?? "Unknown impact")}
                    />
                    <Property label="Status" value={titleCase(linkedReport.workflowStatus)} />
                    <Property
                      label="Findings"
                      value={`${findingCount} structured ${findingCount === 1 ? "finding" : "findings"}`}
                    />
                  </dl>
                </CardContent>
              </Card>
            ) : (
              <Panel>
                <p className="text-sm text-muted-foreground">
                  No feedback was submitted for this interaction.
                </p>
              </Panel>
            )}
          </section>

          {session ? (
            <Panel title="Session">
              <p className="text-sm leading-6">
                This interaction belongs to a continuity group supplied by{" "}
                {interfaceLabel(session.source)}.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => openSession(session.id)}
              >
                Open session
              </Button>
            </Panel>
          ) : null}
        </main>

        <aside aria-label="Technical metadata" className="xl:sticky xl:top-6">
          <Panel title="Technical metadata" className="gap-2">
            <dl className="flex flex-col gap-1 text-sm">
              <MetadataProperty label="Operation" value={interaction.operation} mono />
              <MetadataProperty label="Interaction ID" value={interaction.id} mono />
              <MetadataProperty
                label="Runtime hint"
                value={interaction.runtimeHint ?? "Not provided"}
                mono={Boolean(interaction.runtimeHint)}
              />
              <MetadataProperty
                label="Hint provenance"
                value={interaction.runtimeHintSource ?? "Not provided"}
                mono={Boolean(interaction.runtimeHintSource)}
              />
              <MetadataProperty label="Customer" value={customerDisplay ?? "Not linked"} />
              <MetadataProperty
                label="Session ID"
                value={interaction.sessionId ?? "Not linked"}
                mono={Boolean(interaction.sessionId)}
              />
            </dl>
          </Panel>
        </aside>
      </div>
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

function MetadataProperty({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6.75rem_minmax(0,1fr)] items-start gap-3 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs leading-5" : "min-w-0 break-words"}>
        {value}
      </dd>
    </div>
  );
}
