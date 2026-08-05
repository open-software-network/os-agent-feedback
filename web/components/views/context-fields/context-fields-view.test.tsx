import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { ContextFieldDefinition } from "@/lib/api/context-fields";
import type { ProductInteraction } from "@/lib/api/dashboard";

import { QuestionsView } from "./context-fields-view";

const productId = "22222222-2222-4222-8222-222222222222";

const occasion: ContextFieldDefinition = {
  key: "journey.occasion",
  label: "Shopping occasion",
  type: "preference",
  allowedValues: ["gift", "self_purchase", "replacement", "event", "other"],
  targetedAdvertisingSafe: false,
  operations: ["search_catalog"],
  enabled: true,
  createdAt: "2026-08-04T12:00:00Z",
  updatedAt: "2026-08-04T12:00:00Z",
};

const delivery: ContextFieldDefinition = {
  key: "journey.delivery",
  label: "Delivery timing",
  type: "constraint",
  allowedValues: ["fast", "flexible"],
  targetedAdvertisingSafe: true,
  operations: null,
  enabled: false,
  createdAt: "2026-08-04T12:00:00Z",
  updatedAt: "2026-08-04T12:00:00Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApi(fields: ContextFieldDefinition[] = [occasion, delivery]) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://dashboard.test").pathname;
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "GET") {
      return json({
        fields,
        legacyCatalogActive: fields.every((field) => !field.enabled),
        defaultCatalog: [
          {
            key: "shopping.priority",
            type: "preference",
            allowedValues: ["price", "quality", "speed", "convenience", "sustainability"],
            targetedAdvertisingSafe: true,
          },
          {
            key: "b2b.primary_goal",
            type: "intent",
            allowedValues: ["evaluate", "integrate", "automate", "analyze", "collaborate"],
            targetedAdvertisingSafe: false,
          },
        ],
      });
    }
    if (method === "PUT") return json(occasion);
    if (method === "DELETE") return json(occasion);
    return json({}, 500);
  });
  return { calls, fetchMock };
}

function renderView(
  fetchMock: ReturnType<typeof mockApi>["fetchMock"],
  overrides: Partial<Parameters<typeof QuestionsView>[0]> = {},
) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QuestionsView
      data={dashboardFixture()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
      {...overrides}
    />,
  );
}

