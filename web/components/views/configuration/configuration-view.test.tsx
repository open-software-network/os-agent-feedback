import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { ProductConfigurationView } from "./configuration-view";

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
