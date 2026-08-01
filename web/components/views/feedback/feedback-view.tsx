"use client";

import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCalendarCheck } from "central-icons/IconCalendarCheck";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconCircle } from "central-icons/IconCircle";
import { IconCircleMinus } from "central-icons/IconCircleMinus";
import { IconCirclePlaceholderOn } from "central-icons/IconCirclePlaceholderOn";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMathEqualsCircle } from "central-icons/IconMathEqualsCircle";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { IconThumbUpCurved } from "central-icons/IconThumbUpCurved";
import { IconWarningSign } from "central-icons/IconWarningSign";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";

import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import { EmptyState, Panel, StatusMessage } from "@/components/dashboard/view-primitives";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ApiError, apiRequest } from "@/lib/api/client";
import { fetchProductGithubRepo } from "@/lib/api/connectors";
import type {
  DashboardData,
  DashboardFeedbackFacets,
  DashboardReportResponse,
  ProductFeedbackReport,
} from "@/lib/api/dashboard";
import { fetchDashboardFeedbackPage } from "@/lib/api/dashboard";
import {
  fetchProductGroupsWindow,
  fileGroupGithubIssue,
  type ProductGroupsResponse,
  type ProductReportGroup,
} from "@/lib/api/groups";
import {
  formatDate,
  formatDuration,
  interfaceLabel,
  isEditor,
  relativeDate,
  titleCase,
} from "@/lib/dashboard/format";
import { reportFindings } from "@/lib/dashboard/reports";
import { cn } from "@/lib/utils";

import {
  createEmptyFilters,
  type FeedbackFacet,
  FeedbackFilters,
  type FeedbackFiltersState,
  type FilterOption,
  facetOrder,
  impactLabels,
  impactValues,
  type WorkflowStatus,
  workflowLabels,
  workflowStatuses,
} from "./feedback-filters";
import { WorkflowForm } from "./workflow-form";

const defaultRange = "30d";
const groupsPageSize = 50;

type FeedbackMode = "reports" | "signals";

const statusBadge = {
  new: "workflow-new",
  investigating: "workflow-investigating",
  planned: "workflow-planned",
  resolved: "workflow-resolved",
  wont_act: "workflow-wont-act",
} as const;

type SemanticIcon = ComponentType<{
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
  "data-icon"?: string;
}>;

const workflowIcons: Record<WorkflowStatus, SemanticIcon> = {
  new: IconCircle,
  investigating: IconMagnifyingGlass,
  planned: IconCalendarCheck,
  resolved: IconCheckCircle2,
  wont_act: IconCircleMinus,
};

const impactIcons: Record<string, SemanticIcon> = {
  blocked: IconStopCircle,
  hindered: IconWarningSign,
  helped_with_friction: IconExclamationCircle,
  helped: IconThumbUpCurved,
  neutral: IconMathEqualsCircle,
  unknown: IconCircleQuestionmark,
};

