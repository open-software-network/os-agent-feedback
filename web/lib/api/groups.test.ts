import { beforeEach, expect, it, vi } from "vitest";

import { fetchProductGroupsWindow, type ProductReportGroup } from "@/lib/api/groups";

beforeEach(() => {
  vi.restoreAllMocks();
});

it("deduplicates groups while following the server-echoed page limit", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const first = reportGroup();
  const updated = reportGroup({ reportCount: 4 });
  const second = reportGroup({ groupKey: "search:http:timeout" });
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith(`/groups?limit=50&offset=0`)) {
      return Promise.resolve(json({ groups: [first], hasMore: true, limit: 25, offset: 0 }));
    }
    if (path.endsWith(`/groups?limit=25&offset=25`)) {
      return Promise.resolve(
        json({ groups: [updated, second], hasMore: false, limit: 25, offset: 25 }),
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await fetchProductGroupsWindow(workspaceId, productId, 50);

  expect(result.groups.map((group) => group.groupKey)).toEqual([first.groupKey, second.groupKey]);
  expect(result.groups[0].reportCount).toBe(4);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, init] of fetchMock.mock.calls) {
    expect(new Headers(init.headers).get("x-workspace-id")).toBe(workspaceId);
  }
});

it("continues past an empty page when the server reports more groups", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const group = reportGroup();
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith(`/groups?limit=50&offset=0`)) {
      return Promise.resolve(json({ groups: [], hasMore: true, limit: 50, offset: 0 }));
    }
    if (path.endsWith(`/groups?limit=50&offset=50`)) {
      return Promise.resolve(json({ groups: [group], hasMore: false, limit: 50, offset: 50 }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await fetchProductGroupsWindow(workspaceId, productId, 50);

  expect(result.groups).toEqual([group]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("stops after three consecutive empty pages from a misbehaving server", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    const offset = Number(new URL(path, "http://localhost").searchParams.get("offset"));
    return Promise.resolve(json({ groups: [], hasMore: true, limit: 50, offset }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await fetchProductGroupsWindow(workspaceId, productId, 50);

  expect(result.groups).toEqual([]);
  expect(result.hasMore).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    `/api/products/${productId}/groups?limit=50&offset=0`,
    `/api/products/${productId}/groups?limit=50&offset=50`,
    `/api/products/${productId}/groups?limit=50&offset=100`,
  ]);
});

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
