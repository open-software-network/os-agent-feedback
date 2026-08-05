import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  customerDetailFixture,
  customersPageFixture,
  dashboardFixture,
  featureDetailFixture,
  featuresPageFixture,
} from "@/components/dashboard/test-fixture";
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
    for (const view of [
      "Home",
      "Customers",
      "Responses",
      "Sessions",
      "Connectors",
      "Configurations",
    ]) {
      expect(screen.getByRole("button", { name: view })).toBeVisible();
    }
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

    for (const hidden of [
      "Features",
      "Feedback",
      "Interactions",
      "Signals",
      "Contexts",
      "Evidences",
    ]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Customers" }));
    expect(await screen.findByRole("heading", { name: "Customers" })).toBeVisible();
    expect(await screen.findByRole("row", { name: /Acme workspace/ })).toBeVisible();
  });

  it("keeps shown-once product keys in page memory instead of browser storage", async () => {
    window.history.replaceState({}, "", "/?view=setup");
    const base = dashboardFixture();
    const data = dashboardFixture({
      apiKeys: [],
      insights: {
        ...base.insights,
        opportunities: 0,
        confirmedInteractions: 0,
        reports: 0,
      },
    });
    const secret = "af_live_memory_only_secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/settings/api-keys" && init?.method === "POST") {
          return Promise.resolve(json({ apiKey: base.apiKeys[0], secret, shownOnce: true }));
        }
        return Promise.resolve(feedbackApiResponse(String(input), data) ?? json(data));
      }),
    );

    render(
      <Providers>
        <Home />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create product key" }));
    expect(window.location.hash).toBe("#setup");
    expect((await screen.findAllByText(secret)).length).toBeGreaterThan(0);
    const storedValues = Array.from({ length: window.sessionStorage.length }, (_, index) => {
      const key = window.sessionStorage.key(index);
      return key ? window.sessionStorage.getItem(key) : null;
    });
    expect(storedValues).not.toContain(secret);
    expect(Object.keys(window.sessionStorage)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/agent-feedback:(?:product|read)-key:/)]),
    );
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
    expect(screen.getByRole("button", { name: "Configurations" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Data controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connectors" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New product" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("view=connectors"));
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === "/api/github/installations"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Configurations" }));
    expect(await screen.findByRole("heading", { name: "Configurations" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Product details" })).toBeVisible();
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connectors" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Connectors" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connectors" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Customers" }));
    expect(await screen.findByRole("heading", { name: "Customers" })).toBeVisible();
    window.history.back();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeVisible());
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

  it("keeps Setup on Home and opens Data controls and Questions within Configurations", async () => {
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

    expect(
      (await screen.findAllByRole("heading", { name: "Data controls" })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Configurations" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Product",
      "Team",
      "Data controls",
      "Questions",
    ]);
    expect(screen.getByRole("tab", { name: "Data controls" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "Connect Search API" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Setup" })).toBeVisible();
    expect(new URL(window.location.href).searchParams.get("view")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Configurations" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Product" }));
    expect(await screen.findByRole("heading", { name: "Product details" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Search API 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Product renamed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Customers" }));

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
  if (path.startsWith("/api/dashboard/customers?")) {
    return json(customersPageFixture());
  }
  if (path.startsWith("/api/dashboard/customers/")) {
    return json(customerDetailFixture());
  }
  if (path.startsWith("/api/dashboard/features/")) {
    return json(featureDetailFixture());
  }
  if (path.startsWith("/api/dashboard/features?")) {
    return json(featuresPageFixture());
  }
  if (path.startsWith("/api/dashboard/signals?")) {
    return json({ signals: [], total: 0, limit: 100, nextCursor: null });
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
