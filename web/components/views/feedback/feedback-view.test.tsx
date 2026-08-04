import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { ProductFeedbackReport } from "@/lib/api/dashboard";

import { createEmptyFilters } from "./feedback-filters";
import { FeedbackView, filterFeedbackReports } from "./feedback-view";

describe("FeedbackView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?view=feedback");
  });

  it("combines multiple values within a facet and facets across the result set", () => {
    const data = dashboardFixture();
    const resolved = reportVariant(data.reports[0], {
      id: "77777777-7777-4777-8777-777777777771",
      impact: "helped",
      summary: "Agent completed the recovery flow",
      workflowStatus: "resolved",
    });
    const planned = reportVariant(data.reports[0], {
      id: "77777777-7777-4777-8777-777777777772",
      impact: "blocked",
      summary: "Agent could not retry the operation",
      workflowStatus: "planned",
    });
    const filters = createEmptyFilters();
    filters.status = ["new", "resolved"];
    filters.impact = ["helped"];

    const result = filterFeedbackReports([data.reports[0], resolved, planned], {
      filters,
      query: "",
      range: "all",
    });

    expect(result.map((report) => report.id)).toEqual([resolved.id]);
  });

  it("serializes quick filters and exposes their removable state", async () => {
    const data = dashboardFixture();
    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={null}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "New" }));

    expect(screen.getByRole("button", { name: "Clear Workflow filter" })).toBeVisible();
    await waitFor(() => expect(window.location.search).toContain("status=new"));

    fireEvent.click(screen.getByRole("button", { name: "Clear Workflow filter" }));
    await waitFor(() => expect(window.location.search).not.toContain("status="));
  });

  it("resolves a legacy group backlink to the exact retained reports", async () => {
    const data = dashboardFixture();
    const groupKey = "6910e1b05a001949e02f04db6d67d013";
    window.history.replaceState({}, "", `/?view=feedback&group=${groupKey}`);
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({
            reports: data.reports,
            total: 1,
            facets: feedbackFacets(),
            limit: 50,
            nextCursor: null,
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);

    expect(await screen.findByText("Grouped feedback · 1 matching report")).toBeVisible();
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([input]) =>
        String(input).startsWith("/api/dashboard/feedback?"),
      );
      expect(request).toBeDefined();
      const url = new URL(String(request?.[0]), "https://app.epode.ai");
      expect(url.searchParams.get("groupKey")).toBe(groupKey);
      expect(url.searchParams.has("since")).toBe(false);
      expect(new URL(window.location.href).searchParams.get("range")).toBe("all");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all feedback" }));
    await waitFor(() =>
      expect(new URL(window.location.href).searchParams.has("group")).toBe(false),
    );
  });

  it("paginates the complete server-filtered result and fetches a selected report outside it", async () => {
    const complete = dashboardFixture();
    const report = complete.reports[0];
    const data = dashboardFixture({
      reports: [],
      listState: { ...complete.listState, reportsLoaded: 0, reportsTotal: 501 },
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/feedback?") && path.includes("cursor=next-page")) {
        return Promise.resolve(
          json({ reports: [report], total: 501, limit: 50, nextCursor: null }),
        );
      }
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({ reports: [], total: 501, limit: 50, nextCursor: "next-page" }),
        );
      }
      if (path.includes(`/api/dashboard/reports/${report.id}?`)) {
        return Promise.resolve(json({ report }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const list = renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={null}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Filters cover all retained feedback/)).toBeVisible();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).startsWith("/api/dashboard/feedback?"),
        ),
      ).toBe(true),
    );
    list.unmount();

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

    expect(await screen.findByRole("heading", { name: report.summary })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/dashboard/reports/${report.id}?productId=`),
      expect.any(Object),
    );
  });

  it("offers counted facets from outside the loaded page and retains them when selected", async () => {
    const complete = dashboardFixture();
    const data = dashboardFixture({
      reports: [],
      listState: { ...complete.listState, reportsLoaded: 0, reportsTotal: 7 },
    });
    const facets = {
      status: [{ name: "new", count: 7 }],
      impact: [{ name: "blocked", count: 7 }],
      surface: [{ name: "mcp", count: 7 }],
      topic: [{ name: "outside_page", count: 7 }],
      findingKind: [{ name: "defect", count: 7 }],
      severity: [{ name: "blocking", count: 7 }],
      tag: [],
      assignee: [{ name: "unassigned", count: 7 }],
      workaround: [{ name: "none", count: 7 }],
    };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({
            reports: [],
            total: path.includes("topic=outside_page") ? 0 : 7,
            facets,
            limit: 50,
            nextCursor: null,
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);

    expect(await screen.findByText(/Filters cover all retained feedback/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Topic" }));
    const option = await screen.findByRole("checkbox", { name: "Outside Page" });
    expect(within(option.closest("div") as HTMLElement).getByText("7")).toBeVisible();

    fireEvent.click(option);

    await waitFor(() => {
      expect(window.location.search).toContain("topic=outside_page");
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("topic=outside_page")),
      ).toBe(true);
    });
    expect(screen.getByRole("checkbox", { name: "Outside Page" })).toBeChecked();
  });

  it("debounces feedback search before issuing a server request", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({
            reports: data.reports,
            total: data.reports.length,
            limit: 50,
            nextCursor: null,
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    const search = screen.getByRole("textbox", { name: "Search feedback" });
    fireEvent.change(search, { target: { value: "t" } });
    fireEvent.change(search, { target: { value: "ti" } });
    fireEvent.change(search, { target: { value: "timeout" } });

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("q=timeout"))).toBe(false);
    await waitFor(() => {
      const searched = fetchMock.mock.calls.filter(([input]) => String(input).includes("q="));
      expect(searched).toHaveLength(1);
      expect(String(searched[0][0])).toContain("q=timeout");
    });
  });

  it("places source actions and compact team workflow directly below the feedback header", async () => {
    const data = dashboardFixture();
    const openInteraction = vi.fn();
    const openSession = vi.fn();
    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={data.reports[0].id}
        selectReport={vi.fn()}
        openInteraction={openInteraction}
        openSession={openSession}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    const summary = screen.getByRole("heading", { name: data.reports[0].summary });
    const summarySection = summary.closest("section");
    const sourceActions = screen.getByRole("navigation", { name: "Source actions" });
    expect(summarySection).toContainElement(sourceActions);
    fireEvent.click(within(sourceActions).getByRole("button", { name: "Open interaction" }));
    fireEvent.click(within(sourceActions).getByRole("button", { name: "Open linked session" }));
    expect(openInteraction).toHaveBeenCalledWith(data.reports[0].interactionId);
    expect(openSession).toHaveBeenCalledWith(data.reports[0].sessionId);

    const workflow = screen.getByRole("region", { name: "Team workflow" });
    expect(within(workflow).getByText("Impact")).toBeVisible();
    expect(within(workflow).getByText("Status")).toBeVisible();
    expect(within(workflow).getByText("Assignee")).toBeVisible();
    expect(within(workflow).getByText("Tags")).toBeVisible();
    expect(
      within(workflow).getByRole("button", {
        name: "Change workflow status, currently New",
      }),
    ).toBeVisible();
    expect(
      within(workflow).getByRole("button", {
        name: "Change assignee, currently Unassigned",
      }),
    ).toBeVisible();
    expect(
      within(workflow).getByRole("button", { name: "Edit tags, currently none" }),
    ).toBeVisible();
    expect(within(workflow).getByRole("button", { name: "Edit internal note" })).toBeVisible();
    expect(screen.getByText("Response", { selector: "span" })).toBeVisible();
    expect(screen.getByText("Report ID")).toBeVisible();
    expect(screen.getByText(data.reports[0].id)).toBeVisible();
    expect(screen.queryByText("Metadata")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save triage" })).not.toBeInTheDocument();

    const dividers = screen.getAllByRole("separator");
    expect(dividers).toHaveLength(data.reports[0].workaround ? 3 : 2);
    for (const divider of dividers) expect(divider).toHaveClass("-mx-5", "w-auto");

    fireEvent.click(within(workflow).getByRole("button", { name: "Edit internal note" }));
    expect(await screen.findByRole("textbox", { name: "Internal note" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save note" })).toBeVisible();
  });

  it("renders the same metadata as quiet read-only values for members", () => {
    const data = dashboardFixture({ currentRole: "member" });
    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={data.reports[0].id}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    const workflow = screen.getByRole("region", { name: "Team workflow" });
    expect(within(workflow).getByText("New")).toBeVisible();
    expect(within(workflow).getByText("Unassigned")).toBeVisible();
    expect(within(workflow).getByText("No tags")).toBeVisible();
    expect(within(workflow).queryByRole("button")).not.toBeInTheDocument();
    expect(within(workflow).queryByText("Internal note")).not.toBeInTheDocument();
  });

  it("opens a report from the full row or its explicit accessible control", () => {
    const data = dashboardFixture();
    const selectReport = vi.fn();
    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={null}
        selectReport={selectReport}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    const row = screen.getByRole("row", { name: new RegExp(data.reports[0].summary) });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: data.reports[0].summary }));

    expect(selectReport).toHaveBeenNthCalledWith(1, data.reports[0].id);
    expect(selectReport).toHaveBeenNthCalledWith(2, data.reports[0].id);
  });
});

function reportVariant(
  report: ProductFeedbackReport,
  overrides: Partial<ProductFeedbackReport>,
): ProductFeedbackReport {
  return { ...report, ...overrides };
}

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function renderFeedback(data: ReturnType<typeof dashboardFixture>) {
  return renderWithQuery(
    <FeedbackView
      data={data}
      selectedReportId={null}
      selectReport={vi.fn()}
      openInteraction={vi.fn()}
      openSession={vi.fn()}
      loadMore={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
    />,
  );
}

function feedbackFacets() {
  return {
    status: [{ name: "new", count: 1 }],
    impact: [{ name: "blocked", count: 1 }],
    surface: [{ name: "mcp", count: 1 }],
    topic: [{ name: "freshness", count: 1 }],
    findingKind: [{ name: "defect", count: 1 }],
    severity: [{ name: "blocking", count: 1 }],
    tag: [],
    assignee: [{ name: "unassigned", count: 1 }],
    workaround: [{ name: "none", count: 1 }],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
