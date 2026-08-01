"use client";

import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";

import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import { OutcomeHealth } from "@/components/dashboard/intelligence-badges";
import { MetricStrip } from "@/components/dashboard/metric-strip";
import { SignalEvidenceList } from "@/components/dashboard/signal-evidence-list";
import { EmptyState, ErrorState, NativeSelect } from "@/components/dashboard/view-primitives";
import { Badge } from "@/components/ui/badge";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  type FeatureDetail,
  type FeatureSummary,
  fetchFeatureDetail,
  fetchFeaturesPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";
import { fileGroupGithubIssue } from "@/lib/api/groups";
import { formatDate, isEditor, relativeDate, titleCase } from "@/lib/dashboard/format";

type FeatureFilters = {
  signalType: string;
  impact: string;
  status: string;
  segment: string;
  range: "all" | "7d" | "30d";
};

const emptyFilters: FeatureFilters = {
  signalType: "",
  impact: "",
  status: "",
  segment: "",
  range: "30d",
};

function readFeatureLocation() {
  if (typeof window === "undefined") return { query: "", filters: emptyFilters };
  const params = new URL(window.location.href).searchParams;
  const range = params.get("featureRange");
  return {
    query: params.get("featureQ") ?? "",
    filters: {
      signalType: params.get("featureSignal") ?? "",
      impact: params.get("featureImpact") ?? "",
      status: params.get("featureStatus") ?? "",
      segment: params.get("featureSegment") ?? "",
      range: range === "all" || range === "7d" ? range : "30d",
    } satisfies FeatureFilters,
  };
}

function writeFeatureLocation(query: string, filters: FeatureFilters) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setParam(url, "featureQ", query);
  setParam(url, "featureSignal", filters.signalType);
  setParam(url, "featureImpact", filters.impact);
  setParam(url, "featureStatus", filters.status);
  setParam(url, "featureSegment", filters.segment);
  setParam(url, "featureRange", filters.range === "30d" ? "" : filters.range);
  window.history.replaceState(window.history.state, "", url);
}

function setParam(url: URL, key: string, value: string) {
  if (value.trim()) url.searchParams.set(key, value.trim());
  else url.searchParams.delete(key);
}

function rangeStart(range: FeatureFilters["range"]) {
  if (range === "all") return undefined;
  return new Date(Date.now() - (range === "7d" ? 7 : 30) * 86_400_000).toISOString();
}

