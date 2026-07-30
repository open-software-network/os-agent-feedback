import type { components } from "@/lib/api/types";

type ApiErrorEnvelope = components["schemas"]["ApiErrorEnvelope"];

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRequestOptions = RequestInit & {
  workspaceId?: string;
};

export async function apiRequest<T>(
  requestPath: string,
  { workspaceId, ...init }: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (workspaceId && requestPath.startsWith("/api/")) {
    headers.set("x-workspace-id", workspaceId);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(requestPath, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");

  if (response.status === 401) {
    if (typeof window !== "undefined") {
      window.location.assign("/auth/start");
    }
    throw new ApiError("Authentication required", response.status);
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as ApiErrorEnvelope).error === "string"
        ? (body as ApiErrorEnvelope).error
        : typeof body === "string" && body
          ? body
          : `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}
