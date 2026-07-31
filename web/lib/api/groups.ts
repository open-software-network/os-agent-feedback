import { apiRequest } from "@/lib/api/client";
import type { components } from "@/lib/api/types";

export type GithubIssueLink = components["schemas"]["GithubIssueLink"];
export type ProductGroupsResponse = components["schemas"]["ProductGroupsResponse"];
export type ProductReportGroup = components["schemas"]["ProductReportGroup"];

const GROUP_PAGE_SIZE = 50;

export function fetchProductGroups(
  workspaceId: string,
  productId: string,
  limit: number,
  offset: number,
): Promise<ProductGroupsResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return apiRequest<ProductGroupsResponse>(
    `/api/products/${encodeURIComponent(productId)}/groups?${params}`,
    { workspaceId },
  );
}

export async function fetchProductGroupsWindow(
  workspaceId: string,
  productId: string,
  requestedLimit: number,
): Promise<ProductGroupsResponse> {
  const groups = new Map<string, ProductReportGroup>();
  let hasMore = true;
  let offset = 0;
  let remaining = requestedLimit;

  while (remaining > 0 && hasMore) {
    const limit = Math.min(GROUP_PAGE_SIZE, remaining);
    const page = await fetchProductGroups(workspaceId, productId, limit, offset);
    for (const group of page.groups) groups.set(group.groupKey, group);
    hasMore = page.hasMore;
    remaining -= page.limit;
    offset += page.limit;
    if (!page.groups.length) break;
  }

  return { groups: [...groups.values()], hasMore, limit: requestedLimit, offset: 0 };
}

export function fileGroupGithubIssue(
  workspaceId: string,
  groupKey: string,
): Promise<GithubIssueLink> {
  return apiRequest<GithubIssueLink>(`/api/groups/${encodeURIComponent(groupKey)}/github-issue`, {
    method: "POST",
    workspaceId,
  });
}
