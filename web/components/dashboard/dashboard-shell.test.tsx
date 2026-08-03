import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("uses the thin customer-enrichment navigation", () => {
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

    const labels = ["Home", "Customers", "Responses", "Sessions", "Configurations"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeVisible();
    for (const hidden of [
      "Insights",
      "Signals",
      "Interactions",
      "Contexts",
      "Evidences",
      "Setup",
      "Connectors",
      "Data controls",
    ]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }

    const coreLabels = screen
      .getAllByRole("button")
      .map((item) => item.textContent)
      .filter((label) => ["Home", "Customers", "Responses", "Sessions"].includes(label ?? ""));
    expect(coreLabels).toEqual(["Home", "Customers", "Responses", "Sessions"]);
  });

  it("opens Setup from the Configurations sidebar entry for editors", () => {
    const onNavigate = vi.fn();
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="home"
        onNavigate={onNavigate}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Dashboard content</div>
      </DashboardShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Configurations" }));

    expect(onNavigate).toHaveBeenCalledWith("setup");
  });

  it("marks Configurations current while a configuration tab is open", () => {
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

    expect(screen.getByRole("button", { name: "Configurations" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("routes members to the read-only Product configuration tab", () => {
    const onNavigate = vi.fn();
    render(
      <DashboardShell
        data={dashboardFixture({ currentRole: "member" })}
        view="home"
        onNavigate={onNavigate}
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
    for (const label of ["Home", "Customers", "Responses", "Sessions", "Configurations"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Configurations" }));
    expect(onNavigate).toHaveBeenCalledWith("configuration");
  });

  it("offers product creation from the product menu even with one product", async () => {
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
        name: `${data.currentProduct?.name}, ${data.workspace.name} - open product menu`,
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

    expect(screen.queryByRole("button", { name: /open product menu/i })).not.toBeInTheDocument();
  });
});
