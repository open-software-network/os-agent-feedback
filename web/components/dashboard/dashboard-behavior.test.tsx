import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProductControls } from "@/components/dashboard/product-controls";
import { dashboardFixture } from "@/components/dashboard/test-fixture";
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

  it("sends workflow changes using the generated API shape", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockResolvedValue(json({ updated: true }));
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

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "investigating" } });
    fireEvent.change(screen.getByLabelText("Internal note"), {
      target: { value: "Reproduce against the fresh index" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save triage" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/dashboard/reports/${data.reports[0].id}`,
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"status":"investigating"'),
        }),
      ),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(
      expect.objectContaining({
        productId: data.currentProduct?.id,
        internalNote: "Reproduce against the fresh index",
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("fetches complete session detail before rendering its timeline", async () => {
    const data = dashboardFixture();
    const detail = {
      session: data.sessions[0],
      interactions: data.interactions,
      reports: data.reports,
    };
    const fetchMock = vi.fn().mockResolvedValue(json(detail));
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
    expect(screen.getByRole("button", { name: "session-42" })).toBeVisible();
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
    expect(screen.getByText("search")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/dashboard/sessions/${data.sessions[0].id}?productId=`),
      expect.any(Object),
    );
    rendered.unmount();
  });

  it("fetches an interaction outside the dashboard page and links its context", async () => {
    const complete = dashboardFixture();
    const interaction = complete.interactions[0];
    const data = dashboardFixture({ interactions: [] });
    const fetchMock = vi.fn().mockResolvedValue(json({ interaction }));
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

  it("creates a missing write key and passes its shown-once secret to the controller", async () => {
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    firstMount.unmount();
    renderWithQuery(<SetupView {...props} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
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

    expect(screen.getByRole("button", { name: "Rotate" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("does not recreate a write key that disappears after Setup observed it", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      secrets: null,
      rememberSecret: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      setNotice: vi.fn(),
    };
    const rendered = renderWithQuery(<SetupView {...props} data={dashboardFixture()} />);

    rendered.rerender(
      <QueryClientProvider client={rendered.client}>
        <SetupView {...props} data={dashboardFixture({ apiKeys: [] })} />
      </QueryClientProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("keeps the Feedback list usable when one report has malformed findings", () => {
    const data = dashboardFixture();
    const malformedReport = {
      ...data.reports[0],
      id: "88888888-8888-4888-8888-888888888888",
      summary: "Legacy report with malformed findings",
      findings: null as never,
    };

    renderWithQuery(
      <FeedbackView
        data={{ ...data, reports: [malformedReport, data.reports[0]] }}
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
      screen.getByRole("button", { name: "Legacy report with malformed findings" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Search results omitted the newest document" }),
    ).toBeVisible();
  });

  it("filters feedback by the displayed received time", () => {
    const data = dashboardFixture();
    const report = {
      ...data.reports[0],
      createdAt: new Date().toISOString(),
      occurredAt: "2020-01-01T00:00:00Z",
    };

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

    fireEvent.change(screen.getByLabelText("Time range"), { target: { value: "7d" } });
    expect(
      screen.getByRole("button", { name: "Search results omitted the newest document" }),
    ).toBeVisible();
  });

  it("preserves the existing policy fields while changing feedback mode", async () => {
    const data = dashboardFixture();
    const fetchMock = vi.fn().mockResolvedValue(json({ environment: data.currentEnvironment }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PolicyView data={data} refresh={vi.fn().mockResolvedValue(undefined)} setNotice={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Feedback mode"), { target: { value: "ask_once" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      environmentId: data.currentEnvironment?.id,
      feedbackMode: "ask_once",
      collectEventSummaries: false,
      retentionDays: 90,
    });
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
