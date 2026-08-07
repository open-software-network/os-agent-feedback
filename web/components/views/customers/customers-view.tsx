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
  type CustomerDetail,
  type CustomerFacets,
  type CustomerSummary,
  fetchCustomerDetail,
  fetchCustomersPage,
  type ObservedCustomerFact,
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
                <TableHead className="h-9 w-[22%] text-xs">Context</TableHead>
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
  const referenceHints = [customer.userRefHint, customer.accountRefHint].filter(Boolean);

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
          {identityLabel(customer.identityLevel)}
          {referenceHints.length ? ` · ${referenceHints.join(" · ")}` : ""}
        </p>
      </TableCell>
      <TableCell>
        <span className="text-xs">{customer.traitCount.toLocaleString()}</span>
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

function sessionActivity(operation: string | null) {
  return operation?.trim() || "No activity observed";
}

function observedRequestMetadata(detail: CustomerDetail) {
  const metadata = new Map<string, { label: string; value: string; observedAt: string }>();
  for (const observation of detail.requestObservations) {
    const isAgent = /claude|anthropic|openai|chatgpt/i.test(observation.userAgent ?? "");
    const candidates = [
      observation.clientIp
        ? {
            label: isAgent ? "Agent network address" : "Network address",
            value: observation.clientIp,
          }
        : null,
      observation.userAgent ? { label: "Client software", value: observation.userAgent } : null,
      observation.acceptLanguage
        ? { label: "Preferred language", value: observation.acceptLanguage }
        : null,
      observation.secChUaPlatform
        ? { label: "Device platform", value: observation.secChUaPlatform.replaceAll('"', "") }
        : null,
      observation.referrerOrigin
        ? { label: "Referring site", value: observation.referrerOrigin }
        : null,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = `${candidate.label}:${candidate.value}`;
      if (!metadata.has(key)) {
        metadata.set(key, { ...candidate, observedAt: observation.observedAt });
      }
    }
  }
  return [...metadata.values()].slice(0, 12);
}

function observedFactKind(kind: string) {
  if (kind === "context") return "Context";
  if (kind === "intent") return "Intent";
  if (kind === "constraint") return "Constraint";
  if (kind === "preference") return "Preference";
  if (kind === "unknown") return "Unknown";
  return titleCase(kind);
}

function observedDomain(domain: string) {
  if (domain === "saas") return "SaaS";
  if (domain === "petsmart") return "PetSmart";
  return titleCase(domain);
}

function observedFactScope(fact: ObservedCustomerFact) {
  switch (fact.scope) {
    case "customer":
      return "Customer-wide";
    case "journey":
      return fact.scopeRef ? `Journey · ${fact.scopeRef}` : "Journey";
    case "item":
      return fact.scopeRef ? `Item · ${fact.scopeRef}` : "Item";
    default:
      return fact.scopeRef ? `Session · ${fact.scopeRef}` : "Session";
  }
}

