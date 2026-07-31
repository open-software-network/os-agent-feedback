"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProductControls } from "@/components/dashboard/product-controls";
import type { DashboardView, ShownSecrets } from "@/components/dashboard/types";
import { DASHBOARD_VIEWS } from "@/components/dashboard/types";
import { EmptyState, ErrorState, StatusMessage } from "@/components/dashboard/view-primitives";
import {
  ConfigurationView,
  isConfigurationSection,
  ProductConfigurationView,
} from "@/components/views/configuration/configuration-view";
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
import { isEditor } from "@/lib/dashboard/format";

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
    const callbackResult = url.searchParams.get("github");
    if (callbackResult) {
      url.searchParams.delete("github");
      window.history.replaceState({}, "", url);
      if (callbackResult === "connected") {
        showNotice("GitHub connected. Choose a repository for this product.");
      } else if (callbackResult === "conflict") {
        showNotice(
          "That GitHub installation already belongs to another Epode team.",
          6_000,
          "error",
        );
      } else {
        showNotice(
          "GitHub could not be connected. Try the installation flow again.",
          6_000,
          "error",
        );
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

  const page = data.products.length ? renderView(data) : renderEmptyProductState(data);
  const configurationActive =
    isConfigurationSection(view) || (data.products.length === 0 && data.currentRole !== "member");
  const fullBleed = configurationActive || view === "feedback" || view === "sessions";

  return (
    <DashboardShell
      data={data}
      view={view}
      onNavigate={navigate}
      onWorkspaceChange={changeWorkspace}
      onProductChange={changeProduct}
      onLogout={() => void logout()}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {notice ? (
          <div className="pointer-events-none absolute inset-x-4 top-4 z-50 flex justify-center">
            <div className="pointer-events-auto w-full max-w-xl bg-background">
              <StatusMessage tone={notice.tone}>{notice.message}</StatusMessage>
            </div>
          </div>
        ) : null}
        <div
          className={
            fullBleed ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-auto bg-canvas p-4 md:p-6"
          }
        >
          {page}
        </div>
      </div>
    </DashboardShell>
  );

  function configurationPage(
    currentData: DashboardData,
    section: "configuration" | "setup" | "policy" | "connectors" | "team",
    content: ReactNode,
  ) {
    return (
      <ConfigurationView
        data={currentData}
        section={section}
        onSectionChange={(nextSection) => navigate(nextSection)}
      >
        {content}
      </ConfigurationView>
    );
  }

  function productControls(currentData: DashboardData) {
    return (
      <ProductControls
        data={currentData}
        onProductCreated={productCreated}
        onProductDeleted={productDeleted}
        refresh={refresh}
        setNotice={showNotice}
      />
    );
  }

  function renderEmptyProductState(currentData: DashboardData) {
    if (currentData.currentRole === "member") {
      return (
        <EmptyState
          title="No product yet"
          description="An owner or admin needs to create the first product."
        />
      );
    }

    return configurationPage(
      currentData,
      "configuration",
      <ProductConfigurationView data={currentData} controls={productControls(currentData)} />,
    );
  }

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
      case "setup":
        return configurationPage(
          currentData,
          "setup",
          <SetupView
            data={currentData}
            secrets={secrets}
            rememberSecret={rememberSecret}
            refresh={refresh}
            setNotice={showNotice}
            embedded
          />,
        );
      case "policy":
        return configurationPage(
          currentData,
          "policy",
          <PolicyView data={currentData} refresh={refresh} setNotice={showNotice} embedded />,
        );
      case "connectors":
        return isEditor(currentData.currentRole) ? (
          configurationPage(
            currentData,
            "connectors",
            <ConnectorsView data={currentData} embedded />,
          )
        ) : (
          <HomeView data={currentData} openFeedback={openFeedback} refresh={refresh} />
        );
      case "team":
        return configurationPage(
          currentData,
          "team",
          <TeamView data={currentData} refresh={refresh} setNotice={showNotice} embedded />,
        );
      case "configuration":
        return configurationPage(
          currentData,
          "configuration",
          <ProductConfigurationView data={currentData} controls={productControls(currentData)} />,
        );
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
