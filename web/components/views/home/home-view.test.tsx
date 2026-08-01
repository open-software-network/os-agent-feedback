import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  customersPageFixture,
  dashboardFixture,
  featuresPageFixture,
} from "@/components/dashboard/test-fixture";
import type { DashboardData } from "@/lib/api/dashboard";
import { HomeView } from "./home-view";

describe("HomeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1");
  });

  it("leads with evidence-backed customer intelligence", async () => {
    renderHome(dashboardFixture());

    expect(
      await screen.findByRole("heading", {
        name: "Fresh results after indexing is the leading customer need.",
      }),
    ).toBeVisible();
    const health = screen.getByRole("region", { name: "Customer health" });
    expect(within(health).getByText("Customers observed")).toBeVisible();
    expect(within(health).getByText("Verified customers")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Needs and opportunities" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Customers requiring attention" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent outcome evidence" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Interactions" })).not.toBeInTheDocument();
  });

  it("opens exact feature, customer, and report evidence", async () => {
    const openFeature = vi.fn();
    const openCustomer = vi.fn();
    const openFeedback = vi.fn();
    renderHome(dashboardFixture(), { openFeature, openCustomer, openFeedback });

    fireEvent.click(await screen.findByRole("button", { name: "Review evidence" }));
    expect(openFeature).toHaveBeenCalledWith("freshness-gap");

    fireEvent.click(screen.getByRole("button", { name: "Acme workspace" }));
    expect(openCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    fireEvent.click(
      screen.getByRole("button", { name: "Search results omitted the newest document" }),
    );
    expect(openFeedback).toHaveBeenCalledWith(dashboardFixture().reports[0].id);
  });

  it("routes aggregate exploration only to visible dashboard views", async () => {
    renderHome(dashboardFixture());
    fireEvent.click(await screen.findByRole("button", { name: "View all features" }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("features");

    fireEvent.click(screen.getByRole("button", { name: "View all customers" }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("customers");
  });

  it("refreshes dashboard and both customer-intelligence projections", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = mockIntelligence();
    renderHome(dashboardFixture(), { refresh }, fetchMock);

    await screen.findByText("Fresh results after indexing");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/dashboard/customers?"),
      ).length,
    ).toBeGreaterThan(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/dashboard/features?"))
        .length,
    ).toBeGreaterThan(1);
  });
});

function renderHome(
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
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/customers?")) {
      return Promise.resolve(json(customersPageFixture()));
    }
    if (path.startsWith("/api/dashboard/features?")) {
      return Promise.resolve(json(featuresPageFixture()));
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
