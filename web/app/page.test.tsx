import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { Providers } from "@/components/providers";
import Home from "./page";

describe("dashboard data flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("loads the dashboard with parity limits and navigates to real query data", async () => {
    const fetchMock = vi.fn().mockImplementation(dashboardFetch(dashboardFixture()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connectors" })).toBeVisible();
    expect(screen.getByText("Search results omitted the newest document")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("interactionLimit=250"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("reportLimit=250"),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("sessionLimit=100"),
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole("button", { name: "Feedback (1)" }));
    expect(await screen.findByRole("heading", { name: "Feedback" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Search results omitted the newest document" }),
    ).toBeVisible();
  });

  it("does not expose editor-only views or product actions to members", async () => {
    window.history.replaceState({}, "", "/?view=connectors");
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(json(dashboardFixture({ currentRole: "member" }))));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connectors" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New product" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("view=connectors"));
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === "/api/github/installations"),
    ).toBe(false);
  });

  it.each([
    ["connected", "GitHub connected successfully.", "status"],
    ["conflict", "That GitHub installation is already connected to another workspace.", "alert"],
    ["error", "Could not connect GitHub. Try again.", "alert"],
    ["unexpected", "Could not connect GitHub. Try again.", "alert"],
  ])("consumes the GitHub %s callback result", async (result, message, role) => {
    window.history.replaceState({}, "", `/?view=connectors&github=${result}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === "/api/github/installations") {
          return Promise.resolve(json({ configured: true, installations: [] }));
        }
        return Promise.resolve(json(dashboardFixture()));
      }),
    );

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(await screen.findByText(message)).toHaveAttribute("role", role);
    expect(window.location.search).not.toContain("github=");
  });

  it("restores dashboard state when the browser goes Back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(dashboardFetch(dashboardFixture())));

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Feedback (1)" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Search results omitted the newest document",
      }),
    );
    expect(await screen.findByText("What the agent reported")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open interaction" }));
    expect(await screen.findByRole("heading", { name: "search" })).toBeVisible();

    window.history.back();

    expect(await screen.findByText("What the agent reported")).toBeVisible();
    window.history.back();

    await waitFor(() =>
      expect(screen.queryByText("What the agent reported")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Feedback" })).toBeVisible();
  });

  it("surfaces an invalid invitation and removes it from the URL", async () => {
    window.history.replaceState({}, "", "/?invite=invalid");
    const timeout = vi.spyOn(window, "setTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(json(dashboardFixture()))),
    );

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    const message = await screen.findByText(
      /invitation is expired, revoked, or was created for a different email address/i,
    );
    expect(message).toHaveAttribute("role", "alert");
    expect(window.location.search).not.toContain("invite=");
    const dismiss = timeout.mock.calls.find(([, delay]) => delay === 6_000)?.[0];
    expect(dismiss).toBeTypeOf("function");
    act(() => dismiss?.());
    expect(message).not.toBeInTheDocument();
  });

  it("clears a success notice when navigating to another view", async () => {
    const data = dashboardFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const supplemental = feedbackApiResponse(String(input));
        if (supplemental) return Promise.resolve(supplemental);
        if (init?.method === "PATCH")
          return Promise.resolve(json({ product: data.currentProduct }));
        return Promise.resolve(json(data));
      }),
    );

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Search API 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Product renamed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Feedback (1)" }));

    expect(screen.queryByText("Product renamed.")).not.toBeInTheDocument();
  });
});

function dashboardFetch(data: ReturnType<typeof dashboardFixture>) {
  return (input: RequestInfo | URL) =>
    Promise.resolve(feedbackApiResponse(String(input)) ?? json(data));
}

function feedbackApiResponse(path: string): Response | null {
  if (path.includes("/groups?")) {
    return json({ groups: [], hasMore: false, limit: 50, offset: 0 });
  }
  if (path.endsWith("/github-repo")) return json(null);
  return null;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
