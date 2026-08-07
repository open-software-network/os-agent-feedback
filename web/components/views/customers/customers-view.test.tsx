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

  it("renders customer metrics without exposing unlinked telemetry", async () => {
    const fetchMock = mockCustomers();
    renderCustomers(fetchMock);

    const row = await screen.findByRole("row", { name: "Open customer Acme workspace" });
    expect(within(row).getByText("3")).toBeVisible();
    expect(within(row).getByText("2")).toBeVisible();
    expect(within(row).getByText("Known · user…0042 · acct…0042")).toBeVisible();
    expect(within(row).queryByText(/linked user|linked to account/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Anonymous")[0].parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved interactions")).not.toBeInTheDocument();
    expect(screen.queryByText(/Customers stay linked to their sessions/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toBeVisible();
    expect(screen.queryByLabelText("Identity filter")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Context" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Traits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Identity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Type" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Sessions" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Data use" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sharing filter")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/dashboard/customers?productId="),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("serializes filters and restores an exact customer detail", async () => {
    const selectCustomer = vi.fn();
    const detail = customerDetailFixture();
    detail.signals.push({
      ...detail.signals[0],
      id: "signal-priority",
      signalKey: "shopping.priority",
      value: "quality",
      type: "constraint",
      summary: "shopping priority: quality",
    });
    const fetchMock = mockCustomers(detail);
    renderCustomers(fetchMock, { selectCustomer });

    fireEvent.click(await screen.findByRole("button", { name: /^Filters/ }));
    await screen.findByRole("option", { name: "Known (1)" });
    fireEvent.change(await screen.findByLabelText("Identity filter"), {
      target: { value: "verified" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(window.location.search).toContain("customerIdentity=verified"));
    expect(screen.getByText("Identity: Known")).toBeVisible();

    fireEvent.click(await screen.findByRole("row", { name: "Open customer Acme workspace" }));
    expect(selectCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    renderCustomers(fetchMock, {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(await screen.findByRole("heading", { name: "Acme workspace" })).toBeVisible();
    expect(screen.getAllByText("Known · user…0042 · acct…0042").length).toBeGreaterThan(0);
    expect(screen.queryByText(/linked user|linked to account/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Known customer")).not.toBeInTheDocument();
    const profile = screen.getByRole("region", { name: "What we've observed" });
    expect(within(profile).getByRole("heading", { name: "What we've observed" })).toBeVisible();
    expect(within(profile).getByText("$4,000/month")).toBeVisible();
    expect(within(profile).getByText("Cat")).toBeVisible();
    expect(
      within(profile).getByText(/Scoped context never becomes a customer trait/i),
    ).toBeVisible();
    expect(within(profile).getByText("Customer traits")).toBeVisible();
    expect(within(profile).getByText("Scoped context")).toBeVisible();
    expect(within(profile).getByText("Customer-wide")).toBeVisible();
    expect(within(profile).getByText("Journey · session-42")).toBeVisible();
    expect(within(profile).getByText("Request metadata")).toBeVisible();
    expect(
      within(profile).getByText(/Browser and network details describe a request/),
    ).toBeVisible();
    expect(within(profile).getAllByText(/Last seen/).length).toBeGreaterThan(0);
    expect(within(profile).queryByText("Never identity")).not.toBeInTheDocument();
    expect(within(profile).queryByText("Visitor traits")).not.toBeInTheDocument();
    expect(within(profile).queryByText("Request traits")).not.toBeInTheDocument();
    expect(within(profile).getByText("Network address")).toBeVisible();
    expect(within(profile).getByText("Client software")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Recent activity" })).not.toBeInTheDocument();
    expect(screen.queryByText("Latest activity")).not.toBeInTheDocument();
    expect(screen.queryByText(/deliberately remembers/i)).not.toBeInTheDocument();
    const sessions = screen.getByRole("region", { name: "Sessions" });
    expect(within(sessions).getByText("search")).toBeVisible();
    expect(within(sessions).getAllByText(/1 activity/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("heading", { name: "How we know this customer" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Observed traits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What we know" })).not.toBeInTheDocument();
    expect(screen.queryByText("Find the newest indexed policy")).not.toBeInTheDocument();
    expect(screen.queryByText("Context returned to product")).not.toBeInTheDocument();
    expect(screen.queryByText("Request facts")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissioned memory")).not.toBeInTheDocument();
  });

  it("omits repeated domain badges when every observed fact shares one domain", async () => {
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const profile = await screen.findByRole("region", { name: "What we've observed" });
    expect(within(profile).getByText("Budget")).toBeVisible();
    expect(within(profile).queryByText("Apartments")).not.toBeInTheDocument();
  });

  it("keeps domain badges when observed facts span multiple domains", async () => {
    const detail = customerDetailFixture();
    detail.observedProfile.facts.push({
      ...detail.observedProfile.facts[0],
      key: "petsmart.pet",
      domain: "petsmart",
      label: "Pet",
      value: "Dog",
    });
    renderCustomers(mockCustomers(detail), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const profile = await screen.findByRole("region", { name: "What we've observed" });
    expect(within(profile).getAllByText("Apartments").length).toBeGreaterThan(0);
    expect(within(profile).getByText("PetSmart")).toBeVisible();
  });

  it("keeps item and session context out of customer traits", async () => {
    const detail = customerDetailFixture();
    detail.observedProfile.facts = [
      {
        ...detail.observedProfile.facts[0],
        key: "lamps.budget",
        domain: "lamps",
        value: "$150",
        scope: "item",
        scopeRef: "task-lamp",
      },
      {
        ...detail.observedProfile.facts[0],
        key: "lamps.purpose",
        domain: "lamps",
        label: "Purpose",
        value: "Reading",
        scope: "session",
        scopeRef: "session-99",
      },
    ];
    renderCustomers(mockCustomers(detail), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const profile = await screen.findByRole("region", { name: "What we've observed" });
    expect(within(profile).getByText("Item · task-lamp")).toBeVisible();
    expect(within(profile).getByText("Session · session-99")).toBeVisible();
    expect(within(profile).getByText("No customer-wide traits observed yet.")).toBeVisible();
    expect(within(profile).queryByText("Customer-wide")).not.toBeInTheDocument();
  });

  it("opens the exact session from the full inspector row", async () => {
    const openSession = vi.fn();
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      openSession,
    });

    await screen.findByRole("heading", { name: "Acme workspace" });
    const sessions = screen.getByRole("region", { name: "Sessions" });
    const sessionRow = within(sessions).getByRole("button", {
      name: "Open session session-42",
    });
    expect(within(sessionRow).getByText("session-42")).toBeVisible();
    expect(sessionRow).toHaveClass("px-2");
    expect(sessionRow.parentElement).toHaveClass("-mx-2");
    expect(within(sessions).queryByText("Open session")).not.toBeInTheDocument();
    fireEvent.click(sessionRow);

    expect(openSession).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
  });

  it("opens the exact journey that supports an observed customer fact", async () => {
    const openSession = vi.fn();
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      openSession,
    });

    const profile = await screen.findByRole("region", { name: "What we've observed" });
    fireEvent.click(
      within(profile).getByRole("button", {
        name: "Open evidence for Budget: $4,000/month",
      }),
    );

    expect(openSession).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
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
        openSession={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function mockCustomers(detail = customerDetailFixture()) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/customers/")) {
      return Promise.resolve(json(detail));
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
