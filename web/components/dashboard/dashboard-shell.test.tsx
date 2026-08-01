import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("uses the customer-intelligence navigation without a standalone feedback tab", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="home"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    const labels = ["Home", "Customers", "Features", "Sessions", "Configuration"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Feedback" })).not.toBeInTheDocument();
  });

  it("offers product creation from the context switcher even with one product", async () => {
    const data = dashboardFixture();
    const onNavigate = vi.fn();
    render(
      <DashboardShell
        data={data}
        view="home"
        onNavigate={onNavigate}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `${data.currentProduct?.name}, ${data.workspace.name} - open context menu`,
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "New product" }));

    expect(onNavigate).toHaveBeenCalledWith("configuration");
  });

  it("does not offer product creation to read-only members", () => {
    const data = dashboardFixture({ currentRole: "member" });
    render(
      <DashboardShell
        data={data}
        view="home"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    expect(screen.queryByRole("button", { name: /open context menu/i })).not.toBeInTheDocument();
  });
});
