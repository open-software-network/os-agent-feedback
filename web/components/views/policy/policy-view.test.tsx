import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { PolicyView } from "./policy-view";

describe("PolicyView", () => {
  it("explains durable Ask once consent and its safe no-reference fallback", () => {
    render(
      <PolicyView
        data={dashboardFixture()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
        embedded
      />,
    );

    expect(screen.getByText(/remembered under an HMAC-derived subject/i)).toBeVisible();
    expect(screen.getByText(/stores .* separately with interaction telemetry/i)).toBeVisible();
    expect(screen.getByText(/survive new agent sessions/i)).toBeVisible();
    expect(
      screen.getByText(
        /without a customer reference, permission is safely requested for each use/i,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/For MCP, Never ask is currently the most reliable choice/i),
    ).toBeVisible();
    expect(
      screen.getByText(/verify the exact client versions before enabling them/i),
    ).toBeVisible();
    expect(screen.queryByText(/one agent runtime/i)).not.toBeInTheDocument();
  });
});
