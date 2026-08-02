import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  customersPageFixture,
  dashboardFixture,
  signalFixture,
} from "@/components/dashboard/test-fixture";
import type { DashboardData } from "@/lib/api/dashboard";

import { HomeView } from "./home-view";

describe("InsightsView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1&view=insights");
  });

  it("leads with customer understanding rather than observability", async () => {
    renderInsights(dashboardFixture());

    expect(
      await screen.findByRole("heading", { name: "Epode learned 3 useful context items." }),
    ).toBeVisible();
    const understanding = screen.getByRole("region", { name: "Customer understanding" });
    expect(within(understanding).getByText("Customers with context")).toBeVisible();
    expect(within(understanding).getByText("Personalization-ready")).toBeVisible();
    expect(within(understanding).getByText("Context retrievals")).toBeVisible();
    expect(within(understanding).getByText("Personalization decisions")).toBeVisible();
    expect(within(understanding).getByText("Measured outcomes")).toBeVisible();
    expect(screen.getByRole("heading", { name: "What customers care about" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recently understood customers" })).toBeVisible();
    expect(screen.queryByText("Possibly prefers luxury brands")).not.toBeInTheDocument();
    expect(screen.queryByText("Review coverage")).not.toBeInTheDocument();
  });

  it("opens a customer and routes only to visible MVP screens", async () => {
    const openCustomer = vi.fn();
    renderInsights(dashboardFixture(), { openCustomer });

    fireEvent.click(await screen.findByRole("button", { name: "Acme workspace" }));
    expect(openCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    fireEvent.click(screen.getByRole("button", { name: /view all customers/i }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("customers");
  });

  it("refreshes dashboard, customers, and permissioned context", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = mockIntelligence();
    renderInsights(dashboardFixture(), { refresh }, fetchMock);

    await screen.findByText("Sustainable products");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/dashboard/customers?"),
      ).length,
    ).toBeGreaterThan(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/dashboard/signals?"))
        .length,
    ).toBeGreaterThan(1);
  });
});

function renderInsights(
  data: DashboardData,
  overrides: Partial<Parameters<typeof HomeView>[0]> = {},
  fetchMock = mockIntelligence(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomeView
        data={data}
        openCustomer={vi.fn()}
        openFeature={vi.fn()}
        openFeedback={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function mockIntelligence() {
  const signals = [
    signalFixture({
      type: "preference",
      summary: "Sustainable products",
      consentScope: "share_preferences",
      allowedUses: ["product_personalization"],
    }),
    signalFixture({
      id: "signal-intent",
      type: "intent",
      summary: "Buying a birthday gift",
      consentScope: "share_preferences",
      allowedUses: ["product_personalization"],
    }),
    signalFixture({
      id: "signal-constraint",
      type: "constraint",
      summary: "Under $150",
      consentScope: "share_preferences",
      allowedUses: ["product_personalization"],
    }),
    signalFixture({
      id: "signal-inference",
      type: "preference",
      summary: "Possibly prefers luxury brands",
      provenance: "agent_inference",
      consentScope: "share_preferences",
      consentState: "approved",
      allowedUses: ["product_personalization"],
    }),
  ];
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/customers?")) {
      return Promise.resolve(json(customersPageFixture()));
    }
    if (path.startsWith("/api/dashboard/signals?")) {
      return Promise.resolve(
        json({ signals, total: signals.length, limit: 100, nextCursor: null }),
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
