import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { DashboardData } from "@/lib/api/dashboard";

import { HomeView } from "./home-view";

describe("HomeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1");
  });

  it("leads with the question-and-answer product model", () => {
    renderHome(dashboardFixture());

    expect(
      screen.getByRole("heading", {
        name: "Epode asks customer agents questions and records their answers.",
      }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "EPODE" })).toHaveAttribute(
      "src",
      expect.stringContaining("epode-logo.svg"),
    );
    expect(screen.queryByRole("region", { name: "At a glance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent responses" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent customers" })).not.toBeInTheDocument();
    expect(screen.queryByText(/signals|interactions|contexts|evidences/i)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Setup" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect Search API" })).toBeVisible();
  });

  it("routes to the core object screens", () => {
    renderHome(dashboardFixture());

    fireEvent.click(screen.getByRole("button", { name: /view responses/i }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("responses");

    fireEvent.click(screen.getByRole("button", { name: /view customers/i }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("customers");
  });

  it("scrolls legacy setup deep links after the embedded section mounts", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    window.history.replaceState({}, "", "/#setup");

    renderHome(dashboardFixture());

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });
});

function renderHome(data: DashboardData) {
  return render(
    <HomeView
      data={data}
      secrets={null}
      rememberSecret={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
    />,
  );
}
