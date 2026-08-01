"use client";

import { useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import type { ReactNode } from "react";

import { IdentityBadge, OutcomeHealth } from "@/components/dashboard/intelligence-badges";
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
  type FeatureSummary,
  fetchCustomersPage,
  fetchFeaturesPage,
} from "@/lib/api/customer-intelligence";
import type { DashboardData } from "@/lib/api/dashboard";
import { isEditor, relativeDate, titleCase } from "@/lib/dashboard/format";

export function HomeView({
  data,
  openCustomer = () => undefined,
  openFeature = () => undefined,
  openFeedback,
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
    queryKey: ["home-customers", data.workspace.id, productId],
    queryFn: () => fetchCustomersPage(data.workspace.id, { productId: productId ?? "", limit: 8 }),
    enabled: Boolean(productId),
  });
  const features = useQuery({
    queryKey: ["home-features", data.workspace.id, productId],
    queryFn: () => fetchFeaturesPage(data.workspace.id, { productId: productId ?? "", limit: 8 }),
    enabled: Boolean(productId),
  });
  const customerPage = customers.data;
  const featurePage = features.data;
  const featureItems = Array.isArray(featurePage?.features) ? featurePage.features : [];
  const customerItems = Array.isArray(customerPage?.customers) ? customerPage.customers : [];
  const leadingFeature = featureItems[0];
  const needsSetup = data.insights.opportunities === 0 && isEditor(data.currentRole);
  const recentReports = data.reports.slice(0, 5);
  const outcomeReports = data.insights.reports;
  const helpedReports = data.insights.impacts
    .filter((impact) => impact.name === "helped" || impact.name === "healthy")
    .reduce((total, impact) => total + impact.count, 0);
  const outcomeSuccessRate = outcomeReports
    ? Math.round((helpedReports / outcomeReports) * 100)
    : null;

  async function refreshHome() {
    await Promise.all([refresh(), customers.refetch(), features.refetch()]);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <section aria-labelledby="customer-readout-title" className="border bg-background">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 bg-attention" />
                Customer intelligence · last {data.insights.windowDays} days
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refreshHome()}>
                Refresh
              </Button>
            </div>
            <h2 id="customer-readout-title" className="mt-4 max-w-2xl text-2xl font-medium">
              {readoutHeadline(leadingFeature, customerPage?.rollup?.atRisk ?? 0, data)}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {readoutDetail(leadingFeature, customerPage?.rollup?.atRisk ?? 0, data)}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {needsSetup ? (
                <Button onClick={() => navigateToDashboardView("setup")}>Finish setup</Button>
              ) : null}
              {leadingFeature ? (
                <Button variant="outline" onClick={() => openFeature(leadingFeature.key)}>
                  Review evidence
                  <IconArrowUpRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button variant="outline" onClick={() => navigateToDashboardView("features")}>
                  Explore features
                  <IconArrowUpRight data-icon="inline-end" />
                </Button>
              )}
            </div>
          </div>
          <div className="border-t p-5 lg:border-t-0 lg:border-l">
            <h3 className="text-sm font-medium">Evidence coverage</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Collection health, not a claim about customer identity
            </p>
            <dl className="mt-4 grid gap-3 text-xs">
              <CompactMetric label="Opportunities" value={data.insights.opportunities} />
              <CompactMetric
                label="Confirmed interactions"
                value={data.insights.confirmedInteractions}
              />
              <CompactMetric label="Outcome reports" value={data.insights.reports} />
              <CompactMetric label="Review coverage" value={`${data.insights.reviewRate}%`} />
            </dl>
          </div>
        </div>
      </section>

      <section aria-labelledby="customer-health-title" className="border bg-background">
        <SectionHeader id="customer-health-title" title="Customer health" />
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">
          <Metric
            label="Customers observed"
            value={customerPage?.rollup?.customers ?? 0}
            detail="Known and anonymous actors"
          />
          <Metric
            label="Verified customers"
            value={customerPage?.rollup?.verified ?? 0}
            detail="Company-authorized identity"
          />
          <Metric
            label="At risk"
            value={customerPage?.rollup?.atRisk ?? 0}
            detail="Blocked or hindered outcomes"
          />
          <Metric
            label="Outcome success"
            value={outcomeSuccessRate === null ? "—" : `${outcomeSuccessRate}%`}
            detail="Helped outcomes among reports"
          />
        </dl>
      </section>

      <section aria-labelledby="needs-title" className="border bg-background">
        <SectionHeader
          id="needs-title"
          title="Needs and opportunities"
          description="Ranked by affected customers and linked evidence"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("features")}>
              View all features
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        {features.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Feature intelligence could not be loaded.
          </p>
        ) : features.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading customer needs…</p>
        ) : featureItems.length ? (
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Need or opportunity</TableHead>
                <TableHead>Customers</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead className="pr-4 text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {featureItems.slice(0, 6).map((feature) => (
                <TableRow key={feature.key}>
                  <TableCell className="max-w-lg pl-4">
                    <Button
                      variant="link"
                      className="h-auto justify-start whitespace-normal p-0 text-left"
                      onClick={() => openFeature(feature.key)}
                    >
                      {feature.title}
                    </Button>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {feature.summary}
                    </p>
                  </TableCell>
                  <TableCell>{feature.affectedCustomerCount}</TableCell>
                  <TableCell>{feature.evidenceCount}</TableCell>
                  <TableCell>
                    <OutcomeHealth value={feature.strongestImpact} />
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {feature.trend === null
                      ? "—"
                      : `${feature.trend > 0 ? "+" : ""}${feature.trend}%`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            No evidence-backed customer needs yet.
          </p>
        )}
      </section>

      <section aria-labelledby="customers-title" className="border bg-background">
        <SectionHeader
          id="customers-title"
          title="Customers requiring attention"
          description="Identity level and outcome health stay explicitly separate"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("customers")}>
              View all customers
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        {customers.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Customer intelligence could not be loaded.
          </p>
        ) : customers.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading customers…</p>
        ) : customerItems.length ? (
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Needs</TableHead>
                <TableHead className="pr-4 text-right">Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customerItems.slice(0, 6).map((customer) => (
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
                  <TableCell>
                    <OutcomeHealth value={customer.outcomeHealth} />
                  </TableCell>
                  <TableCell>{customer.activeNeedCount}</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {relativeDate(customer.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">No customers observed yet.</p>
        )}
      </section>

      <section aria-labelledby="recent-evidence-title" className="border bg-background">
        <SectionHeader
          id="recent-evidence-title"
          title="Recent outcome evidence"
          description="Feedback remains evidence throughout the product"
        />
        {recentReports.length ? (
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Summary</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead className="pr-4 text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentReports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="max-w-md pl-4">
                    <Button
                      variant="link"
                      className="h-auto justify-start whitespace-normal p-0 text-left"
                      onClick={() => openFeedback(report.id)}
                    >
                      {report.summary}
                    </Button>
                  </TableCell>
                  <TableCell>{titleCase(report.impact ?? "unknown")}</TableCell>
                  <TableCell className="font-mono text-xs">{report.operation}</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {relativeDate(report.occurredAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">No outcome evidence yet.</p>
        )}
      </section>
    </div>
  );
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

function readoutHeadline(feature: FeatureSummary | undefined, atRisk: number, data: DashboardData) {
  if (feature) return `${feature.title} is the leading customer need.`;
  if (atRisk > 0)
    return `${atRisk} ${atRisk === 1 ? "customer needs" : "customers need"} attention.`;
  if (data.insights.confirmedInteractions > 0)
    return "Customer activity is arriving without enough semantic evidence yet.";
  return "No customer intelligence has been collected yet.";
}

function readoutDetail(feature: FeatureSummary | undefined, atRisk: number, data: DashboardData) {
  if (feature) {
    return `${feature.affectedCustomerCount} customers are affected across ${feature.evidenceCount} evidence items. Open the feature to inspect the exact signals and journeys behind this result.`;
  }
  if (atRisk > 0) return "Review the exact outcomes, needs, and sessions behind the at-risk group.";
  if (data.insights.confirmedInteractions > 0) {
    return "Confirmed product use exists, but customer intent and outcome reports are still sparse.";
  }
  return "Finish setup and send a product request to begin collecting permissioned evidence.";
}

type VisibleDashboardView = "customers" | "features" | "sessions" | "setup";

function navigateToDashboardView(view: VisibleDashboardView) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  for (const parameter of ["customer", "feature", "report", "session", "interaction"]) {
    url.searchParams.delete(parameter);
  }
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
