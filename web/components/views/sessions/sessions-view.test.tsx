import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { SessionsView } from "./sessions-view";

describe("SessionsView", () => {
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
      vi.fn().mockResolvedValue(
        json({
          session,
          interactions: [errorInteraction, firstInteraction],
          reports: base.reports,
        }),
      ),
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

  it("opens a session from the full row with pointer or keyboard input", () => {
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
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });

    expect(selectSession).toHaveBeenNthCalledWith(1, data.sessions[0].id);
    expect(selectSession).toHaveBeenNthCalledWith(2, data.sessions[0].id);
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
