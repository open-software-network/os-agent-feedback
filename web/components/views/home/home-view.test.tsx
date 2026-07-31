import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { DashboardData } from "@/lib/api/dashboard";
import { HomeView } from "./home-view";

describe("HomeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1");
  });

  it("orders the page from readout to evidence, patterns, and usage", () => {
    renderHome(richDashboardFixture());

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "3 reports contained blocking findings.",
      "Evidence pipeline",
      "Feedback patterns",
      "Usage and reliability",
    ]);

    const pipeline = screen.getByRole("region", { name: "Evidence pipeline" });
    expect(within(pipeline).getByText("32")).toBeVisible();
    expect(within(pipeline).getByText("26")).toBeVisible();
    expect(within(pipeline).getByText("18")).toBeVisible();
    expect(within(pipeline).getByText("81% confirmation")).toBeVisible();
    expect(screen.getByText("2 blocking")).toBeVisible();
    expect(screen.getByText("620ms")).toBeVisible();
    expect(screen.getByText("9.8s")).toBeVisible();
    expect(screen.queryByRole("button", { name: /interactions/i })).not.toBeInTheDocument();
  });

  it("keeps refresh and direct feedback drilldown behavior", () => {
    const data = richDashboardFixture();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const openFeedback = vi.fn();

    render(<HomeView data={data} refresh={refresh} openFeedback={openFeedback} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: data.reports[0].summary }));
    expect(openFeedback).toHaveBeenCalledWith(data.reports[0].id);

    fireEvent.click(screen.getByRole("button", { name: "Review leading blocker" }));
    expect(openFeedback).toHaveBeenLastCalledWith(data.reports[0].id);
  });

  it("routes aggregate exploration only to visible dashboard views", () => {
    const onPopState = vi.fn();
    window.addEventListener("popstate", onPopState);
    renderHome(dashboardFixture());

    fireEvent.click(screen.getByRole("button", { name: "Browse feedback" }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("feedback");
    expect(new URL(window.location.href).searchParams.get("team")).toBe("team-1");

    fireEvent.click(screen.getByRole("button", { name: "Explore sessions" }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("sessions");
    expect(new URL(window.location.href).searchParams.get("product")).toBe("product-1");
    expect(onPopState).toHaveBeenCalledTimes(2);

    window.removeEventListener("popstate", onPopState);
  });
});

function renderHome(data: DashboardData) {
  return render(
    <HomeView data={data} openFeedback={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} />,
  );
}

function richDashboardFixture(): DashboardData {
  const base = dashboardFixture();
  const occurredAt = new Date().toISOString();
  return {
    ...base,
    reports: [
      {
        ...base.reports[0],
        occurredAt,
        findings: [
          {
            kind: "defect",
            topic: "idempotency",
            detail: "The retry contract was ambiguous.",
            severity: "blocking",
          },
        ],
      },
    ],
    listState: {
      ...base.listState,
      sessionsTotal: 9,
    },
    insights: {
      ...base.insights,
      windowDays: 30,
      comparisonDays: 7,
      opportunities: 32,
      confirmedInteractions: 26,
      reports: 18,
      confirmationRate: 81,
      reviewRate: 69,
      recentOpportunities: 20,
      previousOpportunities: 12,
      recentConfirmedInteractions: 17,
      previousConfirmedInteractions: 9,
      recentReports: 12,
      previousReports: 6,
      reportsWithBlockers: 3,
      reportsWithWorkarounds: 10,
      p50DurationMs: 620,
      p95DurationMs: 9_800,
      blockingTopics: [
        { name: "idempotency", count: 2 },
        { name: "resumability", count: 1 },
      ],
      topics: [
        { name: "knowledge_freshness", count: 3 },
        { name: "idempotency", count: 2 },
      ],
      impacts: [
        { name: "helped", count: 4 },
        { name: "blocked", count: 3 },
      ],
      findingKinds: [
        { name: "strength", count: 7 },
        { name: "gap", count: 6 },
      ],
      topOperations: [
        { name: "/v1/knowledge/search", count: 6 },
        { name: "refund_create", count: 3 },
      ],
      surfaces: [
        { name: "mcp", count: 20 },
        { name: "http_json", count: 10 },
      ],
    },
  };
}
