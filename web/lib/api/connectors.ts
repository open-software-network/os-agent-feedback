import { apiRequest } from "@/lib/api/client";
import type { components } from "@/lib/api/types";

export type GithubInstallation = components["schemas"]["GithubInstallationResponse"];
export type GithubInstallationsResponse = components["schemas"]["GithubInstallationsResponse"];
export type GithubRepositoriesResponse = components["schemas"]["GithubRepositoriesResponse"];
export type GithubRepository = components["schemas"]["GithubRepositoryResponse"];

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
