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
import type { DashboardData, DashboardSessionDetail, ProductSession } from "@/lib/api/dashboard";
import { formatDate, formatDuration, relativeDate, titleCase } from "@/lib/dashboard/format";

export function SessionsView({
  data,
  selectedSessionId,
  selectSession,
  openFeedback,
  openInteraction,
  loadMore,
  refresh,
}: {
  data: DashboardData;
  selectedSessionId: string | null;
  selectSession: (sessionId: string | null) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  loadMore: () => void;
  refresh: () => Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [reviewState, setReviewState] = useState("all");
  const [source, setSource] = useState("all");
  const [range, setRange] = useState("30d");
  const productId = data.currentProduct?.id;
  const detail = useQuery({
    queryKey: ["session", data.workspace.id, productId, selectedSessionId],
    queryFn: () =>
      apiRequest<DashboardSessionDetail>(
        `/api/dashboard/sessions/${selectedSessionId}?productId=${productId}`,
        { workspaceId: data.workspace.id },
      ),
    enabled: Boolean(selectedSessionId && productId),
  });

  const sessionRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const minimum =
      range === "7d"
        ? Date.now() - 7 * 86_400_000
        : range === "30d"
          ? Date.now() - 30 * 86_400_000
          : 0;
    return data.sessions.filter((session) => {
      const interactions = data.interactions.filter((item) => item.sessionId === session.id);
      const reports = data.reports.filter((item) => item.sessionId === session.id);
      const haystack = [
        session.refHint,
        session.source,
        ...interactions.flatMap((item) => [item.operation, item.surface, item.customerRef]),
        ...reports.map((report) => report.summary),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!needle || haystack.includes(needle)) &&
        (reviewState === "all" ||
          (reviewState === "reviewed" ? reports.length > 0 : reports.length === 0)) &&
        (source === "all" || session.source === source) &&
        new Date(session.lastSeenAt).getTime() >= minimum
      );
    });
  }, [data.interactions, data.reports, data.sessions, query, range, reviewState, source]);

  if (selectedSessionId) {
    if (detail.isError) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
    if (!detail.data) return <p className="text-sm text-muted-foreground">Loading session…</p>;
    return (
      <SessionDetail
        detail={detail.data}
        back={() => selectSession(null)}
        openFeedback={openFeedback}
        openInteraction={openInteraction}
      />
    );
  }

  const sources = Array.from(new Set(data.sessions.map((session) => session.source))).sort();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={data.currentProduct?.name ?? "No product selected"}
        title="Sessions"
        description="Review grouped agent activity and the feedback it produced."
        actions={
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <Panel>
        <div className="grid gap-2 md:grid-cols-4">
          <Input
            aria-label="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
          />
          <NativeSelect
            aria-label="Feedback state"
            value={reviewState}
            onChange={(event) => setReviewState(event.target.value)}
          >
            <option value="all">All sessions</option>
            <option value="reviewed">With feedback</option>
            <option value="unreviewed">Without feedback</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Session source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="all">All sources</option>
            {sources.map((item) => (
              <option value={item} key={item}>
                {titleCase(item)}
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
      {sessionRows.length ? (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Interactions</TableHead>
                <TableHead>Feedback</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessionRows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  interactionCount={
                    data.interactions.filter((item) => item.sessionId === session.id).length
                  }
                  reportCount={data.reports.filter((item) => item.sessionId === session.id).length}
                  onOpen={() => selectSession(session.id)}
                />
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : (
        <EmptyState
          title="No matching sessions"
          description="Try a wider filter or wait for session telemetry."
        />
      )}
      {data.listState.sessionsLoaded < data.listState.sessionsTotal ? (
        <Button variant="outline" onClick={loadMore}>
          Load 100 more
        </Button>
      ) : null}
    </div>
  );
}

function SessionRow({
  session,
  interactionCount,
  reportCount,
  onOpen,
}: {
  session: ProductSession;
  interactionCount: number;
  reportCount: number;
  onOpen: () => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <Button variant="link" className="h-auto p-0" onClick={onOpen}>
          {session.refHint}
        </Button>
      </TableCell>
      <TableCell>{titleCase(session.source)}</TableCell>
      <TableCell>{interactionCount}</TableCell>
      <TableCell>{reportCount}</TableCell>
      <TableCell title={formatDate(session.lastSeenAt)}>
        {relativeDate(session.lastSeenAt)}
      </TableCell>
    </TableRow>
  );
}

function SessionDetail({
  detail,
  back,
  openFeedback,
  openInteraction,
}: {
  detail: DashboardSessionDetail;
  back: () => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
}) {
  const reportsByInteraction = new Map(
    detail.reports.map((report) => [report.interactionId, report]),
  );
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Session"
        title={detail.session.refHint}
        description={`${titleCase(detail.session.source)} · ${formatDate(detail.session.startedAt)} to ${formatDate(detail.session.lastSeenAt)}`}
        actions={
          <Button variant="outline" onClick={back}>
            Back to sessions
          </Button>
        }
      />
      <Panel title="Timeline">
        {detail.interactions.length ? (
          <ol className="space-y-3">
            {[...detail.interactions]
              .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
              .map((interaction) => {
                const report = reportsByInteraction.get(interaction.id);
                return (
                  <li
                    className="grid gap-2 border-b pb-3 last:border-0 sm:grid-cols-[10rem_1fr_auto]"
                    key={interaction.id}
                  >
                    <time className="text-sm text-muted-foreground">
                      {formatDate(interaction.occurredAt)}
                    </time>
                    <div>
                      <Button
                        variant="link"
                        className="h-auto justify-start p-0 font-medium"
                        onClick={() => openInteraction(interaction.id)}
                      >
                        {interaction.operation}
                      </Button>
                      <p className="text-sm text-muted-foreground">
                        {titleCase(interaction.surface)} · {formatDuration(interaction.durationMs)}{" "}
                        · HTTP {interaction.statusCode ?? "—"}
                      </p>
                    </div>
                    {report ? (
                      <Button variant="outline" size="sm" onClick={() => openFeedback(report.id)}>
                        Open feedback
                      </Button>
                    ) : null}
                  </li>
                );
              })}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No interactions in this session.</p>
        )}
      </Panel>
    </div>
  );
}
