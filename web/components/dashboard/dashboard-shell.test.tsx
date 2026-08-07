import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("uses the agent-experience navigation", () => {
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

    const labels = ["Home", "Insights", "Customers", "Sessions", "Configurations"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeVisible();
    for (const hidden of [
      "Responses",
      "Context",
      "Connectors",
      "Signals",
      "Interactions",
      "Contexts",
      "Evidences",
      "Setup",
      "Data controls",
      "Memory",
    ]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }

    const coreLabels = screen
      .getAllByRole("button")
      .map((item) => item.textContent)
      .filter((label) => ["Home", "Sessions", "Customers"].includes(label ?? ""));
    expect(coreLabels).toEqual(["Home", "Sessions", "Customers"]);
  });

  it("marks Configurations current while the Memory section is open", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="questions"
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

  it("opens Product from the Configurations sidebar entry", () => {
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

    expect(onNavigate).toHaveBeenCalledWith("configuration");
  });

  it("marks Configurations current while a configuration tab is open", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="policy"
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

  it("uses the Report title for a linked feedback record", () => {
    render(
      <DashboardShell
        data={dashboardFixture()}
        view="feedback"
        onNavigate={vi.fn()}
        onWorkspaceChange={vi.fn()}
        onProductChange={vi.fn()}
        onLogout={vi.fn()}
      >
        <div>Report detail</div>
      </DashboardShell>,
    );

    expect(screen.getByRole("heading", { name: "Report" })).toBeVisible();
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

    for (const hidden of ["Connectors", "Setup", "Data controls", "Responses", "Context"]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }
    for (const label of ["Home", "Insights", "Sessions", "Customers", "Configurations"]) {
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
    const productMenuChevron = document.querySelector('[data-icon="product-menu-chevron"]');
    expect(productMenuChevron).toHaveAttribute("width", "16px");
    expect(productMenuChevron).toHaveAttribute("height", "16px");
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

  it("keeps the compact shell headers aligned and centers the collapsed trigger", () => {
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

    expect(screen.getByRole("banner")).toHaveClass("h-10");
    expect(document.querySelector('[data-slot="sidebar-header"]')).toHaveClass("h-10");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveClass(
      "left-1/2",
      "-translate-x-1/2",
    );
  });
});
