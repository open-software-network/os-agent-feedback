"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import {
  EmptyState,
  NativeSelect,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
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
import { ApiError, apiRequest } from "@/lib/api/client";
import { fetchProductGithubRepo } from "@/lib/api/connectors";
import type {
  DashboardData,
  DashboardReportResponse,
  ProductFeedbackReport,
} from "@/lib/api/dashboard";
import {
  fetchProductGroupsWindow,
  fileGroupGithubIssue,
  type MergeReportGroupsResponse,
  mergeReportGroups,
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
  const initialLocation = useMemo(readFilterLocation, []);
  const [query, setQuery] = useState(initialLocation.query);
  const [filters, setFilters] = useState<FeedbackFiltersState>(initialLocation.filters);
  const [range, setRange] = useState(initialLocation.range);
  const [mode, setMode] = useState<FeedbackMode>("reports");
  const [groupLimit, setGroupLimit] = useState(groupsPageSize);
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
  const merging = useMutation({
    mutationFn: ({ sourceGroupKey, intoGroupKey }: MergeRequest) =>
      mergeReportGroups(data.workspace.id, sourceGroupKey, { intoGroupKey }),
    onSuccess: () => groups.refetch(),
  });
  const resetMerging = merging.reset;
  const previousMergeContext = useRef({
    mode,
    productId,
    workspaceId: data.workspace.id,
  });

  useEffect(() => {
    const previous = previousMergeContext.current;
    if (
      previous.mode !== mode ||
      previous.productId !== productId ||
      previous.workspaceId !== data.workspace.id
    ) {
      resetMerging();
    }
    previousMergeContext.current = { mode, productId, workspaceId: data.workspace.id };
  }, [data.workspace.id, mode, productId, resetMerging]);

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
    const findings = data.reports.flatMap(reportFindings);
    const memberNames = new Map(
      data.teamMembers.map((member) => [member.osUserId, member.displayName]),
    );
    const assignedIds = unique(data.reports.map((report) => report.assigneeOsUserId));
    const assigneeIds = unique([
      ...data.teamMembers.map((member) => member.osUserId),
      ...assignedIds,
    ]);

    return {
      status: workflowStatuses.map((value) => ({ value, label: workflowLabels[value] })),
      impact: impactValues.map((value) => ({ value, label: impactLabels[value] })),
      surface: unique(data.reports.map((report) => report.surface)).map((value) => ({
        value,
        label: interfaceLabel(value),
      })),
      topic: unique(findings.map((finding) => finding.topic)).map((value) => ({
        value,
        label: titleCase(value),
      })),
      kind: unique(findings.map((finding) => finding.kind)).map((value) => ({
        value,
        label: titleCase(value),
      })),
      severity: unique(findings.map((finding) => finding.severity)).map((value) => ({
        value,
        label: titleCase(value),
      })),
      tag: unique(data.reports.flatMap((report) => report.tags)).map((value) => ({
        value,
        label: value,
      })),
      assignee: [
        { value: "unassigned", label: "Unassigned" },
        ...assigneeIds.map((value) => ({ value, label: memberNames.get(value) ?? value })),
      ],
      workaround: [
        { value: "used", label: "Observed" },
        { value: "suggested", label: "Suggested" },
        { value: "none", label: "None recorded" },
      ],
    };
  }, [data.reports, data.teamMembers]);

  const filteredReports = useMemo(
    () => filterFeedbackReports(data.reports, { filters, query, range }),
    [data.reports, filters, query, range],
  );

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
    await refresh();
    if (!loadedReport) await detail.refetch();
  }

  async function refreshView() {
    await refresh();
    if (mode === "signals" && productId && isEditor(data.currentRole)) {
      await groups.refetch();
    }
  }

  function selectMode(nextMode: FeedbackMode) {
    setMode(nextMode);
    if (nextMode === "signals") selectReport(null);
  }

  const incomplete = data.listState.reportsLoaded < data.listState.reportsTotal;

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

          {incomplete ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
              <p>
                Showing the newest {data.listState.reportsLoaded.toLocaleString()} of{" "}
                {data.listState.reportsTotal.toLocaleString()} reports. Filters apply to loaded
                reports.
              </p>
              <Button variant="outline" size="sm" onClick={loadMore}>
                Load 250 more
              </Button>
            </div>
          ) : null}

          {filteredReports.length ? (
            <section
              className="min-h-0 flex-1 overflow-auto bg-background"
              aria-label="Feedback reports"
            >
              <FeedbackTable
                reports={filteredReports}
                selectedId={selectedReportId}
                onSelect={selectReport}
              />
            </section>
          ) : (
            <div className="min-h-0 flex-1 bg-canvas p-4">
              <EmptyState
                title="No matching feedback"
                description="Try a wider filter or wait for agents to submit feedback."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setRange(defaultRange);
                      commitFilters(createEmptyFilters());
                    }}
                  >
                    Clear filters
                  </Button>
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
            onFileIssue={(groupKey) => filing.mutate(groupKey)}
            onCheckAgain={async () => {
              await groups.refetch();
              filing.reset();
            }}
            mergePendingSource={merging.variables?.sourceGroupKey}
            mergePending={merging.isPending}
            mergeError={merging.error}
            mergeResult={merging.data}
            onBeginMerge={() => {
              if (!merging.isPending) merging.reset();
            }}
            onMerge={(sourceGroupKey, intoGroupKey) => {
              merging.reset();
              merging.mutate({ sourceGroupKey, intoGroupKey });
            }}
            onCheckMergeAgain={async () => {
              await groups.refetch();
              merging.reset();
            }}
            onLoadMore={() => {
              filing.reset();
              merging.reset();
              setGroupLimit((current) => current + groupsPageSize);
            }}
            onRetry={() => Promise.all([groups.refetch(), mapping.refetch()])}
          />
        </TabsPanel>
      </Tabs>
    </DetailWorkspace>
  );
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
  onFileIssue,
  onCheckAgain,
  mergePendingSource,
  mergePending,
  mergeError,
  mergeResult,
  onBeginMerge,
  onMerge,
  onCheckMergeAgain,
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
  onFileIssue: (groupKey: string) => void;
  onCheckAgain: () => Promise<void>;
  mergePendingSource: string | undefined;
  mergePending: boolean;
  mergeError: Error | null;
  mergeResult: MergeReportGroupsResponse | undefined;
  onBeginMerge: () => void;
  onMerge: (sourceGroupKey: string, intoGroupKey: string) => void;
  onCheckMergeAgain: () => Promise<void>;
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

  const pendingMessage =
    filingError instanceof ApiError && filingError.status === 409 ? filingError.message : null;
  const failureMessage = filingError && !pendingMessage ? filingError.message : null;
  const mergeConflictMessage =
    mergeError instanceof ApiError && mergeError.status === 409 ? mergeError.message : null;
  const mergeFailureMessage = mergeError && !mergeConflictMessage ? mergeError.message : null;

  return (
    <div className="grid gap-3">
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
          GitHub issue filing for{" "}
          <span className="font-mono">{mutationGroupKey ?? "unknown group"}</span>: {pendingMessage}{" "}
          <Button type="button" variant="outline" size="sm" onClick={() => void onCheckAgain()}>
            Check again
          </Button>
        </StatusMessage>
      ) : null}
      {failureMessage ? (
        <StatusMessage tone="error">
          GitHub issue filing for{" "}
          <span className="font-mono">{mutationGroupKey ?? "unknown group"}</span>: {failureMessage}
        </StatusMessage>
      ) : null}
      {mergeConflictMessage ? (
        <StatusMessage>
          Merge source <span className="font-mono">{mergePendingSource ?? "unknown group"}</span>:{" "}
          {mergeConflictMessage}{" "}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onCheckMergeAgain()}
          >
            Check again
          </Button>
        </StatusMessage>
      ) : null}
      {mergeFailureMessage ? (
        <StatusMessage tone="error">
          Merge source <span className="font-mono">{mergePendingSource ?? "unknown group"}</span>:{" "}
          {mergeFailureMessage}
        </StatusMessage>
      ) : null}
      {mergeResult ? (
        <StatusMessage>
          Merged away <span className="font-mono">{mergePendingSource ?? "unknown group"}</span> and
          moved {mergeResult.reportsMoved.toLocaleString()} reports into{" "}
          <span className="font-mono">{mergeResult.targetGroupKey}</span>, which survives.
        </StatusMessage>
      ) : null}
      {groups.groups.length ? (
        <Panel className="min-h-0 gap-0 overflow-hidden p-0">
          <SignalsTable
            groups={groups.groups}
            mappingAvailable={mappingAvailable}
            mutationGroupKey={mutationGroupKey}
            filingPending={filingPending}
            onFileIssue={onFileIssue}
            mergePendingSource={mergePendingSource}
            mergePending={mergePending}
            onBeginMerge={onBeginMerge}
            onMerge={onMerge}
          />
        </Panel>
      ) : (
        <EmptyState
          title="No signals yet"
          description="Related reports will appear here once recurring feedback is detected."
        />
      )}
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
  mergePendingSource,
  mergePending,
  onBeginMerge,
  onMerge,
}: {
  groups: ProductReportGroup[];
  mappingAvailable: boolean;
  mutationGroupKey: string | undefined;
  filingPending: boolean;
  onFileIssue: (groupKey: string) => void;
  mergePendingSource: string | undefined;
  mergePending: boolean;
  onBeginMerge: () => void;
  onMerge: (sourceGroupKey: string, intoGroupKey: string) => void;
}) {
  const [mergeSourceGroupKey, setMergeSourceGroupKey] = useState<string | null>(null);
  const [intoGroupKey, setIntoGroupKey] = useState("");

  useEffect(() => {
    const listedGroupKeys = new Set(groups.map((group) => group.groupKey));
    if (mergeSourceGroupKey && !listedGroupKeys.has(mergeSourceGroupKey)) {
      setMergeSourceGroupKey(null);
      setIntoGroupKey("");
    } else if (intoGroupKey && !listedGroupKeys.has(intoGroupKey)) {
      setIntoGroupKey("");
    }
  }, [groups, intoGroupKey, mergeSourceGroupKey]);

  return (
    <Table className="min-w-[680px] table-fixed">
      <TableHeader className="bg-background">
        <TableRow className="hover:bg-background">
          <TableHead className="w-[44%] pl-4 text-xs text-muted-foreground">Signal</TableHead>
          <TableHead className="w-[10%] text-xs text-muted-foreground">Reports</TableHead>
          <TableHead className="w-[16%] text-xs text-muted-foreground">Latest observed</TableHead>
          <TableHead className="w-[20%] text-xs text-muted-foreground">GitHub issue</TableHead>
          <TableHead className="w-[10%] px-1 pr-2 text-right text-xs text-muted-foreground">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const signal = describeSignal(group.explanation);
          const mergeExpanded = mergeSourceGroupKey === group.groupKey;
          const mergePendingForRow = mergePending && mergePendingSource === group.groupKey;
          const selectedTarget = groups.find((target) => target.groupKey === intoGroupKey);
          const invalidTarget =
            !selectedTarget ||
            selectedTarget.groupKey === group.groupKey ||
            Boolean(group.githubIssue && selectedTarget.githubIssue);
          return (
            <Fragment key={group.groupKey}>
              <TableRow className="bg-background hover:bg-muted/40">
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
                    <span className="truncate font-mono">{group.groupKey}</span>
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
                <TableCell className="text-xs">
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
                <TableCell className="px-1 pr-2 text-right text-xs">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={mergeExpanded}
                    aria-label={
                      mergeExpanded
                        ? `Cancel merge of signal ${group.groupKey}`
                        : `Merge signal ${group.groupKey}`
                    }
                    disabled={mergePendingForRow && !mergeExpanded}
                    onClick={() => {
                      if (mergeExpanded) {
                        setMergeSourceGroupKey(null);
                        setIntoGroupKey("");
                      } else {
                        onBeginMerge();
                        setMergeSourceGroupKey(group.groupKey);
                        setIntoGroupKey("");
                      }
                    }}
                  >
                    {mergeExpanded ? "Cancel" : "Merge"}
                  </Button>
                </TableCell>
              </TableRow>
              {mergeExpanded ? (
                <TableRow className="bg-background hover:bg-background">
                  <TableCell colSpan={5} className="p-4">
                    <form
                      className="grid gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (invalidTarget || !selectedTarget) return;
                        onMerge(group.groupKey, selectedTarget.groupKey);
                      }}
                    >
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="outline">Merged away</Badge>
                        <span className="font-mono">{group.groupKey}</span>
                        <span className="text-muted-foreground">will disappear.</span>
                        <Badge variant="secondary">Survives</Badge>
                        <span className="font-mono">{intoGroupKey || "Choose a target below"}</span>
                        <span className="text-muted-foreground">
                          will absorb the source reports.
                        </span>
                      </p>
                      <div className="flex flex-wrap items-end gap-2">
                        <label
                          htmlFor={`merge-target-${group.groupKey}`}
                          className="grid min-w-[280px] flex-1 gap-1 text-xs font-medium"
                        >
                          Signal that survives
                          <NativeSelect
                            id={`merge-target-${group.groupKey}`}
                            aria-label={`Signal that survives merge of ${group.groupKey}`}
                            value={intoGroupKey}
                            disabled={mergePendingForRow}
                            onChange={(event) => setIntoGroupKey(event.target.value)}
                          >
                            <option value="">Choose the signal that survives</option>
                            {groups
                              .filter((target) => target.groupKey !== group.groupKey)
                              .map((target) => {
                                const bothHaveIssues = Boolean(
                                  group.githubIssue && target.githubIssue,
                                );
                                return (
                                  <option
                                    key={target.groupKey}
                                    value={target.groupKey}
                                    disabled={bothHaveIssues}
                                  >
                                    {target.groupKey}
                                    {bothHaveIssues
                                      ? " (unavailable: both signals have GitHub issues)"
                                      : target.githubIssue
                                        ? " (has a GitHub issue)"
                                        : ""}
                                  </option>
                                );
                              })}
                          </NativeSelect>
                        </label>
                        <Button type="submit" disabled={mergePending || invalidTarget}>
                          {mergePendingForRow
                            ? "Merging…"
                            : intoGroupKey
                              ? `Merge away into ${intoGroupKey}`
                              : "Choose a surviving signal"}
                        </Button>
                      </div>
                    </form>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

type MergeRequest = {
  sourceGroupKey: string;
  intoGroupKey: string;
};

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
            tabIndex={0}
            className="cursor-pointer bg-background hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-selected data-[state=selected]:shadow-[inset_2px_0_0_var(--attention)]"
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
                <p className="truncate text-[13px] font-medium leading-5">{report.summary}</p>
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
                {report.workaround.used ? "Workaround observed" : "Suggested workaround"}
              </h3>
              <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
                {report.workaround.detail ?? "No detail provided."}
              </p>
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
