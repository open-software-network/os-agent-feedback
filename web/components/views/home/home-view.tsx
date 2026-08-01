import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardData } from "@/lib/api/dashboard";
import {
  formatDuration,
  interfaceLabel,
  isEditor,
  relativeDate,
  titleCase,
} from "@/lib/dashboard/format";
import { reportFindings } from "@/lib/dashboard/reports";
import { cn } from "@/lib/utils";

type InsightCount = { name: string; count: number };
type VisibleDashboardView = "feedback" | "sessions" | "setup";

const impactTone: Record<string, string> = {
  blocked: "bg-impact-negative",
  hindered: "bg-impact-warning",
  helped_with_friction: "bg-impact-caution",
  helped: "bg-impact-positive",
  neutral: "bg-muted-foreground",
  unknown: "bg-border",
  unspecified: "bg-border",
};

export function HomeView({
  data,
  openFeedback,
  refresh,
}: {
  data: DashboardData;
  openFeedback: (reportId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const insights = data.insights;
  const needsSetup = insights.opportunities === 0 && isEditor(data.currentRole);
  const feedbackGap = Math.max(insights.confirmedInteractions - insights.reports, 0);
  const topBlockingTopic = insights.blockingTopics[0];
  const blockingByTopic = new Map(
    insights.blockingTopics.map((topic) => [topic.name, topic.count]),
  );
  const leadingBlockerReport = topBlockingTopic
    ? data.reports.find((report) =>
        reportFindings(report).some(
          (finding) => finding.severity === "blocking" && finding.topic === topBlockingTopic.name,
        ),
      )
    : undefined;
  const recentThreshold = Date.now() - insights.windowDays * 24 * 60 * 60 * 1000;
  const recentReports = data.reports
    .filter((report) => new Date(report.occurredAt).getTime() >= recentThreshold)
    .slice(0, 5);
  const comparison = [
    {
      label: "Opportunities",
      recent: insights.recentOpportunities,
      previous: insights.previousOpportunities,
    },
    {
      label: "Confirmed",
      recent: insights.recentConfirmedInteractions,
      previous: insights.previousConfirmedInteractions,
    },
    {
      label: "Reports",
      recent: insights.recentReports,
      previous: insights.previousReports,
    },
  ];

  function openLeadingFeedback() {
    if (leadingBlockerReport) {
      openFeedback(leadingBlockerReport.id);
      return;
    }
    navigateToDashboardView("feedback");
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <section aria-labelledby="current-readout-title" className="border bg-background">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 bg-attention" />
                Last {insights.windowDays} days
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                Refresh
              </Button>
            </div>
            <h2 id="current-readout-title" className="mt-4 max-w-2xl text-2xl font-medium">
              {readoutHeadline(insights)}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {readoutDetail(insights)}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              {countLabel(
                feedbackGap,
                "confirmed use without feedback",
                "confirmed uses without feedback",
              )}{" "}
              ·{" "}
              {countLabel(
                insights.reportsWithWorkarounds,
                "report with a workaround",
                "reports with workarounds",
              )}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {needsSetup ? (
                <Button onClick={() => navigateToDashboardView("setup")}>Finish setup</Button>
              ) : null}
              <Button variant="outline" onClick={openLeadingFeedback}>
                {leadingBlockerReport ? "Review leading blocker" : "Browse feedback"}
                <IconArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </div>

          <div className="border-t p-5 lg:border-t-0 lg:border-l">
            <h3 className="text-sm font-medium">Recent comparison</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Two {insights.comparisonDays}-day periods
            </p>
            <Table className="mt-3 text-xs">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-0 text-muted-foreground">Signal</TableHead>
                  <TableHead className="h-8 px-1 text-right text-muted-foreground">
                    Recent
                  </TableHead>
                  <TableHead className="h-8 px-1 text-right text-muted-foreground">Prior</TableHead>
                  <TableHead className="h-8 px-0 text-right text-muted-foreground">
                    Change
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.map((item) => (
                  <TableRow key={item.label} className="hover:bg-transparent">
                    <TableCell className="px-0 py-2">{item.label}</TableCell>
                    <TableCell className="px-1 py-2 text-right">{item.recent}</TableCell>
                    <TableCell className="px-1 py-2 text-right text-muted-foreground">
                      {item.previous}
                    </TableCell>
                    <TableCell className="px-0 py-2 text-right">
                      {formatDelta(item.recent, item.previous)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <section aria-labelledby="evidence-pipeline-title" className="border bg-background">
        <SectionHeader id="evidence-pipeline-title" title="Evidence pipeline" />
        <dl className="grid sm:grid-cols-3 sm:divide-x">
          <PipelineStage
            label="Opportunities"
            value={insights.opportunities}
            detail="Eligible responses"
          />
          <PipelineStage
            label="Confirmed"
            value={insights.confirmedInteractions}
            detail={`${insights.confirmationRate}% confirmation`}
          />
          <PipelineStage
            label="Reports"
            value={insights.reports}
            detail={`${insights.reviewRate}% coverage`}
          />
        </dl>
      </section>

      <section aria-labelledby="feedback-patterns-title" className="border bg-background">
        <SectionHeader id="feedback-patterns-title" title="Feedback patterns" />
        <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
          <div className="border-b p-4 lg:border-r lg:border-b-0">
            <h3 className="text-sm font-medium">Top topics</h3>
            <CountList
              items={insights.topics}
              empty="No topics reported yet."
              metadata={(item) => {
                const blockingCount = blockingByTopic.get(item.name);
                return blockingCount ? `${blockingCount} blocking` : null;
              }}
            />
          </div>
          <div className="divide-y">
            <div className="p-4">
              <h3 className="text-sm font-medium">Impact</h3>
              <CountList items={insights.impacts} empty="No impact data yet." showTone />
            </div>
            <div className="p-4">
              <h3 className="text-sm font-medium">Finding types</h3>
              <CountList items={insights.findingKinds} empty="No findings reported yet." />
            </div>
          </div>
        </div>

        <Separator />

        <div>
          <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-4 pb-2">
            <h3 className="text-sm font-medium">Recent feedback</h3>
            <span className="text-xs text-muted-foreground">{recentReports.length} shown</span>
          </div>
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
            <p className="px-4 py-8 text-sm text-muted-foreground">No feedback in this window.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="usage-reliability-title" className="border bg-background">
        <SectionHeader
          id="usage-reliability-title"
          title="Usage and reliability"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("sessions")}>
              Explore sessions
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
          <div className="border-b p-4 lg:border-r lg:border-b-0">
            <h3 className="text-sm font-medium">Top operations</h3>
            <CountList
              items={insights.topOperations}
              empty="No operations recorded yet."
              technical
            />
          </div>
          <div className="p-4">
            <h3 className="text-sm font-medium">Surfaces</h3>
            <CountList
              items={insights.surfaces}
              empty="No surfaces recorded yet."
              label={interfaceLabel}
            />
            <Separator className="my-4" />
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-medium">Latency</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Across interactions that supplied timing
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-5 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">P50</dt>
                  <dd className="mt-1 font-medium">{formatDuration(insights.p50DurationMs)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">P95</dt>
                  <dd className="mt-1 font-medium">{formatDuration(insights.p95DurationMs)}</dd>
                </div>
              </dl>
            </div>
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              {data.listState.sessionsTotal} sessions recorded
            </p>
          </div>
        </div>
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

function PipelineStage({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="min-w-0 border-b p-4 last:border-b-0 sm:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl font-medium">{value}</dd>
      <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function CountList({
  items,
  empty,
  metadata,
  label,
  showTone = false,
  technical = false,
}: {
  items: InsightCount[];
  empty: string;
  metadata?: (item: InsightCount) => string | null;
  label?: (value: string) => string;
  showTone?: boolean;
  technical?: boolean;
}) {
  if (!items.length) {
    return <p className="mt-3 text-sm text-muted-foreground">{empty}</p>;
  }

  return (
    <ol className="mt-2 divide-y">
      {items.slice(0, 6).map((item) => {
        const secondary = metadata?.(item);
        return (
          <li
            key={item.name}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2.5 text-sm"
          >
            <div className="flex min-w-0 items-center gap-2">
              {showTone ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-[1px]",
                    impactTone[item.name] ?? "bg-muted-foreground",
                  )}
                />
              ) : null}
              <span className={cn("truncate", technical && "font-mono text-xs")}>
                {technical ? item.name : (label?.(item.name) ?? titleCase(item.name))}
              </span>
              {secondary ? (
                <span className="shrink-0 text-xs text-impact-negative">{secondary}</span>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">{item.count}</span>
          </li>
        );
      })}
    </ol>
  );
}

function readoutHeadline(insights: DashboardData["insights"]): string {
  if (insights.opportunities === 0) return "No product activity has been recorded yet.";
  if (insights.reportsWithBlockers > 0) {
    return `${countLabel(insights.reportsWithBlockers, "report contained", "reports contained")} blocking findings.`;
  }
  if (insights.reports > 0) return "No blocking findings were reported.";
  return "Product activity is arriving without feedback yet.";
}

function readoutDetail(insights: DashboardData["insights"]): string {
  const topBlockingTopic = insights.blockingTopics[0];
  if (topBlockingTopic) {
    return `${titleCase(topBlockingTopic.name)} is the leading blocking topic with ${countLabel(topBlockingTopic.count, "finding", "findings")}.`;
  }
  if (insights.reports > 0) {
    return `${countLabel(insights.reports, "report captures", "reports capture")} agent outcomes in this window.`;
  }
  if (insights.confirmedInteractions > 0) {
    return `${countLabel(insights.confirmedInteractions, "interaction is", "interactions are")} confirmed, with no feedback reports in this window.`;
  }
  return "Complete setup and send a product request to begin building evidence.";
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatDelta(current: number, previous: number): string {
  const change = current - previous;
  if (change === 0) return "0";
  return `${change > 0 ? "+" : ""}${change}`;
}

function navigateToDashboardView(view: VisibleDashboardView) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  url.searchParams.delete("report");
  url.searchParams.delete("session");
  url.searchParams.delete("interaction");
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
