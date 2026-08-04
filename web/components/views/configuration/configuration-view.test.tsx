import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { ConfigurationView, ProductConfigurationView } from "./configuration-view";

describe("ConfigurationView", () => {
  it("shows editor tabs in the requested order and routes between sections", () => {
    const onSectionChange = vi.fn();
    render(
      <ConfigurationView
        data={dashboardFixture()}
        section="setup"
        onSectionChange={onSectionChange}
      >
        <p>Configuration content</p>
      </ConfigurationView>,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Setup",
      "Product",
      "Connectors",
      "Team",
      "Data controls",
      "Context fields",
    ]);
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Product" }));
    expect(onSectionChange).toHaveBeenCalledWith("configuration");
  });

  it("keeps read-only product and team configuration available to members", () => {
    render(
      <ConfigurationView
        data={dashboardFixture({ currentRole: "member" })}
        section="configuration"
        onSectionChange={vi.fn()}
      >
        <p>Configuration content</p>
      </ConfigurationView>,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Product", "Team"]);
  });
});

describe("ProductConfigurationView", () => {
  it("shows the product context without exposing the removed environment concept", () => {
    const data = dashboardFixture();
    render(
      <ProductConfigurationView data={data} controls={<button type="button">Manage</button>} />,
    );

    expect(screen.getByText(data.currentProduct?.name ?? "")).toBeVisible();
    expect(screen.getByText(data.workspace.name)).toBeVisible();
    expect(screen.queryByText("Environment")).not.toBeInTheDocument();
    expect(screen.queryByText(data.currentEnvironment?.name ?? "")).not.toBeInTheDocument();
  });
});