export function FeaturesView({
  data,
  selectedFeatureKey,
  selectFeature,
  openCustomer,
  openFeedback,
  openInteraction,
  openSession,
  refresh,
  setNotice,
}: {
  data: DashboardData;
  selectedFeatureKey: string | null;
  selectFeature: (featureKey: string | null) => void;
  openCustomer: (customerId: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const initial = useMemo(readFeatureLocation, []);
  const [query, setQuery] = useState(initial.query);
  const [filters, setFilters] = useState<FeatureFilters>(initial.filters);
  const debouncedQuery = useDebouncedValue(query, 250);
  const settling = query.trim() !== debouncedQuery.trim();
  const productId = data.currentProduct?.id;
  const pages = useInfiniteQuery({
    queryKey: ["features", data.workspace.id, productId, debouncedQuery, filters],
    queryFn: ({ pageParam }) =>
      fetchFeaturesPage(data.workspace.id, {
        productId: productId ?? "",
        q: debouncedQuery.trim() || undefined,
        signalType: filters.signalType ? [filters.signalType] : undefined,
        impact: filters.impact ? [filters.impact] : undefined,
        status: filters.status ? [filters.status] : undefined,
        segment: filters.segment ? [filters.segment] : undefined,
        since: rangeStart(filters.range),
        limit: 50,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(productId),
  });
  const features = settling ? [] : (pages.data?.pages.flatMap((page) => page.features) ?? []);
  const firstPage = pages.data?.pages[0];
  const rollup = firstPage?.rollup ?? {
    features: 0,
    affectedCustomers: 0,
    evidence: 0,
    blocking: 0,
  };
  const facets = firstPage?.facets;
  const detail = useQuery({
    queryKey: ["feature", data.workspace.id, productId, selectedFeatureKey],
    queryFn: () => fetchFeatureDetail(data.workspace.id, productId ?? "", selectedFeatureKey ?? ""),
    enabled: Boolean(productId && selectedFeatureKey),
  });
  const filing = useMutation({
    mutationFn: (groupKey: string) => fileGroupGithubIssue(data.workspace.id, groupKey),
    onSuccess: async () => {
      setNotice("GitHub issue filed from this feature's evidence.");
      await Promise.all([detail.refetch(), pages.refetch()]);
    },
  });

  useEffect(() => writeFeatureLocation(query, filters), [filters, query]);
  useEffect(() => {
    const restore = () => {
      const restored = readFeatureLocation();
      setQuery(restored.query);
      setFilters(restored.filters);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  function applyFilters(next: FeatureFilters) {
    setFilters(next);
    writeFeatureLocation(query, next);
  }

  return (
    <DetailWorkspace
      open={Boolean(selectedFeatureKey)}
      className="bg-background"
      inspector={
        selectedFeatureKey ? (
          <FeatureInspector
            requestedKey={selectedFeatureKey}
            detail={detail.data}
            error={detail.isError ? detail.error : null}
            close={() => selectFeature(null)}
            retry={() => detail.refetch()}
            canEdit={isEditor(data.currentRole)}
            filing={filing.isPending}
            filingError={filing.error}
            fileIssue={() => {
              const groupKey = detail.data?.feature.groupKey;
              if (groupKey) filing.mutate(groupKey);
            }}
            openCustomer={openCustomer}
            openFeedback={openFeedback}
            openInteraction={openInteraction}
            openSession={openSession}
          />
        ) : null
      }
    >
      <MetricStrip
        items={[
          {
            label: "Needs and opportunities",
            value: rollup.features.toLocaleString(),
            signal: true,
          },
          { label: "Customers affected", value: rollup.affectedCustomers.toLocaleString() },
          { label: "Evidence", value: rollup.evidence.toLocaleString() },
          { label: "Blocking", value: rollup.blocking.toLocaleString() },
        ]}
      />
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <InputGroup className="max-w-xl bg-background">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search features"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search needs, friction, workarounds, or alternatives"
          />
        </InputGroup>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <FeatureSelect
            label="Signal"
            value={filters.signalType}
            options={facets?.signalType ?? []}
            onChange={(signalType) => applyFilters({ ...filters, signalType })}
          />
          <FeatureSelect
            label="Impact"
            value={filters.impact}
            options={facets?.impact ?? []}
            onChange={(impact) => applyFilters({ ...filters, impact })}
          />
          <FeatureSelect
            label="Status"
            value={filters.status}
            options={facets?.status ?? []}
            onChange={(status) => applyFilters({ ...filters, status })}
          />
          <FeatureSelect
            label="Segment"
            value={filters.segment}
            options={facets?.segment ?? []}
            onChange={(segment) => applyFilters({ ...filters, segment })}
          />
          <NativeSelect
            aria-label="Feature evidence range"
            className="w-auto min-w-32"
            value={filters.range}
            onChange={(event) =>
              applyFilters({ ...filters, range: event.target.value as FeatureFilters["range"] })
            }
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All retained</option>
          </NativeSelect>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void Promise.all([refresh(), pages.refetch()])}
          >
            Refresh
          </Button>
        </div>
      </div>
      <section className="min-h-0 flex-1 overflow-auto" aria-label="Features">
        {pages.isError ? (
          <div className="p-4 text-sm text-destructive" role="alert">
            Features could not be loaded. Use Refresh to try again.
          </div>
        ) : pages.isPending || settling ? (
          <p className="p-4 text-sm text-muted-foreground" role="status">
            Loading features…
          </p>
        ) : features.length ? (
          <Table className="min-w-[920px] table-fixed">
            <TableHeader className="sticky top-0 z-[1] bg-background">
              <TableRow className="hover:bg-background">
                <TableHead className="h-9 w-[34%] pl-5 text-xs">Need or opportunity</TableHead>
                <TableHead className="h-9 w-[14%] text-xs">Customers</TableHead>
                <TableHead className="h-9 w-[13%] text-xs">Evidence</TableHead>
                <TableHead className="h-9 w-[13%] text-xs">Impact</TableHead>
                <TableHead className="h-9 w-[12%] text-xs">Trend</TableHead>
                <TableHead className="h-9 w-[14%] pr-5 text-right text-xs">Last observed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {features.map((feature) => (
                <FeatureRow
                  key={feature.key}
                  feature={feature}
                  selected={selectedFeatureKey === feature.key}
                  open={() => selectFeature(feature.key)}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="h-full bg-canvas p-4">
            <EmptyState
              title={rollup.features ? "No matching features" : "No customer needs yet"}
              description={
                rollup.features
                  ? "Clear filters or broaden the evidence window."
                  : "Evidence-backed feature needs, friction, alternatives, and workarounds will appear here."
              }
            />
          </div>
        )}
      </section>
      {features.length ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <p>
            Showing {features.length.toLocaleString()} features. Counts cover retained evidence.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!pages.hasNextPage || pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage
              ? "Loading…"
              : pages.hasNextPage
                ? "Load 50 more"
                : "All loaded"}
          </Button>
        </div>
      ) : null}
    </DetailWorkspace>
  );
}

function FeatureSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { name: string; count: number }[];
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect
      aria-label={`${label} filter`}
      className="w-auto min-w-28"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">All {label.toLowerCase()}</option>
      {options.map((option) => (
        <option key={option.name} value={option.name}>
          {titleCase(option.name)} ({option.count})
        </option>
      ))}
    </NativeSelect>
  );
}

function FeatureRow({
  feature,
  selected,
  open,
}: {
  feature: FeatureSummary;
  selected: boolean;
  open: () => void;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      aria-selected={selected}
      aria-label={`Open feature ${feature.title}`}
      tabIndex={0}
      className="cursor-pointer bg-background hover:bg-muted/40 data-[state=selected]:bg-selected data-[state=selected]:shadow-[inset_2px_0_0_var(--attention)]"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <TableCell className="h-[66px] overflow-hidden pl-5">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start truncate p-0 text-[13px] font-medium"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          {feature.title}
        </Button>
        <p className="mt-1 truncate text-xs text-muted-foreground">{feature.summary}</p>
      </TableCell>
      <TableCell className="text-xs">{feature.affectedCustomerCount}</TableCell>
      <TableCell className="text-xs">{feature.evidenceCount}</TableCell>
      <TableCell>
        <OutcomeHealth value={feature.strongestImpact} />
      </TableCell>
      <TableCell className="text-xs">
        {feature.trend === null ? "—" : `${feature.trend > 0 ? "+" : ""}${feature.trend}%`}
      </TableCell>
      <TableCell
        className="pr-5 text-right text-xs text-muted-foreground"
        title={formatDate(feature.lastObservedAt)}
      >
        {relativeDate(feature.lastObservedAt)}
      </TableCell>
    </TableRow>
  );
}

function FeatureInspector({
  requestedKey,
  detail,
  error,
  close,
  retry,
  canEdit,
  filing,
  filingError,
  fileIssue,
  openCustomer,
  openFeedback,
  openInteraction,
  openSession,
}: {
  requestedKey: string;
  detail?: FeatureDetail;
  error: Error | null;
  close: () => void;
  retry: () => Promise<unknown>;
  canEdit: boolean;
  filing: boolean;
  filingError: Error | null;
  fileIssue: () => void;
  openCustomer: (customerId: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  return (
    <DetailRail open onClose={close} label="Feature detail">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {detail?.feature.key ?? requestedKey}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close feature detail" onClick={close}>
          <IconCrossSmall />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-5">
          {error ? (
            <ErrorState error={error} onRetry={() => void retry()} />
          ) : detail ? (
            <FeatureDetailContent
              detail={detail}
              canEdit={canEdit}
              filing={filing}
              filingError={filingError}
              fileIssue={fileIssue}
              openCustomer={openCustomer}
              openFeedback={openFeedback}
              openInteraction={openInteraction}
              openSession={openSession}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Loading feature…
            </p>
          )}
        </div>
      </ScrollArea>
    </DetailRail>
  );
}

function FeatureDetailContent({
  detail,
  canEdit,
  filing,
  filingError,
  fileIssue,
  openCustomer,
  openFeedback,
  openInteraction,
  openSession,
}: {
  detail: FeatureDetail;
  canEdit: boolean;
  filing: boolean;
  filingError: Error | null;
  fileIssue: () => void;
  openCustomer: (customerId: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  const feature = detail.feature;
  return (
    <>
      <p className="text-xs text-muted-foreground">Need or opportunity</p>
      <h2 className="mt-2 text-balance text-lg font-medium leading-6">{feature.title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.summary}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <OutcomeHealth value={feature.strongestImpact} />
        <Badge variant="outline">{titleCase(feature.status)}</Badge>
        {feature.signalTypes.map((type) => (
          <Badge key={type} variant="secondary">
            {titleCase(type)}
          </Badge>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {feature.affectedCustomerCount} affected customers · {feature.evidenceCount} evidence items
      </p>

      <Separator className="my-5" />
      <section aria-labelledby="feature-evidence-heading">
        <h3 id="feature-evidence-heading" className="text-xs font-medium">
          Underlying evidence
        </h3>
        <div className="mt-3">
          <SignalEvidenceList
            signals={detail.signals}
            openFeedback={openFeedback}
            openInteraction={openInteraction}
            openSession={openSession}
          />
        </div>
      </section>

      <Separator className="my-5" />
      <section aria-labelledby="affected-customers-heading">
        <h3 id="affected-customers-heading" className="text-xs font-medium">
          Affected customers
        </h3>
        {detail.customers.length ? (
          <ol className="mt-3 divide-y">
            {detail.customers.map((customer) => (
              <li key={customer.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{customer.displayName}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {titleCase(customer.identityLevel)} · {titleCase(customer.outcomeHealth)}
                  </p>
                </div>
                <Button variant="outline" size="xs" onClick={() => openCustomer(customer.id)}>
                  Open
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Evidence is not linked to a durable customer yet.
          </p>
        )}
      </section>

      {detail.sessions.length ? (
        <>
          <Separator className="my-5" />
          <section aria-labelledby="feature-sessions-heading">
            <h3 id="feature-sessions-heading" className="text-xs font-medium">
              Related sessions
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {detail.sessions.slice(0, 8).map((session) => (
                <Button
                  key={session.id}
                  variant="outline"
                  size="sm"
                  onClick={() => openSession(session.id)}
                >
                  {session.refHint}
                </Button>
              ))}
            </div>
          </section>
        </>
      ) : null}

      <Separator className="my-5" />
      <section aria-labelledby="feature-workflow-heading">
        <h3 id="feature-workflow-heading" className="text-xs font-medium">
          Team workflow
        </h3>
        {feature.githubIssue ? (
          <a
            className="mt-3 inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
            href={feature.githubIssue.url}
            target="_blank"
            rel="noreferrer"
          >
            {feature.githubIssue.repoFullName}#{feature.githubIssue.issueNumber}
            <IconArrowUpRight size={14} />
          </a>
        ) : canEdit && feature.groupKey ? (
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            disabled={filing}
            onClick={fileIssue}
          >
            {filing ? "Filing…" : "File GitHub issue"}
          </Button>
        ) : canEdit ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This feature has no feedback report group to file yet.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            An owner or admin can connect this evidence to the team workflow.
          </p>
        )}
        {filingError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {filingError.message}
          </p>
        ) : null}
      </section>
    </>
  );
}
