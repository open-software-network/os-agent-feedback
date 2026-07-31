import { expect, it, vi } from "vitest";

import { fetchProductGroupsWindow, type ProductReportGroup } from "@/lib/api/groups";

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
