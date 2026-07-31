"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProductControls } from "@/components/dashboard/product-controls";
import type { DashboardView, ShownSecrets } from "@/components/dashboard/types";
import { DASHBOARD_NAV_VIEWS, DASHBOARD_VIEWS } from "@/components/dashboard/types";
import {
  EmptyState,
  ErrorState,
  NativeSelect,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { DashboardHeader } from "@/components/dashboard-header";
import { Button } from "@/components/ui/button";
import { ConnectorsView } from "@/components/views/connectors/connectors-view";
import { FeedbackView } from "@/components/views/feedback/feedback-view";
import { HomeView } from "@/components/views/home/home-view";
import { InteractionDetail } from "@/components/views/interactions/interaction-detail";
import { PolicyView } from "@/components/views/policy/policy-view";
import { SessionsView } from "@/components/views/sessions/sessions-view";
import { SetupView } from "@/components/views/setup/setup-view";
import { TeamView } from "@/components/views/team/team-view";
import { apiRequest } from "@/lib/api/client";
import {
  DASHBOARD_LIMIT_DEFAULTS,
  type DashboardData,
  fetchDashboard,
  type ProductCreatedResponse,
} from "@/lib/api/dashboard";
import { isEditor, titleCase } from "@/lib/dashboard/format";

type Limits = {
  interactionLimit: number;
  reportLimit: number;
  sessionLimit: number;
};

type Notice = {
  message: string;
  timeoutMs: number;
  tone: "status" | "error";
};

export function DashboardApp() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<DashboardView>("home");
  const [workspaceId, setWorkspaceId] = useState("");
  const [productId, setProductId] = useState("");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedInteractionId, setSelectedInteractionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [secrets, setSecrets] = useState<ShownSecrets | null>(null);
  const [limits, setLimits] = useState<Limits>({ ...DASHBOARD_LIMIT_DEFAULTS });
  const historyMode = useRef<"push" | "replace">("replace");

  const showNotice = useCallback(
    (message: string, timeoutMs = 2_800, tone: Notice["tone"] = "status") => {
      setNotice({ message, timeoutMs, tone });
    },
    [],
  );

  const readLocation = useCallback(() => {
    const url = new URL(window.location.href);
    historyMode.current = "replace";
    setNotice(null);
    const githubResult = url.searchParams.get("github");
    if (githubResult) {
      url.searchParams.delete("github");
      window.history.replaceState({}, "", url);
      if (githubResult === "connected") {
        showNotice("GitHub connected successfully.");
      } else if (githubResult === "conflict") {
        showNotice(
          "That GitHub installation is already connected to another workspace.",
          6_000,
          "error",
        );
      } else if (githubResult === "error") {
        showNotice("Could not connect GitHub. Try again.", 6_000, "error");
      }
    }
    if (url.searchParams.get("invite") === "invalid") {
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url);
      showNotice(
        "That invitation is expired, revoked, or was created for a different email address.",
        6_000,
        "error",
      );
    }
    const requestedView = url.searchParams.get("view");
    setView(
      DASHBOARD_VIEWS.includes(requestedView as DashboardView)
        ? (requestedView as DashboardView)
        : "home",
    );
    setWorkspaceId(url.searchParams.get("team") ?? localStorageValue("epode:last-team"));
    setProductId(url.searchParams.get("product") ?? "");
    setSelectedReportId(url.searchParams.get("report"));
    setSelectedSessionId(url.searchParams.get("session"));
    setSelectedInteractionId(url.searchParams.get("interaction"));
  }, [showNotice]);

  useEffect(() => {
    readLocation();
    setReady(true);
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [readLocation]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), notice.timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const dashboardQuery = useQuery({
    queryKey: ["dashboard", workspaceId, productId, limits],
    queryFn: () =>
      fetchDashboard({
        workspaceId: workspaceId || undefined,
        productId: productId || undefined,
        ...limits,
      }),
    enabled: ready,
    refetchInterval: view === "setup" ? 5_000 : false,
  });
  const data = dashboardQuery.data;

  useEffect(() => {
    if (!data) return;
    if (workspaceId !== data.workspace.id) setWorkspaceId(data.workspace.id);
    const resolvedProductId = data.currentProduct?.id ?? "";
    if (productId !== resolvedProductId) setProductId(resolvedProductId);
    try {
      localStorage.setItem("epode:last-team", data.workspace.id);
    } catch {
      // Storage is optional; the query string still retains the active team.
    }
    if (
      !isEditor(data.currentRole) &&
      (view === "connectors" || view === "setup" || view === "policy")
    ) {
      setView("home");
    }
    if (data.currentEnvironment && secrets?.environmentId !== data.currentEnvironment.id) {
      setSecrets(recallSecrets(data.currentEnvironment.id));
    }
  }, [data, productId, secrets?.environmentId, view, workspaceId]);

  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    setOrDelete(url, "view", view === "home" ? "" : view);
    setOrDelete(url, "team", workspaceId);
    setOrDelete(url, "product", productId);
    setOrDelete(url, "report", selectedReportId);
    setOrDelete(url, "session", selectedSessionId);
    setOrDelete(url, "interaction", selectedInteractionId);
    if (historyMode.current === "push") window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
    historyMode.current = "replace";
  }, [
    productId,
    ready,
    selectedInteractionId,
    selectedReportId,
    selectedSessionId,
    view,
    workspaceId,
  ]);

  const refresh = useCallback(async () => dashboardQuery.refetch(), [dashboardQuery.refetch]);

  const rememberSecret = useCallback(
    (kind: "write" | "read", secret: string) => {
      const environmentId = data?.currentEnvironment?.id;
      if (!environmentId || !secret) return;
      persistSecret(environmentId, kind, secret);
      setSecrets((current) => ({
        environmentId,
        ...(current?.environmentId === environmentId ? current : {}),
        [kind]: secret,
      }));
    },
    [data?.currentEnvironment?.id],
  );

  const changeWorkspace = (nextWorkspaceId: string) => {
    setNotice(null);
    setWorkspaceId(nextWorkspaceId);
    setProductId("");
    clearSelection();
    setSecrets(null);
    setLimits({ ...DASHBOARD_LIMIT_DEFAULTS });
  };

  const changeProduct = (nextProductId: string) => {
    setNotice(null);
    setProductId(nextProductId);
    clearSelection();
    setSecrets(null);
    setLimits({ ...DASHBOARD_LIMIT_DEFAULTS });
  };

  function clearSelection() {
    setSelectedReportId(null);
    setSelectedSessionId(null);
    setSelectedInteractionId(null);
  }

  function navigate(nextView: DashboardView) {
    setNotice(null);
    historyMode.current = "push";
    setView(nextView);
    if (nextView !== "feedback") setSelectedReportId(null);
    if (nextView !== "sessions") setSelectedSessionId(null);
    if (nextView !== "interactions") setSelectedInteractionId(null);
  }

  function openFeedback(reportId: string) {
    setNotice(null);
    historyMode.current = "push";
    setSelectedSessionId(null);
    setSelectedInteractionId(null);
    setSelectedReportId(reportId);
    setView("feedback");
  }

  function openSession(sessionId: string) {
    setNotice(null);
    historyMode.current = "push";
    setSelectedReportId(null);
    setSelectedInteractionId(null);
    setSelectedSessionId(sessionId);
    setView("sessions");
  }

  function openInteraction(interactionId: string) {
    setNotice(null);
    historyMode.current = "push";
    setSelectedReportId(null);
    setSelectedSessionId(null);
    setSelectedInteractionId(interactionId);
    setView("interactions");
  }

  if (!ready || dashboardQuery.isPending) {
    return <main className="p-8 text-sm text-muted-foreground">Loading dashboard…</main>;
  }
  if (dashboardQuery.isError) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <ErrorState error={dashboardQuery.error} onRetry={() => dashboardQuery.refetch()} />
      </main>
    );
  }
  if (!data) return null;

  const editor = isEditor(data.currentRole);

  async function productCreated(created: ProductCreatedResponse) {
    persistSecret(created.environment.id, "write", created.secret);
    setSecrets({ environmentId: created.environment.id, write: created.secret });
    setProductId(created.product.id);
    clearSelection();
    historyMode.current = "push";
    setView("setup");
  }

  async function productDeleted() {
    setProductId("");
    setSecrets(null);
    clearSelection();
    setView("home");
  }

  async function logout() {
    try {
      await apiRequest<unknown>("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/");
    }
  }

  const page = data.products.length ? (
    renderView(data)
  ) : data.currentRole === "member" ? (
    <EmptyState
      title="No product yet"
      description="An owner or admin needs to create the first product."
    />
  ) : (
    <EmptyState
      title="Create your first product"
      description="Products keep feedback, interactions, and sessions separate."
    />
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <DashboardHeader
        breadcrumb={
          <div className="flex flex-wrap items-center gap-2">
            <strong>Epode</strong>
            <NativeSelect
              aria-label="Team"
              value={data.workspace.id}
              onChange={(event) => changeWorkspace(event.target.value)}
            >
              {data.workspaceMemberships.map((membership) => (
                <option value={membership.workspaceId} key={membership.workspaceId}>
                  {membership.workspaceName}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Product"
              value={data.currentProduct?.id ?? ""}
              onChange={(event) => changeProduct(event.target.value)}
            >
              {data.products.length ? null : <option value="">No products</option>}
              {data.products.map((product) => (
                <option value={product.id} key={product.id}>
                  {product.name}
                </option>
              ))}
            </NativeSelect>
            <span className="ml-auto text-xs text-muted-foreground">
              {data.user.displayName} · {titleCase(data.currentRole)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        }
      />
      <div className="grid md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="border-b p-4 md:min-h-[calc(100vh-3.5rem)] md:border-r md:border-b-0">
          <nav aria-label="Dashboard" className="flex flex-wrap gap-1 md:flex-col">
            {DASHBOARD_NAV_VIEWS.filter(
              (item) => editor || (item !== "connectors" && item !== "setup" && item !== "policy"),
            ).map((item) => (
              <Button
                key={item}
                variant={view === item ? "secondary" : "ghost"}
                className="justify-start"
                aria-current={view === item ? "page" : undefined}
                onClick={() => navigate(item)}
              >
                {titleCase(item)}
                {item === "feedback" ? ` (${data.listState.reportsTotal})` : ""}
                {item === "sessions" ? ` (${data.listState.sessionsTotal})` : ""}
              </Button>
            ))}
          </nav>
          <div className="mt-5">
            <ProductControls
              data={data}
              onProductCreated={productCreated}
              onProductDeleted={productDeleted}
              refresh={refresh}
              setNotice={showNotice}
            />
          </div>
        </aside>
        <main className="min-w-0 p-4 md:p-8">
          {notice ? (
            <div className="mb-4">
              <StatusMessage tone={notice.tone}>{notice.message}</StatusMessage>
            </div>
          ) : null}
          {page}
        </main>
      </div>
    </div>
  );

  function renderView(currentData: DashboardData) {
    switch (view) {
      case "feedback":
        return (
          <FeedbackView
            data={currentData}
            selectedReportId={selectedReportId}
            selectReport={(reportId) => {
              setNotice(null);
              historyMode.current = "push";
              setSelectedReportId(reportId);
            }}
            openInteraction={openInteraction}
            openSession={openSession}
            loadMore={() =>
              setLimits((current) => ({
                ...current,
                reportLimit: Math.min(current.reportLimit + 250, 10_000),
              }))
            }
            refresh={refresh}
            setNotice={showNotice}
          />
        );
      case "sessions":
        return (
          <SessionsView
            data={currentData}
            selectedSessionId={selectedSessionId}
            selectSession={(sessionId) => {
              setNotice(null);
              historyMode.current = "push";
              setSelectedSessionId(sessionId);
            }}
            openFeedback={openFeedback}
            openInteraction={openInteraction}
            refresh={refresh}
            loadMore={() =>
              setLimits((current) => ({
                ...current,
                sessionLimit: Math.min(current.sessionLimit + 100, 10_000),
              }))
            }
          />
        );
      case "connectors":
        return isEditor(currentData.currentRole) ? (
          <ConnectorsView data={currentData} />
        ) : (
          <HomeView data={currentData} openFeedback={openFeedback} refresh={refresh} />
        );
      case "setup":
        return (
          <SetupView
            data={currentData}
            secrets={secrets}
            rememberSecret={rememberSecret}
            refresh={refresh}
            setNotice={showNotice}
          />
        );
      case "policy":
        return <PolicyView data={currentData} refresh={refresh} setNotice={showNotice} />;
      case "team":
        return <TeamView data={currentData} refresh={refresh} setNotice={showNotice} />;
      case "interactions":
        return selectedInteractionId ? (
          <InteractionDetail
            data={currentData}
            interactionId={selectedInteractionId}
            back={() => window.history.back()}
            openFeedback={openFeedback}
            openSession={openSession}
          />
        ) : (
          <EmptyState
            title="No interaction selected"
            description="Open an interaction from feedback or a session."
          />
        );
      default:
        return <HomeView data={currentData} openFeedback={openFeedback} refresh={refresh} />;
    }
  }
}

function setOrDelete(url: URL, key: string, value: string | null) {
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
}

function localStorageValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function secretStorageKey(environmentId: string, kind: "write" | "read"): string {
  return kind === "read"
    ? `agent-feedback:read-key:${environmentId}`
    : `agent-feedback:product-key:${environmentId}`;
}

function persistSecret(environmentId: string, kind: "write" | "read", secret: string) {
  try {
    window.sessionStorage.setItem(secretStorageKey(environmentId, kind), secret);
  } catch {
    // Private browsing may disable storage; React state keeps the secret visible this page load.
  }
}

function recallSecrets(environmentId: string): ShownSecrets {
  try {
    return {
      environmentId,
      write: window.sessionStorage.getItem(secretStorageKey(environmentId, "write")) || undefined,
      read: window.sessionStorage.getItem(secretStorageKey(environmentId, "read")) || undefined,
    };
  } catch {
    return { environmentId };
  }
}
