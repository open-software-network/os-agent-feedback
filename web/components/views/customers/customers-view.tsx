"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFilterTimeline } from "central-icons/IconFilterTimeline";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";
import { DetailRail, DetailWorkspace } from "@/components/dashboard/detail-rail";
import { IdentityBadge, identityLabel } from "@/components/dashboard/intelligence-badges";
import { MetricStrip } from "@/components/dashboard/metric-strip";
import { EmptyState, ErrorState, NativeSelect } from "@/components/dashboard/view-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  type CustomerContextReturn,
  type CustomerDetail,
  type CustomerFacets,
  type CustomerSignal,
  type CustomerSummary,
  fetchCustomerDetail,
  fetchCustomersPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";
import { formatDate, relativeDate, titleCase } from "@/lib/dashboard/format";

type CustomerFilters = {
  identityLevel: string;
  range: "all" | "7d" | "30d";
};

const emptyFilters: CustomerFilters = {
  identityLevel: "",
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
      range: range === "all" || range === "7d" ? range : "30d",
    } satisfies CustomerFilters,
  };
}

function writeCustomerLocation(query: string, filters: CustomerFilters) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  setParam(url, "customerQ", query);
  setParam(url, "customerIdentity", filters.identityLevel);
  url.searchParams.delete("customerConsent");
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
  return [filters.identityLevel, filters.range === "30d" ? "" : filters.range].filter(Boolean)
    .length;
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
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="w-full bg-background sm:w-80 sm:flex-none">
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
        <div className="flex shrink-0 items-center gap-2">
          <CustomerFilters filters={filters} facets={facets} onApply={applyFilters} />
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
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2">
          {filters.identityLevel ? (
            <Badge variant="outline">Identity: {identityLabel(filters.identityLevel)}</Badge>
          ) : null}
          {filters.range !== "30d" ? (
            <Badge variant="outline">
              {filters.range === "7d" ? "Last 7 days" : "All retained"}
            </Badge>
          ) : null}
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
          <Table className="min-w-[720px] table-fixed">
            <TableHeader className="sticky top-0 z-[1] bg-background">
              <TableRow className="hover:bg-background">
                <TableHead className="h-9 w-[42%] pl-5 text-xs">Customer</TableHead>
                <TableHead className="h-9 w-[22%] text-xs">Identity</TableHead>
                <TableHead className="h-9 w-[18%] text-xs">Sessions</TableHead>
                <TableHead className="h-9 w-[18%] pr-5 text-right text-xs">Updated</TableHead>
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

function CustomerFilters({
  filters,
  facets,
  onApply,
}: {
  filters: CustomerFilters;
  facets?: CustomerFacets;
  onApply: (filters: CustomerFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const activeCount = customerFilterCount(filters);

  function change(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) setDraft(filters);
  }

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <IconFilterTimeline data-icon="inline-start" />
        Filters
        {activeCount ? <Badge variant="secondary">{activeCount}</Badge> : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <PopoverHeader>
          <PopoverTitle>Filter customers</PopoverTitle>
        </PopoverHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="customer-identity-filter">Identity</Label>
            <CustomerSelect
              id="customer-identity-filter"
              label="Identity"
              value={draft.identityLevel}
              options={facets?.identityLevel ?? []}
              onChange={(identityLevel) => setDraft({ ...draft, identityLevel })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="customer-activity-filter">Last active</Label>
            <NativeSelect
              id="customer-activity-filter"
              value={draft.range}
              onChange={(event) =>
                setDraft({ ...draft, range: event.target.value as CustomerFilters["range"] })
              }
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="all">All retained</option>
            </NativeSelect>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t pt-2.5">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(emptyFilters)}>
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CustomerSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { name: string; count: number }[];
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect
      id={id}
      aria-label={`${label} filter`}
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
          {detail ? "Customer" : requestedId}
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

function rawAddsInfo(summary: string, raw: string) {
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return !normalize(summary).includes(normalize(raw));
}

function CustomerDetailContent({
  detail,
  openSession,
}: {
  detail: CustomerDetail;
  openSession: (sessionId: string) => void;
}) {
  const customer = detail.customer;
  const usedSignalIds = new Set(
    detail.contextReturns.flatMap((retrieval) =>
      retrieval.decisions.flatMap((decision) => decision.signalIds),
    ),
  );

  return (
    <>
      <h2 className="text-balance text-lg font-medium leading-6">{customer.displayName}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <IdentityBadge level={customer.identityLevel} />
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
              const raw = [signal.signalKey, value].filter(Boolean).join(" · ");
              const sourceSession = signal.sessionId
                ? detail.sessions.find((session) => session.id === signal.sessionId)
                : undefined;
              return (
                <li key={signal.id} className="py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium leading-5">{signal.summary}</p>
                      {raw && rawAddsInfo(signal.summary, raw) ? (
                        <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                          {raw}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <Badge variant="secondary">{titleCase(signal.type)}</Badge>
                      {usedSignalIds.has(signal.id) ? (
                        <Badge variant="secondary">Used</Badge>
                      ) : null}
                    </div>
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
      <section aria-labelledby="customer-request-facts-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 id="customer-request-facts-heading" className="text-xs font-medium">
            Request facts
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {detail.counts.requestObservations.toLocaleString()} observed
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Automatically observed by the company&apos;s server. Cookies, credentials, full referrer
          URLs, and arbitrary headers are excluded. MAC addresses are not exposed by routed HTTP.
        </p>
        {detail.requestObservations.length ? (
          <ol className="mt-3 divide-y">
            {detail.requestObservations.map((observation) => {
              const facts = [
                observation.clientIp ? `IP ${observation.clientIp}` : null,
                observation.method,
                observation.acceptLanguage,
              ].filter(Boolean);
              return (
                <li key={observation.id} className="py-3 first:pt-0">
                  <p className="break-words font-mono text-[11px] text-foreground">
                    {facts.join(" · ") || "HTTP request"}
                  </p>
                  {observation.userAgent ? (
                    <p className="mt-1 break-words text-[11px] text-muted-foreground">
                      {observation.userAgent}
                    </p>
                  ) : null}
                  {observation.referrerOrigin ? (
                    <p className="mt-1 break-words text-[11px] text-muted-foreground">
                      Referrer origin: {observation.referrerOrigin}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Observed {formatDate(observation.observedAt)}
                  </p>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No request facts have been observed for this customer yet.
          </p>
        )}
      </section>

      <Separator className="my-5" />
      <section aria-labelledby="customer-sessions-heading">
        <h3 id="customer-sessions-heading" className="text-xs font-medium">
          Sessions
        </h3>
        {detail.sessions.length ? (
          <ol className="mt-3 divide-y">
            {detail.sessions.map((session) => (
              <li key={session.id} className="-mx-2">
                <Button
                  variant="ghost"
                  aria-label={`Open session ${session.refHint}`}
                  className="h-auto w-full justify-start rounded-md px-2 py-2 text-left font-normal whitespace-normal hover:bg-muted/40"
                  onClick={() => openSession(session.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs">{session.refHint}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {session.interactionCount} interactions · {relativeDate(session.lastSeenAt)}
                    </span>
                  </span>
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
                {retrieval.items.length ? (
                  <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">
                    {retrieval.items.map((item) => item.key).join(" · ")}
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    No saved context fields were returned.
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">
                    Retrieval details
                  </summary>
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
                </details>
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
                          {decision.signalIds.length === 1 ? "field" : "fields"} used
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
