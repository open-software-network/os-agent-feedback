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
    expect(screen.getByRole("button", { name: "Configuration" })).toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    expect(await screen.findByRole("heading", { name: "Feedback" })).toBeVisible();
    expect(
      screen.getByRole("row", { name: /Search results omitted the newest document/ }),
    ).toBeVisible();
  });

  it("recovers from a removed team saved only in local storage", async () => {
    const staleTeam = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const data = dashboardFixture();
    window.localStorage.setItem("epode:last-team", staleTeam);
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (
        path ===
        `/api/dashboard?workspaceId=${staleTeam}&interactionLimit=250&reportLimit=250&sessionLimit=100`
      ) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "You are not a member of this team" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(feedbackApiResponse(path, data) ?? json(data));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`workspaceId=${staleTeam}`),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard?interactionLimit=250&reportLimit=250&sessionLimit=100",
      expect.any(Object),
    );
    expect(window.localStorage.getItem("epode:last-team")).toBe(data.workspace.id);
    expect(new URL(window.location.href).searchParams.get("team")).toBe(data.workspace.id);
  });

  it("preserves an explicit forbidden team deep link and its error", async () => {
    const forbiddenTeam = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    window.history.replaceState({}, "", `/?view=feedback&team=${forbiddenTeam}`);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "You are not a member of this team" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("You are not a member of this team");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get("team")).toBe(forbiddenTeam);
    expect(window.localStorage.getItem("epode:last-team")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("heading", { name: "Product" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Team" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Connectors" })).not.toBeInTheDocument();
  });

  it.each([
    ["connected", "GitHub connected. Choose a repository for this product.", "status"],
    ["conflict", "That GitHub installation already belongs to another Epode team.", "alert"],
    ["error", "GitHub could not be connected. Try the installation flow again.", "alert"],
    ["unexpected", "GitHub could not be connected. Try the installation flow again.", "alert"],
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

  it("clears the GitHub callback result after leaving Connectors", async () => {
    const message = "GitHub connected. Choose a repository for this product.";
    window.history.replaceState({}, "", "/?view=connectors&github=connected");
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

    expect(await screen.findByText(message)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Connectors" }));

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("restores dashboard state when the browser goes Back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(dashboardFetch(dashboardFixture())));

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    fireEvent.click(
      await screen.findByRole("row", {
        name: /Search results omitted the newest document/,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Search results omitted the newest document" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open interaction" }));
    expect(await screen.findByRole("heading", { name: "search" })).toBeVisible();

    window.history.back();

    expect(
      await screen.findByRole("heading", { name: "Search results omitted the newest document" }),
    ).toBeVisible();
    window.history.back();

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Search results omitted the newest document" }),
      ).not.toBeInTheDocument(),
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

  it("keeps legacy settings deep links inside the unified Configuration surface", async () => {
    window.history.replaceState({}, "", "/?view=policy");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(json(dashboardFixture()))),
    );

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    expect(await screen.findByRole("heading", { name: "Collection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Configuration" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("tab", { name: "Collection" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    expect(await screen.findByRole("heading", { name: "Setup" })).toBeVisible();
    expect(new URL(window.location.href).searchParams.get("view")).toBe("setup");
  });

  it("clears a success notice when navigating to another view", async () => {
    const data = dashboardFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const supplemental = feedbackApiResponse(String(input), data);
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
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("heading", { name: "Product" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Search API 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Product renamed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));

    expect(screen.queryByText("Product renamed.")).not.toBeInTheDocument();
  });
});

function dashboardFetch(data: ReturnType<typeof dashboardFixture>) {
  return (input: RequestInfo | URL) =>
    Promise.resolve(feedbackApiResponse(String(input), data) ?? json(data));
}

function feedbackApiResponse(
  path: string,
  data: ReturnType<typeof dashboardFixture>,
): Response | null {
  if (path.startsWith("/api/dashboard/feedback?")) {
    return json({
      reports: data.reports,
      total: data.listState.reportsTotal,
      limit: 50,
      nextCursor: null,
    });
  }
  if (path.startsWith("/api/dashboard/sessions?")) {
    const interactions = data.sessions.reduce(
      (total, session) => total + session.interactionCount,
      0,
    );
    return json({
      sessions: data.sessions,
      rollup: {
        sessions: data.listState.sessionsTotal,
        interactions,
        multiStepSessions: data.sessions.filter((session) => session.interactionCount > 1).length,
        averageInteractions: data.sessions.length ? interactions / data.sessions.length : 0,
      },
      limit: 50,
      nextCursor: null,
    });
  }
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
