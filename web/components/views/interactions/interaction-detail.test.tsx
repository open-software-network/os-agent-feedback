import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { InteractionDetail } from "./interaction-detail";

describe("InteractionDetail", () => {
  it("prioritizes result, verification, and attached feedback", () => {
    const data = dashboardFixture();
    const interaction = data.interactions[0];
    const openFeedback = vi.fn();
    const openSession = vi.fn();

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={openFeedback}
        openSession={openSession}
      />,
    );

    const operationHeading = screen.getByRole("heading", { name: "search", level: 2 });
    expect(operationHeading).toHaveClass("font-mono");
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "search",
      "Result",
      "Verification",
      "Attached feedback",
      "Session",
      "Technical metadata",
    ]);
    expect(screen.getByText(interaction.id)).toHaveClass("font-mono");

    fireEvent.click(screen.getByRole("button", { name: "Open feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(openFeedback).toHaveBeenCalledWith(data.reports[0].id);
    expect(openSession).toHaveBeenCalledWith(data.sessions[0].id);
  });
});

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
