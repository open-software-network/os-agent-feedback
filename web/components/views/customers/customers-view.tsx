"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import {
  ConsentBadge,
  IdentityBadge,
  identityLabel,
  ProvenanceBadge,
} from "@/components/dashboard/intelligence-badges";
import { MetricStrip } from "@/components/dashboard/metric-strip";
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
  type CustomerDetail,
  type CustomerSignal,
  type CustomerSummary,
  fetchCustomerDetail,
  fetchCustomersPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";
import { formatDate, relativeDate, titleCase } from "@/lib/dashboard/format";

type CustomerFilters = {
  identityLevel: string;
  consentState: string;
  signalType: string;
  range: "all" | "7d" | "30d";
};

const emptyFilters: CustomerFilters = {
  identityLevel: "",
  consentState: "",
  signalType: "",
  range: "30d",
};

function readCustomerLocation() {
  if (typeof window === "undefined") return { query: "", filters: emptyFilters };
  const params = new URL(window.location.href).searchParams;
  const range = params.get("customerRange");
  return {
    query: params.get("customerQ") ?? "",
    filters: {
      identityLevel: params.get("customerIdentity") ?? "",
      consentState: params.get("customerConsent") ?? "",
      signalType: params.get("customerSignal") ?? "",
      range: range === "all" || range === "7d" ? range : "30d",
    } satisfies CustomerFilters,
  };
}

function writeCustomerLocation(query: string, filters: CustomerFilters) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setParam(url, "customerQ", query);
  setParam(url, "customerIdentity", filters.identityLevel);
  setParam(url, "customerConsent", filters.consentState);
  setParam(url, "customerSignal", filters.signalType);
  setParam(url, "customerRange", filters.range === "30d" ? "" : filters.range);
  window.history.replaceState(window.history.state, "", url);
}

function setParam(url: URL, key: string, value: string) {
  if (value.trim()) url.searchParams.set(key, value.trim());
  else url.searchParams.delete(key);
}

