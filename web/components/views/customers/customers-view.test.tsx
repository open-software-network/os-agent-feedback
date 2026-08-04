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
    expect(within(row).getByText("Allowed")).toBeVisible();
    expect(screen.getAllByText("Anonymous")[0].parentElement).toHaveTextContent("1");
    expect(screen.getByText("Active").parentElement).toHaveTextContent("2");
    expect(screen.queryByText("Unresolved interactions")).not.toBeInTheDocument();
    expect(screen.getByText(/Customers stay linked to their sessions/i)).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Sessions" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Data use" })).toBeVisible();
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
    expect(screen.getByRole("heading", { name: "What we know" })).toBeVisible();
    expect(screen.getByText("Find the newest indexed policy")).toBeVisible();
    expect(screen.getAllByText(/search\.goal · newest_policy/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Customer said ·/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Open source session" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("heading", { name: "Data use" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Context returned to product" })).toBeVisible();
    expect(screen.getByText("Context version:").parentElement).toHaveTextContent(
      "ctx1_fixture_customer_context_version",
    );
    expect(screen.getByText("Applied variant: Freshness First")).toBeVisible();
    expect(screen.getByText("Outcome: Completion")).toBeVisible();
    expect(screen.getByText("Used")).toBeVisible();
    expect(screen.getByText(/Customer prompts and searches are not included/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeVisible();
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Targeted Advertising")[0]).toBeVisible();
    expect(screen.getByText("Data-use history (2)")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Permission" })).not.toBeInTheDocument();
  });

  it("links a customer to the exact session", async () => {
    const openSession = vi.fn();
    renderCustomers(mockCustomers(), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      openSession,
    });

    await screen.findByRole("heading", { name: "Acme workspace" });
    fireEvent.click(screen.getAllByRole("button", { name: "Open session" })[0]);

    expect(openSession).toHaveBeenCalled();
  });

  it("shows one data-use choice for the enrichment scopes recorded together", async () => {
    const detail = customerDetailFixture();
    const decidedAt = "2026-07-30T12:05:00Z";
    detail.consent = ["share_preferences", "personalize", "remember_preferences"].map((scope) => ({
      scope,
      enrichmentPurpose: "product_personalization" as const,
      state: "approved",
      basis: "user_consent",
      decidedAt,
      expiresAt: null,
      revokedAt: null,
      revision: 1,
    }));
    detail.consentHistory = detail.consent.map((grant, index) => ({
      id: `consent-event-${index}`,
      scope: grant.scope,
      enrichmentPurpose: grant.enrichmentPurpose,
      priorState: null,
      state: grant.state,
      basis: grant.basis,
      revision: grant.revision,
      source: "enrichment",
      decidedAt,
      createdAt: decidedAt,
    }));

    renderCustomers(mockCustomers(detail), {
      selectedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    await screen.findByRole("heading", { name: "What we know" });
    const dataUseSection = screen.getByRole("heading", { name: "Data use" }).closest("section");
    expect(dataUseSection).not.toBeNull();
    expect(
      within(dataUseSection as HTMLElement).getAllByText("Product Personalization"),
    ).toHaveLength(2);
    expect(
      screen.getByText("Use shared context · Personalize the experience · Remember across visits"),
    ).toBeVisible();
    expect(screen.getByText("Data-use history (1)")).toBeVisible();
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
