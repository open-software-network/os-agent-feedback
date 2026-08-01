import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  customerDetailFixture,
  customersPageFixture,
  dashboardFixture,
} from "@/components/dashboard/test-fixture";
import { CustomersView } from "./customers-view";

describe("CustomersView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?view=customers");
  });

  it("renders server-backed identity, health, consent, and complete rollups", async () => {
    const fetchMock = mockCustomers();
    renderCustomers(fetchMock);

    const row = await screen.findByRole("row", { name: "Open customer Acme workspace" });
    expect(within(row).getByText("Verified")).toBeVisible();
    expect(within(row).getByText("Blocked")).toBeVisible();
    expect(within(row).getByText("Allowed")).toBeVisible();
    expect(screen.getByText("At risk").parentElement).toHaveTextContent("1");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/dashboard/customers?productId="),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("serializes filters and restores an exact customer detail", async () => {
    const selectCustomer = vi.fn();
    const fetchMock = mockCustomers();
    renderCustomers(fetchMock, { selectCustomer });

    await screen.findByRole("option", { name: "Verified (1)" });
    fireEvent.change(await screen.findByLabelText("Identity filter"), {
      target: { value: "verified" },
    });
    await waitFor(() => expect(window.location.search).toContain("customerIdentity=verified"));

    fireEvent.click(await screen.findByRole("row", { name: "Open customer Acme workspace" }));
    expect(selectCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    renderCustomers(fetchMock, {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(await screen.findByRole("heading", { name: "Acme workspace" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Current goals" })).toBeVisible();
    expect(screen.getByText("Find the newest indexed policy")).toBeVisible();
    expect(screen.getByText("Agent inference")).toBeVisible();
    expect(screen.getByText(/not a confirmed user statement/i)).toBeVisible();
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
    expect(screen.getByText("Permission history (1)")).toBeVisible();
  });

  it("links customer evidence to the exact product records", async () => {
    const openFeature = vi.fn();
    const openFeedback = vi.fn();
    const openInteraction = vi.fn();
    const openSession = vi.fn();
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      openFeature,
      openFeedback,
      openInteraction,
      openSession,
    });

    expect(
      await screen.findByText("Results need to include newly indexed documents"),
    ).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Open feature" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Open report" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Open interaction" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Open session" })[0]);

    expect(openFeature).toHaveBeenCalledWith("freshness-gap");
    expect(openFeedback).toHaveBeenCalled();
    expect(openInteraction).toHaveBeenCalled();
    expect(openSession).toHaveBeenCalled();
  });
});

function renderCustomers(
  fetchMock: ReturnType<typeof mockCustomers>,
  overrides: Partial<Parameters<typeof CustomersView>[0]> = {},
) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CustomersView
        data={dashboardFixture()}
        selectedCustomerId={null}
        selectCustomer={vi.fn()}
        openFeature={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function mockCustomers() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/customers/")) {
      return Promise.resolve(json(customerDetailFixture()));
    }
    if (path.startsWith("/api/dashboard/customers?")) {
      return Promise.resolve(json(customersPageFixture()));
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
