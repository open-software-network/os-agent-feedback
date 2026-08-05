import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { ContextFieldDefinition } from "@/lib/api/context-fields";

import { ContextFieldsView } from "./context-fields-view";

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
  overrides: Partial<Parameters<typeof ContextFieldsView>[0]> = {},
) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <ContextFieldsView
      data={dashboardFixture()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ContextFieldsView", () => {
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
    expect(within(deliveryRow).getByText("Eligible")).toBeVisible();
    expect(within(deliveryRow).getByText("Disabled")).toBeVisible();

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

    expect(await screen.findByText(/Default fields in use/)).toBeVisible();
    expect(screen.getByText(/replaces the default set for every new request/)).toBeVisible();
    expect(screen.getByText(/No fields defined yet/)).toBeVisible();
    expect(screen.getByText(/Default fields \(built in\)/)).toBeVisible();
    const defaultRow = screen.getByRole("row", { name: /shopping\.priority/ });
    expect(within(defaultRow).getByText("shopping priority")).toBeVisible();
    expect(within(defaultRow).getByText("Eligible")).toBeVisible();
    expect(
      within(screen.getByRole("row", { name: /b2b\.primary_goal/ })).getByText("Off"),
    ).toBeVisible();
  });

  it("creates a field with parsed values and operation bindings", async () => {
    const { calls, fetchMock } = mockApi();
    renderView(fetchMock);
    await screen.findByRole("row", { name: /journey\.occasion/ });

    fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
    expect(
      within(await screen.findByLabelText("Type")).getByRole("option", { name: "interest" }),
    ).toBeVisible();
    fireEvent.change(await screen.findByLabelText("Field key"), {
      target: { value: "journey.priority" },
    });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Shopping priority" } });
    fireEvent.change(screen.getByLabelText("Allowed values"), {
      target: { value: "price, quality, speed" },
    });
    fireEvent.change(screen.getByLabelText("Operations"), { target: { value: "search_catalog" } });
    fireEvent.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PUT")).toBe(true);
    });
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe(`/api/products/${productId}/context-fields/journey.priority`);
    expect(put?.body).toMatchObject({
      label: "Shopping priority",
      type: "preference",
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

    fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
    fireEvent.change(await screen.findByLabelText("Field key"), {
      target: { value: "Shopping Priority" },
    });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Shopping priority" } });
    fireEvent.change(screen.getByLabelText("Allowed values"), {
      target: { value: "any text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save field" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/namespace\.name/);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    fireEvent.change(screen.getByLabelText("Field key"), {
      target: { value: "journey.priority" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/snake_case/);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
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
    expect(screen.queryByRole("button", { name: /Add field/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit journey.occasion" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a team owner or admin/)).toBeVisible();
  });
});
