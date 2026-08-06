import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { FeedbackView } from "@/components/views/feedback/feedback-view";
import { HomeView } from "@/components/views/home/home-view";
import { SessionsView } from "@/components/views/sessions/sessions-view";
import { TeamView } from "@/components/views/team/team-view";
import type { DashboardData } from "@/lib/api/dashboard";

describe("observability onboarding states", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("keeps setup on Home and scrolls editors to it", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          customers: [],
          features: [],
          rollup: {},
          facets: {},
          limit: 8,
          nextCursor: null,
        }),
      ),
    );
    renderWithQuery(
      <HomeView
        data={emptyDashboard()}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(screen.getByRole("region", { name: "Setup" })).toBeVisible();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(new URL(window.location.href).searchParams.get("view")).toBeNull();
  });

  it("distinguishes first feedback from an empty filtered result", async () => {
    const data = emptyDashboard();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ reports: [], total: 0, limit: 50, nextCursor: null })),
    );
    renderWithQuery(feedbackView(data));

    expect(screen.getByText("No feedback yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Setup" }));

    expect(new URL(window.location.href).searchParams.get("view")).toBeNull();
    expect(window.location.hash).toBe("#setup");
  });

  it("does not flash unfiltered feedback while a server search is pending", async () => {
    const data = dashboardFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("q=missing")) return new Promise<Response>(() => {});
        return Promise.resolve(
          json({ reports: data.reports, total: 1, limit: 50, nextCursor: null }),
        );
      }),
    );
    renderWithQuery(feedbackView(data));

    expect(screen.getByRole("row", { name: /Search results omitted/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search feedback"), {
      target: { value: "missing" },
    });

    await waitFor(() =>
      expect(screen.queryByRole("row", { name: /Search results omitted/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Loading feedback…")).toBeVisible();
    expect(screen.queryByText("No matching feedback")).not.toBeInTheDocument();
  });

  it("explains why a product has no journeys instead of offering a no-op filter reset", () => {
    const data = emptyDashboard();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          sessions: [],
          rollup: { sessions: 0, interactions: 0, multiStepSessions: 0, averageInteractions: 0 },
          limit: 50,
          nextCursor: null,
        }),
      ),
    );
    renderWithQuery(sessionsView(data));

    expect(screen.getByText("No sessions yet")).toBeVisible();
    expect(screen.getAllByText(/stable session reference/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("does not flash unfiltered sessions while a server search is pending", async () => {
    const data = dashboardFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("q=missing")) return new Promise<Response>(() => {});
        return Promise.resolve(
          json({
            sessions: data.sessions,
            rollup: {
              sessions: 1,
              interactions: 1,
              multiStepSessions: 0,
              averageInteractions: 1,
            },
            limit: 50,
            nextCursor: null,
          }),
        );
      }),
    );
    renderWithQuery(sessionsView(data));

    expect(screen.getByRole("row", { name: /session-42/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search sessions"), {
      target: { value: "missing" },
    });

    await waitFor(() =>
      expect(screen.queryByRole("row", { name: /session-42/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Loading sessions…")).toBeVisible();
  });

  it("keeps team rename reachable inside the Configuration layout", async () => {
    const data = dashboardFixture();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const notice = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(json({ workspace: data.workspace }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamView data={data} refresh={refresh} setNotice={notice} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename team" }));
    fireEvent.change(screen.getByLabelText("Team name"), {
      target: { value: "Customer Experience" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/team",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Customer Experience" }),
      }),
    );
    expect(notice).toHaveBeenCalledWith("Team renamed.");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renders sub-millisecond timing and an explicitly unused workaround without implying missing data", () => {
    const base = dashboardFixture();
    const report = {
      ...base.reports[0],
      durationMs: 0,
      workaround: { used: false },
    };
    const data = dashboardFixture({ reports: [report] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ reports: [report], total: 1, limit: 50, nextCursor: null })),
    );
    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={report.id}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(screen.getByText("<1 ms")).toBeVisible();
    expect(screen.getByText("No workaround used")).toBeVisible();
    expect(screen.queryByText("Suggested workaround")).not.toBeInTheDocument();
    expect(screen.queryByText("No detail provided.")).not.toBeInTheDocument();
  });
});

function feedbackView(data: DashboardData) {
  return (
    <FeedbackView
      data={data}
      selectedReportId={null}
      selectReport={vi.fn()}
      openInteraction={vi.fn()}
      openSession={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
    />
  );
}

function sessionsView(data: DashboardData) {
  return (
    <SessionsView
      data={data}
      selectedSessionId={null}
      selectSession={vi.fn()}
      openFeedback={vi.fn()}
      openInteraction={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function emptyDashboard(): DashboardData {
  const base = dashboardFixture();
  const activationMilestones = base.activationMilestones;
  if (!activationMilestones) throw new Error("fixture requires activation milestones");
  return {
    ...base,
    interactions: [],
    reports: [],
    sessions: [],
    activationMilestones: {
      ...activationMilestones,
      firstOpportunityAt: null,
      firstConfirmedInteractionAt: null,
      firstReportAt: null,
    },
    insights: {
      ...base.insights,
      reports: 0,
      opportunities: 0,
      confirmedInteractions: 0,
      confirmationRate: 0,
      reviewRate: 0,
      recentReports: 0,
      previousReports: 0,
      recentOpportunities: 0,
      previousOpportunities: 0,
      recentConfirmedInteractions: 0,
      previousConfirmedInteractions: 0,
      reportsWithBlockers: 0,
      reportsWithWorkarounds: 0,
      p50DurationMs: null,
      p95DurationMs: null,
      impacts: [],
      findingKinds: [],
      topics: [],
      blockingTopics: [],
      surfaces: [],
      topOperations: [],
    },
    listState: {
      interactionsLoaded: 0,
      interactionsTotal: 0,
      reportsLoaded: 0,
      reportsTotal: 0,
      sessionsLoaded: 0,
      sessionsTotal: 0,
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
