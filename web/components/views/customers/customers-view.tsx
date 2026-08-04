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
  type ConsentEvent,
  type ConsentGrant,
  type CustomerContextReturn,
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
  range: "all" | "7d" | "30d";
};

const emptyFilters: CustomerFilters = {
  identityLevel: "",
  consentState: "",
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
  url.searchParams.delete("customerSignal");
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
    filters.range === "30d" ? "" : filters.range,
  ].filter(Boolean).length;
}

export function CustomersView({
  data,
  selectedCustomerId,
  selectCustomer,
  openSession,
  refresh,
}: {
  data: DashboardData;
  selectedCustomerId: string | null;
  selectCustomer: (customerId: string | null) => void;
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
            openSession={openSession}
          />
        ) : null
      }
    >
      <MetricStrip
        items={[
          { label: "Customers", value: rollup.customers.toLocaleString(), accent: true },
          { label: "Known", value: rollup.verified.toLocaleString() },
          { label: "Anonymous", value: rollup.pseudonymous.toLocaleString() },
          { label: "Active", value: rollup.active.toLocaleString() },
        ]}
      />
      <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        Customers stay linked to their sessions whenever the product supplies a stable reference.
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
            placeholder="Search customers"
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
                <TableHead className="h-9 w-[34%] pl-5 text-xs">Customer</TableHead>
                <TableHead className="h-9 w-[18%] text-xs">Type</TableHead>
                <TableHead className="h-9 w-[16%] text-xs">Sessions</TableHead>
                <TableHead className="h-9 w-[16%] text-xs">Data use</TableHead>
                <TableHead className="h-9 w-[16%] pr-5 text-right text-xs">Updated</TableHead>
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
                  : "Known and anonymous customers appear after your product supplies a stable company-owned reference."
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
      <TableCell className="text-xs">{customer.sessionCount.toLocaleString()}</TableCell>
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
  openSession,
}: {
  requestedId: string;
  detail?: CustomerDetail;
  error: Error | null;
  close: () => void;
  retry: () => Promise<unknown>;
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
            <CustomerDetailContent detail={detail} openSession={openSession} />
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

function signalSource(provenance: string) {
  switch (provenance) {
    case "agent_reports_user_statement":
      return "Customer said";
    case "agent_reports_current_task":
      return "Current request";
    case "agent_inference":
      return "Assistant inference";
    case "product_activity":
      return "Product activity";
    case "company_assertion":
      return "Company record";
    default:
      return titleCase(provenance);
  }
}

function signalValue(signal: CustomerSignal) {
  if (typeof signal.value === "string" || typeof signal.value === "number") {
    return String(signal.value);
  }
  if (typeof signal.value === "boolean") return signal.value ? "Yes" : "No";
  if (Array.isArray(signal.value)) {
    return signal.value
      .filter((value) => ["string", "number", "boolean"].includes(typeof value))
      .map(String)
      .join(", ");
  }
  return null;
}

function contextValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .map(String)
      .join(", ");
  }
  return "Structured value";
}

function dataUseScope(scope: string) {
  switch (scope) {
    case "share_preferences":
      return "Use shared context";
    case "personalize":
      return "Personalize the experience";
    case "remember_preferences":
      return "Remember across visits";
    case "share_outcome":
      return "Use outcome feedback";
    default:
      return titleCase(scope);
  }
}

type DataUseGrant = ConsentGrant & { scopes: string[] };
type DataUseEvent = ConsentEvent & { scopes: string[] };

function groupDataUseGrants(grants: ConsentGrant[]): DataUseGrant[] {
  const grouped = new Map<string, DataUseGrant>();
  for (const grant of grants) {
    const key = grant.enrichmentPurpose
      ? [
          grant.enrichmentPurpose,
          grant.state,
          grant.basis,
          grant.revision,
          grant.decidedAt,
          grant.expiresAt,
          grant.revokedAt,
        ].join("|")
      : [grant.scope, grant.state, grant.revision, grant.decidedAt].join("|");
    const existing = grouped.get(key);
    if (existing) existing.scopes.push(grant.scope);
    else grouped.set(key, { ...grant, scopes: [grant.scope] });
  }
  return [...grouped.values()];
}

