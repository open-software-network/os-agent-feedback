import { Metrics, PageHeader, Panel } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardData } from "@/lib/api/dashboard";
import { formatDuration, relativeDate, titleCase } from "@/lib/dashboard/format";

export function HomeView({
  data,
  openFeedback,
  refresh,
}: {
  data: DashboardData;
  openFeedback: (reportId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const recentThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentReports = data.reports
    .filter((report) => new Date(report.occurredAt).getTime() >= recentThreshold)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={data.currentProduct?.name ?? "No product selected"}
        title="Home"
        description="A current overview of product usage and agent feedback."
        actions={
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />

      <Metrics
        items={[
          { label: "Interactions", value: data.listState.interactionsTotal },
          { label: "Feedback reports", value: data.insights.reports },
          { label: "Opportunities", value: data.insights.opportunities },
          { label: "Review rate", value: `${data.insights.reviewRate}%` },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Feedback health">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Confirmed interactions" value={data.insights.confirmedInteractions} />
            <Stat label="Confirmation rate" value={`${data.insights.confirmationRate}%`} />
            <Stat label="With blockers" value={data.insights.reportsWithBlockers} />
            <Stat label="With workarounds" value={data.insights.reportsWithWorkarounds} />
          </dl>
        </Panel>
        <Panel title="Latency">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="P50" value={formatDuration(data.insights.p50DurationMs)} />
            <Stat label="P95" value={formatDuration(data.insights.p95DurationMs)} />
          </dl>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <InsightList title="Top operations" items={data.insights.topOperations} />
        <InsightList title="Top topics" items={data.insights.topics} />
        <InsightList title="Impact" items={data.insights.impacts} />
      </div>

      <Panel title="Recent feedback (30 days)">
        {recentReports.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Summary</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentReports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => openFeedback(report.id)}
                    >
                      {report.summary}
                    </Button>
                  </TableCell>
                  <TableCell>{titleCase(report.impact ?? "unknown")}</TableCell>
                  <TableCell>{report.operation}</TableCell>
                  <TableCell>{relativeDate(report.occurredAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No feedback in the last 30 days.</p>
        )}
      </Panel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function InsightList({
  title,
  items,
}: {
  title: string;
  items: Array<{ name: string; count: number }>;
}) {
  return (
    <Panel title={title}>
      {items.length ? (
        <ol className="space-y-2 text-sm">
          {items.slice(0, 5).map((item) => (
            <li className="flex justify-between gap-4" key={item.name}>
              <span>{titleCase(item.name)}</span>
              <span className="text-muted-foreground">{item.count}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No data yet.</p>
      )}
    </Panel>
  );
}
