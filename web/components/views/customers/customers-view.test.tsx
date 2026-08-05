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
    expect(within(row).getByText("Known")).toBeVisible();
    expect(within(row).getByText("2")).toBeVisible();
    expect(within(row).getByText("Customer · user…0042 · acct…0042")).toBeVisible();
    expect(within(row).queryByText(/linked user|linked to account/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Anonymous")[0].parentElement).toHaveTextContent("1");
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved interactions")).not.toBeInTheDocument();
    expect(screen.queryByText(/Customers stay linked to their sessions/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toBeVisible();
    expect(screen.queryByLabelText("Identity filter")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Identity" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Type" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Journeys" })).toBeVisible();
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
    expect(screen.getAllByText("Customer · user…0042 · acct…0042").length).toBeGreaterThan(0);
    expect(screen.queryByText(/linked user|linked to account/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Known customer")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What we know" })).toBeVisible();
    expect(screen.getByText("Find the newest indexed policy")).toBeVisible();
    expect(screen.getAllByText(/search\.goal · newest_policy/).length).toBeGreaterThan(0);
    expect(screen.getByText("shopping priority: quality")).toBeVisible();
    expect(screen.queryByText("shopping.priority · quality")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Customer said ·/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Open source session" }).length).toBeGreaterThan(
      0,
    );
    const contextReturns = screen.getByRole("region", { name: "Context returned to product" });
    expect(within(contextReturns).getByText("search.goal")).toBeVisible();
    expect(within(contextReturns).queryByText("newest_policy")).not.toBeInTheDocument();
    expect(screen.getByText("Context version:").parentElement).toHaveTextContent(
      "ctx1_fixture_customer_context_version",
    );
    expect(screen.getByText("Retrieval details")).toBeInTheDocument();
    expect(screen.getByText("Applied variant: Freshness First")).toBeVisible();
    expect(screen.getByText("Outcome: Completion")).toBeVisible();
    expect(screen.getByText("Used")).toBeVisible();
    expect(screen.getByText(/Customer prompts and searches are not included/i)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Data use" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request facts" })).toBeVisible();
    expect(screen.getByText(/IP 203\.0\.113\.42 · GET · en-US/)).toBeVisible();
    expect(screen.queryByText(/Not mobile/)).not.toBeInTheDocument();
    expect(screen.getByText("ExampleBrowser/1.0")).toBeVisible();
    expect(screen.getByText(/MAC addresses are not exposed by routed HTTP/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Journeys" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Permission" })).not.toBeInTheDocument();
  });

  it("opens the exact session from the full inspector row", async () => {
    const openSession = vi.fn();
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      openSession,
    });

    await screen.findByRole("heading", { name: "Acme workspace" });
    const sessions = screen.getByRole("region", { name: "Journeys" });
    const sessionRow = within(sessions).getByRole("button", {
      name: "Open journey session-42",
    });
    expect(within(sessionRow).getByText("session-42")).toBeVisible();
    expect(sessionRow).toHaveClass("px-2");
    expect(sessionRow.parentElement).toHaveClass("-mx-2");
    expect(within(sessions).queryByText("Open journey")).not.toBeInTheDocument();
    fireEvent.click(sessionRow);

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
