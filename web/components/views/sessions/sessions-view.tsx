"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";

import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import { MetricStrip } from "@/components/dashboard/metric-strip";
import { EmptyState, ErrorState } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { apiRequest } from "@/lib/api/client";
import type {
  DashboardData,
  DashboardSessionDetail,
  DashboardSessionSummary,
} from "@/lib/api/dashboard";
import { fetchDashboardSessionsPage } from "@/lib/api/dashboard";
import {
  formatDate,
  formatDuration,
  interfaceLabel,
  relativeDate,
  titleCase,
} from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";

type SessionFilter = "all" | "multi" | "feedback" | "no_feedback";

function isSessionFilter(value: string | null): value is SessionFilter {
  return value !== null && ["all", "multi", "feedback", "no_feedback"].includes(value);
}

function readSessionLocation(): { query: string; filter: SessionFilter } {
  if (typeof window === "undefined") return { query: "", filter: "all" };
  const params = new URL(window.location.href).searchParams;
  const filter = params.get("sessionKind");
  return {
    query: params.get("sessionQ") ?? "",
    filter: isSessionFilter(filter) ? filter : "all",
  };
}

function writeSessionLocation(query: string, filter: SessionFilter) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (query.trim()) url.searchParams.set("sessionQ", query.trim());
  else url.searchParams.delete("sessionQ");
  if (filter === "all") url.searchParams.delete("sessionKind");
  else url.searchParams.set("sessionKind", filter);
  window.history.replaceState(window.history.state, "", url);
}

const impactLabels: Record<string, string> = {
  blocked: "Blocked",
  hindered: "Hindered",
  helped_with_friction: "Friction",
  helped: "Helped",
  neutral: "Neutral",
  unknown: "Unknown",
};

function sessionJourney(session: DashboardSessionSummary) {
  if (!session.interactionCount) return "No interactions";
  if (session.interactionCount === 1) return session.firstOperation ?? "Single event";
  if (session.interactionCount > 3) return `${session.interactionCount}-step journey`;
  return `${session.firstOperation ?? "Unknown"} → ${session.lastOperation ?? "Unknown"}`;
}

