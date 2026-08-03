import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("uses the thin customer-enrichment navigation", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="insights"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    const labels = ["Customers", "Insights", "Setup", "Connectors", "Data controls"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeVisible();
    for (const hidden of ["Home", "Features", "Sessions", "Feedback", "Interactions"]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("navigates to connectors from the sidebar", () => {
    const onNavigate = vi.fn();
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="insights"
        onNavigate={onNavigate}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));

    expect(onNavigate).toHaveBeenCalledWith("connectors");
  });

  it("marks the connectors entry current while the connectors view is open", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="connectors"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    expect(screen.getByRole("button", { name: "Connectors" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides editor-only entries from read-only members", () => {
    render(
      <DashboardShell
        data={dashboardFixture({ currentRole: "member" })}
        view="insights"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    for (const hidden of ["Connectors", "Setup", "Data controls"]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }
    for (const label of ["Customers", "Insights"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
  });

  it("offers product creation from the context switcher even with one product", async () => {
    const data = dashboardFixture();
    const onNavigate = vi.fn();
    render(
      <DashboardShell
        data={data}
        view="insights"
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
        view="insights"
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
