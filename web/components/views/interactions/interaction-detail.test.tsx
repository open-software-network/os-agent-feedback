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

  it("shows privacy-safe resolved Customer linkage without a customer ref", () => {
    const data = dashboardFixture();
    const interaction = data.interactions[0];
    interaction.customerRef = null;
    interaction.customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={vi.fn()}
        openSession={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Linked customer", { exact: false })).toHaveLength(2);
    expect(screen.queryByText("Unknown customer", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("Not linked")).not.toBeInTheDocument();
    expect(screen.queryByText(interaction.customerId)).not.toBeInTheDocument();
  });

  it("preserves the unlinked Customer labels when no linkage exists", () => {
    const data = dashboardFixture();
    const interaction = data.interactions[0];
    interaction.customerRef = null;
    interaction.customerId = null;

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={vi.fn()}
        openSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Unknown customer", { exact: false })).toBeVisible();
    expect(screen.getByText("Not linked")).toBeVisible();
  });
});

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
