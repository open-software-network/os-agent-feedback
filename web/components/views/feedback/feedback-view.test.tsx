import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { ProductFeedbackReport } from "@/lib/api/dashboard";
import type { ProductReportGroup } from "@/lib/api/groups";

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

  it("defaults to reports and loads read-only grouped signals on demand", async () => {
    const data = dashboardFixture();
    const selectReport = vi.fn();
    const groups = {
      groups: [
        {
          explanation: "Agents repeatedly hit authorization failures during setup.",
          githubIssue: {
            issueNumber: 42,
            repoFullName: "open-software/epode",
            state: "open",
            url: "https://github.com/open-software/epode/issues/42",
          },
          groupKey: "authorization-setup",
          latestOccurredAt: "2026-07-30T12:00:00Z",
          reportCount: 7,
        },
        {
          explanation:
            "product 22222222-2222-4222-8222-222222222222 · operation refund_create · surface mcp · defect/idempotency · 5xx",
          githubIssue: null,
          groupKey: "c86875b212d12aa37bb9a3fff09787d6",
          latestOccurredAt: "2026-07-30T12:00:00Z",
          reportCount: 2,
        },
      ],
      hasMore: false,
      limit: 100,
      offset: 0,
    };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({ reports: data.reports, total: data.reports.length, limit: 50, nextCursor: null }),
        );
      }
      if (path.includes("/groups?")) return Promise.resolve(json(groups));
      if (path.endsWith("/github-repo")) return Promise.resolve(json(null));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={data.reports[0].id}
        selectReport={selectReport}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(screen.getByText("Reports").closest("button")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByText("Signals"));

    expect(selectReport).toHaveBeenCalledWith(null);
    expect(
      await screen.findByText("Agents repeatedly hit authorization failures during setup."),
    ).toBeVisible();
    expect(screen.getByText("refund_create")).toBeVisible();
    expect(screen.getByText("Defect / Idempotency · HTTP 5xx")).toBeVisible();
    expect(screen.queryByText(/22222222-2222-4222-8222-222222222222/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/products/${data.currentProduct?.id}/groups?limit=50&offset=0`),
      expect.any(Object),
    );
    expect(await screen.findByRole("link", { name: "open-software/epode#42" })).toHaveAttribute(
      "href",
      "https://github.com/open-software/epode/issues/42",
    );
    expect(screen.queryByRole("dialog", { name: "Feedback detail" })).not.toBeInTheDocument();
  });

  it("loads additional signal pages and points unmapped products to Connectors", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const first = reportGroup();
    const second = reportGroup({
      groupKey: "search:http:timeout",
      explanation: "Grouped by search timeouts over HTTP.",
      reportCount: 1,
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) return Promise.resolve(json(null));
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(json({ groups: [first], hasMore: true, limit: 50, offset: 0 }));
      }
      if (path === groupsPath(productId, 50, 50)) {
        return Promise.resolve(json({ groups: [second], hasMore: false, limit: 50, offset: 50 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));

    expect(await screen.findByText(first.explanation)).toBeVisible();
    expect(screen.queryByRole("button", { name: "File GitHub issue" })).not.toBeInTheDocument();
    expect(screen.getByText(/map this product to a GitHub repository/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Connectors" })).toHaveAttribute(
      "href",
      `/?view=connectors&team=${data.workspace.id}&product=${productId}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText(second.explanation)).toBeVisible();
    expect(screen.getByText(first.explanation)).toBeVisible();
    expect(screen.queryByText(first.groupKey)).not.toBeInTheDocument();
    expect(screen.queryByText(second.groupKey)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("offset=50"))).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("x-workspace-id")).toBe(data.workspace.id);
    }
  });

  it("files a GitHub issue from a signal and renders the refetched link", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const group = reportGroup();
    const issue = {
      repoFullName: "open-software-network/os-epode",
      issueNumber: 42,
      url: "https://github.com/open-software-network/os-epode/issues/42",
      state: "open",
    };
    let filed = false;
    let resolveIssue: ((response: Response) => void) | undefined;
    const pendingIssue = new Promise<Response>((resolve) => {
      resolveIssue = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: [{ ...group, githubIssue: filed ? issue : null }],
            hasMore: false,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === issuePath(group.groupKey) && init?.method === "POST") return pendingIssue;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));
    expect(await screen.findByRole("button", { name: "Filing…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    filed = true;
    await act(async () => resolveIssue?.(json(issue, 201)));

    expect(
      await screen.findByRole("link", { name: "open-software-network/os-epode#42" }),
    ).toHaveAttribute("href", issue.url);
    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === issuePath(group.groupKey) && init?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
    expect(new Headers(postCalls[0][1].headers).get("x-workspace-id")).toBe(data.workspace.id);
  });

  it("surfaces a 409 filing conflict and reconciles with Check again", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const group = reportGroup();
    const message = "GitHub issue reconciliation is in progress for this feedback group";
    let groupVisible = true;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: groupVisible ? [group] : [],
            hasMore: false,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === issuePath(group.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 409));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));

    expect(await screen.findByText(message, { exact: false })).toBeVisible();
    groupVisible = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("No signals yet")).toBeVisible();
    expect(screen.queryByText(group.groupKey)).not.toBeInTheDocument();
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument();
  });

  it("keeps workflow editing in the rail's compact single-column layout", () => {
    const data = dashboardFixture();
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

    const form = screen.getByRole("combobox", { name: "Status" }).closest("form");
    expect(form).toBeInTheDocument();
    expect(form).not.toHaveClass("sm:grid-cols-2");
    expect(screen.getByRole("button", { name: "Save triage" })).toBeVisible();
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

function reportGroup(overrides: Partial<ProductReportGroup> = {}): ProductReportGroup {
  return {
    groupKey: "search:http:bug:freshness:2xx",
    explanation: "Grouped by operation, surface, finding, and status class.",
    reportCount: 3,
    latestOccurredAt: "2026-07-30T12:00:00Z",
    githubIssue: null,
    ...overrides,
  };
}

function repositoryMapping(productId: string) {
  return {
    productId,
    installationId: 101,
    repoFullName: "open-software-network/os-epode",
    defaultBranch: "main",
    pathPrefix: null,
    createdAt: "2026-07-30T12:00:00Z",
    updatedAt: "2026-07-30T12:00:00Z",
  };
}

function groupsPath(productId: string, limit: number, offset: number): string {
  return `/api/products/${productId}/groups?limit=${limit}&offset=${offset}`;
}

function issuePath(groupKey: string): string {
  return `/api/groups/${encodeURIComponent(groupKey)}/github-issue`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
