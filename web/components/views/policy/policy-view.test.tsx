import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";

import { PolicyView } from "./policy-view";

describe("PolicyView", () => {
  it("separates customer information, product personalization, and advertising permission", () => {
    render(
      <PolicyView
        data={dashboardFixture()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Allowed customer information" })).toBeVisible();
    for (const label of ["Current intent", "Preferences", "Constraints"]) {
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    }
    expect(screen.getByRole("heading", { name: "Product personalization" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Targeted advertising" })).toBeVisible();
    expect(screen.getByText("Off by default")).toBeVisible();
    expect(screen.getByText(/returns no customer information.*explicitly approved/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Enrichment permission" })).toBeVisible();
    expect(screen.getByText(/silence or ambiguity never becomes approval/i)).toBeVisible();
    expect(screen.getByText(/answers stay bounded to the current session/i)).toBeVisible();
    expect(screen.getByText("Advanced: legacy outcome feedback")).toBeVisible();
    fireEvent.click(screen.getByText("Advanced: legacy outcome feedback"));
    expect(
      screen.getByText(/does not approve, disable, or configure customer enrichment/i),
    ).toBeVisible();
  });
});