function groupDataUseEvents(events: ConsentEvent[]): DataUseEvent[] {
  const grouped = new Map<string, DataUseEvent>();
  for (const event of events) {
    const key = event.enrichmentPurpose
      ? [
          event.enrichmentPurpose,
          event.priorState,
          event.state,
          event.basis,
          event.revision,
          event.source,
          event.decidedAt,
        ].join("|")
      : [event.scope, event.state, event.revision, event.decidedAt].join("|");
    const existing = grouped.get(key);
    if (existing) existing.scopes.push(event.scope);
    else grouped.set(key, { ...event, scopes: [event.scope] });
  }
  return [...grouped.values()];
}

function CustomerDetailContent({
  detail,
  openSession,
}: {
  detail: CustomerDetail;
  openSession: (sessionId: string) => void;
}) {
  const customer = detail.customer;
  const dataUse = groupDataUseGrants(detail.consent);
  const dataUseHistory = groupDataUseEvents(detail.consentHistory);

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
      <section aria-labelledby="customer-knowledge-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 id="customer-knowledge-heading" className="text-xs font-medium">
            What we know
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {detail.signals.length.toLocaleString()}{" "}
            {detail.signals.length === 1 ? "answer" : "answers"}
          </span>
        </div>
        {detail.signals.length ? (
          <ol className="mt-3 divide-y">
            {detail.signals.map((signal) => {
              const value = signalValue(signal);
              const sourceSession = signal.sessionId
                ? detail.sessions.find((session) => session.id === signal.sessionId)
                : undefined;
              return (
                <li key={signal.id} className="py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium leading-5">{signal.summary}</p>
                      {signal.signalKey || value ? (
                        <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                          {[signal.signalKey, value].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    <Badge variant="secondary">{titleCase(signal.type)}</Badge>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-muted-foreground">
                      {signalSource(signal.provenance)} · {relativeDate(signal.collectedAt)}
                    </p>
                    {sourceSession ? (
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto shrink-0 p-0"
                        onClick={() => openSession(sourceSession.id)}
                      >
                        Open source session
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No customer answers are linked yet.</p>
        )}
      </section>

      <Separator className="my-5" />
      <CustomerContextReturns returns={detail.contextReturns} openSession={openSession} />

      <Separator className="my-5" />
      <section aria-labelledby="customer-data-use-heading">
        <h3 id="customer-data-use-heading" className="text-xs font-medium">
          Data use
        </h3>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Recorded from the customer&apos;s choice in their agent. Epode does not ask them again
          here.
        </p>
        {dataUse.length ? (
          <ol className="mt-3 divide-y">
            {dataUse.map((grant) => (
              <li
                key={`${grant.enrichmentPurpose ?? grant.scope}-${grant.state}-${grant.revision}`}
                className="py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">
                    {titleCase(grant.enrichmentPurpose ?? grant.scope)}
                  </span>
                  <ConsentBadge state={grant.state} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {grant.scopes.map(dataUseScope).join(" · ")}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {titleCase(grant.basis)} · recorded {formatDate(grant.decidedAt)}
                  {grant.expiresAt ? ` · expires ${formatDate(grant.expiresAt)}` : ""}
                  {grant.revokedAt ? ` · revoked ${formatDate(grant.revokedAt)}` : ""}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No data-use choice is recorded.</p>
        )}
        {dataUseHistory.length ? (
          <details className="mt-3 border-t pt-3">
            <summary className="cursor-pointer text-xs font-medium">
              Data-use history ({dataUseHistory.length})
            </summary>
            <ol className="mt-2 divide-y">
              {dataUseHistory.map((event) => (
                <li
                  key={`${event.enrichmentPurpose ?? event.scope}-${event.state}-${event.revision}-${event.decidedAt}`}
                  className="py-2 text-[11px] text-muted-foreground"
                >
                  <span className="font-medium text-foreground">
                    {titleCase(event.enrichmentPurpose ?? event.scope)}
                  </span>
                  {` · ${titleCase(event.priorState ?? "not set")} → ${titleCase(event.state)}`}
                  {` · ${titleCase(event.source)} · revision ${event.revision}`}
                  <br />
                  {event.scopes.map(dataUseScope).join(" · ")}
                  <br />
                  {formatDate(event.decidedAt)}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </section>

      <Separator className="my-5" />
      <section aria-labelledby="customer-sessions-heading">
        <h3 id="customer-sessions-heading" className="text-xs font-medium">
          Sessions
        </h3>
        {detail.sessions.length ? (
          <ol className="mt-3 divide-y">
            {detail.sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{session.refHint}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {session.interactionCount} interactions · {relativeDate(session.lastSeenAt)}
                  </p>
                </div>
                <Button variant="outline" size="xs" onClick={() => openSession(session.id)}>
                  Open session
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No sessions for this customer yet.</p>
        )}
      </section>
    </>
  );
}

function CustomerContextReturns({
  returns,
  openSession,
}: {
  returns: CustomerContextReturn[];
  openSession: (sessionId: string) => void;
}) {
  return (
    <section aria-labelledby="customer-context-returned-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="customer-context-returned-heading" className="text-xs font-medium">
          Context returned to product
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {returns.length.toLocaleString()} {returns.length === 1 ? "retrieval" : "retrievals"}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        Structured fields returned through Epode. Customer prompts and searches are not included.
      </p>
      {returns.length ? (
        <ol className="mt-3 divide-y">
          {returns.map((retrieval) => {
            const usedSignalIds = new Set(
              retrieval.decisions.flatMap((decision) => decision.signalIds),
            );
            return (
              <li key={retrieval.retrievalId} className="py-3 first:pt-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{titleCase(retrieval.purpose)}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Returned {formatDate(retrieval.retrievedAt)} · {retrieval.items.length}{" "}
                      {retrieval.items.length === 1 ? "field" : "fields"}
                    </p>
                  </div>
                  {retrieval.sessionId ? (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto shrink-0 p-0"
                      onClick={() => openSession(retrieval.sessionId ?? "")}
                    >
                      Open session
                    </Button>
                  ) : null}
                </div>
                <dl className="mt-2 space-y-1 font-mono text-[10px] leading-4 text-muted-foreground">
                  <div>
                    <dt className="inline font-sans">Context version: </dt>
                    <dd className="inline break-all">{retrieval.contextVersion}</dd>
                  </div>
                  <div>
                    <dt className="inline font-sans">Retrieval: </dt>
                    <dd className="inline break-all">{retrieval.retrievalId}</dd>
                  </div>
                </dl>
                {retrieval.items.length ? (
                  <ul className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
                    {retrieval.items.map((item) => (
                      <li key={item.signalId}>
                        <div className="flex items-start justify-between gap-3">
                          <p className="break-words font-mono text-[11px] font-medium">
                            {item.key} · {contextValue(item.value)}
                          </p>
                          {usedSignalIds.has(item.signalId) ? (
                            <Badge variant="secondary">Used</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                          {item.summary} · {signalSource(item.provenance)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    No saved context fields were returned.
                  </p>
                )}
                {retrieval.decisions.length ? (
                  <div className="mt-3 space-y-2">
                    {retrieval.decisions.map((decision) => (
                      <div key={decision.id} className="border-l-2 pl-3">
                        <p className="text-xs font-medium">
                          {decision.variant
                            ? `Applied variant: ${titleCase(decision.variant)}`
                            : "Personalization applied"}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {decision.signalIds.length} returned{" "}
                          {decision.signalIds.length === 1 ? "field" : "fields"} used ·{" "}
                          {formatDate(decision.createdAt)}
                        </p>
                        {decision.outcomes.length ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Outcome:{" "}
                            {decision.outcomes
                              .map((outcome) => titleCase(outcome.outcome))
                              .join(", ")}
                          </p>
                        ) : (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            No outcome linked yet.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    No product decision has been linked to this retrieval.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          No customer context has been returned to this product yet.
        </p>
      )}
    </section>
  );
}
