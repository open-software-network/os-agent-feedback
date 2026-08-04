import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { InteractionDetail } from "./interaction-detail";

describe("InteractionDetail", () => {
  it("prioritizes result, verification, and attached feedback", () => {
    const data = dashboardFixture();
    const interaction = data.interactions[0];
    const back = vi.fn();
    const openFeedback = vi.fn();
    const openSession = vi.fn();

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={back}
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

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByText("Interaction")).toBeVisible();
    expect(within(breadcrumb).getByText(interaction.operation)).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(within(breadcrumb).getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledOnce();

    const technicalMetadata = screen.getByRole("complementary", {
      name: "Technical metadata",
    });
    expect(technicalMetadata).toHaveClass("xl:sticky");
    expect(within(technicalMetadata).getByText(interaction.id)).toHaveClass("font-mono");

    const feedbackSection = screen
      .getByRole("heading", { name: "Attached feedback" })
      .closest("section");
    expect(feedbackSection).not.toBeNull();
    const feedbackCard = feedbackSection?.querySelector('[data-slot="card"]');
    expect(feedbackCard).not.toBeNull();
    expect(within(feedbackCard as HTMLElement).getByText(data.reports[0].summary)).toBeVisible();
    expect(within(feedbackCard as HTMLElement).getByText("Impact")).toBeVisible();
    expect(within(feedbackCard as HTMLElement).getByText("Status")).toBeVisible();
    expect(within(feedbackCard as HTMLElement).getByText("Findings")).toBeVisible();

    expect(screen.getByText(/Epode stores structured metadata/)).toHaveClass(
      "font-sans",
      "text-xs",
    );

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
