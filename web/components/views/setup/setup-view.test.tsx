import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";

import { SetupView } from "./setup-view";

describe("SetupView sections", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/?view=setup");
  });

  it("keeps main's status overview visible while the long sections collapse", () => {
    renderSetup();

    expect(screen.getAllByText("Product key").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SDK connected").length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation", { name: "Setup walkthrough" })).not.toBeInTheDocument();

    const install = screen.getByRole("button", { name: "1. Install Epode" });
    const identify = screen.getByRole("button", {
      name: "2. Identify customers when possible",
    });
    expect(install).toHaveAttribute("aria-expanded", "true");
    expect(identify).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(identify);
    expect(install).toHaveAttribute("aria-expanded", "false");
    expect(identify).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tab", { name: "Known" })).toBeVisible();

    fireEvent.click(identify);
    expect(identify).toHaveAttribute("aria-expanded", "false");
  });

  it("replaces the hash when a section opens", () => {
    renderSetup();

    fireEvent.click(screen.getByRole("button", { name: "2. Identify customers when possible" }));

    expect(window.location.hash).toBe("#setup-identify");
  });

  it("clears a matching hash when the current section closes", () => {
    window.history.replaceState({}, "", "/?view=setup#setup-identify");
    renderSetup();

    fireEvent.click(screen.getByRole("button", { name: "2. Identify customers when possible" }));

    expect(window.location.hash).toBe("");
  });

  it("opens Install and replaces the hash when a write secret is shown", async () => {
    window.history.replaceState({}, "", "/?view=setup#setup-identify");
    const view = renderSetup();

    view.rerender(
      <SetupView
        data={dashboardFixture()}
        secrets={{ environmentId: "environment-1", write: "af_live_secret" }}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "1. Install Epode" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(window.location.hash).toBe("#setup-install");
    });
  });

  it("opens the URL-addressed section and follows browser history", async () => {
    window.history.replaceState({}, "", "/?view=setup#setup-verify");
    renderSetup();

    const verify = screen.getByRole("button", { name: "4. Verify the complete loop" });
    expect(verify).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("SDK connected", { selector: "span.font-medium" })).toHaveClass(
      "font-medium",
    );
    expect(screen.queryByText(/All 4 steps complete/i)).not.toBeInTheDocument();

    window.history.pushState({}, "", "/?view=setup#setup-identify");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "2. Identify customers when possible" }),
      ).toHaveAttribute("aria-expanded", "true"),
    );
    expect(verify).toHaveAttribute("aria-expanded", "false");
  });
});

function renderSetup() {
  return render(
    <SetupView
      data={dashboardFixture()}
      secrets={null}
      rememberSecret={vi.fn()}
      refresh={vi.fn().mockResolvedValue(undefined)}
      setNotice={vi.fn()}
    />,
  );
}
