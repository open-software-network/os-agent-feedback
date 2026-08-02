"use client";

import { useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import type { ReactNode } from "react";

import { IdentityBadge, ProvenanceBadge } from "@/components/dashboard/intelligence-badges";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type CustomerSignal,
  fetchCustomersPage,
  fetchSignalsPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";
import { isEditor, relativeDate, titleCase } from "@/lib/dashboard/format";

type EnrichmentInsights = {
  customerContextItems: number;
  customersWithContext: number;
  contextRetrievals: number;
  personalizationReadyCustomers: number;
  personalizationDecisions: number;
  personalizationOutcomes: number;
};

export function HomeView({
  data,
  openCustomer = () => undefined,
  refresh,
}: {
  data: DashboardData;
  openCustomer?: (customerId: string) => void;
  openFeature?: (featureKey: string) => void;
  openFeedback: (reportId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const productId = data.currentProduct?.id;
  const customers = useQuery({
    queryKey: ["insights-customers", data.workspace.id, productId],
    queryFn: () => fetchCustomersPage(data.workspace.id, { productId: productId ?? "", limit: 8 }),
    enabled: Boolean(productId),
  });
  const context = useQuery({
    queryKey: ["insights-context", data.workspace.id, productId],
    queryFn: () =>
      fetchSignalsPage(data.workspace.id, {
        productId: productId ?? "",
        type: ["intent", "preference", "constraint"],
        limit: 100,
      }),
    enabled: Boolean(productId),
  });

  const customerPage = customers.data;
  const customerItems = Array.isArray(customerPage?.customers) ? customerPage.customers : [];
  const contextItems = (Array.isArray(context.data?.signals) ? context.data.signals : []).filter(
    isAvailableContext,
  );
  const insights = data.insights as typeof data.insights & Partial<EnrichmentInsights>;
  const customersWithContext = insights.customersWithContext ?? 0;
  const contextLearned = insights.customerContextItems ?? 0;
  const personalizationReady = insights.personalizationReadyCustomers ?? 0;
  const retrievals = insights.contextRetrievals ?? 0;
  const decisions = insights.personalizationDecisions ?? 0;
  const outcomes = insights.personalizationOutcomes ?? 0;
  const common = commonContext(contextItems);
  const needsSetup = data.insights.opportunities === 0 && isEditor(data.currentRole);

  async function refreshInsights() {
    await Promise.all([refresh(), customers.refetch(), context.refetch()]);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <section aria-labelledby="insights-readout-title" className="border bg-background">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 bg-attention" />
                Customer context · last {data.insights.windowDays} days
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refreshInsights()}>
                Refresh
              </Button>
            </div>
            <h2 id="insights-readout-title" className="mt-4 max-w-2xl text-2xl font-medium">
              {contextLearned
                ? `Epode learned ${contextLearned.toLocaleString()} useful context ${contextLearned === 1 ? "item" : "items"}.`
                : "Connect your product to start learning what customers want."}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Known and anonymous customer profiles are included. Context without a stable company
              reference stays interaction-only evidence. Every item preserves its source,
              permission, confidence, and expiration before it can be used for personalization.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {needsSetup ? (
                <Button onClick={() => navigateToDashboardView("setup")}>Finish setup</Button>
              ) : (
                <Button onClick={() => navigateToDashboardView("customers")}>
                  View customers
                  <IconArrowUpRight data-icon="inline-end" />
                </Button>
              )}
              <Button variant="outline" onClick={() => navigateToDashboardView("setup")}>
                Retrieve context
              </Button>
            </div>
          </div>
          <div className="border-t p-5 lg:border-t-0 lg:border-l">
            <h3 className="text-sm font-medium">Identity coverage</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Authentication is optional; identity is never invented.
            </p>
            <dl className="mt-4 grid gap-3 text-xs">
              <CompactMetric label="Known" value={customerPage?.rollup?.verified ?? 0} />
              <CompactMetric label="Anonymous" value={customerPage?.rollup?.pseudonymous ?? 0} />
              <CompactMetric
                label="Unresolved interactions"
                value={customerPage?.rollup?.unclassified ?? 0}
              />
            </dl>
          </div>
        </div>
      </section>

      <section aria-labelledby="context-health-title" className="border bg-background">
        <SectionHeader id="context-health-title" title="Customer understanding" />
        <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
          <Metric
            label="Customers with context"
            value={customersWithContext}
            detail="Known or anonymous profiles with usable context"
          />
          <Metric
            label="Context learned"
            value={contextLearned}
            detail={`Active intent, preference, and constraint ${contextLearned === 1 ? "item" : "items"}`}
          />
          <Metric
            label="Personalization-ready"
            value={personalizationReady}
            detail="Customers with active permissioned context"
          />
          <Metric
            label="Context retrievals"
            value={retrievals}
            detail="Server-side personalization requests"
          />
          <Metric
            label="Personalization decisions"
            value={decisions}
            detail="Responses adapted using returned customer context"
          />
          <Metric
            label="Measured outcomes"
            value={outcomes}
            detail="Personalized decisions linked to subsequent outcomes"
          />
        </dl>
      </section>

      <section aria-labelledby="common-context-title" className="border bg-background">
        <SectionHeader
          id="common-context-title"
          title="What customers care about"
          description="Common context Epode can make available for personalization"
        />
        {context.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Customer context could not be loaded.
          </p>
        ) : context.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading customer context…</p>
        ) : common.length ? (
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Context</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Customers</TableHead>
                <TableHead className="pr-4">Strongest source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {common.slice(0, 8).map((item) => (
                <TableRow key={`${item.type}-${item.summary}`}>
                  <TableCell className="max-w-xl pl-4 font-medium">{item.summary}</TableCell>
                  <TableCell>{titleCase(item.type)}</TableCell>
                  <TableCell>{item.customers}</TableCell>
                  <TableCell className="pr-4">
                    <ProvenanceBadge provenance={item.provenance} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            No permissioned intent, preference, or constraint context yet.
          </p>
        )}
      </section>

      <section aria-labelledby="recent-context-title" className="border bg-background">
        <SectionHeader
          id="recent-context-title"
          title="Recently understood customers"
          description="Known and anonymous profiles with recent evidence"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("customers")}>
              View all customers
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        {customers.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Customers could not be loaded.
          </p>
        ) : customers.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading customers…</p>
        ) : customerItems.length ? (
          <Table className="min-w-[660px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Context</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customerItems.slice(0, 8).map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell className="pl-4">
                    <Button
                      variant="link"
                      className="h-auto justify-start p-0 text-left"
                      onClick={() => openCustomer(customer.id)}
                    >
                      {customer.displayName}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <IdentityBadge level={customer.identityLevel} />
                  </TableCell>
                  <TableCell>{customer.contextCount ?? customer.signalCount} active</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {relativeDate(customer.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">No customers understood yet.</p>
        )}
      </section>
    </div>
  );
}

function commonContext(signals: CustomerSignal[]) {
  const buckets = new Map<
    string,
    {
      type: string;
      summary: string;
      customers: number;
      provenance: string;
      customerIds: Set<string>;
    }
  >();
  for (const signal of signals) {
    const key = `${signal.type}:${signal.summary.trim().toLowerCase()}`;
    const bucket = buckets.get(key) ?? {
      type: signal.type,
      summary: signal.summary,
      customers: 0,
      provenance: signal.provenance,
      customerIds: new Set<string>(),
    };
    if (signal.customerId) bucket.customerIds.add(signal.customerId);
    bucket.customers = bucket.customerIds.size || bucket.customers + 1;
    if (signal.provenance !== "agent_inference") bucket.provenance = signal.provenance;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.customers - a.customers);
}

function isAvailableContext(signal: CustomerSignal) {
  if (signal.provenance === "agent_inference") return false;
  if (!signal.allowedUses.length || signal.consentState !== "approved") return false;
  return !signal.expiresAt || new Date(signal.expiresAt).getTime() > Date.now();
}

function SectionHeader({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
      <div>
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <div className="min-w-0 border-b p-4 last:border-b-0 lg:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl font-medium">{value}</dd>
      <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function CompactMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-2 last:border-b-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

type VisibleDashboardView = "customers" | "setup";

function navigateToDashboardView(view: VisibleDashboardView) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  for (const parameter of ["customer", "feature", "report", "session", "interaction"]) {
    url.searchParams.delete(parameter);
  }
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
