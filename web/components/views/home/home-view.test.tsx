import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { customersPageFixture, dashboardFixture } from "@/components/dashboard/test-fixture";
import type { DashboardData, DashboardResponsesPage } from "@/lib/api/dashboard";

import { HomeView } from "./home-view";

describe("HomeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1");
  });

  it("leads with the question-and-answer product model", async () => {
    renderHome(dashboardFixture());

    expect(
      await screen.findByRole("heading", {
        name: "Epode asks customer agents questions and records their answers.",
      }),
    ).toBeVisible();
    const glance = screen.getByRole("region", { name: "At a glance" });
    expect(within(glance).getByText("Customers")).toBeVisible();
    expect(within(glance).getByText("Questions asked")).toBeVisible();
    expect(within(glance).getByText("Answers received")).toBeVisible();
    expect(within(glance).getByText("Sessions")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent responses" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent customers" })).toBeVisible();
    expect(screen.queryByText(/signals|interactions|contexts|evidences/i)).not.toBeInTheDocument();
  });

  it("opens linked customers and sessions", async () => {
    const openCustomer = vi.fn();
    const openSession = vi.fn();
    renderHome(dashboardFixture(), { openCustomer, openSession });

    fireEvent.click(await screen.findByRole("button", { name: "Acme workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "session-42" }));

    expect(openCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(openSession).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });

  it("routes to the core object screens and refreshes both lists", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = mockHome();
    renderHome(dashboardFixture(), { refresh }, fetchMock);

    await screen.findByText("Blue");
    fireEvent.click(screen.getByRole("button", { name: /view responses/i }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("responses");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/dashboard/customers?"),
      ).length,
    ).toBeGreaterThan(1);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/dashboard/responses?"),
      ).length,
    ).toBeGreaterThan(1);
  });
});

function renderHome(
  data: DashboardData,
  overrides: Partial<Parameters<typeof HomeView>[0]> = {},
  fetchMock = mockHome(),
) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomeView
        data={data}
        openCustomer={vi.fn()}
        openSession={vi.fn()}
        openFeedback={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function responsesPage(): DashboardResponsesPage {
  return {
    responses: [
      {
        id: "response-1",
        question: "What color does the user prefer?",
        operation: "search_catalog",
        status: "answered",
        purpose: "product_personalization",
        surface: "mcp",
        customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        customerName: "Acme workspace",
        sessionId: "33333333-3333-4333-8333-333333333333",
        sessionRef: "session-42",
        askedAt: "2026-08-02T12:00:00Z",
        answeredAt: "2026-08-02T12:01:00Z",
        answers: [
          {
            key: "preferred_color",
            type: "preference",
            value: "Blue",
            summary: "The user prefers blue",
            remembered: true,
          },
        ],
      },
    ],
    rollup: { questions: 4, answered: 3, awaitingAnswer: 1, declined: 0 },
    limit: 6,
    nextCursor: null,
  };
}

function mockHome() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/customers?")) {
      return Promise.resolve(json(customersPageFixture()));
    }
    if (path.startsWith("/api/dashboard/responses?")) {
      return Promise.resolve(json(responsesPage()));
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
