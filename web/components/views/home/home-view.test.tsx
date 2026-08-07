import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardFixture } from "@/components/dashboard/test-fixture";
import type { DashboardData } from "@/lib/api/dashboard";

import { HomeView } from "./home-view";

describe("HomeView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?team=team-1&product=product-1");
  });

  it("leads with the agent experience product model", () => {
    renderHome(dashboardFixture());

    expect(
      screen.getByRole("heading", {
        name: "Epode is the agent experience and analytics layer for your product.",
      }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "EPODE" })).toHaveAttribute(
      "src",
      expect.stringContaining("epode-logo.svg"),
    );
    expect(screen.queryByRole("region", { name: "At a glance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent responses" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent customers" })).not.toBeInTheDocument();
    const overview = screen.getByRole("region", {
      name: "Epode is the agent experience and analytics layer for your product.",
    });
    expect(within(overview).queryByText(/signals|contexts|evidences/i)).not.toBeInTheDocument();
    expect(screen.getByText("Observed interactions")).toBeVisible();
    expect(screen.getByText("Sessions")).toBeVisible();
    expect(screen.getByRole("region", { name: "Setup" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect Search API" })).toBeVisible();
  });

  it("renders the seven experience insight groups from the dashboard payload", () => {
    renderHome(dashboardFixture());

    for (const heading of [
      "What agents asked for and could not get",
      "Where agents go next",
      "Where journeys end",
      "From agent journey to human click",
      "Signals that drive outcomes",
      "Traffic by assistant runtime",
      "Result position views",
      "What agents could not learn",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    }

    expect(screen.getByText("Zero exact matches (25%)")).toBeVisible();
    expect(screen.getByText("Median gap to a match")).toBeVisible();
    expect(screen.getByText("Sessions with a handoff (33%)")).toBeVisible();
    expect(screen.getByText("Handoff landing pages")).toBeVisible();

    // Machine-readable values render verbatim, never title-cased.
    expect(screen.getByText("evidence:glare_control")).toBeVisible();
    expect(screen.getByText("/agent-negotiate/lamp → /agent-decide/lamp")).toBeVisible();
    expect(screen.getByText("raise_budget_from_150_to_164")).toBeVisible();
    expect(screen.getByText("constraint/budget")).toBeVisible();
    expect(screen.getByText("/product/feeder")).toBeVisible();
    expect(screen.getByText("budget · declined")).toBeVisible();
    expect(screen.queryByText("Evidence:glare_control")).not.toBeInTheDocument();

    // Signal outcomes pluralize correctly, including the singular conversion.
    expect(screen.getByText("3 decisions · 2 outcomes · 1 conversion")).toBeVisible();

    // Vendors get human labels and paired counts, plus the privacy note.
    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText("OpenAI")).toBeVisible();
    expect(screen.getByText("5 interactions · 2 sessions")).toBeVisible();
    expect(
      screen.getByText(
        /Runtime hints and user-agent values are unverified observations, never identity\./,
      ),
    ).toBeVisible();

    expect(screen.getByText("Position 1")).toBeVisible();
    expect(screen.getByText("commute")).toBeVisible();
  });

  it("explains when data will appear for each absent insight group", () => {
    const data = dashboardFixture();
    const {
      lostDemand: _lostDemand,
      journeyFlow: _journeyFlow,
      handoff: _handoff,
      signalOutcomes: _signalOutcomes,
      agentVendors: _agentVendors,
      rankPositions: _rankPositions,
      unknownDimensions: _unknownDimensions,
      unansweredQuestions: _unansweredQuestions,
      ...insights
    } = data.insights;

    renderHome({ ...data, insights: insights as DashboardData["insights"] });

    for (const heading of [
      "What agents asked for and could not get",
      "Where agents go next",
      "Where journeys end",
      "From agent journey to human click",
      "Signals that drive outcomes",
      "Traffic by assistant runtime",
      "Result position views",
      "What agents could not learn",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    }

    for (const message of [
      "No expressed dimensions yet.",
      "No hard-constraint violations yet.",
      "No counterfactuals yet. They appear when a search ends with zero exact matches.",
      "Transitions appear when journeys carry a session reference.",
      "No journey exits in the last 30 days.",
      "Landing pages appear when a proven session records a product link click.",
      "No personalization decisions cited customer signals yet.",
      "Runtime evidence has not named an assistant yet.",
      "No search-attributed item views yet.",
      "Agents answered every dimension they were asked.",
      "No declined or unanswerable context questions.",
    ]) {
      expect(screen.getByText(message)).toBeVisible();
    }
  });

  it("routes to the core object screens", () => {
    renderHome(dashboardFixture());

    fireEvent.click(screen.getByRole("button", { name: /view sessions/i }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("sessions");

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
