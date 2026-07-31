import { ApiError, apiRequest } from "@/lib/api/client";
import type { components } from "@/lib/api/types";

export type GithubInstallation = components["schemas"]["GithubInstallationResponse"];
export type GithubInstallationsResponse = components["schemas"]["GithubInstallationsResponse"];
export type GithubRepositoriesResponse = components["schemas"]["GithubRepositoriesResponse"];
export type GithubRepository = components["schemas"]["GithubRepositoryResponse"];
export type ProductGithubRepo = components["schemas"]["ProductGithubRepo"];
export type ProductGithubRepoInput = components["schemas"]["ProductGithubRepoInput"];
export type RemovedResponse = components["schemas"]["RemovedResponse"];

export function fetchGithubInstallations(
  workspaceId: string,
): Promise<GithubInstallationsResponse> {
  return apiRequest<GithubInstallationsResponse>("/api/github/installations", { workspaceId });
}

export function fetchGithubRepositories(
  workspaceId: string,
  installationId: number,
): Promise<GithubRepositoriesResponse> {
  return apiRequest<GithubRepositoriesResponse>(
    `/api/github/installations/${installationId}/repositories`,
    { workspaceId },
  );
}

export async function fetchProductGithubRepo(
  workspaceId: string,
  productId: string,
): Promise<ProductGithubRepo | null> {
  try {
    return await apiRequest<ProductGithubRepo | null>(
      `/api/products/${encodeURIComponent(productId)}/github-repo`,
      { workspaceId },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function setProductGithubRepo(
  workspaceId: string,
  productId: string,
  input: ProductGithubRepoInput,
): Promise<ProductGithubRepo> {
  return apiRequest<ProductGithubRepo>(
    `/api/products/${encodeURIComponent(productId)}/github-repo`,
    {
      method: "PUT",
      workspaceId,
      body: JSON.stringify(input),
    },
  );
}

export function clearProductGithubRepo(
  workspaceId: string,
  productId: string,
): Promise<RemovedResponse> {
  return apiRequest<RemovedResponse>(`/api/products/${encodeURIComponent(productId)}/github-repo`, {
    method: "DELETE",
    workspaceId,
  });
}