function rangeStart(range: CustomerFilters["range"]) {
  if (range === "all") return undefined;
  const days = range === "7d" ? 7 : 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function customerFilterCount(filters: CustomerFilters) {
  return [
    filters.identityLevel,
    filters.consentState,
    filters.signalType,
    filters.range === "30d" ? "" : filters.range,
  ].filter(Boolean).length;
}

export function CustomersView({
  data,
  selectedCustomerId,
  selectCustomer,
  openFeature,
  openFeedback,
  openInteraction,
  openSession,
  refresh,
}: {
  data: DashboardData;
  selectedCustomerId: string | null;
  selectCustomer: (customerId: string | null) => void;
  openFeature: (featureKey: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const initial = useMemo(readCustomerLocation, []);
  const [query, setQuery] = useState(initial.query);
  const [filters, setFilters] = useState<CustomerFilters>(initial.filters);
  const debouncedQuery = useDebouncedValue(query, 250);
  const productId = data.currentProduct?.id;
  const settling = query.trim() !== debouncedQuery.trim();
  const pages = useInfiniteQuery({
    queryKey: ["customers", data.workspace.id, productId, debouncedQuery, filters],
    queryFn: ({ pageParam }) =>
      fetchCustomersPage(data.workspace.id, {
        productId: productId ?? "",
        q: debouncedQuery.trim() || undefined,
        identityLevel: filters.identityLevel ? [filters.identityLevel] : undefined,
        consentState: filters.consentState ? [filters.consentState] : undefined,
        signalType: filters.signalType ? [filters.signalType] : undefined,
        since: rangeStart(filters.range),
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(productId),
  });
  const customers = settling ? [] : (pages.data?.pages.flatMap((page) => page.customers) ?? []);
  const firstPage = pages.data?.pages[0];
  const rollup = firstPage?.rollup ?? {
    customers: 0,
    verified: 0,
    pseudonymous: 0,
    ephemeral: 0,
    unclassified: 0,
    active: 0,
    atRisk: 0,
  };
  const facets = firstPage?.facets;
  const detail = useQuery({
    queryKey: ["customer", data.workspace.id, productId, selectedCustomerId],
    queryFn: () =>
      fetchCustomerDetail(data.workspace.id, productId ?? "", selectedCustomerId ?? ""),
    enabled: Boolean(productId && selectedCustomerId),
  });

  useEffect(() => writeCustomerLocation(query, filters), [filters, query]);
  useEffect(() => {
    const restore = () => {
      const restored = readCustomerLocation();
      setQuery(restored.query);
      setFilters(restored.filters);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  function applyFilters(next: CustomerFilters) {
    setFilters(next);
    writeCustomerLocation(query, next);
  }

  return (
    <DetailWorkspace
      open={Boolean(selectedCustomerId)}
      className="bg-background"
      inspector={
        selectedCustomerId ? (
          <CustomerInspector
            requestedId={selectedCustomerId}
            detail={detail.data}
            error={detail.isError ? detail.error : null}
            close={() => selectCustomer(null)}
            retry={() => detail.refetch()}
            openFeature={openFeature}
            openFeedback={openFeedback}
            openInteraction={openInteraction}
            openSession={openSession}
          />
        ) : null
      }
    >
      <MetricStrip
        items={[
          { label: "Customers", value: rollup.customers.toLocaleString(), signal: true },
          { label: "Known", value: rollup.verified.toLocaleString() },
          { label: "Anonymous", value: rollup.pseudonymous.toLocaleString() },
          { label: "Unresolved interactions", value: rollup.unclassified.toLocaleString() },
        ]}
      />
      <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        Interaction-only context is not a durable customer profile. It remains attached to its
        short-lived interaction handle and evidence until retention removes it.
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <InputGroup className="max-w-xl bg-background">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search customers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customer or context"
          />
        </InputGroup>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <CustomerSelect
            label="Identity"
            value={filters.identityLevel}
            options={facets?.identityLevel ?? []}
            onChange={(identityLevel) => applyFilters({ ...filters, identityLevel })}
          />
          <CustomerSelect
            label="Context"
            value={filters.signalType}
            options={facets?.signalType ?? []}
            onChange={(signalType) => applyFilters({ ...filters, signalType })}
          />
          <CustomerSelect
            label="Sharing"
            value={filters.consentState}
            options={facets?.consentState ?? []}
            onChange={(consentState) => applyFilters({ ...filters, consentState })}
          />
          <NativeSelect
            aria-label="Customer activity range"
            className="w-auto min-w-32"
            value={filters.range}
            onChange={(event) =>
              applyFilters({ ...filters, range: event.target.value as CustomerFilters["range"] })
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
      {customerFilterCount(filters) ? (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          <span>{customerFilterCount(filters)} active customer filters</span>
          <Button variant="ghost" size="xs" onClick={() => applyFilters(emptyFilters)}>
            Clear filters
          </Button>
        </div>
      ) : null}
      <section className="min-h-0 flex-1 overflow-auto" aria-label="Customers">
        {pages.isError ? (
          <div className="p-4 text-sm text-destructive" role="alert">
            Customers could not be loaded. Use Refresh to try again.
          </div>
        ) : pages.isPending || settling ? (
          <p className="p-4 text-sm text-muted-foreground" role="status">
            Loading customers…
          </p>
        ) : customers.length ? (
          <Table className="min-w-[820px] table-fixed">
            <TableHeader className="sticky top-0 z-[1] bg-background">
              <TableRow className="hover:bg-background">
                <TableHead className="h-9 w-[25%] pl-5 text-xs">Customer</TableHead>
                <TableHead className="h-9 w-[14%] text-xs">Type</TableHead>
                <TableHead className="h-9 w-[29%] text-xs">Recent evidence</TableHead>
                <TableHead className="h-9 w-[12%] text-xs">Signals</TableHead>
                <TableHead className="h-9 w-[10%] text-xs">Permission</TableHead>
                <TableHead className="h-9 w-[10%] pr-5 text-right text-xs">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => (
                <CustomerRow
                  key={customer.id}
                  customer={customer}
                  selected={selectedCustomerId === customer.id}
                  open={() => selectCustomer(customer.id)}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="h-full bg-canvas p-4">
            <EmptyState
              title={rollup.customers ? "No matching customers" : "No customers yet"}
              description={
                rollup.customers
                  ? "Clear filters or broaden the activity window."
                  : "Known and anonymous profiles appear after your product supplies a stable company-owned reference. Interaction-only context stays with its evidence instead."
              }
            />
          </div>
        )}
      </section>
      {customers.length ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <p>Showing {customers.length.toLocaleString()} customers. Filters cover retained data.</p>
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

function CustomerSelect({
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
          {label === "Identity" ? identityLabel(option.name) : titleCase(option.name)} (
          {option.count})
        </option>
      ))}
    </NativeSelect>
  );
}

function CustomerRow({
  customer,
  selected,
  open,
}: {
  customer: CustomerSummary;
  selected: boolean;
  open: () => void;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      aria-selected={selected}
      aria-label={`Open customer ${customer.displayName}`}
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
          {customer.displayName}
        </Button>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {titleCase(customer.kind)}
          {customer.memberCount > 0
            ? ` · ${customer.memberCount} linked ${customer.memberCount === 1 ? "user" : "users"}`
            : ""}
          {customer.accountRefHint || customer.userRefHint
            ? ` · ${customer.accountRefHint ?? customer.userRefHint}`
            : ""}
        </p>
      </TableCell>
      <TableCell>
        <IdentityBadge level={customer.identityLevel} />
      </TableCell>
      <TableCell className="overflow-hidden text-xs">
        <p className="line-clamp-2 text-foreground">
          {customer.contextSummary ??
            (customer.signalCount
              ? `${customer.signalCount} retained evidence ${customer.signalCount === 1 ? "signal" : "signals"}`
              : "No retained evidence yet")}
        </p>
      </TableCell>
      <TableCell className="text-xs">{customer.signalCount.toLocaleString()}</TableCell>
      <TableCell>
        <ConsentBadge state={customer.consentState} />
      </TableCell>
      <TableCell
        className="pr-5 text-right text-xs text-muted-foreground"
        title={formatDate(customer.lastActivityAt)}
      >
        {relativeDate(customer.lastActivityAt)}
      </TableCell>
    </TableRow>
  );
}

function CustomerInspector({
  requestedId,
  detail,
  error,
  close,
  retry,
  openFeature,
  openFeedback,
  openInteraction,
  openSession,
}: {
  requestedId: string;
  detail?: CustomerDetail;
  error: Error | null;
  close: () => void;
  retry: () => Promise<unknown>;
  openFeature: (featureKey: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  return (
    <DetailRail open onClose={close} label="Customer detail">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {detail?.customer.displayName ?? requestedId}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close customer detail" onClick={close}>
          <IconCrossSmall />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-5">
          {error ? (
            <ErrorState error={error} onRetry={() => void retry()} />
          ) : detail ? (
            <CustomerDetailContent
              detail={detail}
              openFeature={openFeature}
              openFeedback={openFeedback}
              openInteraction={openInteraction}
              openSession={openSession}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Loading customer…
            </p>
          )}
        </div>
      </ScrollArea>
    </DetailRail>
  );
}

function CustomerDetailContent({
  detail,
  openFeature,
  openFeedback,
  openInteraction,
  openSession,
}: {
  detail: CustomerDetail;
  openFeature: (featureKey: string) => void;
  openFeedback: (reportId: string) => void;
  openInteraction: (interactionId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  const customer = detail.customer;
  const availableSignals = detail.signals.filter((signal) => isAvailableContext(signal));
  const taskSignals = availableSignals.filter(
    (signal) => signal.type === "intent" || signal.provenance === "agent_reports_current_task",
  );
  const otherAllowedSignals = availableSignals.filter(
    (signal) => !taskSignals.includes(signal) && contextSignalTypes.has(signal.type),
  );
  const supportingSignals = detail.signals.filter(
    (signal) => !taskSignals.includes(signal) && !otherAllowedSignals.includes(signal),
  );

  return (
    <>
      <p className="text-xs text-muted-foreground">
        {identityLabel(customer.identityLevel)} customer
      </p>
      <h2 className="mt-2 text-balance text-lg font-medium leading-6">{customer.displayName}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <IdentityBadge level={customer.identityLevel} />
        <ConsentBadge state={customer.consentState} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {titleCase(customer.kind)}
        {customer.parentCustomerId
          ? ` · linked to account ${customer.parentCustomerId.slice(0, 8)}`
          : customer.memberCount > 0
            ? ` · ${customer.memberCount} linked ${customer.memberCount === 1 ? "user" : "users"}`
            : ""}
      </p>
      {customer.segments.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {customer.segments.map((segment) => (
            <Badge key={segment} variant="secondary">
              {segment}
            </Badge>
          ))}
        </div>
      ) : null}

      <Separator className="my-5" />
      <section aria-labelledby="personalization-context-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 id="personalization-context-heading" className="text-xs font-medium">
            Personalization context
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {availableSignals.length} available
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Only relevant, permissioned, and unexpired context is returned to the product.
        </p>
        <div className="mt-4">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Intent and task context
          </h4>
          <div className="mt-2">
            <ContextList signals={taskSignals} empty="No intent or task constraint is available." />
          </div>
        </div>
        <div className="mt-5">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Other allowed context
          </h4>
          <div className="mt-2">
            <ContextList
              signals={otherAllowedSignals}
              empty="No additional context is currently allowed for a product use."
            />
          </div>
        </div>
      </section>

      <Separator className="my-5" />
      <section aria-labelledby="customer-consent-heading">
        <h3 id="customer-consent-heading" className="text-xs font-medium">
          Permission
        </h3>
        {detail.consent.length ? (
          <ol className="mt-3 divide-y">
            {detail.consent.map((grant) => (
              <li
                key={`${grant.scope}-${grant.enrichmentPurpose ?? "legacy"}-${grant.revision}`}
                className="py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">
                    {titleCase(grant.enrichmentPurpose ?? grant.scope)}
                  </span>
                  <ConsentBadge state={grant.state} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {titleCase(grant.basis)} · decided {formatDate(grant.decidedAt)}
                  {grant.expiresAt ? ` · expires ${formatDate(grant.expiresAt)}` : ""}
                  {grant.revokedAt ? ` · revoked ${formatDate(grant.revokedAt)}` : ""}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No scoped permission decision is recorded.
          </p>
        )}
        {detail.consentHistory.length ? (
          <details className="mt-3 border-t pt-3">
            <summary className="cursor-pointer text-xs font-medium">
              Permission history ({detail.consentHistory.length})
            </summary>
            <ol className="mt-2 divide-y">
              {detail.consentHistory.map((event) => (
                <li key={event.id} className="py-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {titleCase(event.enrichmentPurpose ?? event.scope)}
                  </span>
                  {` · ${titleCase(event.priorState ?? "not set")} → ${titleCase(event.state)}`}
                  {` · ${titleCase(event.source)} · revision ${event.revision}`}
                  <br />
                  {formatDate(event.decidedAt)}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>

      <Separator className="my-5" />
      <details>
        <summary className="cursor-pointer text-xs font-medium">Why Epode knows this</summary>
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          Source records are supporting evidence, not additional customer facts.
        </p>
        {supportingSignals.length ? (
          <div className="mt-3">
            <ContextList signals={supportingSignals} />
          </div>
        ) : null}
        {detail.identifiers.length ? (
          <dl className="mt-4 grid grid-cols-[100px_1fr] gap-x-3 gap-y-3 text-xs">
            {detail.identifiers.map((identifier) => (
              <div key={identifier.id} className="contents">
                <dt className="text-muted-foreground">{titleCase(identifier.kind)}</dt>
                <dd>
                  <p className="font-mono">{identifier.displayHint}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {titleCase(identifier.provenance)} · {identityLabel(identifier.identityLevel)}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {detail.sessions.length ? (
          <ol className="mt-4 divide-y border-t">
            {detail.sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{session.refHint}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {session.interactionCount} interactions · {relativeDate(session.lastSeenAt)}
                  </p>
                </div>
                <Button variant="outline" size="xs" onClick={() => openSession(session.id)}>
                  Evidence
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1">
          {supportingSignals.flatMap((signal) => [
            signal.feedbackReportId ? (
              <Button
                key={`report-${signal.id}`}
                variant="link"
                size="xs"
                onClick={() => openFeedback(signal.feedbackReportId as string)}
              >
                Report evidence
              </Button>
            ) : null,
            signal.interactionId ? (
              <Button
                key={`interaction-${signal.id}`}
                variant="link"
                size="xs"
                onClick={() => openInteraction(signal.interactionId as string)}
              >
                Interaction evidence
              </Button>
            ) : null,
            signal.featureKey ? (
              <Button
                key={`feature-${signal.id}`}
                variant="link"
                size="xs"
                onClick={() => openFeature(signal.featureKey as string)}
              >
                Related need
              </Button>
            ) : null,
          ])}
        </div>
      </details>
    </>
  );
}

const contextSignalTypes = new Set(["intent", "preference", "constraint"]);

function isAvailableContext(signal: CustomerSignal) {
  if (!contextSignalTypes.has(signal.type) || signal.allowedUses.length === 0) return false;
  if (signal.provenance === "agent_inference") return false;
  if (signal.consentState !== "approved") return false;
  return signal.expiresAt === null || new Date(signal.expiresAt).getTime() > Date.now();
}

function ContextList({
  signals,
  empty = "No additional context is available.",
}: {
  signals: CustomerSignal[];
  empty?: string;
}) {
  if (!signals.length) return <p className="text-sm text-muted-foreground">{empty}</p>;

  return (
    <ol className="divide-y rounded-lg border px-3">
      {signals.map((signal) => (
        <li key={signal.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{titleCase(signal.type)}</Badge>
            <ProvenanceBadge provenance={signal.provenance} />
          </div>
          <p className="mt-2 text-sm font-medium leading-5">{signal.summary}</p>
          {signal.signalKey && signal.value !== null ? (
            <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
              {signal.signalKey} = {formatSignalValue(signal.value)}
            </p>
          ) : null}
          {signal.detail ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.detail}</p>
          ) : null}
          <p className="mt-2 text-[11px] text-muted-foreground">
            {signal.confidence === null
              ? "Confidence not supplied"
              : `${Math.round(signal.confidence * 100)}% confidence`}
            {signal.expiresAt ? ` · expires ${formatDate(signal.expiresAt)}` : " · no expiry"}
          </p>
          {signal.allowedUses.length ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Allowed for {signal.allowedUses.map(titleCase).join(", ")}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function formatSignalValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