describe("QuestionsView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists fields with values, bindings, and state", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);

    const occasionRow = await screen.findByRole("row", { name: /journey\.occasion/ });
    expect(within(occasionRow).getByText("Shopping occasion")).toBeVisible();
    expect(within(occasionRow).getByText("preference")).toBeVisible();
    expect(within(occasionRow).getByText("search_catalog")).toBeVisible();
    expect(within(occasionRow).getByText("+1")).toBeVisible();
    expect(within(occasionRow).getByText("Enabled")).toBeVisible();

    const deliveryRow = screen.getByRole("row", { name: /journey\.delivery/ });
    expect(within(deliveryRow).getByText("All operations")).toBeVisible();
    expect(within(deliveryRow).getByText("Disabled")).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Ads" })).not.toBeInTheDocument();

    expect(calls[0]).toMatchObject({
      path: `/api/products/${productId}/context-fields`,
      method: "GET",
    });
    expect(screen.queryByText(/Default fields in use/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default fields \(built in\)/)).not.toBeInTheDocument();
  });

  it("shows the built-in default fields when no custom fields exist", async () => {
    const { fetchMock } = mockApi([]);
    renderView(fetchMock);

    expect(await screen.findByText(/Default questions in use/)).toBeVisible();
    expect(screen.getByText(/replaces the default set for every new request/)).toBeVisible();
    expect(screen.getByText(/No questions defined yet/)).toBeVisible();
    expect(screen.getByText(/Default questions \(built in\)/)).toBeVisible();
    const defaultRow = screen.getByRole("row", { name: /shopping\.priority/ });
    expect(within(defaultRow).getByText("shopping priority")).toBeVisible();
    expect(screen.queryByText("Eligible")).not.toBeInTheDocument();
    expect(screen.queryByText("Off")).not.toBeInTheDocument();
  });

  it("creates a field with parsed values and operation bindings", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);
    await screen.findByRole("row", { name: /journey\.occasion/ });

    fireEvent.click(screen.getByRole("button", { name: /Add question/ }));
    fireEvent.change(await screen.findByLabelText("Key"), {
      target: { value: "journey.priority" },
    });
    fireEvent.change(screen.getByLabelText("Question topic"), {
      target: { value: "Shopping priority" },
    });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "customer_goal" } });
    fireEvent.change(screen.getByLabelText("Allowed values"), {
      target: { value: "price, quality, speed" },
    });
    fireEvent.change(screen.getByLabelText("Operations"), { target: { value: "search_catalog" } });
    expect(screen.queryByLabelText(/advertising/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save question" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PUT")).toBe(true);
    });
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe(`/api/products/${productId}/context-fields/journey.priority`);
    expect(put?.body).toMatchObject({
      label: "Shopping priority",
      type: "customer_goal",
      allowedValues: ["price", "quality", "speed"],
      targetedAdvertisingSafe: false,
      operations: ["search_catalog"],
      enabled: true,
    });
  });

  it("rejects invalid keys and free-form values before saving", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);
    await screen.findByRole("row", { name: /journey\.occasion/ });

    fireEvent.click(screen.getByRole("button", { name: /Add question/ }));
    fireEvent.change(await screen.findByLabelText("Key"), {
      target: { value: "Shopping Priority" },
    });
    fireEvent.change(screen.getByLabelText("Question topic"), {
      target: { value: "Shopping priority" },
    });
    fireEvent.change(screen.getByLabelText("Allowed values"), {
      target: { value: "any text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save question" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/namespace\.name/);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "journey.priority" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save question" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/snake_case/);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("preserves hidden advertising eligibility when editing", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);
    await screen.findByRole("row", { name: /journey\.delivery/ });

    fireEvent.click(screen.getByRole("button", { name: "Edit journey.delivery" }));
    fireEvent.change(await screen.findByLabelText("Question topic"), {
      target: { value: "Preferred delivery timing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save question" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
      label: "Preferred delivery timing",
      targetedAdvertisingSafe: true,
    });
  });

  it("deletes a field only after confirmation", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);
    await screen.findByRole("row", { name: /journey\.occasion/ });

    fireEvent.click(screen.getByRole("button", { name: "Delete journey.occasion" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    });
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(
      `/api/products/${productId}/context-fields/journey.occasion`,
    );
  });

  it("is read-only for members", async () => {
    const { fetchMock } = mockApi();
    renderView(fetchMock, { data: dashboardFixture({ currentRole: "member" }) });

    await screen.findByRole("row", { name: /journey\.occasion/ });
    expect(screen.queryByRole("button", { name: /Add question/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit journey.occasion" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a team owner or admin/)).toBeVisible();
  });

  it("shows the journey-dimension empty state without graph telemetry", async () => {
    const { fetchMock } = mockApi();
    renderView(fetchMock);

    await screen.findByRole("row", { name: /journey\.occasion/ });
    expect(screen.getByRole("heading", { name: "Journey dimensions" })).toBeVisible();
    expect(screen.getByText(/No experience-graph journeys observed yet/)).toBeVisible();
  });

  it("summarizes experience-graph categories and promotes one to a remembered question", async () => {
    const { fetchMock } = mockApi();
    const interactions: ProductInteraction[] = [
      graphInteraction("/agent-guide", "session-1", 200, "2026-08-04T10:00:00Z"),
      graphInteraction("/agent-negotiate/lamp", "session-1", 200, "2026-08-04T10:01:00Z"),
      graphInteraction("/agent-negotiate/lamp", "session-1", 200, "2026-08-04T10:02:00Z"),
      graphInteraction("/agent-decide/lamp", "session-1", 200, "2026-08-04T10:03:00Z"),
      graphInteraction("/agent-item", "session-1", 200, "2026-08-04T10:04:00Z"),
      graphInteraction("/agent-negotiate/lamp", "session-2", 200, "2026-08-04T11:00:00Z"),
      graphInteraction("/agent-decide/lamp", "session-2", 422, "2026-08-04T11:01:00Z"),
    ];
    renderView(fetchMock, { data: dashboardFixture({ interactions }) });

    const lampRow = await screen.findByRole("row", { name: /lamp/ });
    expect(within(lampRow).getByText("Lamp")).toBeVisible();
    expect(within(lampRow).getByText("3")).toBeVisible();
    expect(within(lampRow).getByText("1 decided · 1 counterfactual")).toBeVisible();

    fireEvent.click(within(lampRow).getByRole("button", { name: "Remember as question" }));

    expect(await screen.findByLabelText("Key")).toHaveValue("journey.lamp");
    expect(screen.getByLabelText("Question topic")).toHaveValue("Lamp journey need");
    expect(screen.getByLabelText("Operations")).toHaveValue(
      "/agent-negotiate/lamp, /agent-decide/lamp",
    );
  });

  it("marks a dimension as remembered when its question already exists", async () => {
    const remembered: ContextFieldDefinition = {
      ...occasion,
      key: "journey.lamp",
      label: "Lamp journey need",
      operations: ["/agent-negotiate/lamp", "/agent-decide/lamp"],
    };
    const { fetchMock } = mockApi([remembered]);
    const interactions: ProductInteraction[] = [
      graphInteraction("/agent-negotiate/lamp", "session-1", 200, "2026-08-04T10:01:00Z"),
      graphInteraction("/agent-decide/lamp", "session-1", 200, "2026-08-04T10:03:00Z"),
    ];
    renderView(fetchMock, { data: dashboardFixture({ interactions }) });

    const lampRow = await screen.findByRole("row", { name: /lamp/ });
    expect(within(lampRow).getByText("Remembered")).toBeVisible();
    expect(
      within(lampRow).queryByRole("button", { name: "Remember as question" }),
    ).not.toBeInTheDocument();
  });
});

function graphInteraction(
  operation: string,
  sessionId: string,
  statusCode: number,
  occurredAt: string,
): ProductInteraction {
  return {
    id: `${operation}-${sessionId}-${occurredAt}`,
    apiKeyId: null,
    classification: "unclassified",
    confirmationMethod: null,
    createdAt: occurredAt,
    customerId: null,
    customerRef: null,
    durationMs: 12,
    environmentId: "env-1",
    occurredAt,
    operation,
    runtimeHint: null,
    runtimeHintSource: null,
    sessionId,
    statusCode,
    surface: "http_json",
    updatedAt: occurredAt,
    workspaceId: "workspace-1",
  };
}