function ObservedFactList({
  facts,
  showFactDomain,
  openSession,
}: {
  facts: ObservedCustomerFact[];
  showFactDomain: boolean;
  openSession: (sessionId: string) => void;
}) {
  return (
    <ol className="mt-3 space-y-2">
      {facts.map((fact) => {
        const latestEvidence = fact.evidence[0];
        const content = (
          <span className="block min-w-0 text-left">
            <span className="flex flex-wrap items-center gap-1">
              <Badge variant="outline">{observedFactScope(fact)}</Badge>
              {showFactDomain ? (
                <Badge variant="outline">{observedDomain(fact.domain)}</Badge>
              ) : null}
              <Badge variant="secondary">{observedFactKind(fact.kind)}</Badge>
              {fact.strength ? (
                <span className="text-[10px] text-muted-foreground">
                  {titleCase(fact.strength)}
                </span>
              ) : null}
            </span>
            <span className="mt-2 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {fact.label}
            </span>
            <span className="mt-0.5 block text-sm leading-5">{fact.value}</span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              Seen in {fact.sessionCount.toLocaleString()}{" "}
              {fact.sessionCount === 1 ? "session" : "sessions"}
              {fact.observationCount > fact.sessionCount
                ? ` · ${fact.observationCount.toLocaleString()} activities`
                : ""}
              {` · ${relativeDate(fact.lastObservedAt)}`}
            </span>
          </span>
        );
        return (
          <li
            key={`${fact.scope}:${fact.scopeRef ?? "customer"}:${fact.key}:${fact.value}:${fact.strength ?? "none"}`}
          >
            {latestEvidence ? (
              <Button
                variant="ghost"
                className="h-auto w-full justify-start rounded-md border bg-muted/20 p-3 font-normal whitespace-normal hover:bg-muted/40"
                aria-label={`Open evidence for ${fact.label}: ${fact.value}`}
                title={latestEvidence.operation}
                onClick={() => openSession(latestEvidence.sessionId)}
              >
                {content}
              </Button>
            ) : (
              <div className="border bg-muted/20 p-3">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function CustomerDetailContent({
  detail,
  openSession,
}: {
  detail: CustomerDetail;
  openSession: (sessionId: string) => void;
}) {
  const customer = detail.customer;
  const referenceHints = [customer.userRefHint, customer.accountRefHint].filter(Boolean);
  const interactionCount = detail.sessions.reduce(
    (total, session) => total + session.interactionCount,
    0,
  );
  const observedProfile = detail.observedProfile ?? {
    sessionCount: 0,
    activityCount: 0,
    truncated: false,
    lastObservedAt: null,
    facts: [],
  };
  const requestMetadata = observedRequestMetadata(detail);
  const customerTraits = observedProfile.facts.filter((fact) => fact.scope === "customer");
  const scopedContext = observedProfile.facts.filter((fact) => fact.scope !== "customer");
  const factDomains = new Set(observedProfile.facts.map((fact) => fact.domain));
  const showFactDomain = factDomains.size > 1;

  return (
    <>
      <h2 className="text-balance text-lg font-medium leading-6">{customer.displayName}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <IdentityBadge level={customer.identityLevel} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Customer{referenceHints.length ? ` · ${referenceHints.join(" · ")}` : ""}
      </p>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        {customer.identityLevel === "pseudonymous"
          ? "Stable first-party identity supplied by the product. Epode can link sessions without requiring personal information."
          : "Stable product-owned identity used to link this customer’s sessions."}
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
      <section
        aria-labelledby="customer-observed-profile-heading"
        aria-label="Observed customer profile"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 id="customer-observed-profile-heading" className="text-xs font-medium">
            What we&apos;ve observed
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {observedProfile.facts.length.toLocaleString()}{" "}
            {observedProfile.facts.length === 1 ? "observation" : "observations"}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Epode separates customer-wide traits from context that applies only to a journey, item, or
          session. Scoped context never becomes a customer trait.
        </p>
        {observedProfile.truncated ? (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            Showing facts from the latest {observedProfile.activityCount.toLocaleString()} retained
            activities.
          </p>
        ) : null}
        {observedProfile.facts.length ? (
          <>
            <div className="mt-4 flex items-center justify-between gap-3">
              <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Customer traits
              </h4>
              <span className="text-[11px] text-muted-foreground">
                {customerTraits.length.toLocaleString()}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Customer-wide context that can remain relevant across journeys, such as household
              composition.
            </p>
            {customerTraits.length ? (
              <ObservedFactList
                facts={customerTraits}
                showFactDomain={showFactDomain}
                openSession={openSession}
              />
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No customer-wide traits observed yet.
              </p>
            )}
            {scopedContext.length ? (
              <>
                <div className="mt-5 flex items-center justify-between gap-3">
                  <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Scoped context
                  </h4>
                  <span className="text-[11px] text-muted-foreground">
                    {scopedContext.length.toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Budgets, purposes, preferences, and constraints stay attached to the journey,
                  item, or session where they were expressed.
                </p>
                <ObservedFactList
                  facts={scopedContext}
                  showFactDomain={showFactDomain}
                  openSession={openSession}
                />
              </>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No needs, preferences, constraints, or customer context have been expressed in the
            observed session activity yet.
          </p>
        )}
        <h4 className="mt-5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Request metadata
        </h4>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Browser and network details describe a request, not the customer. Epode never uses them as
          identity or promotes them to customer traits.
        </p>
        {requestMetadata.length ? (
          <ol className="mt-3 divide-y border">
            {requestMetadata.map((trait) => (
              <li key={`${trait.label}:${trait.value}`} className="p-3">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {trait.label}
                </p>
                <p className="mt-1 break-words text-xs leading-5">{trait.value}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Last seen {relativeDate(trait.observedAt)}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No request metadata observed yet.</p>
        )}
      </section>

      <Separator className="my-5" />
      <section aria-labelledby="customer-sessions-heading" aria-label="Customer sessions">
        <div className="flex items-center justify-between gap-3">
          <h3 id="customer-sessions-heading" className="text-xs font-medium">
            Sessions
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {interactionCount.toLocaleString()} {interactionCount === 1 ? "activity" : "activities"}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Open a session to inspect every observed activity in chronological order.
        </p>
        {detail.sessions.length ? (
          <ol className="mt-3 divide-y">
            {detail.sessions.map((session) => (
              <li key={session.id} className="-mx-2">
                <Button
                  variant="ghost"
                  aria-label={`Open session ${session.refHint}`}
                  className="h-auto w-full justify-start rounded-md px-2 py-3 text-left font-normal whitespace-normal hover:bg-muted/40"
                  onClick={() => openSession(session.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs font-medium">
                      {session.refHint}
                    </span>
                    <span className="mt-1 block break-words font-mono text-[10px] leading-4 text-muted-foreground">
                      {sessionActivity(session.firstOperation)}
                      {session.lastOperation && session.lastOperation !== session.firstOperation
                        ? ` → ${session.lastOperation}`
                        : ""}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {session.interactionCount}{" "}
                      {session.interactionCount === 1 ? "activity" : "activities"} ·{" "}
                      {relativeDate(session.lastSeenAt)}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No sessions yet.</p>
        )}
      </section>
    </>
  );
}
