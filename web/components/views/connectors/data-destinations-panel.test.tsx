import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataDestination } from "@/lib/api/data-destinations";
import { DataDestinationsPanel } from "./data-destinations-panel";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function destinationFixture(overrides: Partial<DataDestination> = {}): DataDestination {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    name: "Analytics warehouse",
    kind: "postgres",
    config: { connectionUrl: "postgres://loader@db.internal/warehouse", schema: "public" },
    enabled: true,
    syncIntervalSeconds: 300,
    nextSyncAt: "2026-08-04T12:05:00Z",
    syncing: false,
    createdAt: "2026-08-04T12:00:00Z",
    updatedAt: "2026-08-04T12:00:00Z",
    lastRun: null,
    ...overrides,
  };
}

function renderPanel(fetchMock: ReturnType<typeof vi.fn>, editable = true) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DataDestinationsPanel workspaceId={WORKSPACE_ID} editable={editable} />
    </QueryClientProvider>,
  );
}

function mockFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        const result = handler(init);
        return result instanceof Response ? Promise.resolve(result) : Promise.resolve(json(result));
      }
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DataDestinationsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists destinations with their last sync status", async () => {
    const fetchMock = mockFetch({
      "/api/data-destinations": () => ({
        destinations: [
          destinationFixture({
            lastRun: {
              id: "aaaaaaaa-0000-4000-8000-000000000000",
              destinationId: "99999999-9999-4999-8999-999999999999",
              trigger: "scheduled",
              status: "succeeded",
              recordsExported: 42,
              error: null,
              startedAt: "2026-08-04T12:00:00Z",
              finishedAt: "2026-08-04T12:00:04Z",
            },
          }),
        ],
      }),
    });
    renderPanel(fetchMock);

    expect(await screen.findByText("Analytics warehouse")).toBeVisible();
    expect(screen.getByText("PostgreSQL")).toBeVisible();
    expect(screen.getByText("Healthy")).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    // Credentials are sealed server-side and never rendered.
    expect(screen.queryByDisplayValue(/postgres:.*@/)).not.toBeInTheDocument();
  });

  it("walks the picker into a postgres form and creates the destination", async () => {
    let createdBody: string | undefined;
    const fetchMock = mockFetch({
      "/api/data-destinations": (init) => {
        if (init?.method === "POST") {
          createdBody = String(init.body);
          return json({ destination: destinationFixture() }, 200);
        }
        return { destinations: [] };
      },
    });
    renderPanel(fetchMock);

    expect(await screen.findByText("No data destinations")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add a data destination" }));

    // The catalog reads as data systems, and planned kinds are inert.
    expect(screen.getByRole("button", { name: "Snowflake (planned)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Amazon S3 (planned)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Configure PostgreSQL" }));

    fireEvent.change(screen.getByLabelText("Destination name"), {
      target: { value: "Analytics warehouse" },
    });
    fireEvent.change(screen.getByLabelText("Connection URL"), {
      target: { value: "postgres://loader@db.internal/warehouse" },
    });
    fireEvent.change(screen.getByLabelText("Password (optional)"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save destination" }));

    await waitFor(() => expect(createdBody).toBeDefined());
    const body = JSON.parse(createdBody ?? "{}");
    expect(body).toMatchObject({
      name: "Analytics warehouse",
      kind: "postgres",
      config: { connectionUrl: "postgres://loader@db.internal/warehouse" },
      credentials: { password: "s3cret" },
      syncIntervalSeconds: 300,
    });
  });

  it("tests the connection from the form and surfaces the outcome", async () => {
    const fetchMock = mockFetch({
      "/api/data-destinations/test": () => ({ ok: true, detail: "Connected and authenticated." }),
      "/api/data-destinations": () => ({ destinations: [] }),
    });
    renderPanel(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Add a data destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure HTTP collector (NDJSON)" }));
    fireEvent.change(screen.getByLabelText("Destination name"), {
      target: { value: "Lake collector" },
    });
    fireEvent.change(screen.getByLabelText("Collector URL"), {
      target: { value: "https://ingest.example.com/epode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/Connection OK/)).toBeVisible();
  });

  it("triggers a manual sync and shows failures", async () => {
    let syncCalls = 0;
    const fetchMock = mockFetch({
      "/api/data-destinations/99999999-9999-4999-8999-999999999999/sync": () => {
        syncCalls += 1;
        return { triggered: true, runId: "bbbbbbbb-0000-4000-8000-000000000000" };
      },
      "/api/data-destinations": () => ({
        destinations: [
          destinationFixture({
            lastRun: {
              id: "aaaaaaaa-0000-4000-8000-000000000000",
              destinationId: "99999999-9999-4999-8999-999999999999",
              trigger: "manual",
              status: "failed",
              recordsExported: 0,
              error: "connection failed: timeout",
              startedAt: "2026-08-04T12:00:00Z",
              finishedAt: "2026-08-04T12:00:04Z",
            },
          }),
        ],
      }),
    });
    renderPanel(fetchMock);

    expect(await screen.findByText("Last sync failed")).toBeVisible();
    expect(screen.getByText("connection failed: timeout")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(syncCalls).toBe(1));
  });

  it("pauses and deletes a destination", async () => {
    const calls: Array<{ path: string; method: string | undefined }> = [];
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method });
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [destinationFixture()] }));
      }
      if (path.startsWith("/api/data-destinations/99999999")) {
        if (init?.method === "PATCH") {
          return Promise.resolve(json({ destination: destinationFixture({ enabled: false }) }));
        }
        if (init?.method === "DELETE") {
          return Promise.resolve(json({ removed: true }));
        }
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPanel(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });

  it("keeps members read-only", async () => {
    const fetchMock = mockFetch({
      "/api/data-destinations": () => ({ destinations: [destinationFixture()] }),
    });
    renderPanel(fetchMock, false);

    expect(await screen.findByText("Analytics warehouse")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Add a data destination" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });
});
