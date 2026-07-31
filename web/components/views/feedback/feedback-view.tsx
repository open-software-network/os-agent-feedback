"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  EmptyState,
  ErrorState,
  NativeSelect,
  PageHeader,
  Panel,
} from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiRequest } from "@/lib/api/client";
import type {
  DashboardData,
  DashboardReportResponse,
  ProductFeedbackReport,
} from "@/lib/api/dashboard";
import {
  formatDate,
  formatDuration,
  isEditor,
  relativeDate,
  titleCase,
} from "@/lib/dashboard/format";
import { reportFindings } from "@/lib/dashboard/reports";
import { FeedbackGroups } from "./feedback-groups";
import { WorkflowForm } from "./workflow-form";

export function FeedbackView({
  data,
  selectedReportId,
  selectReport,
  openInteraction,
  openSession,
  loadMore,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  selectedReportId: string | null;
  selectReport: (reportId: string | null) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  loadMore: () => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [impact, setImpact] = useState("all");
  const [range, setRange] = useState("30d");
  const productId = data.currentProduct?.id;
  const loadedReport = data.reports.find((report) => report.id === selectedReportId);
  const detail = useQuery({
    queryKey: ["feedback", data.workspace.id, productId, selectedReportId],
    queryFn: () =>
      apiRequest<DashboardReportResponse>(
        `/api/dashboard/reports/${selectedReportId}?productId=${productId}`,
        { workspaceId: data.workspace.id },
      ),
    enabled: Boolean(selectedReportId && productId && !loadedReport),
  });
  const selectedReport = loadedReport ?? detail.data?.report ?? null;
  const impacts = Array.from(
    new Set(data.reports.map((report) => report.impact ?? "unspecified")),
  ).sort();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const minimum =
      range === "7d"
        ? Date.now() - 7 * 86_400_000
        : range === "30d"
          ? Date.now() - 30 * 86_400_000
          : 0;
    return data.reports.filter((report) => {
      const findings = reportFindings(report);
      const haystack = [
        report.summary,
        report.operation,
        report.surface,
        report.customerRef,
        report.runtimeHint,
        report.workflowStatus,
        ...report.tags,
        ...findings.flatMap((finding) => [finding.topic, finding.kind, finding.detail]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!needle || haystack.includes(needle)) &&
        (status === "all" || report.workflowStatus === status) &&
        (impact === "all" || (report.impact ?? "unspecified") === impact) &&
        new Date(report.createdAt).getTime() >= minimum
      );
    });
  }, [data.reports, impact, query, range, status]);

  if (selectedReportId) {
    if (detail.isError) {
      return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
    }
    if (!selectedReport) {
      return <p className="text-sm text-muted-foreground">Loading feedback…</p>;
    }
    return (
      <FeedbackDetail
        data={data}
        report={selectedReport}
        back={() => selectReport(null)}
        openInteraction={openInteraction}
        openSession={openSession}
        refresh={async () => {
          await refresh();
          await detail.refetch();
        }}
        setNotice={setNotice}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={data.currentProduct?.name ?? "No product selected"}
        title="Feedback"
        description="Search submitted agent feedback and manage the team workflow."
        actions={
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <FeedbackGroups
        key={`${data.workspace.id}:${data.currentProduct?.id ?? "none"}`}
        data={data}
      />
      <Panel>
        <div className="grid gap-2 md:grid-cols-4">
          <Input
            aria-label="Search feedback"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search feedback"
          />
          <NativeSelect
            aria-label="Workflow status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="new">New</option>
            <option value="investigating">Investigating</option>
            <option value="planned">Planned</option>
            <option value="resolved">Resolved</option>
            <option value="wont_act">Won&apos;t act</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Impact"
            value={impact}
            onChange={(event) => setImpact(event.target.value)}
          >
            <option value="all">All impacts</option>
            {impacts.map((value) => (
              <option value={value} key={value}>
                {titleCase(value)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Time range"
            value={range}
            onChange={(event) => setRange(event.target.value)}
          >
            <option value="all">All time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </NativeSelect>
        </div>
      </Panel>
      {filtered.length ? (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>{titleCase(report.workflowStatus)}</TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto justify-start p-0 text-left"
                      onClick={() => selectReport(report.id)}
                    >
                      {report.summary}
                    </Button>
                  </TableCell>
                  <TableCell>{report.operation}</TableCell>
                  <TableCell>{report.customerRef ?? "Not linked"}</TableCell>
                  <TableCell title={formatDate(report.createdAt)}>
                    {relativeDate(report.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : (
        <EmptyState
          title="No matching feedback"
          description="Try a wider filter or wait for agents to submit feedback."
        />
      )}
      {data.listState.reportsLoaded < data.listState.reportsTotal ? (
        <Button variant="outline" onClick={loadMore}>
          Load 250 more
        </Button>
      ) : null}
    </div>
  );
}

function FeedbackDetail({
  data,
  report,
  back,
  openInteraction,
  openSession,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  report: ProductFeedbackReport;
  back: () => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const findings = reportFindings(report);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Feedback"
        title={titleCase(report.impact ?? "Unknown impact")}
        description={formatDate(report.createdAt)}
        actions={
          <Button variant="outline" onClick={back}>
            Back to feedback
          </Button>
        }
      />
      <Panel title="What the agent reported">
        <p className="text-lg">{report.summary}</p>
      </Panel>
      <Panel title={`Findings (${findings.length})`}>
        {findings.length ? (
          <ul className="space-y-3">
            {findings.map((finding) => (
              <li
                className="border-b pb-3 last:border-0"
                key={[finding.topic, finding.kind, finding.detail, finding.severity].join(":")}
              >
                <strong>{titleCase(finding.topic ?? finding.kind ?? "Finding")}</strong>
                <p className="text-sm text-muted-foreground">
                  {finding.detail ?? "No detail provided."}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No structured findings.</p>
        )}
      </Panel>
      {report.workaround ? (
        <Panel title="Workaround">
          <p>{report.workaround.detail ?? "No detail provided."}</p>
          <p className="text-sm text-muted-foreground">
            {report.workaround.used ? "The workaround was used." : "The workaround was not used."}
          </p>
        </Panel>
      ) : null}
      <Panel title="Product context">
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <Property label="Operation" value={report.operation} />
          <Property label="Surface" value={titleCase(report.surface)} />
          <Property label="Duration" value={formatDuration(report.durationMs)} />
          <Property label="Status code" value={report.statusCode ?? "—"} />
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => openInteraction(report.interactionId)}>
            Open interaction
          </Button>
          {report.sessionId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => report.sessionId && openSession(report.sessionId)}
            >
              Open linked session
            </Button>
          ) : null}
        </div>
      </Panel>
      <Panel title="Team workflow">
        {isEditor(data.currentRole) ? (
          <WorkflowForm data={data} report={report} refresh={refresh} setNotice={setNotice} />
        ) : (
          <p className="text-sm text-muted-foreground">
            An owner or admin manages status, assignment, tags, and internal notes.
          </p>
        )}
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
