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

    renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={session.id}
        selectSession={selectSession}
        openFeedback={openFeedback}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByRole("heading", { name: "session-42" })).toBeVisible();
    const journey = screen.getByRole("region", { name: "Observed journey" });
    expect(within(journey).getByText("Session started")).toBeVisible();
    expect(within(journey).getByText("Last observed")).toBeVisible();
    expect(within(journey).getByText("+00:00")).toBeVisible();
    expect(within(journey).getByText("+01:05")).toBeVisible();
    expect(within(journey).getByText("Feedback attached")).toBeVisible();
    expect(within(journey).getByText("Error response")).toBeVisible();
    expect(within(journey).queryByText(/replay/i)).not.toBeInTheDocument();

    fireEvent.click(within(journey).getByRole("button", { name: "Open feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Close session detail" }));
    expect(openFeedback).toHaveBeenCalledWith(base.reports[0].id);
    expect(selectSession).toHaveBeenCalledWith(null);
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
    expect(within(row).getByText("3 · Blocked")).toBeVisible();
    expect(within(row).getByText("account-high-volume")).toBeVisible();
    expect(screen.getAllByText("Interactions")[0].parentElement).toHaveTextContent("12");

    fireEvent.click(screen.getByRole("button", { name: "Has feedback" }));
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
    expect(screen.getByRole("button", { name: "Multi-step" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "refund" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Has feedback" }));

    await waitFor(() => {
      expect(window.location.search).toContain("sessionQ=refund");
      expect(window.location.search).toContain("sessionKind=feedback");
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
