import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { SessionsView } from "./sessions-view";

describe("SessionsView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?view=sessions");
  });

  it("renders an observed metadata journey without implying replay", async () => {
    const base = dashboardFixture();
    const session = {
      ...base.sessions[0],
      startedAt: "2026-07-30T12:00:00Z",
      lastSeenAt: "2026-07-30T12:02:00Z",
    };
    const firstInteraction = {
      ...base.interactions[0],
      occurredAt: "2026-07-30T12:00:00Z",
    };
    const errorInteraction = {
      ...base.interactions[0],
      id: "88888888-8888-4888-8888-888888888888",
      operation: "retry_search",
      occurredAt: "2026-07-30T12:01:05Z",
      statusCode: 503,
    };
    const data = dashboardFixture({
      sessions: [session],
      interactions: [firstInteraction, errorInteraction],
    });
    vi.stubGlobal(
      "fetch",
      sessionFetch(data, {
        session,
        interactions: [errorInteraction, firstInteraction],
        reports: base.reports,
      }),
    );
    const selectSession = vi.fn();
    const openFeedback = vi.fn();
    const openInteraction = vi.fn();

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={session.id}
        selectSession={selectSession}
        openFeedback={openFeedback}
        openInteraction={openInteraction}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByRole("heading", { name: "session-42" })).toBeVisible();
    const closeButton = screen.getByRole("button", { name: "Close session detail" });
    expect(closeButton.parentElement).toHaveTextContent("Session");
    expect(closeButton.parentElement).not.toHaveTextContent(session.refHint);
    expect(screen.queryByText("Proven session")).not.toBeInTheDocument();
    const journey = screen.getByRole("region", { name: "Observed journey" });
    expect(screen.getAllByText("Started").some((element) => element.tagName === "DT")).toBe(true);
    expect(within(journey).getByText("Session started")).toBeVisible();
    expect(within(journey).getByText("Last observed")).toBeVisible();
    expect(within(journey).getByText("+00:00")).toBeVisible();
    expect(within(journey).getByText("+01:05")).toBeVisible();
    expect(within(journey).getByText(/Feedback attached/)).toBeVisible();
    expect(within(journey).getByText("Error response")).toBeVisible();
    expect(within(journey).queryByText(/replay/i)).not.toBeInTheDocument();
    expect(within(journey).getByRole("list")).toHaveClass("before:border-dotted");

    const openFeedbackButton = within(journey).getByRole("button", { name: "Open feedback" });
    expect(openFeedbackButton).toHaveClass("border-border", "bg-background");
    expect(openFeedbackButton.closest("div")).toHaveClass("border", "bg-muted/30");

    fireEvent.click(within(journey).getByRole("button", { name: "retry_search" }));
    fireEvent.click(openFeedbackButton);
    fireEvent.click(closeButton);
    expect(openInteraction).toHaveBeenCalledWith(errorInteraction.id);
    expect(openFeedback).toHaveBeenCalledWith(base.reports[0].id);
    expect(selectSession).toHaveBeenCalledWith(null);
  });

  it("links canonical questions and bounded answers to their session interaction", async () => {
    const base = dashboardFixture();
    const session = base.sessions[0];
    const interaction = base.interactions[0];
    const openInteraction = vi.fn();
    vi.stubGlobal(
      "fetch",
      sessionFetch(base, {
        session,
        interactions: [interaction],
        reports: [],
        responses: [
          {
            id: "response-1",
            interactionId: interaction.id,
            question: "What should Tripwise prioritize for this traveler?",
            status: "answered",
            purpose: "product_personalization",
            surface: "mcp",
            customerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            customerName: "Traveler 1042",
            askedAt: "2026-08-02T12:00:00Z",
            answeredAt: "2026-08-02T12:01:00Z",
            answers: [
              {
                key: "travel.cabin_preference",
                type: "preference",
                value: "premium_economy",
                summary: "travel cabin preference: premium economy",
                remembered: true,
              },
              {
                key: "travel.max_stops",
                type: "constraint",
                value: "1",
                summary: "travel maximum stops: 1",
                remembered: false,
              },
            ],
          },
        ],
      }),
    );

    renderWithQuery(
      <SessionsView
        data={base}
        selectedSessionId={session.id}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={openInteraction}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const responses = await screen.findByRole("region", { name: "Questions and answers" });
    const journey = screen.getByRole("region", { name: "Observed journey" });
    expect(journey.compareDocumentPosition(responses) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      within(responses).getByText("What should Tripwise prioritize for this traveler?"),
    ).toBeVisible();
    expect(within(responses).queryByText("Answered")).not.toBeInTheDocument();
    expect(within(responses).getByText("travel.cabin_preference")).toBeVisible();
    expect(within(responses).getByText("premium_economy")).toBeVisible();
    expect(within(responses).getByText("travel.max_stops")).toBeVisible();
    expect(within(responses).getByText("1")).toBeVisible();
    expect(within(responses).getByText("Traveler 1042", { exact: false })).toBeVisible();
    expect(within(responses).queryByText(/raw prompt|tool query/i)).not.toBeInTheDocument();

    fireEvent.click(within(responses).getByRole("button", { name: "Open interaction" }));
    expect(openInteraction).toHaveBeenCalledWith(interaction.id);
  });

  it("describes a response exception once without status chrome", async () => {
    const base = dashboardFixture();
    const session = base.sessions[0];
    const interaction = base.interactions[0];
    vi.stubGlobal(
      "fetch",
      sessionFetch(base, {
        session,
        interactions: [interaction],
        reports: [],
        responses: [
          {
            id: "response-1",
            interactionId: interaction.id,
            question: "What context can be shared?",
            status: "declined",
            purpose: "product_personalization",
            surface: "mcp",
            customerId: null,
            customerName: null,
            askedAt: "2026-08-02T12:00:00Z",
            answeredAt: "2026-08-02T12:01:00Z",
            answers: [],
          },
        ],
      }),
    );

    renderWithQuery(
      <SessionsView
        data={base}
        selectedSessionId={session.id}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const responses = await screen.findByRole("region", { name: "Questions and answers" });
    expect(
      within(responses).getByText("The customer agent declined to share context."),
    ).toBeVisible();
    expect(within(responses).queryByText(/^Declined$/)).not.toBeInTheDocument();
  });

  it("opens a session from the full row or its explicit accessible control", () => {
    const data = dashboardFixture();
    const selectSession = vi.fn();

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={selectSession}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const row = screen.getByRole("row", { name: new RegExp(data.sessions[0].refHint) });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: data.sessions[0].refHint }));

    expect(selectSession).toHaveBeenNthCalledWith(1, data.sessions[0].id);
    expect(selectSession).toHaveBeenNthCalledWith(2, data.sessions[0].id);
    expect(selectSession).toHaveBeenNthCalledWith(3, data.sessions[0].id);
  });

  it("uses complete server rollups when interaction and report windows do not overlap", async () => {
    const base = dashboardFixture();
    const data = dashboardFixture({
      interactions: [],
      reports: [],
      sessions: [
        {
          ...base.sessions[0],
          interactionCount: 12,
          reportCount: 3,
          firstOperation: "search",
          lastOperation: "export",
          customerRef: "account-high-volume",
          strongestImpact: "blocked",
        },
      ],
    });
    vi.stubGlobal("fetch", sessionFetch(data));

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const row = screen.getByRole("row", { name: new RegExp(base.sessions[0].refHint) });
    expect(within(row).getByText("12-step journey")).toBeVisible();
    expect(within(row).getByText("12")).toBeVisible();
    expect(within(row).getByText("Blocked")).toBeVisible();
    expect(within(row).getByText("account-high-volume")).toBeVisible();
    expect(within(row).queryByText(/evidence|signals|context/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Interactions")[0].parentElement).toHaveTextContent("12");

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Has response" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByRole("row", { name: new RegExp(base.sessions[0].refHint) }),
    ).toBeVisible();
  });

  it("restores and updates shareable server filter state", async () => {
    const data = dashboardFixture();
    window.history.replaceState({}, "", "/?view=sessions&sessionQ=checkout&sessionKind=multi");
    vi.stubGlobal("fetch", sessionFetch(data));

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Search sessions" })).toHaveValue("checkout");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.getByRole("button", { name: "Multi-step" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "refund" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Has response" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(window.location.search).toContain("sessionQ=refund");
      expect(window.location.search).toContain("sessionKind=response");
    });
  });

  it("upgrades legacy feedback filter links to response filters", async () => {
    const data = dashboardFixture();
    window.history.replaceState({}, "", "/?view=sessions&sessionKind=feedback");
    vi.stubGlobal("fetch", sessionFetch(data));

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.getByRole("button", { name: "Has response" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(window.location.search).toContain("sessionKind=response"));
  });

  it("restores useful server constraints from the URL and applies them together", async () => {
    const data = dashboardFixture();
    window.history.replaceState(
      {},
      "",
      "/?view=sessions&sessionOperation=checkout&sessionCustomer=tenant-a&sessionImpact=blocked&sessionRange=7d",
    );
    const fetchMock = sessionFetch(data);
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("Operation: checkout")).toBeVisible();
    expect(screen.getByText("Customer: tenant-a")).toBeVisible();
    expect(screen.getByText("Impact: Blocked")).toBeVisible();
    expect(screen.getByText("Last 7 days")).toBeVisible();
    await waitFor(() => {
      const path = fetchMock.mock.calls
        .map(([input]) => String(input))
        .find((input) => input.startsWith("/api/dashboard/sessions?"));
      expect(path).toContain("operation=checkout");
      expect(path).toContain("customerRef=tenant-a");
      expect(path).toContain("impact=blocked");
      expect(path).toContain("since=");
    });

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "refund" } });
    fireEvent.change(screen.getByLabelText("Customer reference"), {
      target: { value: "tenant-b" },
    });
    fireEvent.change(screen.getByLabelText("Contains impact"), {
      target: { value: "hindered" },
    });
    fireEvent.change(screen.getByLabelText("Last seen"), { target: { value: "30d" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(window.location.search).toContain("sessionOperation=refund");
      expect(window.location.search).toContain("sessionCustomer=tenant-b");
      expect(window.location.search).toContain("sessionImpact=hindered");
      expect(window.location.search).toContain("sessionRange=30d");
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const path = String(input);
          return (
            path.includes("operation=refund") &&
            path.includes("customerRef=tenant-b") &&
            path.includes("impact=hindered") &&
            path.includes("since=")
          );
        }),
      ).toBe(true);
    });
  });

  it("debounces session search before issuing a server request", async () => {
    const data = dashboardFixture();
    const fetchMock = sessionFetch(data);
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const search = screen.getByRole("textbox", { name: "Search sessions" });
    fireEvent.change(search, { target: { value: "r" } });
    fireEvent.change(search, { target: { value: "re" } });
    fireEvent.change(search, { target: { value: "refund" } });

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("q=refund"))).toBe(false);
    await waitFor(() => {
      const searched = fetchMock.mock.calls.filter(([input]) => String(input).includes("q="));
      expect(searched).toHaveLength(1);
      expect(String(searched[0][0])).toContain("q=refund");
    });
  });
});

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sessionFetch(data: ReturnType<typeof dashboardFixture>, detail?: unknown) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/sessions?")) {
      const interactions = data.sessions.reduce(
        (total, session) => total + session.interactionCount,
        0,
      );
      return Promise.resolve(
        json({
          sessions: data.sessions,
          rollup: {
            sessions: data.listState.sessionsTotal,
            interactions,
            multiStepSessions: data.sessions.filter((session) => session.interactionCount > 1)
              .length,
            averageInteractions: data.sessions.length ? interactions / data.sessions.length : 0,
          },
          limit: 50,
          nextCursor: null,
        }),
      );
    }
    if (path.startsWith("/api/dashboard/sessions/") && detail) {
      return Promise.resolve(json(detail));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}
