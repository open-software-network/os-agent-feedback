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

  it("renders durable customer profiles separately from unresolved interactions", async () => {
    const fetchMock = mockCustomers();
    renderCustomers(fetchMock);

    const row = await screen.findByRole("row", { name: "Open customer Acme workspace" });
    expect(within(row).getByText("Known")).toBeVisible();
    expect(within(row).getByText("4")).toBeVisible();
    expect(within(row).getByText("Allowed")).toBeVisible();
    expect(screen.getAllByText("Anonymous")[0].parentElement).toHaveTextContent("1");
    expect(screen.getByText("Unresolved interactions").parentElement).toHaveTextContent("0");
    expect(
      screen.getByText(/Interaction-only context is not a durable customer profile/i),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/dashboard/customers?productId="),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("serializes filters and restores an exact customer detail", async () => {
    const selectCustomer = vi.fn();
    const fetchMock = mockCustomers();
    renderCustomers(fetchMock, { selectCustomer });

    await screen.findByRole("option", { name: "Known (1)" });
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
    const personalizationHeading = screen.getByRole("heading", {
      name: "Personalization context",
    });
    expect(personalizationHeading).toBeVisible();
    expect(screen.getByText("Intent and task context")).toBeVisible();
    expect(screen.getByText("Find the newest indexed policy")).toBeVisible();
    expect(
      within(personalizationHeading.closest("section") as HTMLElement).queryByText(
        "May prefer shorter answers",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("search.goal = newest_policy")).toBeVisible();
    expect(screen.getAllByText(/Allowed for Product personalization/i)[0]).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Context API preview" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Targeted Advertising")[0]).toBeVisible();
    expect(screen.getByText("Permission history (2)")).toBeVisible();
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

    await screen.findByRole("heading", { name: "Acme workspace" });
    fireEvent.click(screen.getByText("Why Epode knows this"));
    expect(screen.getByText("Results need to include newly indexed documents")).toBeVisible();
    expect(screen.getByText("May prefer shorter answers")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Related need" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Report evidence" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Interaction evidence" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Evidence" })[0]);

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
