import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { DashboardResponsesPage } from "@/lib/api/dashboard";

import { ResponsesView } from "./responses-view";

describe("ResponsesView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?view=responses");
  });

  it("lists questions and received answers with customer and session links", async () => {
    vi.stubGlobal("fetch", responseFetch());
    const openCustomer = vi.fn();
    const openSession = vi.fn();
    renderResponses(openCustomer, openSession);

    const row = await screen.findByRole("row", { name: /What color does the user prefer/i });
    expect(within(row).getByText("Blue")).toBeVisible();
    expect(within(row).getByText("Answered")).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Acme workspace" }));
    fireEvent.click(within(row).getByRole("button", { name: "session-42" }));

    expect(openCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(openSession).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });

  it("persists search and status filters and sends both to the server", async () => {
    const fetchMock = responseFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderResponses();
    await screen.findByText("Blue");

    fireEvent.change(screen.getByRole("textbox", { name: "Search responses" }), {
      target: { value: "color" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Response status" }), {
      target: { value: "answered" },
    });

    await waitFor(() => {
      expect(window.location.search).toContain("responseQ=color");
      expect(window.location.search).toContain("responseStatus=answered");
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(String(input), "https://epode.test");
          return (
            url.searchParams.get("q") === "color" && url.searchParams.get("status") === "answered"
          );
        }),
      ).toBe(true);
    });
  });

  it("shows an honest empty state before any question is asked", async () => {
    vi.stubGlobal(
      "fetch",
      responseFetch({
        responses: [],
        rollup: { questions: 0, answered: 0, awaitingAnswer: 0, declined: 0 },
      }),
    );
    renderResponses();

    expect(await screen.findByText("No responses yet")).toBeVisible();
    expect(
      screen.getByText("Questions and answers will appear here after Epode asks a customer agent."),
    ).toBeVisible();
  });
});

function renderResponses(openCustomer = vi.fn(), openSession = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ResponsesView
        data={dashboardFixture()}
        openCustomer={openCustomer}
        openSession={openSession}
      />
    </QueryClientProvider>,
  );
}

function responsePage(): DashboardResponsesPage {
  return {
    responses: [
      {
        id: "response-1",
        question: "What color does the user prefer?",
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
    limit: 50,
    nextCursor: null,
  };
}

function responseFetch(overrides: Partial<DashboardResponsesPage> = {}) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    if (!String(input).startsWith("/api/dashboard/responses?")) {
      throw new Error(`Unexpected request: ${String(input)}`);
    }
    return Promise.resolve(json({ ...responsePage(), ...overrides }));
  });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
