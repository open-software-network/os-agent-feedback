import { apiRequest } from "@/lib/api/client";
import type { components } from "@/lib/api/types";

export type DataDestination = components["schemas"]["DataDestination"];
export type DataDestinationSyncRun = components["schemas"]["DataDestinationSyncRun"];
export type DataDestinationsResponse = components["schemas"]["DataDestinationsResponse"];
export type DataDestinationResponse = components["schemas"]["DataDestinationResponse"];
export type DataDestinationRunsResponse = components["schemas"]["DataDestinationRunsResponse"];
export type DataDestinationTestResponse = components["schemas"]["DataDestinationTestResponse"];
export type DataDestinationSyncTriggeredResponse =
  components["schemas"]["DataDestinationSyncTriggeredResponse"];
export type CreateDataDestinationInput = components["schemas"]["CreateDataDestinationInput"];
export type UpdateDataDestinationInput = components["schemas"]["UpdateDataDestinationInput"];
export type TestDataDestinationInput = components["schemas"]["TestDataDestinationInput"];
export type RemovedResponse = components["schemas"]["RemovedResponse"];

export function fetchDataDestinations(workspaceId: string): Promise<DataDestinationsResponse> {
  return apiRequest<DataDestinationsResponse>("/api/data-destinations", { workspaceId });
}

export function createDataDestination(
  workspaceId: string,
  input: CreateDataDestinationInput,
): Promise<DataDestinationResponse> {
  return apiRequest<DataDestinationResponse>("/api/data-destinations", {
    method: "POST",
    workspaceId,
    body: JSON.stringify(input),
  });
}

export function testDataDestination(
  workspaceId: string,
  input: TestDataDestinationInput,
): Promise<DataDestinationTestResponse> {
  return apiRequest<DataDestinationTestResponse>("/api/data-destinations/test", {
    method: "POST",
    workspaceId,
    body: JSON.stringify(input),
  });
}

export function updateDataDestination(
  workspaceId: string,
  destinationId: string,
  input: UpdateDataDestinationInput,
): Promise<DataDestinationResponse> {
  return apiRequest<DataDestinationResponse>(
    `/api/data-destinations/${encodeURIComponent(destinationId)}`,
    {
      method: "PATCH",
      workspaceId,
      body: JSON.stringify(input),
    },
  );
}

export function deleteDataDestination(
  workspaceId: string,
  destinationId: string,
): Promise<RemovedResponse> {
  return apiRequest<RemovedResponse>(
    `/api/data-destinations/${encodeURIComponent(destinationId)}`,
    {
      method: "DELETE",
      workspaceId,
    },
  );
}

export function fetchDataDestinationRuns(
  workspaceId: string,
  destinationId: string,
): Promise<DataDestinationRunsResponse> {
  return apiRequest<DataDestinationRunsResponse>(
    `/api/data-destinations/${encodeURIComponent(destinationId)}/runs`,
    { workspaceId },
  );
}

export function syncDataDestination(
  workspaceId: string,
  destinationId: string,
): Promise<DataDestinationSyncTriggeredResponse> {
  return apiRequest<DataDestinationSyncTriggeredResponse>(
    `/api/data-destinations/${encodeURIComponent(destinationId)}/sync`,
    { method: "POST", workspaceId },
  );
}
