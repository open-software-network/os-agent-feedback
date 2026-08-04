import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";

import { TeamView } from "./team-view";

describe("TeamView", () => {
  it("keeps the member invite-link action in the invitation header", () => {
    render(
      <TeamView
        data={dashboardFixture()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Invite teammates" });
    const copyLink = screen.getByRole("button", { name: "Copy member invite link" });

    expect(heading.parentElement).toContainElement(copyLink);
  });
});
