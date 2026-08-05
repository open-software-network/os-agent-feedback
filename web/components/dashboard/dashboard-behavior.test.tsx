import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProductControls } from "@/components/dashboard/product-controls";
import { dashboardFixture } from "@/components/dashboard/test-fixture";
import { ConnectorsView } from "@/components/views/connectors/connectors-view";
import { FeedbackView } from "@/components/views/feedback/feedback-view";
import { InteractionDetail } from "@/components/views/interactions/interaction-detail";
import { PolicyView } from "@/components/views/policy/policy-view";
import { SessionsView } from "@/components/views/sessions/sessions-view";
import { SetupView } from "@/components/views/setup/setup-view";
import { TeamView } from "@/components/views/team/team-view";

describe("dashboard view behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    window.sessionStorage.clear();
  });

  it("loads GitHub installations and fetches repositories only when one expands", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(
          json({
            configured: true,
            installations: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                installationId: 4242,
                accountLogin: "open-software-network",
                accountType: "Organization",
                createdAt: "2026-07-30T12:00:00Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/4242/repositories") {
        return Promise.resolve(
          json({
            installationId: 4242,
            truncated: true,
            repositories: [
              {
                fullName: "open-software-network/os-epode",
                defaultBranch: "main",
                private: true,
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("open-software-network")).toBeVisible();
    expect(screen.getByText("Organization")).toBeVisible();
    expect(screen.getByRole("link", { name: "Add organization" })).toHaveAttribute(
      "href",
      `/api/github/install?workspaceId=${encodeURIComponent(data.workspace.id)}`,
    );
    const githubCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/github/"));
    expect(githubCalls()).toHaveLength(1);
    expect(new Headers(githubCalls()[0][1].headers).get("x-workspace-id")).toBe(data.workspace.id);

    fireEvent.click(
      screen.getByRole("button", { name: "Show repositories for open-software-network" }),
    );

    expect(await screen.findByText("open-software-network/os-epode")).toBeVisible();
    expect(screen.getByText("main · Private")).toBeVisible();
    expect(screen.getByText(/partial repository list/i)).toBeVisible();
    expect(githubCalls()).toHaveLength(2);
    expect(new Headers(githubCalls()[1][1].headers).get("x-workspace-id")).toBe(data.workspace.id);
  });

  it("distinguishes an unconfigured GitHub App from an empty installation list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === "/api/data-destinations") {
          return Promise.resolve(json({ destinations: [] }));
        }
        return Promise.resolve(json({ configured: false, installations: [] }));
      }),
    );

    renderWithQuery(<ConnectorsView data={dashboardFixture()} />);

    expect(await screen.findByText("GitHub App is not configured on this server.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Add organization" })).not.toBeInTheDocument();
  });

  it("marks planned connectors as disabled and non-interactive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === "/api/data-destinations") {
          return Promise.resolve(json({ destinations: [] }));
        }
        return Promise.resolve(json({ configured: true, installations: [] }));
      }),
    );

    renderWithQuery(<ConnectorsView data={dashboardFixture()} />);

    expect(await screen.findByText("No GitHub installations")).toBeVisible();
    for (const connector of ["Slack", "Linear", "OS Platform"]) {
      const button = screen.getByRole("button", { name: `${connector} planned` });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("fans out repository options and saves and clears the product mapping", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const mappingPath = `/api/products/${productId}/github-repo`;
    let mapping: Record<string, unknown> | null = null;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(
          json({
            configured: true,
            installations: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                installationId: 101,
                accountLogin: "first-org",
                accountType: "Organization",
                createdAt: "2026-07-30T12:00:00Z",
              },
              {
                id: "99999999-9999-4999-8999-999999999999",
                installationId: 202,
                accountLogin: "second-org",
                accountType: "Organization",
                createdAt: "2026-07-30T13:00:00Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/101/repositories") {
        return Promise.resolve(
          json({
            installationId: 101,
            truncated: false,
            repositories: [
              { fullName: "first-org/service", defaultBranch: "main", private: false },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/202/repositories") {
        return Promise.resolve(
          json({
            installationId: 202,
            truncated: true,
            repositories: [{ fullName: "second-org/app", defaultBranch: "develop", private: true }],
          }),
        );
      }
      if (path === mappingPath && init?.method === "PUT") {
        const input = JSON.parse(String(init.body));
        mapping = {
          ...input,
          productId,
          createdAt: "2026-07-30T12:00:00Z",
          updatedAt: "2026-07-30T14:00:00Z",
        };
        return Promise.resolve(json(mapping));
      }
      if (path === mappingPath && init?.method === "DELETE") {
        mapping = null;
        return Promise.resolve(json({ removed: true }));
      }
      if (path === mappingPath) {
        return Promise.resolve(mapping ? json(mapping) : json(null));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("first-org")).toBeVisible();
    expect(screen.getByRole("heading", { name: "GitHub repository for Search API" })).toBeVisible();
    // One GitHub request; the data-destinations listing loads alongside it.
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/github/")),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Configure repository" }));

    const repository = await screen.findByLabelText("Repository");
    expect(screen.getByRole("option", { name: "first-org/service" })).toBeVisible();
    expect(screen.getByRole("option", { name: "second-org/app" })).toBeVisible();
    expect(screen.getByText(/repository list is partial/i)).toBeVisible();
    expect(screen.getByText(/has no repository mapping/i)).toBeVisible();

    fireEvent.change(repository, { target: { value: "second-org/app" } });
    expect(screen.getByLabelText("Default branch")).toHaveValue("develop");
    fireEvent.change(screen.getByLabelText("Default branch"), {
      target: { value: "release" },
    });
    fireEvent.change(screen.getByLabelText("Path prefix (optional)"), {
      target: { value: "packages/web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(await screen.findByText("Repository mapping saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      mappingPath,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          installationId: 202,
          repoFullName: "second-org/app",
          defaultBranch: "release",
          pathPrefix: "packages/web",
        }),
      }),
    );
    expect(screen.getByText(/currently mapped to second-org\/app on release/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear mapping" }));

    expect(await screen.findByText("Repository mapping cleared.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      mappingPath,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(await screen.findByText(/has no repository mapping/i)).toBeVisible();

    const repositoryCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/repositories"),
    );
    expect(repositoryCalls).toHaveLength(2);
    for (const [, init] of repositoryCalls) {
      expect(new Headers(init.headers).get("x-workspace-id")).toBe(data.workspace.id);
    }
    const mappingCalls = fetchMock.mock.calls.filter(([input]) => String(input) === mappingPath);
    expect(mappingCalls).toHaveLength(5);
    for (const [, init] of mappingCalls) {
      expect(new Headers(init.headers).get("x-workspace-id")).toBe(data.workspace.id);
    }
  });

  it("renders repository settings while another installation is still loading", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const mappingPath = `/api/products/${productId}/github-repo`;
    let resolveSlowListing: ((response: Response) => void) | undefined;
    const slowListing = new Promise<Response>((resolve) => {
      resolveSlowListing = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(
          json({
            configured: true,
            installations: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                installationId: 101,
                accountLogin: "ready-org",
                accountType: "Organization",
                createdAt: "2026-07-30T12:00:00Z",
              },
              {
                id: "99999999-9999-4999-8999-999999999999",
                installationId: 202,
                accountLogin: "slow-org",
                accountType: "Organization",
                createdAt: "2026-07-30T13:00:00Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/101/repositories") {
        return Promise.resolve(
          json({
            installationId: 101,
            truncated: false,
            repositories: [
              { fullName: "ready-org/service", defaultBranch: "main", private: false },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/202/repositories") return slowListing;
      if (path === mappingPath) return Promise.resolve(json(null));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("ready-org")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Configure repository" }));

    expect(await screen.findByRole("option", { name: "ready-org/service" })).toBeVisible();
    expect(screen.getByText(/still loading repositories for slow-org/i)).toBeVisible();
    expect(screen.queryByRole("option", { name: "slow-org/app" })).not.toBeInTheDocument();

    await act(async () => {
      resolveSlowListing?.(
        json({
          installationId: 202,
          truncated: true,
          repositories: [{ fullName: "slow-org/app", defaultBranch: "develop", private: true }],
        }),
      );
    });

    expect(await screen.findByRole("option", { name: "slow-org/app" })).toBeVisible();
    expect(screen.queryByText(/still loading repositories for slow-org/i)).not.toBeInTheDocument();
    expect(screen.getByText(/repository list is partial/i)).toBeVisible();
  });

  it("surfaces a missing product from the repository mapping lookup", async () => {
    const data = dashboardFixture();
    const mappingPath = `/api/products/${data.currentProduct?.id ?? ""}/github-repo`;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(json({ configured: true, installations: [] }));
      }
      if (path === mappingPath) {
        return Promise.resolve(json({ error: "Product not found for this team" }, 404));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("No GitHub installations")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Configure repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Product not found for this team");
    expect(screen.queryByText(/has no repository mapping/i)).not.toBeInTheDocument();
  });

  it("keeps a mapped repository editable when a truncated listing omits it", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const mappingPath = `/api/products/${productId}/github-repo`;
    const mappedRepoFullName = "truncated-org/private-service";
    let mappedRepositoryVisible = false;
    let mapping = {
      productId,
      installationId: 101,
      repoFullName: mappedRepoFullName,
      defaultBranch: "stable",
      pathPrefix: "packages/api",
      createdAt: "2026-07-30T12:00:00Z",
      updatedAt: "2026-07-30T12:00:00Z",
    };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(
          json({
            configured: true,
            installations: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                installationId: 101,
                accountLogin: "truncated-org",
                accountType: "Organization",
                createdAt: "2026-07-30T12:00:00Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/101/repositories") {
        return Promise.resolve(
          json({
            installationId: 101,
            truncated: true,
            repositories: [
              ...(mappedRepositoryVisible
                ? [{ fullName: mappedRepoFullName, defaultBranch: "main", private: true }]
                : []),
              { fullName: "truncated-org/visible", defaultBranch: "main", private: false },
            ],
          }),
        );
      }
      if (path === mappingPath && init?.method === "PUT") {
        mapping = {
          ...mapping,
          ...JSON.parse(String(init.body)),
          updatedAt: "2026-07-30T14:00:00Z",
        };
        return Promise.resolve(json(mapping));
      }
      if (path === mappingPath) return Promise.resolve(json(mapping));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("truncated-org")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Configure repository" }));

    const repository = await screen.findByLabelText("Repository");
    const branch = screen.getByLabelText("Default branch");
    expect(repository).toHaveValue(mappedRepoFullName);
    expect(
      screen.getByRole("option", {
        name: `${mappedRepoFullName} (not in the current listing)`,
      }),
    ).toBeVisible();
    expect(branch).toHaveValue("stable");
    expect(branch).toBeEnabled();
    expect(screen.getByText(/repository list is partial/i)).toBeVisible();

    fireEvent.change(branch, { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Path prefix (optional)"), {
      target: { value: "packages/core" },
    });
    mappedRepositoryVisible = true;
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["github-repos", data.workspace.id, 101],
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("option", {
          name: `${mappedRepoFullName} (not in the current listing)`,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("option", { name: mappedRepoFullName })).toHaveLength(1);
    expect(repository).toHaveValue(mappedRepoFullName);
    expect(branch).toHaveValue("release");

    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(await screen.findByText("Repository mapping saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      mappingPath,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          installationId: 101,
          repoFullName: mappedRepoFullName,
          defaultBranch: "release",
          pathPrefix: "packages/core",
        }),
      }),
    );
  });

  it("keeps a failed installation's mapped repository editable through retry", async () => {
    const data = dashboardFixture();
    const productId = data.currentProduct?.id ?? "";
    const mappingPath = `/api/products/${productId}/github-repo`;
    const mappedRepoFullName = "failed-org/private-app";
    let failedListing = true;
    let mapping = {
      productId,
      installationId: 202,
      repoFullName: mappedRepoFullName,
      defaultBranch: "stable",
      pathPrefix: null as string | null,
      createdAt: "2026-07-30T12:00:00Z",
      updatedAt: "2026-07-30T12:00:00Z",
    };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      if (path === "/api/github/installations") {
        return Promise.resolve(
          json({
            configured: true,
            installations: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                installationId: 101,
                accountLogin: "loaded-org",
                accountType: "Organization",
                createdAt: "2026-07-30T12:00:00Z",
              },
              {
                id: "99999999-9999-4999-8999-999999999999",
                installationId: 202,
                accountLogin: "failed-org",
                accountType: "Organization",
                createdAt: "2026-07-30T13:00:00Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/github/installations/101/repositories") {
        return Promise.resolve(
          json({
            installationId: 101,
            truncated: false,
            repositories: [{ fullName: "loaded-org/app", defaultBranch: "main", private: false }],
          }),
        );
      }
      if (path === "/api/github/installations/202/repositories") {
        return failedListing
          ? Promise.resolve(json({ error: "GitHub repository listing failed" }, 502))
          : Promise.resolve(
              json({
                installationId: 202,
                truncated: false,
                repositories: [
                  { fullName: mappedRepoFullName, defaultBranch: "main", private: true },
                ],
              }),
            );
      }
      if (path === mappingPath && init?.method === "PUT") {
        mapping = {
          ...mapping,
          ...JSON.parse(String(init.body)),
          updatedAt: "2026-07-30T14:00:00Z",
        };
        return Promise.resolve(json(mapping));
      }
      if (path === mappingPath) return Promise.resolve(json(mapping));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={data} />);

    expect(await screen.findByText("loaded-org")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Configure repository" }));

    const repository = await screen.findByLabelText("Repository");
    const branch = screen.getByLabelText("Default branch");
    expect(await screen.findByRole("option", { name: "loaded-org/app" })).toBeVisible();
    expect(repository).toHaveValue(mappedRepoFullName);
    expect(
      screen.getByRole("option", {
        name: `${mappedRepoFullName} (not in the current listing)`,
      }),
    ).toBeVisible();
    expect(branch).toHaveValue("stable");
    expect(branch).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not load repositories for failed-org/i,
    );

    fireEvent.change(branch, { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Path prefix (optional)"), {
      target: { value: "packages/web" },
    });
    failedListing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry failed installations" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("option", {
          name: `${mappedRepoFullName} (not in the current listing)`,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("option", { name: mappedRepoFullName })).toHaveLength(1);
    expect(repository).toHaveValue(mappedRepoFullName);
    expect(branch).toHaveValue("release");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(await screen.findByText("Repository mapping saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      mappingPath,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          installationId: 202,
          repoFullName: mappedRepoFullName,
          defaultBranch: "release",
          pathPrefix: "packages/web",
        }),
      }),
    );
  });

  it("keeps the product mapping mutation unreachable for members", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/data-destinations") {
        return Promise.resolve(json({ destinations: [] }));
      }
      return Promise.resolve(json({ configured: true, installations: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(<ConnectorsView data={dashboardFixture({ currentRole: "member" })} />);

    expect(await screen.findByText("No GitHub installations")).toBeVisible();
    const configure = screen.getByRole("button", { name: "Configure repository" });
    expect(configure).toBeDisabled();
    expect(configure).toHaveAttribute("aria-disabled", "true");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/github-repo"))).toBe(
      false,
    );
  });

  it("sends workflow changes using the generated API shape", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PATCH") return Promise.resolve(json({ updated: true }));
      if (path.startsWith("/api/dashboard/feedback?")) {
        return Promise.resolve(
          json({
            reports: data.reports,
            total: data.reports.length,
            facets: {
              status: [{ name: "new", count: 1 }],
              impact: [{ name: "degraded", count: 1 }],
              surface: [{ name: "http", count: 1 }],
              topic: [{ name: "freshness", count: 1 }],
              findingKind: [{ name: "bug", count: 1 }],
              severity: [{ name: "high", count: 1 }],
              tag: [],
              assignee: [{ name: "unassigned", count: 1 }],
              workaround: [{ name: "used", count: 1 }],
            },
            limit: 50,
            nextCursor: null,
          }),
        );
      }
      if (path.startsWith(`/api/dashboard/reports/${data.reports[0].id}?`)) {
        return Promise.resolve(json({ report: data.reports[0] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn().mockResolvedValue(undefined);

    renderWithQuery(
      <FeedbackView
        data={data}
        selectedReportId={data.reports[0].id}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={refresh}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change workflow status, currently New" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Investigating" }));

    await waitFor(() => {
      const workflowRequests = fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === `/api/dashboard/reports/${data.reports[0].id}` &&
          init?.method === "PATCH",
      );
      expect(workflowRequests).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit internal note" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Internal note" }), {
      target: { value: "Reproduce against the fresh index" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      const workflowRequests = fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === `/api/dashboard/reports/${data.reports[0].id}` &&
          init?.method === "PATCH",
      );
      expect(workflowRequests).toHaveLength(2);
    });
    const workflowRequests = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === `/api/dashboard/reports/${data.reports[0].id}` &&
        init?.method === "PATCH",
    );
    expect(JSON.parse(workflowRequests[0]?.[1]?.body as string)).toEqual({
      productId: data.currentProduct?.id,
      status: "investigating",
      assigneeOsUserId: null,
      tags: [],
      internalNote: null,
    });
    expect(JSON.parse(workflowRequests[1]?.[1]?.body as string)).toEqual({
      productId: data.currentProduct?.id,
      status: "investigating",
      assigneeOsUserId: null,
      tags: [],
      internalNote: "Reproduce against the fresh index",
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("fetches complete session detail before rendering its timeline", async () => {
    const data = dashboardFixture();
    const detail = {
      session: data.sessions[0],
      interactions: data.interactions,
      reports: data.reports,
    };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/dashboard/sessions?")) {
        return Promise.resolve(
          json({
            sessions: data.sessions,
            rollup: {
              sessions: 1,
              interactions: 1,
              multiStepSessions: 0,
              averageInteractions: 1,
            },
            limit: 50,
            nextCursor: null,
          }),
        );
      }
      if (path.startsWith("/api/dashboard/sessions/")) return Promise.resolve(json(detail));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const list = renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={null}
        selectSession={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("row", { name: /session-42/ })).toBeVisible();
    list.unmount();

    const selectSession = vi.fn();
    const rendered = renderWithQuery(
      <SessionsView
        data={data}
        selectedSessionId={data.sessions[0].id}
        selectSession={selectSession}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByRole("heading", { name: "session-42" })).toBeVisible();
    expect(screen.getAllByText("search")[0]).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/dashboard/sessions/${data.sessions[0].id}?productId=`),
      expect.any(Object),
    );
    rendered.unmount();
  });

  it("fetches an interaction outside the dashboard page and links its records", async () => {
    const complete = dashboardFixture();
    const interaction = complete.interactions[0];
    const data = dashboardFixture({ interactions: [], reports: [], sessions: [] });
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        interaction,
        report: complete.reports[0],
        session: complete.sessions[0],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const openFeedback = vi.fn();
    const openSession = vi.fn();

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={openFeedback}
        openSession={openSession}
      />,
    );

    expect(await screen.findByRole("heading", { name: "search" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/dashboard/interactions/${interaction.id}?productId=`),
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(openFeedback).toHaveBeenCalledWith(complete.reports[0].id);
    expect(openSession).toHaveBeenCalledWith(complete.sessions[0].id);
  });

  it("fetches exact associations when independently bounded lists omit them", async () => {
    const complete = dashboardFixture();
    const interaction = complete.interactions[0];
    const data = dashboardFixture({ reports: [], sessions: [] });
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={vi.fn()}
        openSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading linked feedback and session…")).toBeVisible();
    expect(
      screen.queryByText("No feedback was submitted for this interaction."),
    ).not.toBeInTheDocument();
    await act(async () => {
      resolveFetch?.(
        json({
          interaction,
          report: complete.reports[0],
          session: complete.sessions[0],
        }),
      );
    });
    expect(await screen.findByRole("button", { name: "Open feedback" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open session" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/dashboard/interactions/${interaction.id}?productId=`),
      expect.any(Object),
    );
  });

  it("removes a bootstrap session when exact interaction detail returns no session", async () => {
    const complete = dashboardFixture();
    const interaction = complete.interactions[0];
    const data = dashboardFixture({ reports: [] });
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={vi.fn()}
        openSession={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Open session" })).toBeVisible();
    await act(async () => {
      resolveFetch?.(
        json({
          interaction,
          report: complete.reports[0],
          session: null,
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open session" })).not.toBeInTheDocument();
    });
  });

  it("keeps exact association failures visible and retryable", async () => {
    const complete = dashboardFixture();
    const interaction = complete.interactions[0];
    const data = dashboardFixture({ reports: [], sessions: [] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Lookup failed" }, 500)));

    renderWithQuery(
      <InteractionDetail
        data={data}
        interactionId={interaction.id}
        back={vi.fn()}
        openFeedback={vi.fn()}
        openSession={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load linked feedback and session. Lookup failed",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(
      screen.queryByText("No feedback was submitted for this interaction."),
    ).not.toBeInTheDocument();
  });

  it("creates a missing write key only after an explicit action", async () => {
    const base = dashboardFixture();
    const data = dashboardFixture({ apiKeys: [] });
    const rememberSecret = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          apiKey: base.apiKeys[0],
          secret: "af_live_full_secret",
          shownOnce: true,
        }),
      ),
    );

    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={rememberSecret}
        refresh={refresh}
        setNotice={vi.fn()}
      />,
    );

    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create product key" }));
    await waitFor(() =>
      expect(rememberSecret).toHaveBeenCalledWith("write", "af_live_full_secret"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("does not create a duplicate write key when Setup remounts during the request", async () => {
    const data = dashboardFixture({ apiKeys: [] });
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      data,
      secrets: null,
      rememberSecret: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      setNotice: vi.fn(),
    };

    const firstMount = renderWithQuery(<SetupView {...props} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create product key" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    firstMount.unmount();
    renderWithQuery(<SetupView {...props} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Create product key" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("offers safe rotation without destructive key revocation", () => {
    renderWithQuery(
      <SetupView
        data={dashboardFixture()}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Advanced integration details"));
    expect(screen.getByRole("button", { name: "Rotate" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("makes setup entirely company-side for every customer identity state", () => {
    renderWithQuery(
      <SetupView
        data={dashboardFixture()}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/customers do not need an Epode account, app, plugin, or SDK/i),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Identify customers when possible/ }));
    for (const identity of ["Known", "Anonymous", "No stable ID"]) {
      expect(screen.getByRole("tab", { name: identity })).toBeVisible();
    }
    expect(screen.queryByText(/Companion/)).not.toBeInTheDocument();
  });

  it("keeps setup status authoritative when key activity is outside the dashboard slice", () => {
    const data = dashboardFixture({ interactions: [], reports: [] });
    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Verify the complete loop/ }));
    expect(screen.getAllByText("Customer answers received").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SDK connected").length).toBeGreaterThan(0);
    expect(screen.getByText(/3 answers are available/)).toBeVisible();
    expect(screen.getByText("Verify linked Sessions manually · not yet verified")).toBeVisible();
    expect(
      screen.getByText(
        /Run A create, cache\/dedup replay, and ordered follow-up appear in Session A/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        /activation totals prove transport and answer milestones, not exact Session correlation/i,
      ),
    ).toBeVisible();
  });

  it("keeps product setup connected while a rotated key overlaps its unused successor", () => {
    const base = dashboardFixture();
    const predecessor = base.apiKeys[0];
    const successor = {
      ...predecessor,
      id: "88888888-8888-4888-8888-888888888888",
      prefix: "af_live_5678efab",
      createdAt: "2026-07-30T12:30:00Z",
      lastUsedAt: null,
      interactionCount: 0,
      reportCount: 0,
    };
    const data = dashboardFixture({
      apiKeys: [successor, predecessor],
      interactions: [],
      reports: [],
    });

    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Verify the complete loop/ }));
    expect(screen.getAllByText("Customer answers received").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SDK connected").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Advanced integration details"));
    expect(screen.getAllByText(/af_live_5678efab/).length).toBeGreaterThan(0);
    expect(screen.getByText(/af_live_1234abcd/)).toBeVisible();
  });

  it.each([
    [0, 0, 0, "Not connected", /Next: deploy the product key/],
    [1, 0, 0, "SDK connected", /company-side connection works/],
    [1, 1, 0, "Customer answers received", /Answers are ready/],
    [
      1,
      1,
      1,
      "Customer answers are ready for personalization",
      /linked Sessions still require the manual checks below/,
    ],
  ] as const)("separates SDK, learning, and retrieval activation at %i/%i/%i", (connected, learned, retrieved, description, nextAction) => {
    const base = dashboardFixture();
    const activationMilestones = base.activationMilestones;
    if (!activationMilestones) throw new Error("fixture requires activation milestones");
    const writeKey = base.apiKeys[0];
    const insights = {
      ...base.insights,
      opportunities: connected,
      confirmedInteractions: connected,
      reports: learned,
      customerContextItems: learned,
      customersWithContext: learned ? 1 : 0,
      contextRetrievals: retrieved,
      personalizationReadyCustomers: learned ? 1 : 0,
      personalizationDecisions: 0,
      personalizationOutcomes: 0,
    } as typeof base.insights & {
      customerContextItems: number;
      customersWithContext: number;
      contextRetrievals: number;
      personalizationReadyCustomers: number;
      personalizationDecisions: number;
      personalizationOutcomes: number;
    };
    const data = dashboardFixture({
      apiKeys: [
        {
          ...writeKey,
          interactionCount: connected,
          reportCount: learned,
        },
      ],
      insights,
      activationMilestones: {
        ...activationMilestones,
        firstOpportunityAt: connected ? "2026-07-01T12:00:00Z" : null,
        firstConfirmedInteractionAt: connected ? "2026-07-02T12:00:00Z" : null,
        firstReportAt: learned ? "2026-07-03T12:00:00Z" : null,
      },
    });

    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Verify the complete loop/ }));
    expect(screen.getAllByText(description).length).toBeGreaterThan(0);
    expect(screen.getAllByText("SDK connected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Customer answers received").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Answers retrieved").length).toBeGreaterThan(0);
    expect(screen.getByText(nextAction)).toBeVisible();
  });

  it("keeps durable activation complete after the rolling insight window becomes quiet", () => {
    const base = dashboardFixture();
    const data = dashboardFixture({
      interactions: [],
      reports: [],
      sessions: [],
      listState: {
        interactionsLoaded: 0,
        interactionsTotal: 0,
        reportsLoaded: 0,
        reportsTotal: 0,
        sessionsLoaded: 0,
        sessionsTotal: 0,
      },
      insights: {
        ...base.insights,
        opportunities: 0,
        confirmedInteractions: 0,
        reports: 0,
      },
    });

    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Verify the complete loop/ }));
    expect(screen.getAllByText("Customer answers received").length).toBeGreaterThan(0);
    expect(screen.getByText(/3 answers are available/i)).toBeVisible();
    expect(screen.getByText(/Answers are ready/i)).toBeVisible();
  });

  it("does not auto-recreate a removed write key and offers manual recovery", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      secrets: null,
      rememberSecret: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      setNotice: vi.fn(),
    };
    const rendered = renderWithQuery(<SetupView {...props} data={data} />);

    rendered.rerender(
      <QueryClientProvider client={rendered.client}>
        <SetupView {...props} data={dashboardFixture({ apiKeys: [] })} />
      </QueryClientProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(
      json({
        apiKey: data.apiKeys[0],
        secret: "af_live_manual_secret",
        shownOnce: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create product key" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/api-keys",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          environmentId: data.currentEnvironment?.id,
          kind: "write",
          label: "Default product key",
        }),
      }),
    );
    expect(props.rememberSecret).toHaveBeenCalledWith("write", "af_live_manual_secret");
  });

  it("rotates an existing key and surfaces the replacement secret", async () => {
    const data = dashboardFixture();
    const rememberSecret = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        apiKey: data.apiKeys[0],
        predecessorExpiresAt: "2026-07-30T13:00:00Z",
        secret: "af_live_rotated_secret",
        shownOnce: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithQuery(
      <SetupView
        data={data}
        secrets={null}
        rememberSecret={rememberSecret}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Advanced integration details"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/settings/api-keys/${data.apiKeys[0].id}/rotate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(rememberSecret).toHaveBeenCalledWith("write", "af_live_rotated_secret");
  });

  it("renders a full key only while the controller supplies the shown-once secret", () => {
    const data = dashboardFixture();
    const props = {
      data,
      rememberSecret: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      setNotice: vi.fn(),
    };
    const rendered = renderWithQuery(
      <SetupView
        {...props}
        secrets={{
          environmentId: data.currentEnvironment?.id ?? "",
          write: "af_live_full_secret",
        }}
      />,
    );

    expect(screen.getAllByText("af_live_full_secret").length).toBeGreaterThan(0);
    rendered.rerender(
      <QueryClientProvider client={rendered.client}>
        <SetupView {...props} secrets={null} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("af_live_full_secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Advanced integration details"));
    expect(screen.getAllByText(/af_live_1234abcd/).length).toBeGreaterThan(0);
  });

  it("keeps exact-name confirmation on product deletion", async () => {
    const data = dashboardFixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ deleted: true, product: data.currentProduct }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProductControls
        data={data}
        onProductCreated={vi.fn()}
        onProductDeleted={vi.fn().mockResolvedValue(undefined)}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = screen.getByLabelText(/Type Search API/);
    fireEvent.change(confirmation, { target: { value: "search api" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete product" }));
    expect(await screen.findByText("Type Search API exactly")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(confirmation, { target: { value: "Search API" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete product" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirmation: "Search API" }),
      }),
    );
  });

  it("keeps the Feedback list usable when one report has malformed findings", async () => {
    const data = dashboardFixture();
    const malformedReport = {
      ...data.reports[0],
      id: "88888888-8888-4888-8888-888888888888",
      summary: "Legacy report with malformed findings",
      findings: null as never,
    };
    const malformedData = { ...data, reports: [malformedReport, data.reports[0]] };
    vi.stubGlobal("fetch", feedbackFetch(malformedData));

    renderWithQuery(
      <FeedbackView
        data={malformedData}
        selectedReportId={null}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("row", { name: /Legacy report with malformed findings/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("row", { name: /Search results omitted the newest document/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("row", { name: /Legacy report with malformed findings/ }),
    ).toBeVisible();
  });

  it("filters feedback by the displayed received time", async () => {
    window.history.replaceState({}, "", "/?view=feedback&range=all");
    const data = dashboardFixture();
    const report = {
      ...data.reports[0],
      createdAt: new Date().toISOString(),
      occurredAt: "2020-01-01T00:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.startsWith("/api/dashboard/feedback?")) {
          const reports = path.includes("since=") ? [] : [report];
          return Promise.resolve(
            json({ reports, total: reports.length, limit: 50, nextCursor: null }),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    renderWithQuery(
      <FeedbackView
        data={{ ...data, reports: [report] }}
        selectedReportId={null}
        selectReport={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        loadMore={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Received/ }));
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("row", { name: /Search results omitted the newest document/ }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("No matching feedback")).toBeVisible();
  });

  it("saves an exact custom retention period with feedback mode and explains deletion timing", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockResolvedValue(json({ environment: data.currentEnvironment }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PolicyView data={data} refresh={vi.fn().mockResolvedValue(undefined)} setNotice={vi.fn()} />,
    );
    const retentionInput = screen.getByLabelText("Retention days");
    expect(retentionInput).toHaveAttribute("min", "1");
    expect(retentionInput).toHaveAttribute("max", "365");
    expect(screen.getByRole("button", { name: "7 days" })).toBeVisible();
    expect(screen.getByRole("button", { name: "365 days" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(retentionInput).toHaveValue(30);
    fireEvent.change(retentionInput, { target: { value: "47" } });
    fireEvent.click(screen.getByText("Advanced: legacy outcome feedback"));
    fireEvent.change(screen.getByLabelText("Outcome feedback mode"), {
      target: { value: "ask_once" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention and outcome settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      environmentId: data.currentEnvironment?.id,
      feedbackMode: "ask_once",
      collectEventSummaries: false,
      retentionDays: 47,
    });
    expect(screen.getByText(/Dashboard filtering changes immediately/)).toBeVisible();
    expect(screen.getByText(/scheduled purge interval/)).toBeVisible();
    expect(screen.getByText(/survives retention until/)).toBeVisible();
  });

  it("rejects retention periods outside 1 to 365 days before saving", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PolicyView data={data} refresh={vi.fn().mockResolvedValue(undefined)} setNotice={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Retention days"), { target: { value: "366" } });
    const policyForm = screen
      .getByRole("button", { name: "Save retention and outcome settings" })
      .closest("form");
    if (!policyForm) throw new Error("Policy form is missing");
    fireEvent.submit(policyForm);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Retention must be between 1 and 365 days.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps team-management controls hidden from members", () => {
    const data = dashboardFixture({ currentRole: "member" });
    render(
      <TeamView data={data} refresh={vi.fn().mockResolvedValue(undefined)} setNotice={vi.fn()} />,
    );

    expect(screen.getByText(/owner or admin manages membership/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename team" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy member invite link" }),
    ).not.toBeInTheDocument();
  });

  it("creates and copies a member invitation through the team API", async () => {
    const data = dashboardFixture();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        invitation: {
          id: "invitation-id",
          workspaceId: data.workspace.id,
          invitedByOsUserId: data.user.id,
          inviteeKind: "link",
          inviteeValue: "",
          role: "member",
          createdAt: "2026-07-30T12:00:00Z",
          expiresAt: "2026-08-06T12:00:00Z",
        },
        joinPath: "/join/invitation-id",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TeamView data={data} refresh={vi.fn().mockResolvedValue(undefined)} setNotice={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy member invite link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("http://localhost:3000/join/invitation-id"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/team/invitations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ role: "member", invitee: null }),
      }),
    );
  });
});

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return { ...rendered, client };
}

function feedbackFetch(data: ReturnType<typeof dashboardFixture>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/dashboard/feedback?")) {
      return Promise.resolve(
        json({ reports: data.reports, total: data.reports.length, limit: 50, nextCursor: null }),
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