const impactTone: Record<string, string> = {
  blocked: "text-impact-negative",
  hindered: "text-impact-warning",
  helped_with_friction: "text-impact-caution",
  helped: "text-impact-positive",
  neutral: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

export function FeedbackView({
  data,
  selectedReportId,
  selectReport,
  openInteraction,
  openSession,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  selectedReportId: string | null;
  selectReport: (reportId: string | null) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  /** @deprecated Pagination is now owned by the server-backed list query. */
  loadMore?: () => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const initialLocation = useMemo(readFilterLocation, []);
  const [query, setQuery] = useState(initialLocation.query);
  const [filters, setFilters] = useState<FeedbackFiltersState>(initialLocation.filters);
  const [range, setRange] = useState(initialLocation.range);
  const [mode, setMode] = useState<FeedbackMode>("reports");
  const [groupLimit, setGroupLimit] = useState(groupsPageSize);
  const productId = data.currentProduct?.id;
  const debouncedQuery = useDebouncedValue(query, 250);
  const since = useMemo(() => rangeStart(range), [range]);
  const searchSettling = query.trim() !== debouncedQuery.trim();
  const hasFacetFilters = facetOrder.some((facet) => filters[facet].length > 0);
  const canSeedReportList =
    !query.trim() &&
    !hasFacetFilters &&
    data.listState.reportsLoaded === data.listState.reportsTotal &&
    data.reports.every((report) => !since || new Date(report.createdAt) >= new Date(since));
  const seedFacets = useMemo(() => feedbackFacetsFromReports(data.reports), [data.reports]);
  const reportPages = useInfiniteQuery({
    queryKey: ["feedback-list", data.workspace.id, productId, debouncedQuery, filters, since],
    queryFn: ({ pageParam }) =>
      fetchDashboardFeedbackPage(data.workspace.id, {
        productId: productId ?? "",
        q: debouncedQuery.trim() || undefined,
        status: filters.status,
        impact: filters.impact,
        surface: filters.surface,
        topic: filters.topic,
        findingKind: filters.kind,
        severity: filters.severity,
        tag: filters.tag,
        assignee: filters.assignee,
        workaround: filters.workaround,
        since,
        limit: 50,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    initialData: canSeedReportList
      ? {
          pages: [
            {
              reports: data.reports,
              total: data.listState.reportsTotal,
              facets: seedFacets,
              limit: Math.min(100, Math.max(1, data.reports.length || 50)),
              nextCursor: null,
            },
          ],
          pageParams: [undefined],
        }
      : undefined,
    initialDataUpdatedAt: 0,
    enabled: Boolean(productId),
  });
  const reports = searchSettling
    ? []
    : (reportPages.data?.pages.flatMap((page) =>
        Array.isArray(page.reports) ? page.reports : [],
      ) ?? []);
  const reportTotal = reportPages.data?.pages[0]?.total ?? data.listState.reportsTotal;
  const facetData = reportPages.data?.pages[0]?.facets ?? feedbackFacetsFromReports(reports);
  const feedbackPending = reportPages.isPending || searchSettling;
  const loadedReport = reports.find((report) => report.id === selectedReportId);
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
  const groups = useQuery({
    queryKey: ["product-groups", data.workspace.id, productId, groupLimit],
    queryFn: () => fetchProductGroupsWindow(data.workspace.id, productId ?? "", groupLimit),
    enabled: mode === "signals" && Boolean(productId) && isEditor(data.currentRole),
    gcTime: 0,
  });
  const mapping = useQuery({
    queryKey: ["product-github-repo", data.workspace.id, productId],
    queryFn: () => fetchProductGithubRepo(data.workspace.id, productId ?? ""),
    enabled: mode === "signals" && Boolean(productId) && isEditor(data.currentRole),
  });
  const filing = useMutation({
    mutationFn: (groupKey: string) => fileGroupGithubIssue(data.workspace.id, groupKey),
    onSuccess: () => groups.refetch(),
  });

  useEffect(() => {
    writeFilterLocation(query, filters, range);
  }, [filters, query, range]);

  useEffect(() => {
    const restoreFilters = () => {
      const location = readFilterLocation();
      setQuery(location.query);
      setFilters(location.filters);
      setRange(location.range);
    };
    window.addEventListener("popstate", restoreFilters);
    return () => window.removeEventListener("popstate", restoreFilters);
  }, []);

  const filterOptions = useMemo<Record<FeedbackFacet, FilterOption[]>>(() => {
    const memberNames = new Map(
      data.teamMembers.map((member) => [member.osUserId, member.displayName]),
    );
    const counts = Object.fromEntries(
      Object.entries(facetData).map(([facet, values]) => [
        facet,
        new Map(values.map((item) => [item.name, item.count])),
      ]),
    ) as Record<keyof DashboardFeedbackFacets, Map<string, number>>;
    const options = (
      facet: FeedbackFacet,
      source: keyof DashboardFeedbackFacets,
      label: (value: string) => string,
    ) =>
      unique([...facetData[source].map((item) => item.name), ...filters[facet]]).map((value) => ({
        value,
        label: label(value),
        count: counts[source].get(value) ?? 0,
      }));
    const assignedIds = facetData.assignee
      .map((item) => item.name)
      .filter((value) => value !== "unassigned");
    const assigneeIds = unique([
      ...data.teamMembers.map((member) => member.osUserId),
      ...assignedIds,
      ...filters.assignee.filter((value) => value !== "unassigned"),
    ]);

    return {
      status: workflowStatuses.map((value) => ({
        value,
        label: workflowLabels[value],
        count: counts.status.get(value) ?? 0,
      })),
      impact: impactValues.map((value) => ({
        value,
        label: impactLabels[value],
        count: counts.impact.get(value) ?? 0,
      })),
      surface: options("surface", "surface", interfaceLabel),
      topic: options("topic", "topic", titleCase),
      kind: options("kind", "findingKind", titleCase),
      severity: options("severity", "severity", titleCase),
      tag: options("tag", "tag", (value) => value),
      assignee: [
        {
          value: "unassigned",
          label: "Unassigned",
          count: counts.assignee.get("unassigned") ?? 0,
        },
        ...assigneeIds.map((value) => ({
          value,
          label: memberNames.get(value) ?? value,
          count: counts.assignee.get(value) ?? 0,
        })),
      ],
      workaround: [
        { value: "used", label: "Observed", count: counts.workaround.get("used") ?? 0 },
        {
          value: "suggested",
          label: "Not used",
          count: counts.workaround.get("suggested") ?? 0,
        },
        {
          value: "none",
          label: "None recorded",
          count: counts.workaround.get("none") ?? 0,
        },
      ],
    };
  }, [data.teamMembers, facetData, filters]);

  function commitFilters(nextFilters: FeedbackFiltersState) {
    setFilters(nextFilters);
  }

  function toggleFilter(facet: FeedbackFacet, value: string) {
    const selected = filters[facet];
    const nextValues = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
    commitFilters({ ...filters, [facet]: nextValues });
  }

  async function refreshSelectedReport() {
    await Promise.all([refresh(), reportPages.refetch()]);
    if (!loadedReport) await detail.refetch();
  }

  async function refreshView() {
    await Promise.all([refresh(), reportPages.refetch()]);
    if (mode === "signals" && productId && isEditor(data.currentRole)) {
      await groups.refetch();
    }
  }

  function selectMode(nextMode: FeedbackMode) {
    setMode(nextMode);
    if (nextMode === "signals") selectReport(null);
  }

  const incomplete = Boolean(reportPages.hasNextPage);

  return (
    <DetailWorkspace
      open={mode === "reports" && Boolean(selectedReportId)}
      className="bg-background"
      inspector={
        <FeedbackInspector
          open={mode === "reports" && Boolean(selectedReportId)}
          reportId={selectedReportId}
          report={selectedReport}
          loading={detail.isPending && !selectedReport}
          error={detail.isError ? detail.error : null}
          onRetry={() => detail.refetch()}
          onClose={() => selectReport(null)}
          data={data}
          openInteraction={openInteraction}
          openSession={openSession}
          refresh={refreshSelectedReport}
          setNotice={setNotice}
        />
      }
    >
      <Tabs
        value={mode}
        onValueChange={(value) => selectMode(value as FeedbackMode)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-4">
          <TabsList variant="line" aria-label="Feedback view">
            <TabsTab value="reports">Reports</TabsTab>
            <TabsTab value="signals">Signals</TabsTab>
          </TabsList>
          <Button variant="ghost" size="sm" onClick={() => void refreshView()}>
            Refresh
          </Button>
        </div>

        <TabsPanel value="reports" className="flex min-h-0 flex-1 flex-col">
          <FeedbackFilters
            query={query}
            onQueryChange={setQuery}
            filters={filters}
            options={filterOptions}
            range={range}
            onRangeChange={setRange}
            onToggle={toggleFilter}
            onClearFacet={(facet) => commitFilters({ ...filters, [facet]: [] })}
            onClearAll={() => {
              setQuery("");
              setRange(defaultRange);
              commitFilters(createEmptyFilters());
            }}
          />

          {reportPages.isError ? (
            <div
              className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive"
              role="alert"
            >
              Feedback could not be loaded. Use Refresh to try again.
            </div>
          ) : null}

          {feedbackPending ? (
            <p className="border-b px-4 py-3 text-xs text-muted-foreground" role="status">
              Loading feedback…
            </p>
          ) : null}

          {!feedbackPending && reportTotal > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
              <p aria-live="polite">
                Showing {reports.length.toLocaleString()} of {reportTotal.toLocaleString()} matching
                reports. Filters cover all retained feedback.
              </p>
              {incomplete ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reportPages.isFetchingNextPage}
                  onClick={() => void reportPages.fetchNextPage()}
                >
                  {reportPages.isFetchingNextPage ? "Loading…" : "Load 50 more"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {reports.length ? (
            <section
              className="min-h-0 flex-1 overflow-auto bg-background"
              aria-label="Feedback reports"
            >
              <FeedbackTable
                reports={reports}
                selectedId={selectedReportId}
                onSelect={selectReport}
              />
            </section>
          ) : feedbackPending ? (
            <div className="min-h-0 flex-1 bg-canvas" />
          ) : (
            <div className="min-h-0 flex-1 bg-canvas p-4">
              <EmptyState
                title={
                  data.listState.reportsTotal === 0 ? "No feedback yet" : "No matching feedback"
                }
                description={
                  data.listState.reportsTotal === 0
                    ? "Finish setup and send one real product request before waiting for an agent report."
                    : "Clear the filters and show all retained feedback."
                }
                action={
                  data.listState.reportsTotal === 0 ? (
                    isEditor(data.currentRole) ? (
                      <Button size="sm" onClick={() => navigateToSetup()}>
                        Open Setup
                      </Button>
                    ) : null
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setRange("all");
                        commitFilters(createEmptyFilters());
                      }}
                    >
                      Show all retained feedback
                    </Button>
                  )
                }
              />
            </div>
          )}
        </TabsPanel>

        <TabsPanel value="signals" className="min-h-0 overflow-auto bg-canvas p-4">
          <SignalsView
            canView={isEditor(data.currentRole)}
            hasProduct={Boolean(productId)}
            groups={groups.data}
            loading={groups.isPending || mapping.isPending}
            error={groups.isError ? groups.error : mapping.isError ? mapping.error : null}
            mappingAvailable={Boolean(mapping.data)}
            connectorsHref={connectorsPath(data.workspace.id, productId ?? "")}
            mutationGroupKey={filing.variables}
            filingPending={filing.isPending}
            filingError={filing.error}
            onReviewReports={() => selectMode("reports")}
            onFileIssue={(groupKey) => filing.mutate(groupKey)}
            onCheckAgain={async () => {
              await groups.refetch();
              filing.reset();
            }}
            onLoadMore={() => {
              filing.reset();
              setGroupLimit((current) => current + groupsPageSize);
            }}
            onRetry={() => Promise.all([groups.refetch(), mapping.refetch()])}
          />
        </TabsPanel>
      </Tabs>
    </DetailWorkspace>
  );
}

function navigateToSetup() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "setup");
  url.searchParams.delete("report");
  url.searchParams.delete("session");
  url.searchParams.delete("interaction");
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function SignalsView({
  canView,
  hasProduct,
  groups,
  loading,
  error,
  mappingAvailable,
  connectorsHref,
  mutationGroupKey,
  filingPending,
  filingError,
  onReviewReports,
  onFileIssue,
  onCheckAgain,
  onLoadMore,
  onRetry,
}: {
  canView: boolean;
  hasProduct: boolean;
  groups: ProductGroupsResponse | undefined;
  loading: boolean;
  error: Error | null;
  mappingAvailable: boolean;
  connectorsHref: string;
  mutationGroupKey: string | undefined;
  filingPending: boolean;
  filingError: Error | null;
  onReviewReports: () => void;
  onFileIssue: (groupKey: string) => void;
  onCheckAgain: () => Promise<void>;
  onLoadMore: () => void;
  onRetry: () => unknown;
}) {
  if (!hasProduct) {
    return (
      <EmptyState
        title="No product selected"
        description="Choose a product to review its grouped feedback signals."
      />
    );
  }
  if (!canView) {
    return (
      <EmptyState
        title="Signals require editor access"
        description="An owner or admin can review grouped feedback signals."
      />
    );
  }
  if (error) {
    return (
      <EmptyState
        title="Signals could not be loaded"
        description={error.message}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (loading || !groups) {
    return <p className="p-4 text-sm text-muted-foreground">Loading signals…</p>;
  }
  if (!groups.groups.length) {
    return (
      <EmptyState
        title="No signals yet"
        description="Related reports will appear here once recurring feedback is detected."
      />
    );
  }

  const pendingMessage =
    filingError instanceof ApiError && filingError.status === 409 ? filingError.message : null;
  const failureMessage = filingError && !pendingMessage ? filingError.message : null;

  return (
    <div className="grid gap-3">
      <section className="border bg-background px-4 py-3" aria-labelledby="signal-clusters-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="signal-clusters-title" className="text-sm font-medium">
              Signal clusters
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Each report belongs to one cluster using its operation, interface, status class, and
              one deterministic primary finding (severity first, then finding type). Secondary
              findings remain available on the full report.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onReviewReports}>
            Review full reports
          </Button>
        </div>
      </section>
      {!mappingAvailable && groups.groups.some((group) => !group.githubIssue) ? (
        <StatusMessage>
          Map this product to a GitHub repository before filing an issue.{" "}
          <a className={buttonVariants({ variant: "link", size: "sm" })} href={connectorsHref}>
            Open Connectors
          </a>
        </StatusMessage>
      ) : null}
      {pendingMessage ? (
        <StatusMessage>
          {pendingMessage}{" "}
          <Button type="button" variant="outline" size="sm" onClick={() => void onCheckAgain()}>
            Check again
          </Button>
        </StatusMessage>
      ) : null}
      {failureMessage ? <StatusMessage tone="error">{failureMessage}</StatusMessage> : null}
      <Panel className="min-h-0 gap-0 overflow-hidden p-0">
        <SignalsTable
          groups={groups.groups}
          mappingAvailable={mappingAvailable}
          mutationGroupKey={mutationGroupKey}
          filingPending={filingPending}
          onFileIssue={onFileIssue}
        />
      </Panel>
      {groups.hasMore ? (
        <Button className="w-fit" type="button" variant="outline" onClick={onLoadMore}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function SignalsTable({
  groups,
  mappingAvailable,
  mutationGroupKey,
  filingPending,
  onFileIssue,
}: {
  groups: ProductReportGroup[];
  mappingAvailable: boolean;
  mutationGroupKey: string | undefined;
  filingPending: boolean;
  onFileIssue: (groupKey: string) => void;
}) {
  return (
    <Table className="min-w-[680px] table-fixed">
      <TableHeader className="bg-background">
        <TableRow className="hover:bg-background">
          <TableHead className="w-[52%] pl-4 text-xs text-muted-foreground">Cluster</TableHead>
          <TableHead className="w-[12%] text-xs text-muted-foreground">Reports</TableHead>
          <TableHead className="w-[18%] text-xs text-muted-foreground">Latest observed</TableHead>
          <TableHead className="w-[18%] pr-4 text-xs text-muted-foreground">GitHub issue</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const signal = describeSignal(group.explanation);
          return (
            <TableRow key={group.groupKey} className="bg-background hover:bg-muted/40">
              <TableCell className="h-[66px] overflow-hidden pl-4">
                {signal.operation ? (
                  <p className="truncate text-[13px] font-medium leading-5">
                    <span className="font-mono">{signal.operation}</span>
                    {signal.surface ? (
                      <span className="font-sans font-normal text-muted-foreground">
                        {" "}
                        on {signal.surface}
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="line-clamp-2 text-[13px] font-medium leading-5">
                    {signal.fallback}
                  </p>
                )}
                <p className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                  {signal.detail ? <span className="truncate">{signal.detail}</span> : null}
                </p>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {group.reportCount.toLocaleString()}
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                title={group.latestOccurredAt ? formatDate(group.latestOccurredAt) : undefined}
              >
                {group.latestOccurredAt ? relativeDate(group.latestOccurredAt) : "Not recorded"}
              </TableCell>
              <TableCell className="pr-4 text-xs">
                {group.githubIssue ? (
                  <a
                    href={group.githubIssue.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    <span className="truncate">
                      {group.githubIssue.repoFullName}#{group.githubIssue.issueNumber}
                    </span>
                    <IconArrowUpRight className="shrink-0" size={13} />
                  </a>
                ) : mappingAvailable ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={filingPending}
                    aria-busy={filingPending && mutationGroupKey === group.groupKey}
                    onClick={() => onFileIssue(group.groupKey)}
                  >
                    {filingPending && mutationGroupKey === group.groupKey
                      ? "Filing…"
                      : "File GitHub issue"}
                  </Button>
                ) : (
                  <span className="text-muted-foreground">Not linked</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function describeSignal(explanation: string) {
  const parts = explanation
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  const operation = parts.find((part) => part.startsWith("operation "))?.slice(10);
  if (!operation) {
    return {
      operation: null,
      surface: null,
      detail: null,
      fallback: explanation || "Related feedback reports",
    };
  }

  const surface = parts.find((part) => part.startsWith("surface "))?.slice(8);
  const finding = parts.find(
    (part) => part.includes("/") && !part.startsWith("product ") && !part.startsWith("operation "),
  );
  const statusClass = parts.find((part) => /^\dxx$/i.test(part));
  const findingLabel =
    finding && finding !== "none/none"
      ? finding
          .split("/")
          .map((part) => titleCase(part))
          .join(" / ")
      : null;

  return {
    operation,
    surface: surface ? interfaceLabel(surface) : null,
    detail: [findingLabel, statusClass ? `HTTP ${statusClass.toLowerCase()}` : null]
      .filter(Boolean)
      .join(" · "),
    fallback: explanation,
  };
}

function FeedbackTable({
  reports,
  selectedId,
  onSelect,
}: {
  reports: ProductFeedbackReport[];
  selectedId: string | null;
  onSelect: (reportId: string) => void;
}) {
  return (
    <Table className="min-w-[760px] table-fixed">
      <TableHeader className="bg-background">
        <TableRow className="hover:bg-background">
          <TableHead className="w-[44%] pl-4 text-xs text-muted-foreground">Feedback</TableHead>
          <TableHead className="w-[17%] text-xs text-muted-foreground">Impact</TableHead>
          <TableHead className="w-[17%] text-xs text-muted-foreground">Workflow</TableHead>
          <TableHead className="w-[12%] text-xs text-muted-foreground">Customer</TableHead>
          <TableHead className="w-[10%] pr-4 text-right text-xs text-muted-foreground">
            Received
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reports.map((report) => (
          <TableRow
            key={report.id}
            data-state={selectedId === report.id ? "selected" : undefined}
            aria-selected={selectedId === report.id}
            aria-label={`Open feedback: ${report.summary}`}
            tabIndex={0}
            className="cursor-pointer bg-background hover:bg-muted/40 data-[state=selected]:bg-selected data-[state=selected]:shadow-[inset_2px_0_0_var(--attention)]"
            onClick={() => onSelect(report.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(report.id);
              }
            }}
          >
            <TableCell className="h-[66px] overflow-hidden pl-4">
              <div className="min-w-0">
                <Button
                  variant="link"
                  className="h-auto max-w-full justify-start truncate p-0 text-[13px] font-medium leading-5"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(report.id);
                  }}
                >
                  {report.summary}
                </Button>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {report.operation} · {interfaceLabel(report.surface)}
                </p>
              </div>
            </TableCell>
            <TableCell>
              <ImpactLabel impact={report.impact} />
            </TableCell>
            <TableCell>
              <WorkflowBadge status={report.workflowStatus} />
            </TableCell>
            <TableCell className="truncate text-xs text-muted-foreground">
              {report.customerRef ?? "Not linked"}
            </TableCell>
            <TableCell
              className="pr-4 text-right text-xs text-muted-foreground"
              title={formatDate(report.createdAt)}
            >
              {relativeDate(report.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FeedbackInspector({
  open,
  reportId,
  report,
  loading,
  error,
  onRetry,
  onClose,
  data,
  openInteraction,
  openSession,
  refresh,
  setNotice,
}: {
  open: boolean;
  reportId: string | null;
  report: ProductFeedbackReport | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => unknown;
  onClose: () => void;
  data: DashboardData;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  return (
    <DetailRail open={open} onClose={onClose} label="Feedback detail">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <IconCirclePlaceholderOn size={14} />
          <span className="truncate font-mono">{report?.id ?? reportId}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Close detail" onClick={onClose}>
            <IconCrossSmall />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="grid gap-3 p-5">
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
          <Button className="w-fit" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : loading || !report ? (
        <p className="p-5 text-sm text-muted-foreground">Loading feedback…</p>
      ) : (
        <FeedbackDetailContent
          data={data}
          report={report}
          openInteraction={openInteraction}
          openSession={openSession}
          refresh={refresh}
          setNotice={setNotice}
        />
      )}
    </DetailRail>
  );
}

function FeedbackDetailContent({
  data,
  report,
  openInteraction,
  openSession,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  report: ProductFeedbackReport;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const findings = reportFindings(report);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-5">
        <section>
          <p className="text-xs text-muted-foreground">
            {report.customerRef ?? "Customer not linked"} · {formatDate(report.createdAt)}
          </p>
          <h2 className="mt-2 text-balance text-lg font-medium leading-6">{report.summary}</h2>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ImpactLabel impact={report.impact} />
            <WorkflowBadge status={report.workflowStatus} />
            {report.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        </section>

        <Separator className="my-5" />

        <section>
          <h3 className="text-xs font-medium">Findings ({findings.length})</h3>
          {findings.length ? (
            <div className="mt-3 grid gap-3">
              {findings.map((finding, index) => (
                <div
                  key={`${finding.topic ?? "finding"}-${finding.kind ?? "general"}-${finding.detail ?? index}`}
                  className="border-l-2 border-foreground/15 pl-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">
                      {titleCase(finding.topic ?? finding.kind ?? "Finding")}
                    </span>
                    {finding.severity ? (
                      <span className="text-[11px] text-muted-foreground">
                        {titleCase(finding.severity)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                    {finding.detail ?? "No detail provided."}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">No structured findings.</p>
          )}
        </section>

        {report.workaround ? (
          <>
            <Separator className="my-5" />
            <section>
              <h3 className="text-xs font-medium">
                {report.workaround.used ? "Workaround observed" : "No workaround used"}
              </h3>
              {report.workaround.detail ? (
                <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
                  {report.workaround.detail}
                </p>
              ) : null}
            </section>
          </>
        ) : null}

        <Separator className="my-5" />

        <section>
          <h3 className="text-xs font-medium">Source interaction</h3>
          <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-3 gap-y-3 text-xs">
            <Property label="Interface" value={interfaceLabel(report.surface)} />
            <Property label="Operation" value={report.operation} mono />
            <Property label="Duration" value={formatDuration(report.durationMs)} />
            <Property label="HTTP status" value={report.statusCode ?? "Not recorded"} />
            <Property label="Customer" value={report.customerRef ?? "Not linked"} />
            <Property
              label="Confirmed by"
              value={interfaceLabel(report.confirmationMethod ?? "unknown")}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openInteraction(report.interactionId)}
            >
              Open interaction
              <IconArrowUpRight data-icon="inline-end" />
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
        </section>

        <Separator className="my-5" />

        <section>
          <h3 className="text-xs font-medium">Team workflow</h3>
          <div className="mt-3">
            {isEditor(data.currentRole) ? (
              <WorkflowForm
                compact
                data={data}
                report={report}
                refresh={refresh}
                setNotice={setNotice}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                An owner or admin manages status, assignment, tags, and internal notes.
              </p>
            )}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}

function WorkflowBadge({ status }: { status: string }) {
  if (!isWorkflowStatus(status)) {
    return <Badge variant="outline">{titleCase(status)}</Badge>;
  }
  const StatusIcon = workflowIcons[status];
  return (
    <Badge variant={statusBadge[status]}>
      <StatusIcon data-icon="inline-start" />
      {workflowLabels[status]}
    </Badge>
  );
}

function ImpactLabel({ impact }: { impact: string | null }) {
  const value = impact ?? "unknown";
  const ImpactIcon = impactIcons[value] ?? IconCircleQuestionmark;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <ImpactIcon size={14} className={impactTone[value] ?? "text-muted-foreground"} />
      <span>{impactLabels[value] ?? titleCase(value)}</span>
    </span>
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
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate", mono && "font-mono")} title={String(value)}>
        {value}
      </dd>
    </>
  );
}

export function filterFeedbackReports(
  reports: ProductFeedbackReport[],
  {
    filters,
    query,
    range,
    now = Date.now(),
  }: {
    filters: FeedbackFiltersState;
    query: string;
    range: string;
    now?: number;
  },
) {
  const needle = query.trim().toLowerCase();
  const minimum =
    range === "7d" ? now - 7 * 86_400_000 : range === "30d" ? now - 30 * 86_400_000 : 0;

  return reports.filter((report) => {
    const findings = reportFindings(report);
    const workaround = report.workaround ? (report.workaround.used ? "used" : "suggested") : "none";
    const matches =
      (filters.status.length === 0 || filters.status.includes(report.workflowStatus)) &&
      (filters.impact.length === 0 || filters.impact.includes(report.impact ?? "unknown")) &&
      (filters.surface.length === 0 || filters.surface.includes(report.surface)) &&
      (filters.tag.length === 0 || filters.tag.some((tag) => report.tags.includes(tag))) &&
      (filters.assignee.length === 0 ||
        filters.assignee.includes(report.assigneeOsUserId ?? "unassigned")) &&
      (filters.workaround.length === 0 || filters.workaround.includes(workaround)) &&
      (filters.topic.length === 0 ||
        findings.some((finding) =>
          finding.topic ? filters.topic.includes(finding.topic) : false,
        )) &&
      (filters.kind.length === 0 ||
        findings.some((finding) => (finding.kind ? filters.kind.includes(finding.kind) : false))) &&
      (filters.severity.length === 0 ||
        findings.some((finding) =>
          finding.severity ? filters.severity.includes(finding.severity) : false,
        ));
    const searchable = [
      report.summary,
      report.operation,
      report.customerRef,
      report.surface,
      report.runtimeHint,
      report.workflowStatus,
      report.internalNote,
      report.workaround?.detail,
      ...report.tags,
      ...findings.flatMap((finding) => [
        finding.topic,
        finding.kind,
        finding.severity,
        finding.detail,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      matches &&
      (!needle || searchable.includes(needle)) &&
      new Date(report.createdAt).getTime() >= minimum
    );
  });
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return workflowStatuses.includes(value as WorkflowStatus);
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function feedbackFacetsFromReports(reports: ProductFeedbackReport[]): DashboardFeedbackFacets {
  const facet = (values: (report: ProductFeedbackReport) => Array<string | null | undefined>) => {
    const counts = new Map<string, number>();
    for (const report of reports) {
      for (const value of new Set(values(report).filter((item): item is string => Boolean(item)))) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  };

  return {
    status: facet((report) => [report.workflowStatus ?? "new"]),
    impact: facet((report) => [report.impact ?? "unknown"]),
    surface: facet((report) => [report.surface]),
    topic: facet((report) => reportFindings(report).map((finding) => finding.topic)),
    findingKind: facet((report) => reportFindings(report).map((finding) => finding.kind)),
    severity: facet((report) => reportFindings(report).map((finding) => finding.severity)),
    tag: facet((report) => report.tags),
    assignee: facet((report) => [report.assigneeOsUserId ?? "unassigned"]),
    workaround: facet((report) => [
      report.workaround ? (report.workaround.used ? "used" : "suggested") : "none",
    ]),
  };
}

function rangeStart(range: string): string | undefined {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : null;
  if (days === null) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function connectorsPath(workspaceId: string, productId: string): string {
  const params = new URLSearchParams({ view: "connectors", team: workspaceId, product: productId });
  return `/?${params}`;
}

function readFilterLocation(): {
  query: string;
  filters: FeedbackFiltersState;
  range: string;
} {
  if (typeof window === "undefined") {
    return { query: "", filters: createEmptyFilters(), range: defaultRange };
  }
  const params = new URL(window.location.href).searchParams;
  const filters = createEmptyFilters();
  for (const facet of facetOrder) filters[facet] = params.getAll(facet).filter(Boolean);
  return {
    query: params.get("q") ?? "",
    filters,
    range: params.get("range") ?? defaultRange,
  };
}

function writeFilterLocation(query: string, filters: FeedbackFiltersState, range: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (query.trim()) url.searchParams.set("q", query.trim());
  else url.searchParams.delete("q");
  for (const facet of facetOrder) {
    url.searchParams.delete(facet);
    for (const value of filters[facet]) url.searchParams.append(facet, value);
  }
  if (range === defaultRange) url.searchParams.delete("range");
  else url.searchParams.set("range", range);
  window.history.replaceState(window.history.state, "", url);
}
