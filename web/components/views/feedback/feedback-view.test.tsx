import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { ProductFeedbackReport } from "@/lib/api/dashboard";
import type { ProductReportGroup } from "@/lib/api/groups";

import { createEmptyFilters } from "./feedback-filters";
import { FeedbackView, filterFeedbackReports } from "./feedback-view";

const mergeSourceGroupKey = "a".repeat(32);
const mergeTargetGroupKey = "b".repeat(32);
const mergeOtherGroupKey = "c".repeat(32);

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

  it("keeps the loaded-page disclosure and fetches a selected report outside that page", async () => {
    const complete = dashboardFixture();
    const report = complete.reports[0];
    const data = dashboardFixture({
      reports: [],
      listState: { ...complete.listState, reportsLoaded: 0, reportsTotal: 501 },
    });
    const loadMore = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(json({ report }));
    vi.stubGlobal("fetch", fetchMock);

    const list = renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={null}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={loadMore}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(screen.getByText(/Filters apply to loaded reports/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load 250 more" }));
    expect(loadMore).toHaveBeenCalledOnce();
    list.unmount();

    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={report.id}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={loadMore}
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
    const fetchMock = vi.fn().mockResolvedValue(
      json({
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
      }),
    );
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

    expect(await screen.findByText(first.groupKey)).toBeVisible();
    expect(screen.getByText(first.explanation)).toBeVisible();
    expect(screen.queryByRole("button", { name: "File GitHub issue" })).not.toBeInTheDocument();
    expect(screen.getByText(/map this product to a GitHub repository/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Connectors" })).toHaveAttribute(
      "href",
      `/?view=connectors&team=${data.workspace.id}&product=${productId}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText(second.groupKey)).toBeVisible();
    expect(screen.getByText(first.groupKey)).toBeVisible();
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

    expect(await screen.findByRole("status")).toHaveTextContent(
      `GitHub issue filing for ${group.groupKey}: ${message}`,
    );
    groupVisible = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("No signals yet")).toBeVisible();
    expect(screen.queryByText(group.groupKey)).not.toBeInTheDocument();
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument();
  });

  it("names the group on a non-409 filing failure", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const group = reportGroup({ groupKey: "d".repeat(32) });
    const message = "GitHub issue filing is temporarily unavailable";
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(json({ groups: [group], hasMore: false, limit: 50, offset: 0 }));
      }
      if (path === issuePath(group.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 500));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      `GitHub issue filing for ${group.groupKey}: ${message}`,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("merges the acted-on source into the selected survivor and removes the source row", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({
      groupKey: mergeSourceGroupKey,
      explanation: "Grouped stale search results.",
      reportCount: 3,
    });
    const target = reportGroup({
      groupKey: mergeTargetGroupKey,
      explanation: "Grouped freshness failures.",
      reportCount: 5,
    });
    let merged = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: merged ? [{ ...target, reportCount: 8 }] : [source, target],
            hasMore: merged,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === groupsPath(productId, 50, 50)) {
        return Promise.resolve(json({ groups: [], hasMore: false, limit: 50, offset: 50 }));
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") {
        merged = true;
        return Promise.resolve(
          json({ reportsMoved: source.reportCount, targetGroupKey: target.groupKey }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));

    const targetPicker = screen.getByRole("combobox", {
      name: `Signal that survives merge of ${source.groupKey}`,
    });
    expect(
      Array.from(targetPicker.querySelectorAll("option")).some(
        (option) => option.value === source.groupKey,
      ),
    ).toBe(false);
    fireEvent.change(targetPicker, { target: { value: target.groupKey } });
    expect(screen.getAllByText(source.groupKey)).toHaveLength(2);
    expect(screen.getAllByText(target.groupKey)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      `Merged away ${source.groupKey} and moved 3 reports into ${target.groupKey}, which survives.`,
    );
    expect(
      screen.queryByRole("button", { name: `Merge signal ${source.groupKey}` }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(source.groupKey)).toHaveLength(1);
    expect(screen.getByText(source.groupKey).closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getAllByText(target.groupKey)).toHaveLength(2);

    const mergeCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === mergePath(source.groupKey) && init?.method === "POST",
    );
    expect(mergeCalls).toHaveLength(1);
    expect(new Headers(mergeCalls[0][1].headers).get("x-workspace-id")).toBe(data.workspace.id);
    expect(JSON.parse(String(mergeCalls[0][1].body))).toEqual({ intoGroupKey: target.groupKey });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input) === groupsPath(productId, 50, 50)),
      ).toBe(true),
    );
    expect(
      screen.queryByText(new RegExp(`Merged away ${source.groupKey}`)),
    ).not.toBeInTheDocument();
  });

  it.each([
    "Source GitHub issue #42 and target GitHub issue #43 are both filed; close one on GitHub before merging",
    `A GitHub issue filing is still in progress for ${mergeSourceGroupKey} (pending); retry the merge once it settles`,
  ])("renders the merge 409 verbatim and reconciles without closing the form: %s", async (message) => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({ groupKey: mergeSourceGroupKey });
    const target = reportGroup({ groupKey: mergeTargetGroupKey });
    let groupLoads = 0;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        groupLoads += 1;
        return Promise.resolve(
          json({ groups: [source, target], hasMore: false, limit: 50, offset: 0 }),
        );
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 409));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));
    fireEvent.change(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${source.groupKey}`,
      }),
      { target: { value: target.groupKey } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      `Merge source ${source.groupKey}: ${message}`,
    );
    expect(screen.getByText(message, { exact: false })).toBeVisible();
    expect(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${source.groupKey}`,
      }),
    ).toBeEnabled();
    const loadsBeforeCheck = groupLoads;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(groupLoads).toBeGreaterThan(loadsBeforeCheck));
    await waitFor(() =>
      expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));
    expect(await screen.findByText(message, { exact: false })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === mergePath(source.groupKey) && init?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("clears a selected target that disappears from the current listing", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({ groupKey: mergeSourceGroupKey });
    const target = reportGroup({ groupKey: mergeTargetGroupKey });
    const other = reportGroup({ groupKey: mergeOtherGroupKey });
    const message = `Target feedback group is already merged into ${other.groupKey}; merge into that final target directly`;
    let targetVisible = true;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: targetVisible ? [source, target, other] : [source, other],
            hasMore: false,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 409));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));
    const targetPicker = screen.getByRole("combobox", {
      name: `Signal that survives merge of ${source.groupKey}`,
    });
    fireEvent.change(targetPicker, { target: { value: target.groupKey } });
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));
    expect(await screen.findByText(message, { exact: false })).toBeVisible();

    targetVisible = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(targetPicker).toHaveValue(""));
    expect(
      Array.from(targetPicker.querySelectorAll("option")).some(
        (option) => option.value === target.groupKey,
      ),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Choose a surviving signal" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: `Merge away into ${target.groupKey}` }),
    ).not.toBeInTheDocument();
  });

  it("keeps merge confirmation visible when the refetched listing is empty", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({ groupKey: mergeSourceGroupKey, reportCount: 2 });
    const target = reportGroup({ groupKey: mergeTargetGroupKey });
    let merged = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: merged ? [] : [source, target],
            hasMore: false,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") {
        merged = true;
        return Promise.resolve(
          json({ reportsMoved: source.reportCount, targetGroupKey: target.groupKey }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));
    fireEvent.change(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${source.groupKey}`,
      }),
      { target: { value: target.groupKey } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));

    expect(await screen.findByText("No signals yet")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      `Merged away ${source.groupKey} and moved 2 reports into ${target.groupKey}, which survives.`,
    );
  });

  it("renders a non-409 merge failure as an error without reconciliation", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({ groupKey: mergeSourceGroupKey });
    const target = reportGroup({ groupKey: mergeTargetGroupKey });
    const message = "Merge service is temporarily unavailable";
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({ groups: [source, target], hasMore: false, limit: 50, offset: 0 }),
        );
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 500));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));
    fireEvent.change(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${source.groupKey}`,
      }),
      { target: { value: target.groupKey } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Merge source ${source.groupKey}: ${message}`,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }),
    ).toBeEnabled();
  });

  it("excludes self-merge and disables a target when both groups have GitHub issues", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const issue = {
      repoFullName: "open-software-network/os-epode",
      issueNumber: 42,
      url: "https://github.com/open-software-network/os-epode/issues/42",
      state: "open",
    };
    const source = reportGroup({ groupKey: mergeSourceGroupKey, githubIssue: issue });
    const target = reportGroup({
      groupKey: mergeTargetGroupKey,
      githubIssue: { ...issue, issueNumber: 43 },
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({ groups: [source, target], hasMore: false, limit: 50, offset: 0 }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    expect(await screen.findByRole("columnheader", { name: "Signal" })).toHaveClass("w-[44%]");
    expect(screen.getByRole("columnheader", { name: "Reports" })).toHaveClass("w-[10%]");
    expect(screen.getByRole("columnheader", { name: "Latest observed" })).toHaveClass("w-[16%]");
    expect(screen.getByRole("columnheader", { name: "GitHub issue" })).toHaveClass("w-[20%]");
    expect(screen.getByRole("columnheader", { name: "Actions" })).toHaveClass("w-[10%]");
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));

    const picker = screen.getByRole("combobox", {
      name: `Signal that survives merge of ${source.groupKey}`,
    });
    expect(picker.closest("td")).toHaveAttribute("colspan", "5");
    const options = Array.from(picker.querySelectorAll("option"));
    expect(options.some((option) => option.value === source.groupKey)).toBe(false);
    const targetOption = options.find((option) => option.value === target.groupKey);
    expect(targetOption).toBeDisabled();
    expect(targetOption).toHaveTextContent("unavailable: both signals have GitHub issues");
    expect(screen.getByRole("button", { name: "Choose a surviving signal" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/merge"))).toBe(false);
  });

  it("keeps Cancel and other row triggers usable while one merge is in flight", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const source = reportGroup({ groupKey: mergeSourceGroupKey });
    const target = reportGroup({ groupKey: mergeTargetGroupKey });
    const other = reportGroup({ groupKey: mergeOtherGroupKey });
    let resolveMerge: ((response: Response) => void) | undefined;
    const pendingMerge = new Promise<Response>((resolve) => {
      resolveMerge = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({ groups: [source, target, other], hasMore: false, limit: 50, offset: 0 }),
        );
      }
      if (path === mergePath(source.groupKey) && init?.method === "POST") return pendingMerge;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
    fireEvent.click(await screen.findByRole("button", { name: `Merge signal ${source.groupKey}` }));
    fireEvent.change(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${source.groupKey}`,
      }),
      { target: { value: target.groupKey } },
    );
    fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));

    const cancel = await screen.findByRole("button", {
      name: `Cancel merge of signal ${source.groupKey}`,
    });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("button", { name: `Merge signal ${other.groupKey}` })).toBeEnabled();
    fireEvent.click(cancel);
    expect(screen.getByRole("button", { name: `Merge signal ${source.groupKey}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Merge signal ${other.groupKey}` })).toBeEnabled();

    await act(async () => resolveMerge?.(json({ error: "Merge is still in progress" }, 409)));
  });

  it("attributes a late merge result to its source while another row form is open", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const sourceA = reportGroup({ groupKey: mergeSourceGroupKey, reportCount: 7 });
    const sourceB = reportGroup({ groupKey: mergeOtherGroupKey, reportCount: 2 });
    const target = reportGroup({ groupKey: mergeTargetGroupKey, reportCount: 5 });
    let sourceAMerged = false;
    let resolveMerge: ((response: Response) => void) | undefined;
    const pendingMerge = new Promise<Response>((resolve) => {
      resolveMerge = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({
            groups: sourceAMerged ? [sourceB, target] : [sourceA, sourceB, target],
            hasMore: false,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (path === mergePath(sourceA.groupKey) && init?.method === "POST") return pendingMerge;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFeedback(data);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Signals" }));
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: `Merge signal ${sourceA.groupKey}` });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Merge signal ${sourceA.groupKey}` }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(
        screen.getByRole("combobox", {
          name: `Signal that survives merge of ${sourceA.groupKey}`,
        }),
        { target: { value: target.groupKey } },
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Merging…" })).toBeDisabled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: `Cancel merge of signal ${sourceA.groupKey}` }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Merge signal ${sourceB.groupKey}` }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(
        screen.getByRole("combobox", {
          name: `Signal that survives merge of ${sourceB.groupKey}`,
        }),
        { target: { value: target.groupKey } },
      );
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }),
    ).toBeDisabled();

    sourceAMerged = true;
    await act(async () => {
      resolveMerge?.(json({ reportsMoved: sourceA.reportCount, targetGroupKey: target.groupKey }));
      await pendingMerge;
      await Promise.resolve();
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      `Merged away ${sourceA.groupKey} and moved 7 reports into ${target.groupKey}, which survives.`,
    );
    expect(
      screen.getByRole("button", { name: `Cancel merge of signal ${sourceB.groupKey}` }),
    ).toBeEnabled();
    expect(
      screen.getByRole("combobox", {
        name: `Signal that survives merge of ${sourceB.groupKey}`,
      }),
    ).toHaveValue(target.groupKey);
    expect(
      screen.getByRole("button", { name: `Merge away into ${target.groupKey}` }),
    ).toBeEnabled();
    expect(screen.getAllByText(sourceB.groupKey)).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: `Merge signal ${sourceA.groupKey}` }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === mergePath(sourceA.groupKey) && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === mergePath(sourceB.groupKey) && init?.method === "POST",
      ),
    ).toBe(false);
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

  it("opens a report from the full row with pointer or keyboard input", () => {
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
    fireEvent.keyDown(row, { key: "Enter" });

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

function mergePath(sourceGroupKey: string): string {
  return `/api/groups/${encodeURIComponent(sourceGroupKey)}/merge`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
