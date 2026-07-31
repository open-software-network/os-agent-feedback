import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { FeedbackGroups } from "@/components/views/feedback/feedback-groups";
import type { ProductReportGroup } from "@/lib/api/groups";

describe("feedback group filing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders fresh group pages and points unmapped products to Connectors", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json({ error: "Repository mapping not found" }, 404));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(
          json({ groups: [reportGroup()], hasMore: true, limit: 50, offset: 0 }),
        );
      }
      if (path === groupsPath(productId, 50, 50)) {
        return Promise.resolve(
          json({
            groups: [
              reportGroup({
                groupKey: "search:http:timeout",
                explanation: "Grouped by search timeouts over HTTP.",
                reportCount: 1,
              }),
            ],
            hasMore: false,
            limit: 50,
            offset: 50,
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGroups(data);

    expect(await screen.findByText("search:http:bug:freshness:2xx")).toBeVisible();
    expect(screen.getByText(/3 reports · latest/i)).toBeVisible();
    expect(
      screen.getByText("Grouped by operation, surface, finding, and status class."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "File GitHub issue" })).not.toBeInTheDocument();
    expect(screen.getByText(/map this product to a GitHub repository/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Connectors" })).toHaveAttribute(
      "href",
      `/?view=connectors&team=${data.workspace.id}&product=${productId}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("search:http:timeout")).toBeVisible();
    expect(screen.getByText("search:http:bug:freshness:2xx")).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("offset=50"))).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("x-workspace-id")).toBe(data.workspace.id);
    }
  });

  it.each([
    200, 201,
  ])("keeps filing pending and renders the refetched issue link after HTTP %s", async (status) => {
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

    renderGroups(data);

    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));
    const filing = await screen.findByRole("button", { name: "Filing…" });
    expect(filing).toBeDisabled();
    expect(filing).toHaveAttribute("aria-busy", "true");

    filed = true;
    await act(async () => {
      resolveIssue?.(json(issue, status));
    });

    const issueLink = await screen.findByRole("link", {
      name: "open-software-network/os-epode#42",
    });
    expect(issueLink).toHaveAttribute("href", issue.url);
    expect(screen.getByText("Open")).toBeVisible();
    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === issuePath(group.groupKey) && init?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
    expect(new Headers(postCalls[0][1].headers).get("x-workspace-id")).toBe(data.workspace.id);
  });

  it.each([
    "A GitHub issue is already being filed for this feedback group",
    "GitHub issue reconciliation is in progress for this feedback group",
  ])("surfaces the 409 server message and checks the current listing: %s", async (message) => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const group = reportGroup();
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

    renderGroups(data);

    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));
    expect(await screen.findByText(message, { exact: false })).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();

    groupVisible = false;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(
      await screen.findByText("No feedback groups are available for this product."),
    ).toBeVisible();
    expect(screen.queryByText(group.groupKey)).not.toBeInTheDocument();
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument();
    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === issuePath(group.groupKey) && init?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("surfaces non-409 filing failures without a retry loop", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const group = reportGroup();
    const message = "GitHub did not accept the issue creation request";
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/products/${productId}/github-repo`) {
        return Promise.resolve(json(repositoryMapping(productId)));
      }
      if (path === groupsPath(productId, 50, 0)) {
        return Promise.resolve(json({ groups: [group], hasMore: false, limit: 50, offset: 0 }));
      }
      if (path === issuePath(group.groupKey) && init?.method === "POST") {
        return Promise.resolve(json({ error: message }, 502));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGroups(data);

    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) => String(input) === issuePath(group.groupKey) && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
  });
});

function renderGroups(data: ReturnType<typeof dashboardFixture>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FeedbackGroups data={data} />
    </QueryClientProvider>,
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
