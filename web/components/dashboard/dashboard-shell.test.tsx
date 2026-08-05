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

    const labels = [
      "Home",
      "Customers",
      "Responses",
      "Journeys",
      "Questions",
      "Connectors",
      "Configurations",
    ];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeVisible();
    for (const hidden of [
      "Insights",
      "Signals",
      "Interactions",
      "Contexts",
      "Evidences",
      "Setup",
      "Data controls",
    ]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }

    const coreLabels = screen
      .getAllByRole("button")
      .map((item) => item.textContent)
      .filter((label) => ["Home", "Journeys", "Customers", "Responses"].includes(label ?? ""));
    expect(coreLabels).toEqual(["Home", "Journeys", "Customers", "Responses"]);
  });

  it("opens Questions from the sidebar as a top-level destination", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Questions" }));

    expect(onNavigate).toHaveBeenCalledWith("questions");
  });

  it("marks the Questions sidebar entry current on the Questions view", () => {
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

    expect(screen.getByRole("button", { name: "Questions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Configurations" })).not.toHaveAttribute(
      "aria-current",
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

  it("uses the main-owned Response title for a linked record", () => {
    const data = dashboardFixture();
    const commonProps = {
      data,
      onNavigate: vi.fn(),
      onWorkspaceChange: vi.fn(),
      onProductChange: vi.fn(),
      onLogout: vi.fn(),
    };
    const { rerender } = render(
      <DashboardShell {...commonProps} view="responses">
        <div>Response queue</div>
      </DashboardShell>,
    );

    expect(screen.getByRole("heading", { name: "Responses" })).toBeVisible();

    rerender(
      <DashboardShell {...commonProps} view="feedback">
        <div>Response detail</div>
      </DashboardShell>,
    );

    expect(screen.getByRole("heading", { name: "Response" })).toBeVisible();
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
    for (const label of ["Home", "Journeys", "Customers", "Responses", "Configurations"]) {
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
