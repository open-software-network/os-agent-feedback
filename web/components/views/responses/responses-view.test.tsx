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

  it("leads with received answers and links the tool, customer, and session", async () => {
    vi.stubGlobal("fetch", responseFetch());
    const openCustomer = vi.fn();
    const openSession = vi.fn();
    renderResponses(openCustomer, openSession);

    const row = await screen.findByRole("row", { name: /Blue.*search_catalog/i });
    expect(within(row).getByText("Blue")).toBeVisible();
    expect(within(row).getByText("search_catalog")).toBeVisible();
    expect(within(row).queryByText("Answered")).not.toBeInTheDocument();
    expect(within(row).queryByText("What color does the user prefer?")).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Acme workspace" }));
    fireEvent.click(within(row).getByRole("button", { name: "session-42" }));

    expect(openCustomer).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(openSession).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
    expect(screen.getByRole("columnheader", { name: "Answer" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Tool called" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Journey" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Question" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Session" })).not.toBeInTheDocument();
  });

  it("persists search without promoting response protocol states into filters", async () => {
    window.history.replaceState({}, "", "/?view=responses&responseStatus=answered");
    const fetchMock = responseFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderResponses();
    await screen.findByText("Blue");

    fireEvent.change(screen.getByRole("textbox", { name: "Search responses" }), {
      target: { value: "color" },
    });

    await waitFor(() => {
      expect(window.location.search).toContain("responseQ=color");
      expect(window.location.search).not.toContain("responseStatus");
      expect(screen.queryByRole("combobox", { name: "Response status" })).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(String(input), "https://epode.test");
          return url.searchParams.get("q") === "color" && !url.searchParams.has("status");
        }),
      ).toBe(true);
    });
  });

  it("restores search after same-view browser history navigation", async () => {
    window.history.replaceState({}, "", "/?view=responses&responseQ=beta");
    vi.stubGlobal("fetch", responseFetch());
    renderResponses();

    expect(screen.getByRole("textbox", { name: "Search responses" })).toHaveValue("beta");

    window.history.replaceState({}, "", "/?view=responses&responseQ=alpha");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search responses" })).toHaveValue("alpha");
    });
  });

  it("describes exceptional outcomes once without status badges", async () => {
    const base = responsePage().responses[0];
    vi.stubGlobal(
      "fetch",
      responseFetch({
        responses: [
          { ...base, id: "awaiting", status: "awaiting_answer", answers: [] },
          { ...base, id: "declined", status: "declined", answers: [] },
          { ...base, id: "unavailable", status: "no_relevant_context", answers: [] },
          { ...base, id: "missing", status: "answered", answers: [] },
        ],
      }),
    );
    renderResponses();

    expect(await screen.findByText("Waiting for shared context.")).toBeVisible();
    expect(screen.getByText("The customer agent declined to share context.")).toBeVisible();
    expect(screen.getByText("No relevant context was shared.")).toBeVisible();
    expect(screen.getByText("No answer content was recorded.")).toBeVisible();
    expect(screen.queryByText(/^Answered$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Declined$/)).not.toBeInTheDocument();
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
      screen.getByText(
        "Answers appear here when a customer agent shares context during a journey.",
      ),
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