function elapsedLabel(startedAt: string, occurredAt: string) {
  const elapsedSeconds = Math.max(
    0,
    Math.round((new Date(occurredAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return `+${parts.map((part) => String(part).padStart(2, "0")).join(":")}`;
}

function sessionDuration(startedAt: string, lastSeenAt: string) {
  const durationMs = Math.max(0, new Date(lastSeenAt).getTime() - new Date(startedAt).getTime());
  if (durationMs === 0) return "Single observation";
  if (durationMs < 60_000) return "Less than a minute";
  const minutes = Math.round(durationMs / 60_000);
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

export function SessionsView({
  data,
  selectedSessionId,
  selectSession,
  openFeedback,
  openInteraction,
  refresh,
}: {
  data: DashboardData;
  selectedSessionId: string | null;
  selectSession: (sessionId: string | null) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  /** @deprecated Pagination is now owned by the server-backed list query. */
  loadMore?: () => void;
  refresh: () => Promise<unknown>;
}) {
  const initialLocation = useMemo(readSessionLocation, []);
  const [query, setQuery] = useState(initialLocation.query);
  const [filter, setFilter] = useState<SessionFilter>(initialLocation.filter);
  const productId = data.currentProduct?.id;
  const sessionPages = useInfiniteQuery({
    queryKey: ["session-list", data.workspace.id, productId, query, filter],
    queryFn: ({ pageParam }) =>
      fetchDashboardSessionsPage(data.workspace.id, {
        productId: productId ?? "",
        q: query.trim() || undefined,
        kind: filter,
        limit: 50,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    initialData: {
      pages: [
        {
          sessions: data.sessions,
          rollup: {
            sessions: data.listState.sessionsTotal,
            interactions: data.sessions.reduce(
              (total, session) => total + session.interactionCount,
              0,
            ),
            multiStepSessions: data.sessions.filter((session) => session.interactionCount > 1)
              .length,
            averageInteractions: data.sessions.length
              ? data.sessions.reduce((total, session) => total + session.interactionCount, 0) /
                data.sessions.length
              : 0,
          },
          limit: Math.min(100, Math.max(1, data.sessions.length || 50)),
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    },
    initialDataUpdatedAt: 0,
    enabled: Boolean(productId),
  });
  const sessionRows =
    sessionPages.data?.pages.flatMap((page) =>
      Array.isArray(page.sessions) ? page.sessions : [],
    ) ?? [];
  const rollup = sessionPages.data?.pages[0]?.rollup ?? {
    sessions: 0,
    interactions: 0,
    multiStepSessions: 0,
    averageInteractions: 0,
  };
  const detail = useQuery({
    queryKey: ["session", data.workspace.id, productId, selectedSessionId],
    queryFn: () =>
      apiRequest<DashboardSessionDetail>(
        `/api/dashboard/sessions/${selectedSessionId}?productId=${productId}`,
        { workspaceId: data.workspace.id },
      ),
    enabled: Boolean(selectedSessionId && productId),
  });

  useEffect(() => writeSessionLocation(query, filter), [filter, query]);

  useEffect(() => {
    const restore = () => {
      const location = readSessionLocation();
      setQuery(location.query);
      setFilter(location.filter);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  return (
    <DetailWorkspace
      open={Boolean(selectedSessionId)}
      className="bg-background"
      inspector={
        selectedSessionId ? (
          <SessionInspector
            requestedId={selectedSessionId}
            detail={detail.data}
            error={detail.isError ? detail.error : null}
            close={() => selectSession(null)}
            retry={() => detail.refetch()}
            openFeedback={openFeedback}
            openInteraction={openInteraction}
          />
        ) : null
      }
    >
      <MetricStrip
        items={[
          { label: "Proven sessions", value: rollup.sessions.toLocaleString() },
          { label: "Interactions", value: rollup.interactions.toLocaleString() },
          { label: "Multi-step", value: rollup.multiStepSessions.toLocaleString() },
          { label: "Average", value: rollup.averageInteractions.toFixed(1) },
        ]}
      />
      <p className="border-b bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
        Sessions exist only when the product supplies a stable reference.
      </p>
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <InputGroup className="max-w-xl bg-background">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search session, customer, or operation"
          />
        </InputGroup>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <ToggleGroup
            value={[filter]}
            spacing={1}
            aria-label="Filter sessions"
            onValueChange={(value) => {
              const next = value[0] as SessionFilter | undefined;
              if (next) setFilter(next);
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="multi">Multi-step</ToggleGroupItem>
            <ToggleGroupItem value="feedback">Has feedback</ToggleGroupItem>
            <ToggleGroupItem value="no_feedback">No feedback</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void Promise.all([refresh(), sessionPages.refetch()])}
          >
            Refresh
          </Button>
        </div>
      </div>
      <section className="min-h-0 flex-1 overflow-auto bg-background" aria-label="Sessions">
        {sessionPages.isError ? (
          <div className="p-4 text-sm text-destructive" role="alert">
            Sessions could not be loaded. Use Refresh to try again.
          </div>
        ) : sessionPages.isPending ? (
          <p className="p-4 text-sm text-muted-foreground" role="status">
            Loading sessions…
          </p>
        ) : sessionRows.length ? (
          <Table className="min-w-[760px] table-fixed">
            <TableHeader className="sticky top-0 z-[1] bg-background">
              <TableRow className="hover:bg-background">
                <TableHead className="h-9 w-[24%] pl-5 text-xs">Session</TableHead>
                <TableHead className="h-9 w-[31%] text-xs">Journey</TableHead>
                <TableHead className="h-9 w-[12%] text-xs">Interactions</TableHead>
                <TableHead className="h-9 w-[13%] text-xs">Feedback</TableHead>
                <TableHead className="h-9 w-[20%] pr-5 text-right text-xs">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessionRows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={selectedSessionId === session.id}
                  onOpen={() => selectSession(session.id)}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="h-full bg-canvas p-4">
            <EmptyState
              title="No matching sessions"
              description="Clear the search or choose a different session view."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        )}
      </section>
      {sessionRows.length ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-4 py-2 text-xs text-muted-foreground">
          <p aria-live="polite">
            Showing {sessionRows.length.toLocaleString()} of {rollup.sessions.toLocaleString()}{" "}
            matching sessions. Filters cover all retained sessions.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!sessionPages.hasNextPage || sessionPages.isFetchingNextPage}
            onClick={() => void sessionPages.fetchNextPage()}
          >
            {sessionPages.isFetchingNextPage
              ? "Loading…"
              : sessionPages.hasNextPage
                ? "Load 50 more"
                : "All loaded"}
          </Button>
        </div>
      ) : null}
    </DetailWorkspace>
  );
}

function SessionRow({
  session,
  selected,
  onOpen,
}: {
  session: DashboardSessionSummary;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      aria-selected={selected}
      aria-label={`Open session ${session.refHint}`}
      tabIndex={0}
      className="cursor-pointer bg-background hover:bg-muted/40 data-[state=selected]:bg-selected data-[state=selected]:shadow-[inset_2px_0_0_var(--attention)]"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell className="h-[66px] overflow-hidden pl-5">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start truncate p-0 font-mono text-xs font-medium"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {session.refHint}
        </Button>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {interfaceLabel(session.source)}
        </p>
      </TableCell>
      <TableCell className="overflow-hidden">
        <p className="truncate font-mono text-xs">{sessionJourney(session)}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {session.customerRef ?? "Unknown customer"}
        </p>
      </TableCell>
      <TableCell className="text-xs">{session.interactionCount}</TableCell>
      <TableCell className="text-xs">
        {session.reportCount
          ? `${session.reportCount} · ${impactLabels[session.strongestImpact ?? "unknown"]}`
          : "None"}
      </TableCell>
      <TableCell
        className="pr-5 text-right text-xs text-muted-foreground"
        title={formatDate(session.lastSeenAt)}
      >
        {relativeDate(session.lastSeenAt)}
      </TableCell>
    </TableRow>
  );
}

function SessionInspector({
  requestedId,
  detail,
  error,
  close,
  retry,
  openFeedback,
  openInteraction,
}: {
  requestedId: string;
  detail?: DashboardSessionDetail;
  error: Error | null;
  close: () => void;
  retry: () => Promise<unknown>;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
}) {
  return (
    <DetailRail open onClose={close} label="Session detail">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {detail?.session?.refHint ?? requestedId}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close session detail" onClick={close}>
          <IconCrossSmall />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-5">
          {error ? (
            <ErrorState error={error} onRetry={() => void retry()} />
          ) : detail?.session ? (
            <SessionJourney
              detail={detail}
              openFeedback={openFeedback}
              openInteraction={openInteraction}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Loading session…
            </p>
          )}
        </div>
      </ScrollArea>
    </DetailRail>
  );
}

function SessionJourney({
  detail,
  openFeedback,
  openInteraction,
}: {
  detail: DashboardSessionDetail;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
}) {
  const reportsByInteraction = new Map(
    detail.reports.map((report) => [report.interactionId, report]),
  );
  const interactions = [...detail.interactions].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );

  return (
    <>
      <p className="text-xs text-muted-foreground">Proven session</p>
      <div className="mt-2 flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words font-mono text-base font-medium">
          {detail.session.refHint}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {interfaceLabel(detail.session.source)}
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-[100px_1fr] gap-x-3 gap-y-3 text-xs">
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatDate(detail.session.startedAt)}</dd>
        <dt className="text-muted-foreground">Observed for</dt>
        <dd>{sessionDuration(detail.session.startedAt, detail.session.lastSeenAt)}</dd>
        <dt className="text-muted-foreground">Interactions</dt>
        <dd>{interactions.length}</dd>
        <dt className="text-muted-foreground">Feedback reports</dt>
        <dd>{detail.reports.length}</dd>
      </dl>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Epode groups this journey only because the product supplied a stable session reference.
      </p>

      <Separator className="my-5" />

      <section aria-labelledby="observed-journey-heading">
        <h3 id="observed-journey-heading" className="text-xs font-medium">
          Observed journey
        </h3>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Structured interaction metadata in chronological order.
        </p>
        <ol className="relative mt-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:border-l before:border-dotted before:border-foreground/25 before:content-['']">
          <JourneyCap label="Session started" timestamp={detail.session.startedAt} />
          {interactions.length ? (
            interactions.map((interaction, index) => {
              const report = reportsByInteraction.get(interaction.id);
              const isError = interaction.statusCode !== null && interaction.statusCode >= 400;
              return (
                <li
                  key={interaction.id}
                  className="relative grid grid-cols-[12px_minmax(0,1fr)] gap-3 pb-5"
                >
                  <span
                    className={cn(
                      "relative z-[1] mt-1 size-3 border bg-background",
                      isError && "border-destructive bg-destructive",
                      !isError && report && "border-attention bg-attention",
                      !isError && !report && "border-foreground/40",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
                      <span>{elapsedLabel(detail.session.startedAt, interaction.occurredAt)}</span>
                      <span>Step {index + 1}</span>
                    </div>
                    <Button
                      variant="link"
                      className="h-auto max-w-full justify-start p-0 font-mono text-xs font-medium"
                      onClick={() => openInteraction(interaction.id)}
                    >
                      <span className="truncate">{interaction.operation}</span>
                    </Button>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {interfaceLabel(interaction.surface)} ·{" "}
                      {formatDuration(interaction.durationMs)} ·{" "}
                      {interaction.statusCode === null
                        ? "No status"
                        : `HTTP ${interaction.statusCode}`}
                    </p>
                    {isError || report ? (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        {isError ? <span className="text-destructive">Error response</span> : null}
                        {report ? (
                          <span className="text-muted-foreground">Feedback attached</span>
                        ) : null}
                      </div>
                    ) : null}
                    {report ? (
                      <div className="mt-3 border bg-muted/30 p-3 shadow-[inset_2px_0_0_var(--attention)]">
                        <p className="text-xs leading-5">{report.summary}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {titleCase(report.impact ?? "Unknown impact")} ·{" "}
                          {titleCase(report.workflowStatus)}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => openFeedback(report.id)}
                        >
                          Open feedback
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })
          ) : (
            <li className="relative grid grid-cols-[12px_minmax(0,1fr)] gap-3 pb-5">
              <span
                className="relative z-[1] mt-1 size-3 border border-foreground/25 bg-background"
                aria-hidden="true"
              />
              <p className="text-xs text-muted-foreground">
                No interactions were observed in this session.
              </p>
            </li>
          )}
          <JourneyCap label="Last observed" timestamp={detail.session.lastSeenAt} last />
        </ol>
      </section>
    </>
  );
}

function JourneyCap({
  label,
  timestamp,
  last = false,
}: {
  label: string;
  timestamp: string;
  last?: boolean;
}) {
  return (
    <li className={cn("relative grid grid-cols-[12px_minmax(0,1fr)] gap-3", !last && "pb-5")}>
      <span
        className="relative z-[1] mt-1 size-3 border border-foreground/40 bg-background"
        aria-hidden="true"
      />
      <div>
        <p className="text-xs font-medium">{label}</p>
        <time dateTime={timestamp} className="mt-0.5 block text-[11px] text-muted-foreground">
          {formatDate(timestamp)}
        </time>
      </div>
    </li>
  );
}
